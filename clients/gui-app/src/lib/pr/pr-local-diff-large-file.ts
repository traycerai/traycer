import type { PrLocalDiffSummaryFile } from "@traycer/protocol/host/pr-schemas";
import { BUNDLE_INLINE_LINE_THRESHOLD } from "@/lib/git/bundle-thresholds";

/**
 * Whether a PR range-diff file is too large to render (or fetch) inline
 * without an explicit "Load diff" - the same `BUNDLE_INLINE_LINE_THRESHOLD`
 * the Git Diff bundle applies to its rows.
 *
 * `null` line counts count as LARGE, not small: they mean the numstat sweep
 * had nothing to say about a (non-binary) file, so its size is unknown - and
 * the placeholder's failure mode ("one extra click") is far cheaper than the
 * inline mode's (parsing an unbounded patch on mount).
 *
 * Shared by the section renderer (placeholder vs. inline) and the find
 * session (a large file's content is not searchable until it is loaded), so
 * the two can never disagree about which files are guarded.
 */
export function isPrLocalDiffLargeFile(file: PrLocalDiffSummaryFile): boolean {
  if (file.insertions === null || file.deletions === null) return true;
  return file.insertions + file.deletions > BUNDLE_INLINE_LINE_THRESHOLD;
}
