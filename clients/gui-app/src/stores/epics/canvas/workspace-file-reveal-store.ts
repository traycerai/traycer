import { create } from "zustand";

/** A transient "scroll to + highlight this line" request for a workspace-file preview tile. */
export interface WorkspaceFileRevealTarget {
  /** 1-based line to scroll into view and highlight. */
  readonly line: number;
  /** 1-based column parsed off the link, carried for parity (unused today). */
  readonly col: number | null;
  /** Bumped on every `setRevealTarget` so a same-value re-click re-fires. */
  readonly nonce: number;
}

interface WorkspaceFileRevealState {
  /** Keyed by a composite `<viewTabId>\u0000<contentId>` (see `revealKey`), NOT by content id alone. */
  readonly targetsByKey: Readonly<
    Record<string, WorkspaceFileRevealTarget | undefined>
  >;
}

/** Hard cap on live reveal entries. */
const MAX_REVEAL_TARGETS = 64;

/**
 * The NUL separator can appear in neither a tab id (uuid) nor a content id
 * (`workspace-file:` path token), so the composite key is unambiguous.
 */
function revealKey(viewTabId: string, contentId: string): string {
  return `${viewTabId}\u0000${contentId}`;
}

export const useWorkspaceFileRevealStore = create<WorkspaceFileRevealState>(
  () => ({
    targetsByKey: {},
  }),
);

/** Records a reveal request for a `(viewTabId, contentId)` pair. */
export function setWorkspaceFileRevealTarget(
  viewTabId: string,
  contentId: string,
  line: number,
  col: number | null,
): void {
  const key = revealKey(viewTabId, contentId);
  useWorkspaceFileRevealStore.setState((state) => {
    const previous = state.targetsByKey[key];
    const nonce = previous === undefined ? 1 : previous.nonce + 1;
    // Drop any existing entry first so the fresh write lands at the END of the insertion order: the
    // cap evicts the OLDEST keys, never the target we just wrote for an imminent open.
    const { [key]: _previous, ...rest } = state.targetsByKey;
    return {
      targetsByKey: capRevealTargets({ ...rest, [key]: { line, col, nonce } }),
    };
  });
}

/** Drops the reveal entry for a `(viewTabId, contentId)` pair. */
export function clearWorkspaceFileRevealTarget(
  viewTabId: string,
  contentId: string,
): void {
  const key = revealKey(viewTabId, contentId);
  useWorkspaceFileRevealStore.setState((state) => {
    if (state.targetsByKey[key] === undefined) return state;
    const { [key]: _removed, ...rest } = state.targetsByKey;
    return { targetsByKey: rest };
  });
}

export function useWorkspaceFileRevealTarget(
  viewTabId: string,
  contentId: string,
): WorkspaceFileRevealTarget | null {
  const key = revealKey(viewTabId, contentId);
  return useWorkspaceFileRevealStore(
    (state) => state.targetsByKey[key] ?? null,
  );
}

/**
 * Keeps the most-recently-written `MAX_REVEAL_TARGETS` entries. Object key order
 * is insertion order, so the oldest keys sit at the front and are dropped first.
 */
function capRevealTargets(
  targets: Record<string, WorkspaceFileRevealTarget | undefined>,
): Record<string, WorkspaceFileRevealTarget | undefined> {
  const keys = Object.keys(targets);
  if (keys.length <= MAX_REVEAL_TARGETS) return targets;
  const keep = keys.slice(keys.length - MAX_REVEAL_TARGETS);
  return Object.fromEntries(keep.map((key) => [key, targets[key]]));
}
