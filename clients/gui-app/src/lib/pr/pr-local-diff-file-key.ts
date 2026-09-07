import type { PrLocalDiffSummaryFileV11 } from "@traycer/protocol/host/pr-schemas";

/**
 * One file of the PR diff view, in either patch mode: the 1.1 summary row shape.
 * Monolith-fallback files normalize into it at the mode seam with `null` sidecars (legacy-unknown), so every consumer downstream of the seam keys files exactly one way.
 */
export type PrLocalDiffViewFile = PrLocalDiffSummaryFileV11;

/**
 * One path side's identity in the tagged key space: `b:<token>` when the side is byte-addressed, `p:<path>` when it is clean.
 */
export function prLocalDiffPathKey(
  path: string,
  pathBytes: string | null,
): string {
  return pathBytes !== null ? `b:${pathBytes}` : `p:${path}`;
}

/**
 * THE identity of a PR-diff view file - its destination side, tagged.
 * Row keys, collapse entries, find file ids, section state keys and patch cache scopes all derive from this one function; keying any of them on the lossy `path` instead is how two distinct byte paths merge into one row.
 */
export function prLocalDiffFileKey(file: PrLocalDiffViewFile): string {
  return prLocalDiffPathKey(file.path, file.pathBytes);
}

/**
 * The rename-source side's identity, `""` for a non-rename.
 * Derived per side and independently of the destination: a clean source beside a byte destination is legal (and the common rename-away-from-bad-name case).
 */
export function prLocalDiffPreviousSideKey(file: PrLocalDiffViewFile): string {
  if (file.previousPath === null) return "";
  return prLocalDiffPathKey(file.previousPath, file.previousPathBytes);
}

/**
 * Collapse membership for one file - the ONE predicate behind all three collapse gates (the row chevron, the toolbar's collapse-all, and the find session's coverage/reveal), so what "collapsed" means cannot diverge between them.
 */
export function isPrLocalDiffFileCollapsed(
  collapsedFileKeys: ReadonlyArray<string>,
  file: PrLocalDiffViewFile,
): boolean {
  return collapsedFileKeys.includes(prLocalDiffFileKey(file));
}
