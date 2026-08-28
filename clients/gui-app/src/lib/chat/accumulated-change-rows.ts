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
  /**
   * Where this row's diff lives when the CUMULATIVE surfaces cannot answer for
   * it, or `null` when they can.
   *
   * Non-null on exactly one kind of row: the client's own view of a file the
   * active turn is writing, which no host summary covers and no inline change
   * carries. Cumulative resolution addresses a file either by `digest` or by
   * the host's inline change array, and that row has neither - so a cumulative
   * open resolves to nothing and the tile can only say source-unavailable.
   *
   * The edit's `file_change` blocks ARE hydrated (the row is on screen because
   * they are), so the diff is reachable through the segment tile that addresses
   * them by block id. This is that address, in the shape
   * `ChatSnapshotDiffOpener.segment` takes.
   */
  readonly liveDiff: {
    readonly sourceBlockIds: SnapshotSourceBlockIds;
    readonly beforeHash: string | null;
    readonly afterHash: string | null;
  } | null;
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
    // Contents rode the snapshot; `resolveSnapshotDiffContent` finds them in
    // the inline change array this row was built from.
    liveDiff: null,
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
    // A summary always names a host version, so the cumulative fetch answers.
    liveDiff: null,
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
 * Whether the delivered summary set AGREES with the host's authoritative count.
 *
 * Separate from {@link undeliveredHostChangeCount} because the two questions
 * differ in exactly the case that goes wrong. That one answers "how many rows
 * are still missing", so it clamps at zero - a shortfall is a number the panel
 * shows. This one answers "is the set trustworthy", and an OVERSHOOT is an
 * emphatic no: a revert lowers `accumulatedFileChangeCount` while the client
 * retains the previous summary array until a replacement chunk starting at
 * index 0 arrives, so a dropped first chunk leaves MORE summaries than the
 * count. The clamp turns that into `0`, which every gate reads as "complete"
 * and none of them can distinguish from a genuinely finished stream.
 *
 * Every visibility and action gate over the summary set reads this, so the
 * three of them cannot drift into three different definitions of complete.
 */
export function accumulatedSummarySetComplete(input: {
  readonly windowed: boolean;
  readonly hostChangeCount: number;
  readonly deliveredSummaryCount: number;
  /**
   * Whether any chunk of the CURRENT generation has been accepted - see
   * `ChatSessionState.accumulatedSummaryGenerationSeated`.
   */
  readonly generationSeated: boolean;
}): boolean {
  // The legacy line ships the whole set on the snapshot; there is no stream to
  // be mid-way through.
  if (!input.windowed) return true;
  // GENERATION before length, because length cannot see this state at all. A
  // rebuild resets the generation while the previous stream's array is
  // deliberately retained, so until a replacement chunk lands that array is the
  // OLD generation's - with the old digests. When the replacement's
  // authoritative total happens to equal the retained length, the equality
  // below is true over entries this generation never sent: every content fetch
  // then returns `stale`, and no length-based check can distinguish it from a
  // finished delivery. Certain, not incidental, whenever the whole set fits one
  // chunk and that chunk is the one dropped.
  if (!input.generationSeated && input.hostChangeCount > 0) return false;
  return input.hostChangeCount === input.deliveredSummaryCount;
}

/**
 * Merge the host's rows with what the ACTIVE turn is writing right now.
 *
 * The host recomputes its accumulated set at turn boundaries, so mid-turn it is
 * one turn behind: a file the running turn has just created is not in it at
 * all. Walking the rendered messages supplies those missing rows.
 *
 * ## The HOST list is the order, not the rendered rows
 *
 * The panel's documented order is first-touched across the whole chat, and the
 * host's list is already exactly that - `computeAccumulatedFileChanges` walks
 * `earliestEntriesByPath(chat.events)`, whose insertion order IS whole-history
 * first touch. Deriving the order from the rendered rows instead agreed with it
 * only while those rows WERE the whole chat.
 *
 * On the windowed line they are not: `messages` is the hydrated tail, so every
 * file the recent turns touched sorted ahead of files first touched earlier in
 * unhydrated history, and the panel resorted itself as spans hydrated and were
 * evicted. Taking the host's order fixes that at the root and needs no
 * line-conditional, because the host's answer is the same definition on both.
 *
 * What the rendered rows still supply is the TAIL of the list: a path the host
 * has no row for is one no completed turn has touched, so the active turn is
 * its first toucher and it belongs after everything the host knows.
 *
 * (A file reverted mid-chat leaves the host's list and re-enters at its true
 * first-touch position on the next refresh, so it appears at the end for the
 * rest of the running turn. Same reorder the previous shape had, and the host's
 * refresh is what settles it either way.)
 *
 * A host row WINS wholesale wherever one exists. That is deliberate and
 * predates this: mid-turn the host's number is one turn stale, and showing a
 * stale number for a file the host knows beats showing a per-edit number that
 * means something different from every other row in the list.
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

/**
 * The active turn's file edits, merged per path, in the order it touched them.
 *
 * A `Map` rather than a set plus a parallel array: insertion order IS the
 * first-touch order this returns, and the lookup the caller needs comes free.
 */
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

/**
 * The client's own row for a file no host version names yet.
 *
 * Its counts are the per-edit magnitudes summed across the turn, which is what
 * lets the panel move on every edit rather than sit at nothing until the turn
 * ends. `null` when the active edit is a net no-op (equal content-addressed
 * endpoints).
 *
 * Only reached for a path the host has no row for; where it has one, that row
 * wins wholesale and this is never consulted.
 */
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
    // The blocks exist, so a diff IS openable - through the SEGMENT tile, which
    // addresses them by block id. Carrying that address is what makes the row
    // clickable: a `null` digest and no host entry means cumulative resolution
    // has nothing to resolve, so a cumulative open could only ever land on
    // source-unavailable.
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
