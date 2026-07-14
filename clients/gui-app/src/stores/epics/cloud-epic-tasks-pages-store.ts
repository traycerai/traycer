import { create } from "zustand";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";

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
 * Each identity also carries a monotonic generation. `resetIdentity` (called on
 * refresh/refetch) bumps it; `appendPage` ignores any page tagged with an older
 * generation. That guards the cursor race where a "Show more" fetch resolves
 * *after* a refresh reset the list - without it, the in-flight response would
 * re-create `pagesByIdentity[identity]` with stale rows on top of the refreshed
 * first page. The next-page fetch (a TanStack `useHostMutation`) captures the
 * generation when it starts and hands it back here on success.
 *
 * `registerIdentity` must run before that first fetch is dispatched, even
 * though no page or reset has touched the identity yet. Without an explicit
 * `generationByIdentity` entry, `resetCloudEpicTasksPagesForScope` only
 * iterates identities already present in `pagesByIdentity` /
 * `generationByIdentity` - a pin/unpin reset that lands while the *first*
 * "Show more" request for an identity is still in flight would find no entry
 * to bump, so the stale response's captured generation `0` would still equal
 * the (never-advanced) current generation `0` and get accepted.
 */
interface CloudEpicTasksPagesStoreState {
  readonly pagesByIdentity: Readonly<
    Record<string, readonly ListTasksResponse[]>
  >;
  readonly generationByIdentity: Readonly<Record<string, number>>;
  readonly registerIdentity: (identity: string) => void;
  readonly appendPage: (
    identity: string,
    generation: number,
    page: ListTasksResponse,
  ) => void;
  readonly resetIdentity: (identity: string) => void;
}

export const useCloudEpicTasksPagesStore =
  create<CloudEpicTasksPagesStoreState>()((set) => ({
    pagesByIdentity: {},
    generationByIdentity: {},
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
        const current = state.pagesByIdentity[identity] ?? [];
        return {
          pagesByIdentity: {
            ...state.pagesByIdentity,
            [identity]: [...current, page],
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
 * Drops every accumulated pagination tail for one host/user. A personal pin can
 * move an item across page boundaries, so retaining any old tail risks a
 * duplicate row after the first page refetches in pinned-first order.
 */
export function resetCloudEpicTasksPagesForScope(
  hostId: string,
  userId: string,
): void {
  const state = useCloudEpicTasksPagesStore.getState();
  const prefix = `${hostId}|${userId}|`;
  const identities = new Set([
    ...Object.keys(state.pagesByIdentity),
    ...Object.keys(state.generationByIdentity),
  ]);
  identities.forEach((identity) => {
    if (identity.startsWith(prefix)) state.resetIdentity(identity);
  });
}
