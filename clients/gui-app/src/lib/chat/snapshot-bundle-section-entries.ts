import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import type { ResolvedSnapshotDiff } from "@/lib/chat/resolve-snapshot-diff-content";
import type { SnapshotUnifiedPatchEntry } from "@/lib/diff/snapshot-diff-patch";

export interface SnapshotBundleSectionEntry extends SnapshotUnifiedPatchEntry {
  readonly operation: AccumulatedChangeRow["operation"];
  readonly reason: AccumulatedChangeRow["reason"];
}

/**
 * Per-file section headers for a bundle tile, taken from the accumulated-change ROWS rather than from the content-bearing changes.
 */
export function snapshotBundleSectionEntries(
  resolved: ReadonlyArray<ResolvedSnapshotDiff>,
  rows: ReadonlyArray<AccumulatedChangeRow>,
): ReadonlyArray<SnapshotBundleSectionEntry> {
  const rowsByPath = new Map(rows.map((row) => [row.filePath, row]));
  return resolved.flatMap((entry) => {
    const row = rowsByPath.get(entry.filePath);
    if (row === undefined) return [];
    return [
      {
        ...entry,
        operation: row.operation,
        reason: row.reason,
      },
    ];
  });
}
