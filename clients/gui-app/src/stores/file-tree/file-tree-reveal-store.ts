import { create } from "zustand";

/**
 * A transient "show THIS file in the Files panel" request - what "Reveal in
 * Sidebar" on a workspace-file tab writes, and what the file-tree panel for
 * that view tab consumes: switch to the file's host/workspace if the panel is
 * showing another, expand the file's ancestors, select the row, scroll it into
 * view.
 *
 * Keyed by the Epic VIEW tab (the same id the panel is rendered for), not by
 * file: a split can host two Files panels, and the request belongs to the one
 * whose tab strip the gesture came from. In-memory only - a reload drops it.
 *
 * The `nonce` is a monotonic counter per view tab so a repeat request for the
 * same file still re-fires (the user revealed, scrolled away, revealed again),
 * and so a consumer can clear exactly the request it served without racing a
 * newer one written in the meantime.
 */
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
 * Records a reveal request for `viewTabId`. Call this BEFORE switching the
 * sidebar to the Files panel, so a panel that mounts on that switch reads the
 * request on its first render. A later request for the same view tab replaces
 * the earlier one (there is only ever one file to reveal per panel).
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
 * Drops the request for `viewTabId` - but only if it is still the one the
 * caller served (`nonce` matches). A request written after the caller read its
 * copy is newer and survives, so the consumer's clear can never swallow a
 * reveal it has not performed. The consumer calls this once the row is
 * selected, and when the request cannot be served (the file's workspace is not
 * a browsable root of the panel's host).
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
