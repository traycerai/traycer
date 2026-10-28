import { use, useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { QueryClientContext } from "@tanstack/react-query";
import type { EpicDeletedAttribution } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { removeDeletedEpicsFromCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import { epicAccessToast } from "@/lib/toast/channels";
import {
  subscribeDeletedEpicNotifications,
  type DeletedEpicNotification,
} from "@/lib/epics/deleted-epic-events";
import {
  clearDeletedEpicRunSettings,
  epicIdsLostInWindow,
} from "@/lib/epics/deleted-epic-scope";
import { activeHostIdOrNull } from "@/lib/host/runtime";
import { isUnavailableEpicCode } from "@/lib/epics/unavailable-epic";
import {
  CREATED_EPIC_UNAVAILABLE_RETRY_DELAYS_MS,
  wasEpicCreatedRecentlyThisSession,
} from "@/lib/epics/session-created-epics";
import { liveEpicTitleFromHandle } from "@/lib/epic-selectors";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { LANDING_ROUTE, readActiveEpicIdFromPath } from "@/lib/routes";
import {
  collectOpenEpicIds,
  epicTabName,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

/**
 * App-level coordinator that force-closes an epic tab when the user loses
 * access to it, and redirects to the landing page when the closed tab was the
 * one being viewed. It is the single reactor to three "this epic is gone"
 * signals:
 *
 *  - **Revoke** - `permissionChanged(null)` → `accessLost` on the session.
 *  - **Delete** - a remote `epicDeleted` frame → `epicDeleted` on the session.
 *  - **Unavailable on open** - a `snapshotFetchError` with the `NOT_FOUND`
 *    protocol code (deleted/removed room discovered when the
 *    session reconnects or is opened offline). Because that signal cannot tell
 *    a delete apart from a revoke, it gets a neutral "no longer available"
 *    toast rather than asserting either cause.
 *
 * It also undoes one: a session whose stream the host closed `FORBIDDEN`
 * re-opens once that epic's chat-records read succeeds again after failing,
 * so a re-granted epic recovers without Retry.
 *
 * It generalizes the former `useCloseUnavailableEpicTab`: it observes EVERY
 * live session through the module-scoped session registry, not just the active
 * route, so a background tab whose epic is revoked/deleted closes live too.
 *
 * Behavior (see the revoke/delete decision log):
 *  - Active tab → `closeTabsForEpics` + redirect to the landing page + toast.
 *  - Background tab → silent close + toast, no navigation.
 *  - A role downgrade (editor/owner → viewer) is NOT a loss of access: the
 *    session keeps the tab open read-only and never raises these signals, so a
 *    downgrade never reaches this coordinator.
 *
 * Must be mounted INSIDE the router subtree - it calls `navigate`. Live
 * background close is guaranteed only for sessions resident in the registry's
 * MRU window; a session pruned out of that window has no live stream and is
 * caught by the same signals on its next open.
 */
export function EpicAccessCoordinator() {
  const navigate = useNavigate();
  const queryClient = use(QueryClientContext);
  // Track which epic (if any) the user is currently viewing, off the route -
  // read at close time to decide whether to redirect. Kept in a ref so the
  // long-lived subscriptions below see the latest value without re-running the
  // effect on every navigation.
  const activeEpicId = useRouterState({
    select: (state) => readActiveEpicIdFromPath(state.location.pathname),
  });
  const activeEpicIdRef = useRef<string | null>(activeEpicId);
  useEffect(() => {
    activeEpicIdRef.current = activeEpicId;
  }, [activeEpicId]);

  useEffect(() => {
    const registry = getOpenEpicRegistry();
    const perHandleUnsub = new Map<string, () => void>();
    const handled = new Set<string>();
    // Set by the effect's cleanup. `evaluate` defers its verdict to a
    // microtask, so a signal that lands just before unmount can fire that
    // microtask AFTER teardown - where acting would navigate/mutate stores
    // from a dead coordinator, or park a grace timer in a map teardown has
    // already swept. The replacement coordinator instance re-walks every open
    // session on mount (`reconcile` + its dead-at-subscribe catch), so a
    // bailed verdict is re-derived, never lost.
    let disposed = false;
    // Attempts already spent (and the pending timer, if any) of the
    // created-this-session `unavailable` grace. Attempts are deliberately
    // never reset on recovery: the budget exists to absorb ONE create's
    // replication lag, and a session that later turns `unavailable` again
    // with the budget spent gets the ordinary eject.
    const createGraceAttempts = new Map<string, number>();
    const createGraceTimers = new Map<string, number>();
    const clearCreateGraceTimer = (epicId: string): void => {
      const timer = createGraceTimers.get(epicId);
      if (timer === undefined) return;
      window.clearTimeout(timer);
      createGraceTimers.delete(epicId);
    };
    // An epic whose stream the host closed `FORBIDDEN` (access lost while it
    // was open). The client never reopens that stream on its own, so a
    // re-granted epic would hold the removal-time error until Retry. Its
    // chat-records read keeps polling the same host, and the host answering
    // it again after a failure is the proof access is back: on that first
    // failure-to-success switch the session re-opens once. A real revoke never
    // answers, and nothing new polls.
    const forbiddenWatches = new Map<string, () => void>();
    const disarmForbiddenRecovery = (epicId: string): void => {
      const unsubscribe = forbiddenWatches.get(epicId);
      if (unsubscribe === undefined) return;
      unsubscribe();
      forbiddenWatches.delete(epicId);
    };
    const armForbiddenRecovery = (epicId: string): void => {
      if (queryClient === undefined || forbiddenWatches.has(epicId)) return;
      const cache = queryClient.getQueryCache();
      // Per query, whether it has failed since the error landed: a success
      // already in flight when access went away proves nothing.
      const failed = new Set<string>();
      for (const query of cache.findAll({
        predicate: (candidate) => {
          const queryKey: unknown = candidate.queryKey;
          return isEpicChatRecordsKey(queryKey, epicId);
        },
      })) {
        if (query.state.status === "error") failed.add(query.queryHash);
      }
      const unsubscribe = cache.subscribe((event) => {
        if (event.type !== "updated") return;
        const queryKey: unknown = event.query.queryKey;
        if (!isEpicChatRecordsKey(queryKey, epicId)) return;
        const actionType = event.action.type;
        if (actionType === "failed" || actionType === "error") {
          failed.add(event.query.queryHash);
          return;
        }
        if (actionType !== "success" || !failed.has(event.query.queryHash)) {
          return;
        }
        disarmForbiddenRecovery(epicId);
        // Out of the cache's notify: re-opening publishes into the store.
        queueMicrotask(() => {
          if (disposed) return;
          const live = registry.peek(epicId);
          if (live === null) return;
          const liveState = live.store.getState();
          if (liveState.snapshotFetchError?.code !== "FORBIDDEN") return;
          // `requestFreshSnapshot` replaces the replica; local work the person
          // has not synced stays theirs to keep, behind the banner's Retry.
          if (holdsUnsyncedWork(liveState)) return;
          live.requestFreshSnapshot();
        });
      });
      forbiddenWatches.set(epicId, unsubscribe);
    };
    const syncForbiddenRecovery = (
      epicId: string,
      state: OpenEpicState,
    ): void => {
      if (state.snapshotFetchError?.code === "FORBIDDEN") {
        armForbiddenRecovery(epicId);
      } else {
        disarmForbiddenRecovery(epicId);
      }
    };
    // Last resident-set signature reconcile acted on, so the per-keystroke
    // eligibility emits the registry fires (which don't change membership)
    // short-circuit instead of re-walking every open session.
    let lastResidentSignature: string | null = null;

    // Toast only - no layout/source mutation, and no settings: each caller
    // clears a deleted epic's composer settings in its deletion's scope.
    // Kept separate from the mutation so a genuine multi-epic batch (see
    // `applyDeletedEpicNotification`) can announce each epic individually
    // while still routing the mutation through ONE coordinated
    // `handleEpicAccessLoss` call. Two sequential single-epic calls would
    // placeholder each side of a shared split independently, leaving BOTH
    // sides stuck as `unavailable` instead of collapsing the group - only a
    // single call carrying every lost epicId resolves both sides at once.
    const announceEpicLoss = (epicId: string, reason: DeadEpicReason): void => {
      // One channel per epic, so a duplicate "epic is gone" signal (e.g. a
      // delete that also trips the unavailable-on-reconnect path) replaces the
      // eject toast instead of stacking a second.
      const channel = epicAccessToast(epicId);
      if (reason.kind === "deleted") {
        const subject = deletedEpicSubject(epicId, reason.title);
        const by = reason.attribution?.deletedByDisplayName ?? null;
        channel.info(
          by !== null && by.length > 0
            ? `${subject} was deleted by ${by}`
            : `${subject} was deleted`,
        );
      } else if (reason.kind === "revoked") {
        channel.info(
          `You no longer have access to ${objectEpicSubject(epicId)}`,
        );
      } else {
        channel.info(`${sentenceEpicSubject(epicId)} is no longer available`);
      }
    };

    const runClose = (epicId: string, reason: DeadEpicReason): void => {
      const ownerUserId = registry.peek(epicId)?.userId ?? null;
      if (
        ownerUserId !== null &&
        (useAuthStore.getState().profile?.userId ?? null) !== ownerUserId
      )
        return;
      const wasActive = activeEpicIdRef.current === epicId;
      announceEpicLoss(epicId, reason);
      // A session's own deleted signal is the epic's deletion as its host
      // reports it, which has always cleared the epic on every host.
      if (reason.kind === "deleted") {
        useComposerRunSettingsStore.getState().clearEpicRunSettings([epicId]);
      }
      tabCommandCoordinator.handleEpicAccessLoss([epicId], ownerUserId);
      if (wasActive) {
        // `handleEpicAccessLoss` recomputes `activeTabId` to a neighbor as a
        // side effect; clear it so the route-driven strip highlight and the
        // canvas store agree once we leave the epic for landing.
        useEpicCanvasStore.setState({ activeTabId: null });
        void navigate({ ...LANDING_ROUTE, replace: true });
      }
    };

    const applyDeletedEpicNotification = (
      notification: DeletedEpicNotification,
    ): void => {
      const { epicIds, userId, epicTitlesById } = notification;
      // The scopes the deleting window tombstoned in: a local-homed Task
      // under the host that deleted it, the rest account-wide.
      const hostScoped = new Set(notification.hostScopedEpicIds);
      const scopes = {
        accountWideIds: epicIds.filter((id) => !hostScoped.has(id)),
        hostScopedIds: [...hostScoped],
        deletingHostId: notification.hostId,
      };
      if (queryClient !== undefined) {
        if (scopes.hostScopedIds.length > 0) {
          removeDeletedEpicsFromCloudTaskCaches(
            queryClient,
            { hostId: notification.hostId, userId },
            scopes.hostScopedIds,
          );
        }
        if (scopes.accountWideIds.length > 0) {
          removeDeletedEpicsFromCloudTaskCaches(
            queryClient,
            { hostId: null, userId },
            scopes.accountWideIds,
          );
        }
      }
      // Settings in each deletion's scope, resident tab or not: a deleted
      // epic's settings must not silently survive it, and a same-id Task on
      // another host keeps its own - matching `useEpicBatchDelete`.
      clearDeletedEpicRunSettings(scopes);
      // Only what this window lost: a same-id Task it holds on a host that
      // did not delete it stays open (`epicIdsLostInWindow`).
      const lostIds = epicIdsLostInWindow(scopes, activeHostIdOrNull());
      const openEpicIds = new Set(collectOpenEpicIds());
      let anyWasActive = false;
      for (const epicId of lostIds) {
        if (!openEpicIds.has(epicId) && activeEpicIdRef.current !== epicId) {
          continue;
        }
        if (activeEpicIdRef.current === epicId) anyWasActive = true;
        announceEpicLoss(epicId, {
          kind: "deleted",
          attribution: null,
          title: readEpicTitle(epicTitlesById, epicId),
        });
      }
      // One coordinated call over the WHOLE notification batch - not a loop
      // of single-epic calls - so a pair of Epics that are both sides of the
      // same split (or that duplicate a ref across groups) collapse in one
      // coordinator transaction instead of firing a separate transaction
      // (and a separate persistence flush) per epic for what is semantically
      // one event.
      tabCommandCoordinator.handleEpicAccessLoss(lostIds, notification.userId);
      if (anyWasActive) {
        useEpicCanvasStore.setState({ activeTabId: null });
        void navigate({ ...LANDING_ROUTE, replace: true });
      }
    };

    const evaluate = (epicId: string): void => {
      if (handled.has(epicId)) return;
      const handle = registry.peek(epicId);
      if (handle === null) return;
      if (deadEpicReason(handle.store.getState()) === null) return;
      handled.add(epicId);
      // Defer out of the firing store-subscription callback: `runClose` mutates
      // the canvas store and disposes the session, which must not run
      // re-entrantly inside the emit that triggered it.
      queueMicrotask(() => {
        if (disposed) return;
        // Re-derive at fire time: the tab may have been closed by the user, the
        // session released, or a TRANSIENT `unavailable` error cleared on a
        // successful reconnect between scheduling and now. Acting on the stale
        // captured reason would force-close a tab that recovered (or toast for
        // one already gone). Drop the latch so a fresh signal re-evaluates.
        const current = registry.peek(epicId);
        const currentState = current === null ? null : current.store.getState();
        const reason =
          currentState === null ? null : deadEpicReason(currentState);
        const stillOpen = collectOpenEpicIds().includes(epicId);
        if (reason === null || !stillOpen) {
          handled.delete(epicId);
          return;
        }
        // Create-race grace: an `unavailable` (cloud NOT_FOUND) on an epic
        // this renderer created SECONDS AGO is far more likely the create
        // host's background cloud connect still in flight than a real
        // delete, so spend the bounded retry schedule re-subscribing before
        // believing it. The latch is dropped so the retry's own failure (a
        // fresh `snapshotFetchError`) re-enters this evaluation and takes
        // the next slot; past the last slot, the eject below runs as usual.
        //
        // Scoped to the race window, not the session: `requestFreshSnapshot`
        // is DESTRUCTIVE (it clears the unsynced queue and replaces the
        // replica), and an epic created hours ago has had every chance to
        // accumulate work a transient NOT_FOUND must not silently erase.
        // `holdsUnsyncedWork` is the second half of that guarantee - inside
        // the window there is nothing to lose yet, and if there somehow is,
        // the ordinary announced close runs instead of a silent discard.
        if (
          reason.kind === "unavailable" &&
          wasEpicCreatedRecentlyThisSession(epicId) &&
          !holdsUnsyncedWork(currentState)
        ) {
          // A pending retry owns this epic's verdict until it fires; a signal
          // landing meanwhile must neither double-schedule nor fall through
          // to the eject below.
          if (createGraceTimers.has(epicId)) {
            handled.delete(epicId);
            return;
          }
          const attempts = createGraceAttempts.get(epicId) ?? 0;
          if (attempts < CREATED_EPIC_UNAVAILABLE_RETRY_DELAYS_MS.length) {
            const delay = CREATED_EPIC_UNAVAILABLE_RETRY_DELAYS_MS[attempts];
            createGraceAttempts.set(epicId, attempts + 1);
            handled.delete(epicId);
            const timer = window.setTimeout(() => {
              createGraceTimers.delete(epicId);
              const live = registry.peek(epicId);
              if (live === null) return;
              // Re-derive at fire time, exactly like the eject path above: a
              // session that recovered (or died for a DIFFERENT, first-hand
              // reason) must not be torn down and re-dialed by a stale grace.
              const liveState = live.store.getState();
              const liveReason = deadEpicReason(liveState);
              if (liveReason === null || liveReason.kind !== "unavailable") {
                return;
              }
              // Re-check the destructive precondition too: local work can
              // appear during the delay (an offline edit, a dirty artifact
              // room), and `requestFreshSnapshot` would discard it with no
              // trace. Hand the verdict back to the announced close instead -
              // what this epic would have got without the grace.
              if (holdsUnsyncedWork(liveState)) {
                if (!collectOpenEpicIds().includes(epicId)) return;
                // Re-arm the latch the grace dropped, so `runClose` stays
                // once-per-epic against the emits its own teardown fires.
                handled.add(epicId);
                runClose(epicId, liveReason);
                return;
              }
              live.requestFreshSnapshot();
            }, delay);
            createGraceTimers.set(epicId, timer);
            return;
          }
        }
        runClose(epicId, reason);
      });
    };

    const reconcile = (): void => {
      const openEpicIds = collectOpenEpicIds();
      const openSet = new Set(openEpicIds);
      // Sorted so a pure tab reorder (same membership) is a no-op.
      const signature = openEpicIds
        .filter((epicId) => registry.peek(epicId) !== null)
        .slice()
        .sort()
        .join("|");
      if (signature === lastResidentSignature) return;
      lastResidentSignature = signature;

      for (const epicId of openEpicIds) {
        if (perHandleUnsub.has(epicId)) continue;
        const handle = registry.peek(epicId);
        if (handle === null) continue;
        const unsubscribe = handle.store.subscribe((state, prev) => {
          // Only the three "epic is gone" signals matter; skip the per-edit
          // store churn so `evaluate` isn't re-run on every keystroke.
          if (
            state.accessLost === prev.accessLost &&
            state.epicDeleted === prev.epicDeleted &&
            state.snapshotFetchError === prev.snapshotFetchError
          ) {
            return;
          }
          syncForbiddenRecovery(epicId, state);
          evaluate(epicId);
        });
        perHandleUnsub.set(epicId, unsubscribe);
        // Catch a session already dead at subscribe time (signal landed before
        // this coordinator observed the session).
        syncForbiddenRecovery(epicId, handle.store.getState());
        evaluate(epicId);
      }
      for (const [epicId, unsubscribe] of [...perHandleUnsub.entries()]) {
        if (openSet.has(epicId) && registry.peek(epicId) !== null) continue;
        unsubscribe();
        perHandleUnsub.delete(epicId);
        // Allow a reopened (e.g. re-granted) epic to be evaluated afresh.
        handled.delete(epicId);
        // A departed tab's pending grace retry must not re-dial a session the
        // user already left; the spent-attempts record goes with it so a
        // reopen starts the schedule over.
        clearCreateGraceTimer(epicId);
        createGraceAttempts.delete(epicId);
        disarmForbiddenRecovery(epicId);
      }
    };

    reconcile();
    const unsubscribeRegistry = registry.subscribe(reconcile);
    const unsubscribeCanvas = useEpicCanvasStore.subscribe((next, prev) => {
      if (next.openTabOrder === prev.openTabOrder) return;
      reconcile();
    });
    const unsubscribeDeletedEpicNotifications =
      subscribeDeletedEpicNotifications((notification) => {
        const currentUserId =
          useAuthStore.getState().contextMetadata?.userId ?? null;
        if (currentUserId === null || notification.userId !== currentUserId) {
          return;
        }
        applyDeletedEpicNotification(notification);
      });

    return () => {
      disposed = true;
      unsubscribeRegistry();
      unsubscribeCanvas();
      unsubscribeDeletedEpicNotifications();
      for (const unsubscribe of perHandleUnsub.values()) unsubscribe();
      perHandleUnsub.clear();
      for (const timer of createGraceTimers.values()) {
        window.clearTimeout(timer);
      }
      createGraceTimers.clear();
      for (const unsubscribe of forbiddenWatches.values()) unsubscribe();
      forbiddenWatches.clear();
    };
  }, [navigate, queryClient]);

  return null;
}

type DeadEpicReason =
  | {
      readonly kind: "deleted";
      readonly attribution: EpicDeletedAttribution | null;
      readonly title: string | null;
    }
  | { readonly kind: "revoked" }
  | { readonly kind: "unavailable" };

function deadEpicReason(state: OpenEpicState): DeadEpicReason | null {
  if (state.epicDeleted !== null) {
    return { kind: "deleted", attribution: state.epicDeleted, title: null };
  }
  if (state.accessLost) {
    return { kind: "revoked" };
  }
  if (
    state.snapshotFetchError !== null &&
    isUnavailableEpicCode(state.snapshotFetchError.code)
  ) {
    // The host could not return a live room on (re)open. This surfaces a
    // delete OR a revoke indistinguishably, so the cause is left neutral.
    return { kind: "unavailable" };
  }
  return null;
}

/**
 * Whether the replica holds local work that has not reached the host -
 * offline-buffered ops (`unsyncedQueueSize`) or an un-flushed dirty signal
 * over the root doc or any artifact room (`isDirty`). Both are exactly what
 * `requestFreshSnapshot` throws away, so the create-race grace refuses to run
 * while either is set. `null` (no live handle) holds nothing by definition.
 */
function holdsUnsyncedWork(state: OpenEpicState | null): boolean {
  if (state === null) return false;
  return state.isDirty || state.unsyncedQueueSize > 0;
}

const CHAT_RECORDS_METHOD = "epic.listChatRecords";

/** Whether `queryKey` is an `epic.listChatRecords` read of `epicId`, on any host. */
function isEpicChatRecordsKey(queryKey: unknown, epicId: string): boolean {
  if (
    !Array.isArray(queryKey) ||
    !hostQueryKeys.matchesMethodOnAnyHost(queryKey, CHAT_RECORDS_METHOD)
  ) {
    return false;
  }
  const params: unknown = queryKey[queryKey[1] === CHAT_RECORDS_METHOD ? 2 : 3];
  return (
    typeof params === "object" &&
    params !== null &&
    "epicId" in params &&
    params.epicId === epicId
  );
}

/**
 * Best-available live title for an epic: the projected Y.Doc/snapshot title,
 * else the active/MRU open-tab name (via the canvas store, so it matches the
 * strip), else `null` when nothing resolves.
 */
function resolveEpicTitle(epicId: string): string | null {
  return (
    liveEpicTitleFromHandle(getOpenEpicRegistry().peek(epicId)) ??
    epicTabName(epicId)
  );
}

function deletedEpicSubject(
  epicId: string,
  titleOverride: string | null,
): string {
  const title = titleOverride ?? resolveEpicTitle(epicId);
  return title === null ? "Epic" : `Epic "${title}"`;
}

// Sentence-initial subject for a toast: the quoted title, or a bare "This epic"
// when the title can't be resolved (never the quoted literal `"this epic"`).
function sentenceEpicSubject(epicId: string): string {
  const title = resolveEpicTitle(epicId);
  return title === null ? "This epic" : `"${title}"`;
}

// Mid-sentence object form ("...access to <here>"): quoted title or lowercase
// "this epic" fallback.
function objectEpicSubject(epicId: string): string {
  const title = resolveEpicTitle(epicId);
  return title === null ? "this epic" : `"${title}"`;
}

function readEpicTitle(
  titlesById: Readonly<Record<string, string | undefined>>,
  epicId: string,
): string | null {
  const title = titlesById[epicId];
  return title === undefined ? null : normalizeEpicTitle(title);
}

function normalizeEpicTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}
