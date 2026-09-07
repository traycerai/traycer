import { create } from "zustand";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { setEpicPinnedInCloudTasksResponse } from "@/lib/cloud-epic-tasks-query/cache";

/**
 * Accumulated "Show more" pages for the cloud epic-tasks list, keyed by the query identity (`host
 * | user | request scope`).
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
  readonly setTaskPinned: (
    identityPrefix: string,
    epicId: string,
    pinned: boolean,
  ) => void;
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
        // A response tagged with a superseded generation belongs to a list that was reset (e.g. by a
        // refresh) after the fetch started - drop it so late results can't revive a cleared identity.
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
    setTaskPinned: (identityPrefix, epicId, pinned) => {
      set((state) => {
        // In-place optimistic pin patch across every retained tail in the scope.
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
  }));

function currentGeneration(
  state: Pick<CloudEpicTasksPagesStoreState, "generationByIdentity">,
  identity: string,
): number {
  return state.generationByIdentity[identity] ?? 0;
}

/**
 * Current generation for an identity, read imperatively so the next-page fetch can tag its request
 * and `appendPage` can reject responses from before the latest reset.
 */
export function cloudEpicTasksPageGeneration(identity: string): number {
  return currentGeneration(useCloudEpicTasksPagesStore.getState(), identity);
}

/**
 * Registers an identity's generation entry imperatively, before the fetch that will read it via
 * `cloudEpicTasksPageGeneration` is dispatched.
 */
export function registerCloudEpicTasksPageIdentity(identity: string): void {
  useCloudEpicTasksPagesStore.getState().registerIdentity(identity);
}

/**
 * Drops every accumulated pagination tail for one host/user and advances their generations so
 * in-flight tails are rejected on arrival.
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

/**
 * Drops only last-viewed pagination tails for one host/user. Recording a view can move rows across
 * page boundaries for that ordering, but leaves cursors for every other sort valid.
 */
export function resetLastViewedCloudEpicTasksPagesForScope(
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
    if (
      identity.startsWith(prefix) &&
      identity.includes('"sort":"last-viewed"')
    ) {
      state.resetIdentity(identity);
    }
  });
}

export function setCloudEpicTasksPagePinned(
  hostId: string,
  userId: string,
  epicId: string,
  pinned: boolean,
): void {
  useCloudEpicTasksPagesStore
    .getState()
    .setTaskPinned(`${hostId}|${userId}|`, epicId, pinned);
}
