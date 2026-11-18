import { create } from "zustand";

/**
 * A transient request to bring one projected Epic node into view in the
 * sidebar panel rendered for a specific Epic view tab.
 *
 * The nonce makes repeated reveals of the same node observable after the user
 * scrolls away, and lets a consumer clear only the request it actually served.
 */
export interface SidebarNodeRevealRequest {
  readonly nodeId: string;
  readonly nonce: number;
}

interface SidebarNodeRevealState {
  readonly requestsByViewTabId: Readonly<
    Record<string, SidebarNodeRevealRequest | undefined>
  >;
  readonly visibleByViewTabId: Readonly<
    Record<string, SidebarNodeRevealRequest | undefined>
  >;
}

export const useSidebarNodeRevealStore = create<SidebarNodeRevealState>(() => ({
  requestsByViewTabId: {},
  visibleByViewTabId: {},
}));

export const SIDEBAR_NODE_REVEAL_VISIBILITY_MS = 3_000;

export function requestSidebarNodeReveal(
  viewTabId: string,
  nodeId: string,
): void {
  useSidebarNodeRevealStore.setState((state) => {
    const previous =
      state.requestsByViewTabId[viewTabId] ??
      state.visibleByViewTabId[viewTabId];
    const nonce = previous === undefined ? 1 : previous.nonce + 1;
    return {
      requestsByViewTabId: {
        ...state.requestsByViewTabId,
        [viewTabId]: { nodeId, nonce },
      },
    };
  });
}

export function clearSidebarNodeRevealRequest(
  viewTabId: string,
  nonce: number,
): void {
  const served =
    useSidebarNodeRevealStore.getState().requestsByViewTabId[viewTabId];
  if (served === undefined || served.nonce !== nonce) return;
  useSidebarNodeRevealStore.setState((state) => {
    const { [viewTabId]: _removed, ...rest } = state.requestsByViewTabId;
    return {
      requestsByViewTabId: rest,
      visibleByViewTabId: {
        ...state.visibleByViewTabId,
        [viewTabId]: served,
      },
    };
  });
  window.setTimeout(() => {
    useSidebarNodeRevealStore.setState((state) => {
      const visible = state.visibleByViewTabId[viewTabId];
      if (visible !== served) return state;
      const { [viewTabId]: _removed, ...rest } = state.visibleByViewTabId;
      return { visibleByViewTabId: rest };
    });
  }, SIDEBAR_NODE_REVEAL_VISIBILITY_MS);
}

export function useVisibleSidebarNodeRevealRequest(
  viewTabId: string,
): SidebarNodeRevealRequest | null {
  return useSidebarNodeRevealStore(
    (state) =>
      state.requestsByViewTabId[viewTabId] ??
      state.visibleByViewTabId[viewTabId] ??
      null,
  );
}

export function useSidebarNodeRevealRequest(
  viewTabId: string,
): SidebarNodeRevealRequest | null {
  return useSidebarNodeRevealStore(
    (state) => state.requestsByViewTabId[viewTabId] ?? null,
  );
}
