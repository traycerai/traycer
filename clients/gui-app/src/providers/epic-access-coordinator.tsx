import { use, useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { QueryClientContext } from "@tanstack/react-query";
import type { EpicDeletedAttribution } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { removeDeletedEpicsFromCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import { epicAccessToast } from "@/lib/toast/channels";
import { subscribeDeletedEpicNotifications } from "@/lib/epics/deleted-epic-events";
import { isUnavailableEpicReason } from "@/lib/epics/unavailable-epic";
import { liveEpicTitleFromHandle } from "@/lib/epic-selectors";
import {
  getOpenEpicRegistry,
  releaseOpenEpicSessionIfUnused,
} from "@/lib/registries/epic-session-registry";
import { LANDING_ROUTE, readActiveEpicIdFromPath } from "@/lib/routes";
import {
  collectOpenEpicIds,
  epicTabName,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

/**
 * App-level coordinator that force-closes an epic tab when the user loses
 * access to it, and redirects to the landing page when the closed tab was the
 * one being viewed. It is the single reactor to three "this epic is gone"
 * signals:
 *
 *  - **Revoke** - `permissionChanged(null)` → `accessLost` on the session.
 *  - **Delete** - a remote `epicDeleted` frame → `epicDeleted` on the session.
 *  - **Unavailable on open** - a `snapshotFetchError` whose message matches
 *    {@link isUnavailableEpicReason} (deleted/removed room discovered when the
 *    session reconnects or is opened offline). Because that signal cannot tell
 *    a delete apart from a revoke, it gets a neutral "no longer available"
 *    toast rather than asserting either cause.
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
    // Last resident-set signature reconcile acted on, so the per-keystroke
    // eligibility emits the registry fires (which don't change membership)
    // short-circuit instead of re-walking every open session.
    let lastResidentSignature: string | null = null;

    const runClose = (epicId: string, reason: DeadEpicReason): void => {
      const wasActive = activeEpicIdRef.current === epicId;
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
      if (reason.kind === "deleted") {
        useComposerRunSettingsStore.getState().clearEpicRunSettings([epicId]);
      }
      useEpicCanvasStore.getState().closeTabsForEpics([epicId]);
      releaseOpenEpicSessionIfUnused(epicId);
      if (wasActive) {
        // `closeTabsForEpics` recomputes `activeTabId` to a neighbor as a side
        // effect; clear it so the route-driven strip highlight and the canvas
        // store agree once we leave the epic for landing.
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
      for (const epicId of epicIds) {
        if (openEpicIds.has(epicId) || activeEpicIdRef.current === epicId) {
          runClose(epicId, {
            kind: "deleted",
            attribution: null,
            title: readEpicTitle(epicTitlesById, epicId),
          });
          continue;
        }
        useComposerRunSettingsStore.getState().clearEpicRunSettings([epicId]);
        useEpicCanvasStore.getState().closeTabsForEpics([epicId]);
        releaseOpenEpicSessionIfUnused(epicId);
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
        // Re-derive at fire time: the tab may have been closed by the user, the
        // session released, or a TRANSIENT `unavailable` error cleared on a
        // successful reconnect between scheduling and now. Acting on the stale
        // captured reason would force-close a tab that recovered (or toast for
        // one already gone). Drop the latch so a fresh signal re-evaluates.
        const current = registry.peek(epicId);
        const reason =
          current === null ? null : deadEpicReason(current.store.getState());
        const stillOpen = collectOpenEpicIds().includes(epicId);
        if (reason === null || !stillOpen) {
          handled.delete(epicId);
          return;
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
      unsubscribeRegistry();
      unsubscribeCanvas();
      unsubscribeDeletedEpicNotifications();
      for (const unsubscribe of perHandleUnsub.values()) unsubscribe();
      perHandleUnsub.clear();
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
    isUnavailableEpicReason(state.snapshotFetchError.message)
  ) {
    // The host could not return a live room on (re)open. This surfaces a
    // delete OR a revoke indistinguishably, so the cause is left neutral.
    return { kind: "unavailable" };
  }
  return null;
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
