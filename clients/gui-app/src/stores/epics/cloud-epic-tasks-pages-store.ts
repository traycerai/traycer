import { create } from "zustand";
import { hashKey } from "@tanstack/react-query";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type { ListCloudTasksRequest } from "@/lib/cloud-epic-tasks-query/query";
import { queryKeys } from "@/lib/query-keys";
import {
  removeDeletedEpicsFromCloudTasksResponse,
  setEpicLocalHomeInCloudTasksResponse,
  setEpicPinnedInCloudTasksResponse,
} from "@/lib/cloud-epic-tasks-query/response-patches";

/**
 * Accumulated "Show more" pages for the cloud epic-tasks list, keyed by the
 * query identity (`host | user | request scope`).
 *
 * The first page lives in the TanStack Query cache, but the cursor-paginated
 * extra pages are accumulated here rather than in `useCloudEpicTasksQuery`'s
 * component state. Holding them in component state meant they were discarded the
 * moment the host surface unmounted - closing the History overlay collapsed the
 * list back to the first page on every reopen. Owning them in this module-level
 * store lets the loaded pages survive unmount/remount for the whole app session.
 *
 * Keyed by identity so distinct surfaces/filters don't clobber each other, and
 * so reopening with the same scope restores exactly the pages that were loaded.
 * In-memory only: a full reload starts a fresh list (cursors and page snapshots
 * are not worth persisting across reloads); search/filter/sort persistence is
 * owned separately by `useHistorySearchStore`.
 *
 * Each identity also carries a monotonic generation. `resetIdentity` advances
 * it whenever retained cursor pages are invalidated: a first-page dispatch,
 * successful delete, pin/reorder, last-viewed update, host-store rebind, or
 * explicit refresh. `appendPage` ignores any page tagged with an older
 * generation. That guards the cursor race where a "Show more" fetch resolves
 * after any reset - without it, the in-flight response would re-create
 * `pagesByIdentity[identity]` with stale rows on top of the current first page.
 * The next-page fetch (a principal-bound TanStack mutation) captures the
 * generation when it starts and hands it back here on success.
 *
 * `registerIdentity` must run before that first fetch is dispatched, even
 * though no page or reset has touched the identity yet. Without an explicit
 * `generationByIdentity` entry, `resetCloudEpicTasksPagesForScope` only
 * iterates identities already present in `pagesByIdentity` /
 * `generationByIdentity` - a scope reset that lands while the *first*
 * "Show more" request for an identity is still in flight would find no entry
 * to bump, so the stale response's captured generation `0` would still equal
 * the (never-advanced) current generation `0` and get accepted.
 *
 * This cursor generation deliberately differs from the QueryClient-owned
 * local-first revalidation episode. The episode controls exactly one
 * asynchronous replacement of the first page; this generation controls every
 * retained cursor snapshot, including deletes and tail-only invalidations that
 * need not cancel a valid first-page revalidation. Both are advanced by a
 * first-page dispatch, their one shared reset boundary.
 */
interface CloudEpicTasksPagesStoreState {
  readonly pagesByIdentity: Readonly<
    Record<string, readonly ListTasksResponse[]>
  >;
  readonly generationByIdentity: Readonly<Record<string, number>>;
  /**
   * Session-scoped delete facts keyed by host/user scope. They are retained
   * after a list reset because a cursor started after the delete may still be
   * served from a cloud page that predates it.
   */
  readonly deletedEpicIdsByScope: Readonly<Record<string, readonly string[]>>;
  readonly registerIdentity: (identity: string) => void;
  readonly appendPage: (
    identity: string,
    generation: number,
    page: ListTasksResponse,
  ) => void;
  readonly resetIdentity: (identity: string) => void;
  readonly recordDeletedEpicIdsForScope: (
    hostId: string | null,
    userId: string,
    epicIds: ReadonlyArray<string>,
  ) => void;
  readonly setTaskPinned: (
    identityPrefix: string,
    epicId: string,
    pinned: boolean,
  ) => void;
  readonly setTaskLocalHome: (
    identityPrefix: string,
    epicId: string,
    localHome: boolean,
  ) => void;
  /**
   * `setTaskLocalHome` over every identity the user holds, whichever host
   * served it. Where an epic is durable is a property of the EPIC, and the
   * History list can be served by a host other than the one the open epic's
   * session lives on.
   */
  readonly setTaskLocalHomeForUser: (
    userId: string,
    epicId: string,
    localHome: boolean,
  ) => void;
}

export const useCloudEpicTasksPagesStore =
  create<CloudEpicTasksPagesStoreState>()((set) => ({
    pagesByIdentity: {},
    generationByIdentity: {},
    deletedEpicIdsByScope: {},
    registerIdentity: (identity) => {
      set((state) => {
        if (identity in state.generationByIdentity) return state;
        return {
          generationByIdentity: {
            ...state.generationByIdentity,
            [identity]: 0,
          },
        };
      });
    },
    appendPage: (identity, generation, page) => {
      set((state) => {
        // A response tagged with a superseded generation belongs to a list
        // that was reset (e.g. by a refresh) after the fetch started - drop it
        // so late results can't revive a cleared identity.
        if (generation !== currentGeneration(state, identity)) return state;
        const pageWithoutDeletedEpics =
          removeDeletedEpicsFromCloudTasksResponse(
            page,
            deletedEpicIdsForIdentity(state, identity),
            userIdFromIdentity(identity),
          );
        const current = state.pagesByIdentity[identity] ?? [];
        return {
          pagesByIdentity: {
            ...state.pagesByIdentity,
            [identity]: [...current, pageWithoutDeletedEpics],
          },
        };
      });
    },
    resetIdentity: (identity) => {
      set((state) => {
        const generationByIdentity = {
          ...state.generationByIdentity,
          [identity]: currentGeneration(state, identity) + 1,
        };
        if (!(identity in state.pagesByIdentity)) {
          return { generationByIdentity };
        }
        const pagesByIdentity = { ...state.pagesByIdentity };
        delete pagesByIdentity[identity];
        return { pagesByIdentity, generationByIdentity };
      });
    },
    recordDeletedEpicIdsForScope: (hostId, userId, epicIds) => {
      set((state) => {
        const scope = deletedEpicIdsScopeIdentity(hostId, userId);
        const current = state.deletedEpicIdsByScope[scope] ?? [];
        const next = new Set(current);
        for (const epicId of epicIds) next.add(epicId);
        if (next.size === current.length) return state;
        return {
          deletedEpicIdsByScope: {
            ...state.deletedEpicIdsByScope,
            [scope]: [...next],
          },
        };
      });
    },
    setTaskPinned: (identityPrefix, epicId, pinned) => {
      set((state) => {
        // In-place optimistic pin patch across every retained tail in the
        // scope. Identity-preserving on both levels (page and identity
        // bucket) so untouched scopes never re-render, and deliberately
        // generation-neutral: the patch only updates what is displayed. The
        // pin mutation's success handler resets the scope's pagination
        // afterwards - a pin reorders rows across server page boundaries,
        // so every retained cursor goes stale on commit.
        const entries = Object.entries(state.pagesByIdentity).map(
          ([identity, pages]): [string, readonly ListTasksResponse[]] => {
            if (!identity.startsWith(identityPrefix)) {
              return [identity, pages];
            }
            const nextPages = pages.map((page) =>
              setEpicPinnedInCloudTasksResponse(page, epicId, pinned),
            );
            const identityChanged = nextPages.some(
              (page, index) => page !== pages[index],
            );
            return [identity, identityChanged ? nextPages : pages];
          },
        );
        const scopeChanged = entries.some(
          ([identity, pages]) => pages !== state.pagesByIdentity[identity],
        );
        return scopeChanged
          ? { pagesByIdentity: Object.fromEntries(entries) }
          : state;
      });
    },
    setTaskLocalHome: (identityPrefix, epicId, localHome) => {
      // The home-marker twin of `setTaskPinned`, added because promotion
      // completing patched only the TanStack first page: a row loaded
      // through "Show more" lives here, kept `home: "local"`, and its
      // cloud-only actions (pin) stayed disabled until a reset or refresh.
      // Same identity-preserving, generation-neutral contract as the pin
      // patch.
      set((state) =>
        patchLocalHomeAcrossIdentities(
          state,
          (identity) => identity.startsWith(identityPrefix),
          epicId,
          localHome,
        ),
      );
    },
    setTaskLocalHomeForUser: (userId, epicId, localHome) => {
      set((state) =>
        patchLocalHomeAcrossIdentities(
          state,
          (identity) => userIdFromIdentity(identity) === userId,
          epicId,
          localHome,
        ),
      );
    },
  }));

function currentGeneration(
  state: Pick<CloudEpicTasksPagesStoreState, "generationByIdentity">,
  identity: string,
): number {
  return state.generationByIdentity[identity] ?? 0;
}

/**
 * Current generation for an identity, read imperatively so the next-page fetch
 * can tag its request and `appendPage` can reject responses from before the
 * latest reset.
 */
export function cloudEpicTasksPageGeneration(identity: string): number {
  return currentGeneration(useCloudEpicTasksPagesStore.getState(), identity);
}

/** Canonical identity shared by first-page dispatch and cursor-page storage. */
export function cloudEpicTasksPageIdentity(
  hostId: string,
  userId: string,
  request: ListCloudTasksRequest,
): string {
  // TanStack identifies the first-page query by canonicalizing object-key
  // order with `hashKey`. Cursor tails must name that same semantic request:
  // a raw JSON serialization makes two equivalent filters one first page but
  // two retained-tail buckets, so a first-page reset can miss an old tail.
  return `${cloudEpicTasksPageIdentityPrefix(hostId, userId)}${hashKey(
    queryKeys.cloudEpicTasks(hostId, userId, request),
  )}`;
}

/**
 * The `<host>|<user>|` prefix every identity in a scope shares, with each
 * segment ENCODED so a `|` inside a host or user id cannot be read as the
 * boundary by the scope parsers below. Spelled once, because a prefix built
 * by hand at a call site is what let an unencoded `a|b` host pass a scope
 * reset and a delete-tombstone lookup under host `a`, user `b`.
 */
export function cloudEpicTasksPageIdentityPrefix(
  hostId: string,
  userId: string,
): string {
  return `${encodeIdentitySegment(hostId)}|${encodeIdentitySegment(userId)}|`;
}

function encodeIdentitySegment(segment: string): string {
  return encodeURIComponent(segment);
}

function decodeIdentitySegment(segment: string): string {
  return decodeURIComponent(segment);
}

/**
 * A first-page dispatch supersedes every retained cursor for its exact query.
 * Keeping this next to the generation store makes raw TanStack `refetch` as
 * safe as the History callback that used to remember this reset itself.
 */
export function resetCloudEpicTasksPageIdentity(identity: string): void {
  useCloudEpicTasksPagesStore.getState().resetIdentity(identity);
}

/**
 * Registers an identity's generation entry imperatively, before the fetch
 * that will read it via `cloudEpicTasksPageGeneration` is dispatched. Must be
 * called first so a scope reset landing during that very first in-flight
 * request has an entry to advance - see the store-level doc comment.
 */
export function registerCloudEpicTasksPageIdentity(identity: string): void {
  useCloudEpicTasksPagesStore.getState().registerIdentity(identity);
}

/**
 * Drops every accumulated pagination tail for one host/user and advances
 * their generations so in-flight tails are rejected on arrival. The pin
 * mutation patches rows in place at mutate time (`setCloudEpicTasksPagePinned`)
 * and calls this on success: the committed reorder crosses server page
 * boundaries, so every retained cursor is stale and a later "Show more"
 * against one could silently skip rows.
 */
export function resetCloudEpicTasksPagesForScope(
  hostId: string | null,
  userId: string,
): void {
  const state = useCloudEpicTasksPagesStore.getState();
  const identities = new Set([
    ...Object.keys(state.pagesByIdentity),
    ...Object.keys(state.generationByIdentity),
  ]);
  identities.forEach((identity) => {
    if (cloudEpicTasksPageIdentityMatchesScope(identity, hostId, userId)) {
      state.resetIdentity(identity);
    }
  });
}

/**
 * The only retained-tail delete boundary. It first retains the delete fact for
 * future cursor admissions, then clears matching pages and advances each
 * generation for cursor requests already in flight.
 */
export function invalidateCloudEpicTasksPagesForDeletedEpics(
  hostId: string | null,
  userId: string,
  epicIds: ReadonlyArray<string>,
): void {
  useCloudEpicTasksPagesStore
    .getState()
    .recordDeletedEpicIdsForScope(hostId, userId, epicIds);
  resetCloudEpicTasksPagesForScope(hostId, userId);
}

/**
 * Returns every delete fact which reaches this host/user page: a broadcast
 * delete applies to every host for the user, while a host-local delete only
 * applies to that host. The list-specific admission layer uses it for each
 * incoming History first page and last-known fallback write; `appendPage`
 * uses the same facts for cursor tails. Generic host RPC remains outside this
 * module's list-specific delivery contract.
 */
export function deletedCloudEpicTasksPageEpicIdsForScope(
  hostId: string | null,
  userId: string,
): ReadonlySet<string> {
  return deletedEpicIdsForScope(
    useCloudEpicTasksPagesStore.getState(),
    hostId,
    userId,
  );
}

/**
 * Drops every accumulated pagination tail for one HOST, every user. A local
 * store rebind republishes the host's durability store wholesale, so a tail
 * answered by the abandoned store is stale for whoever loaded it - its rows,
 * home markers and cursors all name the old store's world.
 */
export function resetCloudEpicTasksPagesForHost(hostId: string): void {
  const state = useCloudEpicTasksPagesStore.getState();
  const prefix = `${encodeIdentitySegment(hostId)}|`;
  const identities = new Set([
    ...Object.keys(state.pagesByIdentity),
    ...Object.keys(state.generationByIdentity),
  ]);
  identities.forEach((identity) => {
    if (identity.startsWith(prefix)) state.resetIdentity(identity);
  });
}

/**
 * Drops only last-viewed pagination tails for one host/user. Recording a view
 * can move rows across page boundaries for that ordering, but leaves cursors
 * for every other sort valid.
 */
export function resetLastViewedCloudEpicTasksPagesForScope(
  hostId: string,
  userId: string,
): void {
  const state = useCloudEpicTasksPagesStore.getState();
  const prefix = cloudEpicTasksPageIdentityPrefix(hostId, userId);
  const identities = new Set([
    ...Object.keys(state.pagesByIdentity),
    ...Object.keys(state.generationByIdentity),
  ]);
  identities.forEach((identity) => {
    if (
      identity.startsWith(prefix) &&
      identity.includes('"sort":"last-viewed"')
    ) {
      state.resetIdentity(identity);
    }
  });
}

function cloudEpicTasksPageIdentityMatchesScope(
  identity: string,
  hostId: string | null,
  userId: string,
): boolean {
  const firstSeparator = identity.indexOf("|");
  if (firstSeparator < 0) return false;
  const secondSeparator = identity.indexOf("|", firstSeparator + 1);
  if (secondSeparator < 0) return false;
  // Compared ENCODED, the way the identity was written.
  return (
    identity.slice(firstSeparator + 1, secondSeparator) ===
      encodeIdentitySegment(userId) &&
    (hostId === null ||
      identity.slice(0, firstSeparator) === encodeIdentitySegment(hostId))
  );
}

function deletedEpicIdsForIdentity(
  state: Pick<CloudEpicTasksPagesStoreState, "deletedEpicIdsByScope">,
  identity: string,
): ReadonlySet<string> {
  const firstSeparator = identity.indexOf("|");
  const secondSeparator = identity.indexOf("|", firstSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0) return new Set<string>();
  const hostId = decodeIdentitySegment(identity.slice(0, firstSeparator));
  const userId = decodeIdentitySegment(
    identity.slice(firstSeparator + 1, secondSeparator),
  );
  return deletedEpicIdsForScope(state, hostId, userId);
}

function deletedEpicIdsForScope(
  state: Pick<CloudEpicTasksPagesStoreState, "deletedEpicIdsByScope">,
  hostId: string | null,
  userId: string,
): ReadonlySet<string> {
  return new Set([
    ...(state.deletedEpicIdsByScope[
      deletedEpicIdsScopeIdentity(null, userId)
    ] ?? []),
    ...(hostId === null
      ? []
      : (state.deletedEpicIdsByScope[
          deletedEpicIdsScopeIdentity(hostId, userId)
        ] ?? [])),
  ]);
}

function deletedEpicIdsScopeIdentity(
  hostId: string | null,
  userId: string,
): string {
  return JSON.stringify([hostId, userId]);
}

/**
 * The identity-preserving local-home patch over every retained page of every
 * identity `matches` selects. Returns the same state object when nothing
 * changed, so a no-op patch is not a store notification.
 */
function patchLocalHomeAcrossIdentities(
  state: CloudEpicTasksPagesStoreState,
  matches: (identity: string) => boolean,
  epicId: string,
  localHome: boolean,
):
  | CloudEpicTasksPagesStoreState
  | Pick<CloudEpicTasksPagesStoreState, "pagesByIdentity"> {
  const entries = Object.entries(state.pagesByIdentity).map(
    ([identity, pages]): [string, readonly ListTasksResponse[]] => {
      if (!matches(identity)) return [identity, pages];
      const nextPages = pages.map((page) =>
        setEpicLocalHomeInCloudTasksResponse(page, epicId, localHome),
      );
      const identityChanged = nextPages.some(
        (page, index) => page !== pages[index],
      );
      return [identity, identityChanged ? nextPages : pages];
    },
  );
  const scopeChanged = entries.some(
    ([identity, pages]) => pages !== state.pagesByIdentity[identity],
  );
  return scopeChanged
    ? { pagesByIdentity: Object.fromEntries(entries) }
    : state;
}

function userIdFromIdentity(identity: string): string {
  const firstSeparator = identity.indexOf("|");
  const secondSeparator = identity.indexOf("|", firstSeparator + 1);
  return secondSeparator < 0
    ? ""
    : decodeIdentitySegment(
        identity.slice(firstSeparator + 1, secondSeparator),
      );
}

/**
 * Flips one epic's `pinned` bit inside every retained "Show more" tail for
 * one host/user - the pages-store half of the optimistic pin patch (the
 * cached first page lives in TanStack Query and is patched by
 * `setEpicPinnedInCloudTaskCaches`).
 */
export function setCloudEpicTasksPagePinned(
  hostId: string,
  userId: string,
  epicId: string,
  pinned: boolean,
): void {
  useCloudEpicTasksPagesStore
    .getState()
    .setTaskPinned(
      cloudEpicTasksPageIdentityPrefix(hostId, userId),
      epicId,
      pinned,
    );
}

/**
 * Flips one epic's `home` marker inside every retained "Show more" tail for
 * one host/user - the pages-store half of the promotion home patch (the
 * cached first page lives in TanStack Query and is patched by
 * `setEpicLocalHomeInCloudTaskCaches`).
 */
export function setCloudEpicTasksPageLocalHome(
  hostId: string,
  userId: string,
  epicId: string,
  localHome: boolean,
): void {
  useCloudEpicTasksPagesStore
    .getState()
    .setTaskLocalHome(
      cloudEpicTasksPageIdentityPrefix(hostId, userId),
      epicId,
      localHome,
    );
}

/**
 * The home patch for every host's retained tails the user holds. The open
 * epic's session reports the fact, and it lives on ONE host, while the
 * History list showing the row may be served by another - the app-wide
 * (effective) host, in a tab pinned elsewhere. Scoping the patch to the
 * session's host left the other host's rows `home: "local"`.
 */
export function setCloudEpicTasksPageLocalHomeForUser(
  userId: string,
  epicId: string,
  localHome: boolean,
): void {
  useCloudEpicTasksPagesStore
    .getState()
    .setTaskLocalHomeForUser(userId, epicId, localHome);
}
