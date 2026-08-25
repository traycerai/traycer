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
import { mergeSnapshotSourceBlockIds } from "@/lib/chat/snapshot-source-block-ids";

/**
 * # What the accumulated-changes panel renders, on either line
 *
 * The pinned panel above the composer lists every file the chat has touched.
 * It used to take the host's `ChatAccumulatedFileChange` directly - a row
 * carrying the file's whole before AND after contents - and derive the `+`/`-`
 * from them.
 *
 * On the windowed line those contents do not arrive (D7): the snapshot carries
 * SUMMARIES, and contents come from `chat.readAccumulatedFileChange` when a
 * diff is actually opened. So the panel cannot keep taking a content-bearing
 * type, and this is what it takes instead.
 *
 * ## It is content-free on purpose
 *
 * The panel never rendered the contents. It rendered two numbers derived from
 * them, and everything else it shows - the path, the operation, the artifact
 * tag, whether the row can be reverted - was already metadata. Making that
 * explicit is most of the work: once the row carries `counts` rather than two
 * file bodies, the windowed line has nothing left to be missing, and the
 * pre-windowed line loses a per-render diff of every file the chat has touched.
 *
 * The contents remain exactly one surface's business - the diff tile a row
 * click opens - and that surface fetches them by {@link AccumulatedChangeRow.digest}.
 */
export interface AccumulatedChangeRow {
  readonly filePath: string;
  readonly operation: CheckpointFileOperation;
  readonly diffSource: DiffSource;
  readonly reason: FileEditReason;
  readonly undoable: boolean;
  readonly artifact: CheckpointArtifactTag | null;
  /**
   * The `+`/`-` for this row, or `null` when there is nothing to count.
   *
   * `null` is NOT zero. A change whose `diffSource` is `none` has no
   * before/after at all and renders as a bare row; `{0, 0}` means the two
   * revisions were compared and came back equal. The host draws the same
   * distinction and ties it to {@link hasContents}.
   */
  readonly counts: DiffLineCounts | null;
  /** Whether a diff can be fetched for this row at all. */
  readonly hasContents: boolean;
  /**
   * The VERSION of this file's accumulated change, quoted verbatim when
   * fetching its contents. Opaque - a client echoes it, it does not parse it.
   *
   * `null` means "contents do not need fetching": either they rode the
   * snapshot (the pre-windowed line) or this row is the client's own view of a
   * file the active turn is still writing, which no host version names yet.
   */
  readonly digest: string | null;
}

/**
 * The pre-windowed line's row: contents in hand, so count them here.
 *
 * This is the per-render diff the summaries exist to delete. It stays because
 * the old line still runs it, and because it is the definition the host's
 * `counts` was built to agree with - `diffLineCounts` there is the same
 * `structuredPatch` call with the same settings, which is what keeps the
 * panel's collapsed total equal to the sum of its rows on both lines.
 */
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
  };
}

/**
 * The windowed line's row: every field arrives already decided.
 *
 * `hasContents` is copied rather than re-derived from `diffSource`. The two
 * agree today, and the host is the one entitled to change that - re-deriving
 * here would be a second implementation of a rule that is already on the wire.
 */
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
  };
}

/**
 * The host's half of the panel, in whichever shape this line delivers it.
 *
 * The discriminator is the LINE, never the emptiness of either array: the
 * windowed line leaves `changes` empty by construction and a chat that has
 * touched no files is empty on both, so "whichever is non-empty" would resolve
 * a real state to the wrong branch and show nothing.
 */
export function hostAccumulatedChangeRows(input: {
  readonly windowed: boolean;
  readonly changes: ReadonlyArray<ChatAccumulatedFileChange>;
  readonly summaries: ReadonlyArray<ChatAccumulatedFileChangeSummary>;
}): ReadonlyArray<AccumulatedChangeRow> {
  return input.windowed
    ? input.summaries.map(rowFromAccumulatedChangeSummary)
    : input.changes.map(rowFromAccumulatedChange);
}

/**
 * How many of the host's rows have NOT arrived yet.
 *
 * The summaries stream as chunks while the snapshot states the total up front,
 * so between those two the panel holds a list it must not present as the whole
 * set: "Undo all" reverts every file the HOST holds, not every row on screen,
 * and an artifact opt-out counted off a partial list understates what it is
 * opting out of. Same shape as the revert-on-edit prompt's unknown scope, and
 * answered the same way - name the shortfall rather than let a number imply
 * completeness.
 *
 * Always `0` on the pre-windowed line, where the set rides the snapshot whole.
 */
export function undeliveredHostChangeCount(input: {
  readonly windowed: boolean;
  readonly hostChangeCount: number;
  readonly deliveredSummaryCount: number;
}): number {
  if (!input.windowed) return 0;
  return Math.max(0, input.hostChangeCount - input.deliveredSummaryCount);
}

/**
 * Merge the host's rows with what the ACTIVE turn is writing right now.
 *
 * The host recomputes its accumulated set at turn boundaries, so mid-turn it is
 * one turn behind: a file the running turn has just created is not in it at
 * all. Walking the rendered messages supplies both the missing rows and the
 * panel's ORDER (first-touched, across the whole chat).
 *
 * Unchanged in behaviour by the windowed line - it operates on rows now rather
 * than on content-bearing changes, and a host row still wins wholesale wherever
 * one exists. That last part is deliberate and predates this: mid-turn the
 * host's number is one turn stale, and showing a stale number for a file the
 * host knows beats showing a per-edit number that means something different
 * from every other row in the list.
 */
export function accumulatedChangeRows(
  messages: ReadonlyArray<ChatMessage>,
  fromHost: ReadonlyArray<AccumulatedChangeRow>,
  activeTurnId: string | null,
): ReadonlyArray<AccumulatedChangeRow> {
  const { order, activeSegments, activePaths } = collectMessageSegments(
    messages,
    activeTurnId,
  );
  const hostByPath = new Map(fromHost.map((row) => [row.filePath, row]));
  const out: AccumulatedChangeRow[] = [];
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
      out.push(hostEntry);
      seen.add(filePath);
    }
  }
  for (const row of fromHost) {
    if (seen.has(row.filePath)) continue;
    out.push(row);
  }
  return out;
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
  fromHost: AccumulatedChangeRow | undefined,
): AccumulatedChangeRow | null {
  if (merged === undefined) return null;
  // When the host already has this file its row wins wholesale. Otherwise emit
  // the client's own row for a file no host version names yet - its counts are
  // the per-edit magnitudes summed across the turn, which is what lets the
  // panel move on every edit rather than sit at nothing until the turn ends.
  // Dropped when the active edit is a net no-op (equal content-addressed
  // endpoints).
  if (fromHost !== undefined) return fromHost;
  if (merged.beforeHash === merged.afterHash) return null;
  return {
    filePath: merged.filePath,
    operation: normalizeOperation(merged.operation),
    diffSource: merged.diffSource,
    reason: merged.reason,
    undoable: true,
    artifact: null,
    counts: { additions: merged.additions, deletions: merged.deletions },
    // The blocks exist, so a diff is openable - through the SEGMENT tile, which
    // addresses them by block id. What is absent is a host-named cumulative
    // version, which is what a `null` digest says.
    hasContents: merged.diffSource !== "none",
    digest: null,
  };
}

function isRealFileChange(segment: FileChangeSegment): boolean {
  return segment.reason !== "denied" && segment.reason !== "capture_failed";
}

function normalizeOperation(operation: string): CheckpointFileOperation {
  if (operation === "create" || operation === "delete") return operation;
  return "edit";
}
