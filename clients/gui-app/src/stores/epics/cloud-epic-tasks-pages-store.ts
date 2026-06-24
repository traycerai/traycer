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
 */
interface CloudEpicTasksPagesStoreState {
  readonly pagesByIdentity: Readonly<
    Record<string, readonly ListTasksResponse[]>
  >;
  readonly fetchingByIdentity: Readonly<Record<string, true>>;
  readonly appendPage: (identity: string, page: ListTasksResponse) => void;
  readonly resetIdentity: (identity: string) => void;
  readonly setFetching: (identity: string, fetching: boolean) => void;
}

export const useCloudEpicTasksPagesStore =
  create<CloudEpicTasksPagesStoreState>()((set) => ({
    pagesByIdentity: {},
    fetchingByIdentity: {},
    appendPage: (identity, page) => {
      set((state) => {
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
        if (!(identity in state.pagesByIdentity)) return state;
        const next = { ...state.pagesByIdentity };
        delete next[identity];
        return { pagesByIdentity: next };
      });
    },
    setFetching: (identity, fetching) => {
      set((state) => {
        const isFetching = identity in state.fetchingByIdentity;
        if (fetching === isFetching) return state;
        if (fetching) {
          return {
            fetchingByIdentity: {
              ...state.fetchingByIdentity,
              [identity]: true,
            },
          };
        }
        const next = { ...state.fetchingByIdentity };
        delete next[identity];
        return { fetchingByIdentity: next };
      });
    },
  }));
