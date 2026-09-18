/**
 * The three write-throughs a LIVE epic session owns: what the session knows
 * that lives somewhere a session is not read from.
 *
 *  - the TAB NAME: the canvas store's tab record mirrors the session's title,
 *    so a restored or released tab still reads its name;
 *  - the HISTORY / task-context TITLE: `epic.listTasks` is manual-refresh
 *    only, so the open epic's stream is the only live source of a generated
 *    title for those caches;
 *  - the HOME marker: the same caches' `home`, for the same reason.
 *
 * All three used to be React effects - one in the mounted epic route, two in
 * `EpicSessionProvider` - so they ran only while something was on screen. A
 * session now exists without a surface (the tab-owned controller), and a
 * title that lands on a never-activated tab has to reach the tab record and
 * History just the same. They are attached per live handle by the controller
 * (`lib/registries/epic-session-controller.ts`), which owns WHEN; this module
 * owns WHAT, and nothing else writes a tab name from a session.
 *
 * Every write re-checks two things first.
 *
 * `isCurrent`: the subscriptions are torn down on every path that drops the
 * handle, but a store or Query-cache notification already in flight when that
 * happens must not write into the next identity's caches, and detaching
 * cannot recall it.
 *
 * {@link isEpicSessionLive}: a session is an AUTHORITY only while it is live.
 * The mounted effects got that for free - a mounted session is one the user
 * is looking at on a connected host - and a warm one does not: it can sit
 * unmounted on a host that went away, holding a title the user has since
 * changed from History (`useEpicUpdateTitle` patches the caches on RPC
 * success and never touches this store). Re-applying its title then REVERTS
 * the rename, on every host's caches, on every fetch. So while the session is
 * not live the subscriptions stay attached and write nothing; the liveness
 * facts live in the same store, so the transition back to live is itself a
 * store notification and the store halves flush whatever changed meanwhile.
 */
import type { QueryCacheNotifyEvent, QueryClient } from "@tanstack/react-query";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { isRealEpicTitle } from "@/lib/display-title";
import {
  cloudEpicTasksQueryKeyMatchesScope,
  epicTaskContextsQueryKeyMatchesScope,
  setEpicLocalHomeInCloudTaskCaches,
  updateEpicTitleInCloudTaskCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import { setCloudEpicTasksPageLocalHomeForUser } from "@/stores/epics/cloud-epic-tasks-pages-store";
import { hostQueryKeys } from "@/lib/query-keys";

export interface EpicSessionWriteThroughSpec {
  readonly epicId: string;
  readonly handle: OpenEpicStoreHandle;
  /** The epic's OPEN tab ids, read at write time so later siblings are seen. */
  readonly readTabIds: () => ReadonlyArray<string>;
  /**
   * The app's Query client, or `null` before the app has installed one. The
   * cache halves are a no-op without it; the tab name needs none.
   */
  readonly queryClient: QueryClient | null;
  /**
   * Whose caches the cache halves write: the cloud-tasks user, which is the
   * request context's id rather than the profile's. `null` writes nothing.
   */
  readonly cacheUserId: string | null;
  /** Whether this attachment is still the one its owner wants writing. */
  readonly isCurrent: () => boolean;
}

export interface EpicSessionWriteThroughs {
  /**
   * Run every writer against the session's CURRENT state, synchronously.
   *
   * The writers are store subscribers, and so is whoever is about to let the
   * session go (the controller's metadata hold). Subscriber order decides who
   * sees a title first, and the one that releases demand can evict the
   * session - detaching these - before they have run. The owner calls this
   * before releasing, so no ordering can lose a write.
   */
  flush(): void;
  /**
   * Re-apply the session's current title to the epic's tab records. Called
   * when membership changes: a duplicated tab, or one opened in this window
   * for an epic already live here, is seeded from the session at once rather
   * than on the next title change (which may never come).
   */
  refreshTabNames(): void;
  detach(): void;
}

/**
 * The title the session shows: the document's own, else the workspace-context
 * light's. Both are sources of a generated title (the records lane row and
 * `epic.getWorkspaceContext`), so both are observed; the light is also where
 * the host's "Untitled" placeholder arrives, which is why every reader here
 * goes through {@link isRealEpicTitle}.
 */
export function readEpicSessionTitle(handle: OpenEpicStoreHandle): string {
  const state = handle.store.getState();
  const title =
    state.epic.title.length > 0
      ? state.epic.title
      : (state.snapshotMeta?.epicLight?.title ?? "");
  return title.trim();
}

/**
 * Whether the session may speak for the epic right now: its snapshot has
 * loaded AND its host transport is open.
 *
 * The RAW renderer-host transport, not the blended `connectionStatus`: that
 * one also reads "reconnecting" while the host's cloud link is down, which is
 * the steady state of a local-homed epic on an offline machine, and its
 * document is still the freshest copy there is. Residual, accepted: a
 * reachable host whose cloud link is down is still treated as an authority,
 * which is the same lag a mounted, connected session already has.
 */
export function isEpicSessionLive(handle: OpenEpicStoreHandle): boolean {
  const state = handle.store.getState();
  return state.snapshotLoaded && state.hostTransportStatus === "open";
}

function normalizeGeneratedTitle(title: string): string | null {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * MIRRORS the session title onto every open tab record of the epic.
 *
 * The record is a mirror, not a second source: a user renames an EPIC (the
 * strip's inline rename enqueues `update-epic-title` on the session), never a
 * tab record, so the session's title already IS the user's name and writing it
 * through cannot lose one. The mounted effect this replaces overwrote
 * unconditionally for that reason, and so does this.
 *
 * One narrowing: an absent title is never written. The mounted effect skipped
 * only the empty string; this also skips the placeholders
 * (`isRealEpicTitle`), because the controller's demand rule reads the record -
 * "this tab still has no real name" - and a host-synthesized "Untitled"
 * written over an empty record would be this module inventing a name.
 */
interface AttachedWriter {
  readonly flush: () => void;
  readonly detach: () => void;
}

function mayWrite(spec: EpicSessionWriteThroughSpec): boolean {
  return spec.isCurrent() && isEpicSessionLive(spec.handle);
}

function attachTabNameSync(spec: EpicSessionWriteThroughSpec): AttachedWriter {
  const refresh = (): void => {
    if (!mayWrite(spec)) return;
    const title = readEpicSessionTitle(spec.handle);
    if (!isRealEpicTitle(title)) return;
    const canvas = useEpicCanvasStore.getState();
    for (const tabId of spec.readTabIds()) {
      // `renameTab` is idempotent, but it is also a store write on a store
      // this runs inside a notification of; skip the no-op explicitly.
      if (canvas.tabsById[tabId]?.name === title) continue;
      canvas.renameTab(tabId, title);
    }
  };
  refresh();
  return { flush: refresh, detach: spec.handle.store.subscribe(refresh) };
}

/**
 * Patches the History and task-context caches with a generated title.
 *
 * BOTH halves are load-bearing. The store subscription relays a title change;
 * the Query-cache subscription re-applies the current title when a late
 * `epic.listTasks` / task-contexts result lands, which would otherwise put
 * the pre-generation title back over the patch.
 *
 * Any host's caches for this user (`hostId: null`), for the reason given at
 * {@link attachHomeCacheSync}: the title is the epic's, and the History list
 * showing it can be served by a host other than the session's.
 */
function attachTitleCacheSync(
  spec: EpicSessionWriteThroughSpec,
  queryClient: QueryClient,
  userId: string,
): AttachedWriter {
  const { epicId, handle } = spec;
  const scope = { hostId: null, userId };
  let lastObservedTitle: string | null = null;
  const currentTitle = (): string | null =>
    normalizeGeneratedTitle(handle.store.getState().epic.title);
  const writeThroughTitle = (title: string): void => {
    updateEpicTitleInCloudTaskCaches(queryClient, scope, epicId, title);
  };
  const syncChangedTitle = (): void => {
    // Gated BEFORE `lastObservedTitle` moves: a title seen while the gate was
    // closed is still unwritten, and the reopening flush has to find it new.
    if (!mayWrite(spec)) return;
    const title = currentTitle();
    if (title === null || title === lastObservedTitle) return;
    lastObservedTitle = title;
    writeThroughTitle(title);
  };
  const syncMatchingQueryUpdate = (event: QueryCacheNotifyEvent): void => {
    if (event.type !== "updated") return;
    // The half that can REVERT: it re-applies over any differing result, so
    // it must never run for a session that is not the fresh party.
    if (!mayWrite(spec)) return;
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
  return {
    flush: syncChangedTitle,
    detach: () => {
      unsubscribeStore();
      unsubscribeQueries();
    },
  };
}

/**
 * Keeps the History list's `home` marker in step with the OPEN epic's own
 * durability - `s4-promotion-task-list-invalidation`, folded into
 * `s5-status-truthfulness`.
 *
 * Sibling of {@link attachTitleCacheSync}, and here for the same reason:
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
function attachHomeCacheSync(
  spec: EpicSessionWriteThroughSpec,
  queryClient: QueryClient,
  userId: string,
): AttachedWriter {
  const { epicId, handle } = spec;
  let lastSyncedLocalHome: boolean | null = null;
  const syncHome = (): void => {
    if (!mayWrite(spec)) return;
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
  return { flush: syncHome, detach: handle.store.subscribe(syncHome) };
}

export function attachEpicSessionWriteThroughs(
  spec: EpicSessionWriteThroughSpec,
): EpicSessionWriteThroughs {
  const tabNames = attachTabNameSync(spec);
  const writers: AttachedWriter[] = [tabNames];
  const { cacheUserId, queryClient } = spec;
  if (queryClient !== null && cacheUserId !== null) {
    writers.push(attachTitleCacheSync(spec, queryClient, cacheUserId));
    writers.push(attachHomeCacheSync(spec, queryClient, cacheUserId));
  }
  let detached = false;
  return {
    flush: () => {
      if (detached) return;
      for (const writer of writers) writer.flush();
    },
    refreshTabNames: () => {
      if (!detached) tabNames.flush();
    },
    detach: () => {
      if (detached) return;
      detached = true;
      for (const writer of writers) writer.detach();
    },
  };
}
