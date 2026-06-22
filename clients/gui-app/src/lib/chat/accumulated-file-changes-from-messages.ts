import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import type { CheckpointFileOperation } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  ChatMessage,
  FileChangeSegment,
  MessageSegment,
} from "@/stores/composer/chat-store";
import type { DiffLineCounts } from "@/lib/file-change-diff-hunks";
import { mergeSnapshotSourceBlockIds } from "@/lib/chat/snapshot-source-block-ids";

/**
 * A row in the pinned accumulated-changes panel. Extends the host's
 * content-bearing `ChatAccumulatedFileChange` with `streamingCounts`: the
 * per-edit `+/-` summed across the ACTIVE turn's `file_change` blocks. The
 * host resolves before/after CONTENT only at turn boundaries, so an
 * active-turn row's content is null mid-stream and the panel can't derive a
 * magnitude from it; `streamingCounts` carries that magnitude live so the panel
 * updates on every edit instead of showing 0 until the turn ends. `null` for
 * host rows - those derive `+/-` from their resolved content.
 */
export type AccumulatedFileChange = ChatAccumulatedFileChange & {
  readonly streamingCounts: DiffLineCounts | null;
};

/**
 * Client-side accumulation for the pinned changes panel above the composer:
 * walks completed assistant messages' per-turn `file_change_group` segments and
 * the active turn's raw `file_change` segments in order, then merges by
 * `filePath` - earliest `beforeHash` paired with the latest `afterHash`.
 *
 * The host's `accumulatedFileChanges` is the whole-chat source of truth and
 * carries the resolved before/after CONTENT (read from snapshot blobs). The
 * chat doc no longer inlines that content on file_change blocks, so an
 * active-turn row for a file the host hasn't recomputed yet appears with
 * null content (presence/operation only) until the host's recompute lands -
 * a brief, self-healing window while an edit streams.
 */
export function accumulatedFileChangesFromMessages(
  messages: ReadonlyArray<ChatMessage>,
  fromHost: ReadonlyArray<ChatAccumulatedFileChange>,
  activeTurnId: string | null,
): ReadonlyArray<AccumulatedFileChange> {
  const { order, activeSegments, activePaths } = collectMessageSegments(
    messages,
    activeTurnId,
  );
  const hostByPath = new Map(
    fromHost.map((change) => [change.filePath, change]),
  );
  const out: AccumulatedFileChange[] = [];
  const seen = new Set<string>();
  for (const filePath of order) {
    const hostEntry = hostByPath.get(filePath);
    if (activePaths.has(filePath)) {
      const activeRow = activeTurnRow(activeSegments.get(filePath), hostEntry);
      if (activeRow !== null) {
        out.push(activeRow);
      }
      seen.add(filePath);
      continue;
    }
    if (hostEntry !== undefined) {
      out.push(hostRow(hostEntry));
      seen.add(filePath);
    }
  }
  for (const change of fromHost) {
    if (seen.has(change.filePath)) continue;
    out.push(hostRow(change));
  }
  return out;
}

// A content-resolved host row derives its `+/-` from before/after content,
// so it never carries streaming counts.
function hostRow(change: ChatAccumulatedFileChange): AccumulatedFileChange {
  return { ...change, streamingCounts: null };
}

function collectMessageSegments(
  messages: ReadonlyArray<ChatMessage>,
  activeTurnId: string | null,
): {
  readonly order: string[];
  readonly activeSegments: Map<string, FileChangeSegment>;
  readonly activePaths: Set<string>;
} {
  // `order` keeps first-seen path order; `seen` mirrors its membership so
  // de-duping is O(1) instead of an `order.includes` scan. This runs on every
  // stream delta, so the array scan was O(n^2) over the turn's file count.
  const paths: PathOrder = { order: [], seen: new Set() };
  const activeSegments = new Map<string, FileChangeSegment>();
  const activePaths = new Set<string>();
  for (const message of messages) {
    const isActiveTurn = activeTurnMessage(message, activeTurnId);
    for (const segment of message.segments) {
      if (segment.kind === "file_change_group") {
        for (const file of segment.files) {
          recordPathOrder(paths, file.filePath);
        }
        continue;
      }
      if (isActiveTurn) {
        for (const file of activeFileChangesFromSegment(segment)) {
          recordActiveFileChange(paths, activeSegments, activePaths, file);
        }
      }
    }
  }
  return { order: paths.order, activeSegments, activePaths };
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

interface PathOrder {
  readonly order: string[];
  readonly seen: Set<string>;
}

function recordPathOrder(paths: PathOrder, filePath: string): void {
  if (paths.seen.has(filePath)) return;
  paths.seen.add(filePath);
  paths.order.push(filePath);
}

function recordActiveFileChange(
  paths: PathOrder,
  activeSegments: Map<string, FileChangeSegment>,
  activePaths: Set<string>,
  file: FileChangeSegment,
): void {
  if (!isRealFileChange(file)) return;
  recordPathOrder(paths, file.filePath);
  activePaths.add(file.filePath);
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

function activeTurnRow(
  merged: FileChangeSegment | undefined,
  fromHost: ChatAccumulatedFileChange | undefined,
): AccumulatedFileChange | null {
  if (merged === undefined) return null;
  // When the host already has this file, its row carries the resolved
  // content - prefer it wholesale. Otherwise emit a content-less placeholder
  // (presence + operation) that the host's recompute fills in shortly; drop
  // it when the active edit is a net no-op (equal content-addressed endpoints).
  if (fromHost !== undefined) return hostRow(fromHost);
  if (merged.beforeHash === merged.afterHash) return null;
  return {
    filePath: merged.filePath,
    operation: normalizeOperation(merged.operation),
    diffSource: merged.diffSource,
    beforeContent: null,
    afterContent: null,
    reason: merged.reason,
    undoable: true,
    // Content is null until the host recomputes at turn end, so carry the
    // per-edit magnitude already summed onto the merged segment - this is what
    // lets the pinned panel show a live, indicative `+/-` on every edit instead
    // of 0 until the turn completes.
    streamingCounts: {
      additions: merged.additions,
      deletions: merged.deletions,
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
