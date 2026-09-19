import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  QueryClientContext,
  type QueryCacheNotifyEvent,
  type QueryClient,
} from "@tanstack/react-query";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  cloudEpicTasksQueryKeyMatchesScope,
  epicTaskContextsQueryKeyMatchesScope,
  setEpicLocalHomeInCloudTaskCaches,
  updateEpicTitleInCloudTaskCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import { setCloudEpicTasksPageLocalHomeForUser } from "@/stores/epics/cloud-epic-tasks-pages-store";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
  EpicSessionPresentationContext,
} from "@/lib/registries/epic-session-registry";
import {
  getEpicSessionController,
  type EpicSessionTabSnapshot,
} from "@/lib/registries/epic-session-controller";
// For its side effect: the open-tab projection that gives the controller its
// membership. Imported here as well as by the tab host so that wherever a
// provider can mount, the tab it mounts for is already a member.
import "@/lib/epics/epic-parking-open-tabs";
import { useImportedUnseenStore } from "@/stores/session-import/imported-unseen-store";

interface EpicSessionProviderProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}

/**
 * The React OBSERVER of one tab's epic session.
 *
 * The session is owned by the tab, not by this component: the controller
 * (`lib/registries/epic-session-controller.ts`) acquires it because the tab is
 * open, claims this tab's desktop ownership, selects the host, re-points,
 * backs off, parks and releases. This provider does three things only:
 *
 *  - reads the controller's per-tab snapshot into the three session contexts;
 *  - tells the controller a SURFACE is showing this tab, which is what holds
 *    the session's residency while a pane can see it;
 *  - forwards the two user commands, Retry and "open on original host".
 *
 * It never acquires, re-points or releases. Mounting it for a tab that is not
 * open yields no session: membership is the tab store's fact, not this
 * component's.
 */
export function EpicSessionProvider(
  props: EpicSessionProviderProps,
): ReactNode {
  const { epicId, tabId, children } = props;
  const controller = getEpicSessionController();

  // Opening the task is what retires its imported-unseen dot, and every open
  // path - list click, palette, deep link - mounts this provider.
  useEffect(() => {
    useImportedUnseenStore.getState().markSeen(epicId);
  }, [epicId]);

  const queryClient = use(QueryClientContext);
  const navigate = useNavigate();
  const cloudTasksUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );

  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const readSnapshot = useCallback(
    (): EpicSessionTabSnapshot => controller.readTabSnapshot(epicId, tabId),
    [controller, epicId, tabId],
  );
  const snapshot = useSyncExternalStore(subscribe, readSnapshot);

  // A pane is showing this tab. Residency, not intent: detaching leaves the
  // session warm for the cap and parking to decide, as unmounting always did.
  useEffect(
    () => controller.attachSurface(epicId, tabId),
    [controller, epicId, tabId],
  );

  // Another window owns this TAB, so the controller has discarded it here.
  // Leaving the route is the one part of that only a mounted surface can do.
  useEffect(
    () =>
      controller.subscribeOwnershipDenied((deniedEpicId, deniedTabId) => {
        if (deniedEpicId !== epicId || deniedTabId !== tabId) return;
        void navigate({ to: "/epics", replace: true });
      }),
    [controller, epicId, navigate, tabId],
  );

  const retry = useCallback(() => {
    controller.retry(epicId);
  }, [controller, epicId]);
  const openOnOriginalHost = useCallback(() => {
    controller.openOnOriginalHost(epicId);
  }, [controller, epicId]);
  const { handle, presentation, sessionHostClient, sessionHostId } = snapshot;
  const sessionPresentation = useMemo(
    () => ({
      ...presentation,
      retry,
      openOnOriginalHost,
    }),
    [openOnOriginalHost, presentation, retry],
  );
  useCloudTaskTitleCacheSync({
    activeHostId: sessionHostId,
    epicId,
    handle,
    queryClient,
    userId: cloudTasksUserId,
  });
  useEpicHomeCacheSync({
    activeHostId: sessionHostId,
    epicId,
    handle,
    queryClient,
    userId: cloudTasksUserId,
  });

  return (
    <EpicSessionContext.Provider value={handle}>
      <EpicSessionPresentationContext.Provider value={sessionPresentation}>
        <EpicSessionHostClientContext.Provider value={sessionHostClient}>
          {children}
        </EpicSessionHostClientContext.Provider>
      </EpicSessionPresentationContext.Provider>
    </EpicSessionContext.Provider>
  );
}

interface EpicSessionCacheSyncArgs {
  /**
   * The session's host, and `null` before a session exists - the liveness
   * gate for these syncs, NOT the scope of their cache writes, which reach
   * every host's caches for the user (see `useEpicHomeCacheSync`).
   */
  readonly activeHostId: string | null;
  readonly epicId: string;
  readonly handle: OpenEpicStoreHandle | null;
  readonly queryClient: QueryClient | undefined;
  readonly userId: string | null;
}

function useCloudTaskTitleCacheSync(args: EpicSessionCacheSyncArgs): void {
  const { activeHostId, epicId, handle, queryClient, userId } = args;
  useEffect(() => {
    if (activeHostId === null) return;
    if (handle === null) return;
    if (queryClient === undefined) return;
    if (userId === null) return;

    // Any host's caches for this user (`hostId: null`), for the reason given
    // at `useEpicHomeCacheSync`: the title is the epic's, and the History
    // list showing it can be served by a host other than the session's.
    const scope = { hostId: null, userId };
    let lastObservedTitle: string | null = null;
    const currentTitle = (): string | null =>
      normalizeGeneratedTitle(handle.store.getState().epic.title);
    const writeThroughTitle = (title: string): void => {
      updateEpicTitleInCloudTaskCaches(queryClient, scope, epicId, title);
    };
    const syncChangedTitle = (): void => {
      const title = normalizeGeneratedTitle(handle.store.getState().epic.title);
      if (title === null || title === lastObservedTitle) return;
      lastObservedTitle = title;
      writeThroughTitle(title);
    };
    const syncMatchingQueryUpdate = (event: QueryCacheNotifyEvent): void => {
      if (event.type !== "updated") return;
      const queryKey: unknown = event.query.queryKey;
      if (!Array.isArray(queryKey)) return;
      if (
        !cloudEpicTasksQueryKeyMatchesScope(queryKey, scope) &&
        !epicTaskContextsQueryKeyMatchesScope(queryKey, scope)
      ) {
        return;
      }
      const title = currentTitle();
      if (title !== null) writeThroughTitle(title);
    };

    syncChangedTitle();
    const unsubscribeStore = handle.store.subscribe(syncChangedTitle);
    const unsubscribeQueries = queryClient
      .getQueryCache()
      .subscribe(syncMatchingQueryUpdate);
    return () => {
      unsubscribeStore();
      unsubscribeQueries();
    };
  }, [activeHostId, epicId, handle, queryClient, userId]);
}

function normalizeGeneratedTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Keeps the History list's `home` marker in step with the OPEN epic's own
 * durability - `s4-promotion-task-list-invalidation`, folded into
 * `s5-status-truthfulness`.
 *
 * Sibling of {@link useCloudTaskTitleCacheSync}, and here for the same reason:
 * `epic.listTasks` is manual-refresh-only, the open epic's stream is the only
 * live source of the fact, and a Zustand store has no query client to push it
 * from. The two writes this repairs are a local-first `epic.create` (whose
 * `TaskLight` cache patch cannot carry `home` at all) and a promotion
 * completing (which previously updated only the open-epic store).
 *
 * `getTaskContexts` is INVALIDATED rather than patched: its `localHomedTaskIds`
 * is a response-level sibling list, so there is no per-row edit to make, and
 * that query is the tab strip's only source of the marker.
 */
function useEpicHomeCacheSync(args: EpicSessionCacheSyncArgs): void {
  const { activeHostId, epicId, handle, queryClient, userId } = args;
  useEffect(() => {
    if (activeHostId === null) return;
    if (handle === null) return;
    if (queryClient === undefined) return;
    if (userId === null) return;

    let lastSyncedLocalHome: boolean | null = null;
    const syncHome = (): void => {
      const state = handle.store.getState();
      // Only a FRESH cloud-status frame for this open cycle is evidence. The
      // pre-connect default is not a statement about home, and writing it into
      // the cache would be this window inventing the very fact it is here to
      // relay.
      if (!state.hasFreshCloudSyncStatus) return;
      const status = state.durabilityStatus ?? null;
      // A fresh frame WITHOUT the datum from a peer that negotiated `@1.4`
      // or `@1.5` is the cloud answer, not silence: through `@1.5` the enum
      // has no `cloud` member, so an epic that just finished promotion
      // against such a host reports its new home by omitting the key - and
      // returning here left the History row `home: "local"` (Pin withheld)
      // until a manual refresh. A `@1.6` peer (`durabilityLegsNegotiated`)
      // says `cloud` positively; its omission means unknown and stays out.
      // Same version-aware rule as `useEpicCommentRoomAvailability`.
      const omittedByPre16Peer =
        status === null &&
        state.durabilityStatusNegotiated &&
        !state.durabilityLegsNegotiated;
      if (status === "unknown" || (status === null && !omittedByPre16Peer)) {
        return;
      }
      // `paused` says nothing about home. An unpromoted epic whose promotion
      // was blocked (entitlement, access) goes `promoting` -> `paused` and is
      // still local-homed; a cloud-homed epic paused over orphaned local
      // edits is not. Writing `false` for both patched History and the
      // last-known caches as though a cloud task existed for the first kind -
      // enabling Pin and dropping local-home treatment until a list refresh
      // corrected it. Keep whatever home the caches already hold.
      if (status === "paused") return;
      const localHome = status === "local" || status === "promoting";
      if (localHome === lastSyncedLocalHome) return;
      lastSyncedLocalHome = localHome;
      // EVERY host's caches for this user, not the session host's. Where an
      // epic is durable is a property of the epic, and the surfaces holding
      // the marker are app-wide: History and the tab strip's pin batch
      // (`useEpicTaskPinnedStates`, on `useHostClient()`) key under the
      // EFFECTIVE host, which need not be the host this Epic's session lives
      // on. Scoped to the session host, a promotion on host B left host A's
      // `home: "local"` rows and its infinite-stale `getTaskContexts` batch
      // untouched, so the tab's Pin action stayed unresolved for the life of
      // the cache.
      setEpicLocalHomeInCloudTaskCaches(
        queryClient,
        { hostId: null, userId },
        epicId,
        localHome,
      );
      // The retained "Show more" tails live in the pages store, exactly as
      // they do for the pin patch - a promoted row loaded through pagination
      // kept `home: "local"` (and its cloud-only actions disabled) until a
      // reset or refresh without this half.
      setCloudEpicTasksPageLocalHomeForUser(userId, epicId, localHome);
      void queryClient.invalidateQueries({
        predicate: (query) =>
          hostQueryKeys.matchesMethodOnAnyHost(
            query.queryKey,
            "epic.getTaskContexts",
          ),
      });
    };

    syncHome();
    return handle.store.subscribe(syncHome);
  }, [activeHostId, epicId, handle, queryClient, userId]);
}
