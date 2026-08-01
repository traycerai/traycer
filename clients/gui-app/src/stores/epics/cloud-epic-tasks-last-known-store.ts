import { create } from "zustand";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";

/**
 * Last-known settled first page of the cloud epic-tasks list, keyed by
 * `host | user` rather than the full filter request.
 *
 * `useCloudEpicTasksQuery` renders through `EpicsListPanel`, mounted once by
 * the History modal and again, independently, by a promoted History tab -
 * two separate `QueryObserver`s. TanStack's own
 * `placeholderData(previousData, previousQuery)` only carries rows across
 * remounts of the *same* observer, so a promotion during the search debounce
 * or an unsettled request left the fresh tab observer with nothing to show
 * until its request resolved. Holding the last settled page here, outside any
 * observer, lets a brand-new observer render it immediately.
 *
 * Scoped to host/user (not the exact request) to match
 * `hasSameCloudTasksPlaceholderIdentity`, which already treats any filter
 * change within the same host/user as eligible to keep showing the previous
 * rows while the new request settles.
 */
interface CloudEpicTasksLastKnownStoreState {
  readonly firstPageByScope: Readonly<Record<string, ListTasksResponse>>;
  readonly setFirstPage: (scope: string, page: ListTasksResponse) => void;
}

export const useCloudEpicTasksLastKnownStore =
  create<CloudEpicTasksLastKnownStoreState>()((set) => ({
    firstPageByScope: {},
    setFirstPage: (scope, page) => {
      set((state) => {
        if (state.firstPageByScope[scope] === page) return state;
        return {
          firstPageByScope: { ...state.firstPageByScope, [scope]: page },
        };
      });
    },
  }));

function lastKnownScope(hostId: string, userId: string): string {
  return `${hostId}|${userId}`;
}

export function readLastKnownCloudEpicTasksFirstPage(
  hostId: string,
  userId: string,
): ListTasksResponse | undefined {
  return useCloudEpicTasksLastKnownStore.getState().firstPageByScope[
    lastKnownScope(hostId, userId)
  ];
}

export function writeLastKnownCloudEpicTasksFirstPage(
  hostId: string,
  userId: string,
  page: ListTasksResponse,
): void {
  useCloudEpicTasksLastKnownStore
    .getState()
    .setFirstPage(lastKnownScope(hostId, userId), page);
}
