import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatAccumulatedFileChangeSummary } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type {
  CheckpointArtifactTag,
  CheckpointFileOperation,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  DiffSource,
  FileEditReason,
} from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  ChatMessage,
  FileChangeSegment,
  MessageSegment,
} from "@/stores/composer/chat-store";
import {
  diffLineCountsFromContents,
  type DiffLineCounts,
} from "@/lib/file-change-diff-hunks";
import {
  mergeSnapshotSourceBlockIds,
  type SnapshotSourceBlockIds,
} from "@/lib/chat/snapshot-source-block-ids";

/** # What the accumulated-changes panel renders, on either line */
export interface AccumulatedChangeRow {
  readonly filePath: string;
  readonly operation: CheckpointFileOperation;
  readonly diffSource: DiffSource;
  readonly reason: FileEditReason;
  readonly undoable: boolean;
  readonly artifact: CheckpointArtifactTag | null;
  /** The `+`/`-` for this row, or `null` when there is nothing to count. */
  readonly counts: DiffLineCounts | null;
  /** Whether a diff can be fetched for this row at all. */
  readonly hasContents: boolean;
  /**
   * The VERSION of this file's accumulated change, quoted verbatim when fetching its contents.
   * Opaque - a client echoes it, it does not parse it.
   */
  readonly digest: string | null;
  /** Where this row's diff lives when the CUMULATIVE surfaces cannot answer for it, or `null` when they can. */
  readonly liveDiff: {
    readonly sourceBlockIds: SnapshotSourceBlockIds;
    readonly beforeHash: string | null;
    readonly afterHash: string | null;
  } | null;
}

/** The pre-windowed line's row: contents in hand, so count them here. */
export function rowFromAccumulatedChange(
  change: ChatAccumulatedFileChange,
): AccumulatedChangeRow {
  const hasContents = change.diffSource !== "none";
  return {
    filePath: change.filePath,
    operation: change.operation,
    diffSource: change.diffSource,
    reason: change.reason,
    undoable: change.undoable,
    artifact: change.artifact ?? null,
    counts: hasContents
      ? diffLineCountsFromContents(
          change.beforeContent,
          change.afterContent,
          false,
        )
      : null,
    hasContents,
    digest: null,
    // Contents rode the snapshot; `resolveSnapshotDiffContent` finds them in
    // the inline change array this row was built from.
    liveDiff: null,
  };
}

/** The windowed line's row: every field arrives already decided. */
export function rowFromAccumulatedChangeSummary(
  summary: ChatAccumulatedFileChangeSummary,
): AccumulatedChangeRow {
  return {
    filePath: summary.filePath,
    operation: summary.operation,
    diffSource: summary.diffSource,
    reason: summary.reason,
    undoable: summary.undoable,
    artifact: summary.artifact ?? null,
    counts: summary.counts,
    hasContents: summary.hasContents,
    digest: summary.digest,
    // A summary always names a host version, so the cumulative fetch answers.
    liveDiff: null,
  };
}

/** The host's half of the panel, in whichever shape this line delivers it. */
export function hostAccumulatedChangeRows(input: {
  readonly windowed: boolean;
  readonly changes: ReadonlyArray<ChatAccumulatedFileChange>;
  readonly summaries: ReadonlyArray<ChatAccumulatedFileChangeSummary>;
}): ReadonlyArray<AccumulatedChangeRow> {
  return input.windowed
    ? input.summaries.map(rowFromAccumulatedChangeSummary)
    : input.changes.map(rowFromAccumulatedChange);
}

/** How many of the host's rows have NOT arrived yet. */
export function undeliveredHostChangeCount(input: {
  readonly windowed: boolean;
  readonly hostChangeCount: number;
  readonly deliveredSummaryCount: number;
}): number {
  if (!input.windowed) return 0;
  return Math.max(0, input.hostChangeCount - input.deliveredSummaryCount);
}

/** Whether the delivered summary set AGREES with the host's authoritative count. */
export function accumulatedSummarySetComplete(input: {
  readonly windowed: boolean;
  readonly hostChangeCount: number;
  readonly deliveredSummaryCount: number;
  /**
   * Whether any chunk of the CURRENT generation has been accepted - see `ChatSessionState.accumulatedSummaryGenerationSeated`.
   */
  readonly generationSeated: boolean;
  /**
   * Whether a replacement generation is assembling off-screen right now - see `ChatSessionState.accumulatedSummaryAssemblyStarted`.
   */
  readonly assemblyStarted: boolean;
}): boolean {
  // The legacy line ships the whole set on the snapshot; there is no stream to
  // be mid-way through.
  if (!input.windowed) return true;
  // GENERATION before length, because length cannot see this state at all.
  // A rebuild resets the generation while the previous stream's array is deliberately retained, so until a replacement chunk lands that array is the OLD generation's - with the old digests.
  if (
    !input.generationSeated &&
    (input.assemblyStarted || input.hostChangeCount > 0)
  ) {
    return false;
  }
  return input.hostChangeCount === input.deliveredSummaryCount;
}

/**
 * Host list is the order (whole-history first-touch); rendered rows only append paths the host does not yet have.
 * A host row wins wholesale wherever one exists, even if its number is one turn stale.
 */
export function accumulatedChangeRows(
  messages: ReadonlyArray<ChatMessage>,
  fromHost: ReadonlyArray<AccumulatedChangeRow>,
  activeTurnId: string | null,
): ReadonlyArray<AccumulatedChangeRow> {
  const active = collectActiveTurnFileChanges(messages, activeTurnId);
  const hostPaths = new Set(fromHost.map((row) => row.filePath));
  const out: AccumulatedChangeRow[] = [...fromHost];
  for (const [filePath, merged] of active) {
    if (hostPaths.has(filePath)) continue;
    const activeRow = activeTurnRow(merged);
    if (activeRow !== null) out.push(activeRow);
  }
  return out;
}

/** The active turn's file edits, merged per path, in the order it touched them. */
function collectActiveTurnFileChanges(
  messages: ReadonlyArray<ChatMessage>,
  activeTurnId: string | null,
): ReadonlyMap<string, FileChangeSegment> {
  const active = new Map<string, FileChangeSegment>();
  for (const message of messages) {
    if (!activeTurnMessage(message, activeTurnId)) continue;
    for (const segment of message.segments) {
      for (const file of activeFileChangesFromSegment(segment)) {
        recordActiveFileChange(active, file);
      }
    }
  }
  return active;
}

function activeFileChangesFromSegment(
  segment: MessageSegment,
): ReadonlyArray<FileChangeSegment> {
  if (segment.kind === "file_change") return [segment];
  if (segment.kind === "subagent") {
    return segment.children.filter(
      (child): child is FileChangeSegment => child.kind === "file_change",
    );
  }
  return [];
}

function recordActiveFileChange(
  activeSegments: Map<string, FileChangeSegment>,
  file: FileChangeSegment,
): void {
  if (!isRealFileChange(file)) return;
  const existing = activeSegments.get(file.filePath);
  if (existing === undefined) {
    activeSegments.set(file.filePath, file);
    return;
  }
  activeSegments.set(file.filePath, {
    ...file,
    id: `${existing.id}+${file.id}`,
    // Span earliest before → latest after (the `...file` spread carries the
    // latest `afterHash`); sum the per-edit counts for an indicative magnitude.
    beforeHash: existing.beforeHash,
    additions: existing.additions + file.additions,
    deletions: existing.deletions + file.deletions,
    sourceBlockIds: mergeSnapshotSourceBlockIds(
      existing.sourceBlockIds,
      file.sourceBlockIds,
    ),
  });
}

function activeTurnMessage(
  message: ChatMessage,
  activeTurnId: string | null,
): boolean {
  if (message.runState !== null) return true;
  if (activeTurnId === null) return false;
  const activeAssistantRowId = `assistant:${activeTurnId}`;
  return (
    message.id === activeAssistantRowId ||
    message.id.startsWith(`${activeAssistantRowId}:part:`)
  );
}

/** The client's own row for a file no host version names yet. */
function activeTurnRow(merged: FileChangeSegment): AccumulatedChangeRow | null {
  if (merged.beforeHash === merged.afterHash) return null;
  return {
    filePath: merged.filePath,
    operation: normalizeOperation(merged.operation),
    diffSource: merged.diffSource,
    reason: merged.reason,
    undoable: true,
    artifact: null,
    counts: { additions: merged.additions, deletions: merged.deletions },
    hasContents: merged.diffSource !== "none",
    digest: null,
    // The blocks exist, so a diff IS openable - through the SEGMENT tile, which addresses them by block id.
    // Carrying that address is what makes the row clickable: a `null` digest and no host entry means cumulative resolution has nothing to resolve, so a cumulative open could only ever land on source-unavailable.
    liveDiff: {
      sourceBlockIds: merged.sourceBlockIds,
      beforeHash: merged.beforeHash,
      afterHash: merged.afterHash,
    },
  };
}

function isRealFileChange(segment: FileChangeSegment): boolean {
  return segment.reason !== "denied" && segment.reason !== "capture_failed";
}

function normalizeOperation(operation: string): CheckpointFileOperation {
  if (operation === "create" || operation === "delete") return operation;
  return "edit";
}
