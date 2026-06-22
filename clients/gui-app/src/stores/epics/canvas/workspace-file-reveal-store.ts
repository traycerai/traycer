import { create } from "zustand";

/**
 * A transient "scroll to + highlight this line" request for a workspace-file
 * preview tile.
 *
 * The `nonce` is a monotonic counter so a repeat request - the SAME line
 * re-clicked, or a different line on an already-open tab - still re-fires the
 * reveal effect even though the `{ line, col }` values may be unchanged.
 */
export interface WorkspaceFileRevealTarget {
  /** 1-based line to scroll into view and highlight. */
  readonly line: number;
  /** 1-based column parsed off the link, carried for parity (unused today). */
  readonly col: number | null;
  /** Bumped on every `setRevealTarget` so a same-value re-click re-fires. */
  readonly nonce: number;
}

interface WorkspaceFileRevealState {
  /**
   * Keyed by a composite `<viewTabId>\u0000<contentId>` (see `revealKey`), NOT
   * by content id alone. A preview of the same file can be open in more than
   * one Epic view tab at once; `openTile` dedups on the content id WITHIN a
   * tab, so `(viewTabId, contentId)` names exactly one tile. Keying on the
   * content id alone made a `:line` click in one tab scroll/highlight every
   * open preview of that file across tabs (CL-6). The content id is itself the
   * `WorkspaceFileRef.id` (`workspace-file:<host>:<workspace>:<file>`), NEVER
   * the click-time `instanceId`: `openTile` discards the click-time instance,
   * so the tile that renders only knows its content id and its `viewTabId`.
   */
  readonly targetsByKey: Readonly<
    Record<string, WorkspaceFileRevealTarget | undefined>
  >;
}

/**
 * Hard cap on live reveal entries. The happy path consumes its entry on reveal
 * (G4), but the dead-tile / error / null-content states never mount the
 * consuming preview, so a stranded entry can survive until the tile clears it.
 * This bounds the worst case - a flood of clicks landing on failing tiles -
 * regardless of any single clear path firing (CL-5 / pin G4). Far above any
 * realistic count of simultaneously-pending reveals.
 */
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

/**
 * Records a reveal request for a `(viewTabId, contentId)` pair. Call this
 * IMMEDIATELY BEFORE opening/focusing the tile so the channel entry is present
 * by the time the (possibly new) tile mounts and reads it. The line is
 * transient and never persisted - it is consumed on reveal and gone on reload.
 *
 * `viewTabId` is the Epic view tab the file opens into (the same id passed to
 * `openTilePreviewInTab`); it scopes the entry to the one tile that should
 * react, not every open preview of the file.
 */
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
    // Drop any existing entry first so the fresh write lands at the END of the
    // insertion order: the cap evicts the OLDEST keys, never the target we just
    // wrote for an imminent open.
    const { [key]: _previous, ...rest } = state.targetsByKey;
    return {
      targetsByKey: capRevealTargets({ ...rest, [key]: { line, col, nonce } }),
    };
  });
}

/**
 * Drops the reveal entry for a `(viewTabId, contentId)` pair. The tile CONSUMES
 * its target this way after scrolling (G4); the dead-tile / error / null-content
 * states clear it the same way when they settle without mounting the consuming
 * preview, so a failing click leaves no residual entry. Clearing both bounds the
 * map and prevents a tab-switch remount from re-scrolling to a stale line. A
 * fresh click writes a new entry with a bumped nonce.
 */
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

/**
 * Per-tile selector hook: subscribes a `WorkspaceFileTile` to just its own
 * reveal target by `(viewTabId, contentId)`, so unrelated reveal requests - for
 * the same file in another tab, or any other file - don't re-render it.
 */
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
