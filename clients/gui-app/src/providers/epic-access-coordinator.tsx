import { use, useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { QueryClientContext } from "@tanstack/react-query";
import type { EpicDeletedAttribution } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { removeDeletedEpicsFromCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import { epicAccessToast } from "@/lib/toast/channels";
import { subscribeDeletedEpicNotifications } from "@/lib/epics/deleted-epic-events";
import { isUnavailableEpicCode } from "@/lib/epics/unavailable-epic";
import {
  CREATED_EPIC_UNAVAILABLE_RETRY_DELAYS_MS,
  wasEpicCreatedRecentlyThisSession,
} from "@/lib/epics/session-created-epics";
import { liveEpicTitleFromHandle } from "@/lib/epic-selectors";
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

/** Force-close epic tabs on revoke, delete, or unavailable-on-open. Mount inside the router; observes every live registry session. A role downgrade is not a loss of access. Live background close is only for sessions still in the MRU window. */
export function EpicAccessCoordinator() {
  const navigate = useNavigate();
  const queryClient = use(QueryClientContext);
  // Viewing epic in a ref so close-time redirect sees the latest without
  // re-running subscriptions on every navigation.
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
    // evaluate is a microtask; bail after unmount. The replacement re-walks
    // sessions on mount so a bailed verdict is re-derived.
    let disposed = false;
    // Grace budget is never reset on recovery. A later unavailable with the
    // budget spent gets the ordinary eject.
    const createGraceAttempts = new Map<string, number>();
    const createGraceTimers = new Map<string, number>();
    const clearCreateGraceTimer = (epicId: string): void => {
      const timer = createGraceTimers.get(epicId);
      if (timer === undefined) return;
      window.clearTimeout(timer);
      createGraceTimers.delete(epicId);
    };
    // Last resident-set signature reconcile acted on, so the per-keystroke
    // eligibility emits the registry fires (which don't change membership)
    // short-circuit instead of re-walking every open session.
    let lastResidentSignature: string | null = null;

    // Toast/bookkeeping only. Multi-epic loss must be one handleEpicAccessLoss
    // call or a shared split leaves both sides unavailable.
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
        useComposerRunSettingsStore.getState().clearEpicRunSettings([epicId]);
      } else if (reason.kind === "revoked") {
        channel.info(
          `You no longer have access to ${objectEpicSubject(epicId)}`,
        );
      } else {
        channel.info(`${sentenceEpicSubject(epicId)} is no longer available`);
      }
    };

    const runClose = (epicId: string, reason: DeadEpicReason): void => {
      const wasActive = activeEpicIdRef.current === epicId;
      announceEpicLoss(epicId, reason);
      tabCommandCoordinator.handleEpicAccessLoss([epicId]);
      if (wasActive) {
        // `handleEpicAccessLoss` recomputes `activeTabId` to a neighbor as a
        // side effect; clear it so the route-driven strip highlight and the
        // canvas store agree once we leave the epic for landing.
        useEpicCanvasStore.setState({ activeTabId: null });
        void navigate({ ...LANDING_ROUTE, replace: true });
      }
    };

    const applyDeletedEpicNotification = (
      epicIds: ReadonlyArray<string>,
      userId: string,
      epicTitlesById: Readonly<Record<string, string | undefined>>,
    ): void => {
      if (queryClient !== undefined) {
        removeDeletedEpicsFromCloudTaskCaches(
          queryClient,
          { hostId: null, userId },
          epicIds,
        );
      }
      const openEpicIds = new Set(collectOpenEpicIds());
      let anyWasActive = false;
      const withoutResidentTab: Array<string> = [];
      for (const epicId of epicIds) {
        if (!openEpicIds.has(epicId) && activeEpicIdRef.current !== epicId) {
          withoutResidentTab.push(epicId);
          continue;
        }
        if (activeEpicIdRef.current === epicId) anyWasActive = true;
        announceEpicLoss(epicId, {
          kind: "deleted",
          attribution: null,
          title: readEpicTitle(epicTitlesById, epicId),
        });
      }
      // Deleted epic without a resident tab never hits announceEpicLoss; still
      // clear its run settings.
      if (withoutResidentTab.length > 0) {
        useComposerRunSettingsStore
          .getState()
          .clearEpicRunSettings(withoutResidentTab);
      }
      // One handleEpicAccessLoss over the whole batch so a shared split
      // collapses in one transaction.
      tabCommandCoordinator.handleEpicAccessLoss(epicIds);
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
        // Re-derive at fire time. A recovered or already-gone tab must not get
        // the stale captured close. Drop the latch so a fresh signal re-evaluates.
        const current = registry.peek(epicId);
        const currentState = current === null ? null : current.store.getState();
        const reason =
          currentState === null ? null : deadEpicReason(currentState);
        const stillOpen = collectOpenEpicIds().includes(epicId);
        if (reason === null || !stillOpen) {
          handled.delete(epicId);
          return;
        }
        // Create-race grace: a recent-create NOT_FOUND retries before eject. `requestFreshSnapshot` is destructive, so only the race window, and never if `holdsUnsyncedWork`.
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
              // Re-check: local work can appear during the delay, and
              // requestFreshSnapshot would discard it. Hand back to announced close.
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
          evaluate(epicId);
        });
        perHandleUnsub.set(epicId, unsubscribe);
        // Catch a session already dead at subscribe time (signal landed before
        // this coordinator observed the session).
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
        applyDeletedEpicNotification(
          notification.epicIds,
          notification.userId,
          notification.epicTitlesById,
        );
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

/** Create-race grace must not run while unsyncedQueueSize or isDirty is set; requestFreshSnapshot would throw that work away. */
function holdsUnsyncedWork(state: OpenEpicState | null): boolean {
  if (state === null) return false;
  return state.isDirty || state.unsyncedQueueSize > 0;
}

/**
 * Projected title, else canvas-store tab name, else null.
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
