import { create } from "zustand";

export interface FileTreeRevealRequest {
  /** The tab's host - tabs are bound to a host for life, so this names one. */
  readonly hostId: string;
  readonly workspacePath: string;
  /** Host-canonical file token relative to `workspacePath` (the tab's `filePath`). */
  readonly filePath: string;
  /** Bumped on every `requestFileTreeReveal` for the same view tab. */
  readonly nonce: number;
}

export interface FileTreeRevealTarget {
  readonly hostId: string;
  readonly workspacePath: string;
  readonly filePath: string;
}

interface FileTreeRevealState {
  readonly requestsByViewTabId: Readonly<
    Record<string, FileTreeRevealRequest | undefined>
  >;
}

export const useFileTreeRevealStore = create<FileTreeRevealState>(() => ({
  requestsByViewTabId: {},
}));

/**
 * Records a reveal request for `viewTabId`. Call this BEFORE switching the sidebar to the Files
 * panel, so a panel that mounts on that switch reads the request on its first render.
 */
export function requestFileTreeReveal(
  viewTabId: string,
  target: FileTreeRevealTarget,
): void {
  useFileTreeRevealStore.setState((state) => {
    const previous = state.requestsByViewTabId[viewTabId];
    const nonce = previous === undefined ? 1 : previous.nonce + 1;
    return {
      requestsByViewTabId: {
        ...state.requestsByViewTabId,
        [viewTabId]: { ...target, nonce },
      },
    };
  });
}

/**
 * Drops the request for `viewTabId` - but only if it is still the one the caller served (`nonce`
 * matches).
 */
export function clearFileTreeRevealRequest(
  viewTabId: string,
  nonce: number,
): void {
  useFileTreeRevealStore.setState((state) => {
    const current = state.requestsByViewTabId[viewTabId];
    if (current === undefined || current.nonce !== nonce) return state;
    const { [viewTabId]: _removed, ...rest } = state.requestsByViewTabId;
    return { requestsByViewTabId: rest };
  });
}

/** Subscribes a panel to just its own view tab's request. */
export function useFileTreeRevealRequest(
  viewTabId: string,
): FileTreeRevealRequest | null {
  return useFileTreeRevealStore(
    (state) => state.requestsByViewTabId[viewTabId] ?? null,
  );
}
