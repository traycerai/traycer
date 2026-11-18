import type { PrLocalDiffSummaryFileV11 } from "@traycer/protocol/host/pr-schemas";

/**
 * One file of the PR diff view, in either patch mode: the 1.1 summary row
 * shape. Monolith-fallback files normalize into it at the mode seam with
 * `null` sidecars (legacy-unknown), so every consumer downstream of the seam
 * keys files exactly one way. `path`/`previousPath` are DISPLAY strings
 * (possibly lossy); `pathBytes`/`previousPathBytes` are opaque canonical
 * tokens the host minted - never decoded client-side, only echoed and keyed.
 */
export type PrLocalDiffViewFile = PrLocalDiffSummaryFileV11;

/**
 * One path side's identity in the tagged key space: `b:<token>` when the
 * side is byte-addressed, `p:<path>` when it is clean.
 *
 * The tag is what makes the key injective: a bare `pathBytes ?? path` would
 * put tokens and paths in one string space, where a clean file literally
 * NAMED like some token collides with the token's file. With the tag, the
 * two domains cannot meet.
 */
export function prLocalDiffPathKey(
  path: string,
  pathBytes: string | null,
): string {
  return pathBytes !== null ? `b:${pathBytes}` : `p:${path}`;
}

/**
 * THE identity of a PR-diff view file - its destination side, tagged.
 * Row keys, collapse entries, find file ids, section state keys and patch
 * cache scopes all derive from this one function; keying any of them on the
 * lossy `path` instead is how two distinct byte paths merge into one row.
 * Against a 1.0 host every sidecar is `null`, so every key degrades to `p:`
 * and behavior is exactly the pre-1.1 view's.
 */
export function prLocalDiffFileKey(file: PrLocalDiffViewFile): string {
  return prLocalDiffPathKey(file.path, file.pathBytes);
}

/**
 * The rename-source side's identity, `""` for a non-rename. Derived per side
 * and independently of the destination: a clean source beside a byte
 * destination is legal (and the common rename-away-from-bad-name case).
 */
export function prLocalDiffPreviousSideKey(file: PrLocalDiffViewFile): string {
  if (file.previousPath === null) return "";
  return prLocalDiffPathKey(file.previousPath, file.previousPathBytes);
}

/**
 * Collapse membership for one file - the ONE predicate behind all three
 * collapse gates (the row chevron, the toolbar's collapse-all, and the find
 * session's coverage/reveal), so what "collapsed" means cannot diverge
 * between them. Entries in `collapsedFileKeys` are {@link prLocalDiffFileKey}
 * values and nothing else; the legacy bare-path `collapsedFilePaths` field is
 * never read for PR tiles (see `PrDiffTileViewState`).
 */
export function isPrLocalDiffFileCollapsed(
  collapsedFileKeys: ReadonlyArray<string>,
  file: PrLocalDiffViewFile,
): boolean {
  return collapsedFileKeys.includes(prLocalDiffFileKey(file));
}
