import type { PrLocalDiffSummaryFile } from "@traycer/protocol/host/pr-schemas";
import { BUNDLE_INLINE_LINE_THRESHOLD } from "@/lib/git/bundle-thresholds";

/**
 * Whether a PR range-diff file is too large to render (or fetch) inline without an explicit "Load diff" - the same `BUNDLE_INLINE_LINE_THRESHOLD` the Git Diff bundle applies to its rows.
 */
export function isPrLocalDiffLargeFile(file: PrLocalDiffSummaryFile): boolean {
  if (file.insertions === null || file.deletions === null) return true;
  return file.insertions + file.deletions > BUNDLE_INLINE_LINE_THRESHOLD;
}
