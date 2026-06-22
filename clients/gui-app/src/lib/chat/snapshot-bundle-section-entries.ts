import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ResolvedSnapshotDiff } from "@/lib/chat/resolve-snapshot-diff-content";
import type { SnapshotUnifiedPatchEntry } from "@/lib/diff/snapshot-diff-patch";

export interface SnapshotBundleSectionEntry extends SnapshotUnifiedPatchEntry {
  readonly operation: ChatAccumulatedFileChange["operation"];
  readonly reason: ChatAccumulatedFileChange["reason"];
}

export function snapshotBundleSectionEntries(
  resolved: ReadonlyArray<ResolvedSnapshotDiff>,
  changes: ReadonlyArray<ChatAccumulatedFileChange>,
): ReadonlyArray<SnapshotBundleSectionEntry> {
  const changesByPath = new Map(
    changes.map((change) => [change.filePath, change]),
  );
  return resolved.flatMap((entry) => {
    const change = changesByPath.get(entry.filePath);
    if (change === undefined) return [];
    return [
      {
        ...entry,
        operation: change.operation,
        reason: change.reason,
      },
    ];
  });
}
