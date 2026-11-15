import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";

/** Lays a surface's timed items among its rows; see `createTimedLineCollator`. */
export type TimedLineCollator<T> = (
  rows: readonly TranscriptListRow[],
  items: ReadonlyArray<T>,
) => readonly TranscriptListRow[];

/** What a kind of line needs from its items. */
export interface TimedLineSpec<T> {
  readonly timeOf: (item: T) => number;
  /** A line's key, kept while its run grows: derive it from the run's first item. */
  readonly keyOf: (run: ReadonlyArray<T>) => string;
  /** Whether two runs draw the same line, so the earlier model can be kept. */
  readonly sameRun: (
    before: ReadonlyArray<T>,
    after: ReadonlyArray<T>,
  ) => boolean;
  readonly lineRowOf: (run: ReadonlyArray<T>) => TranscriptListRow;
}

/** A line and the index of the row it goes before (`rows.length`: last). */
interface PlacedLine {
  readonly before: number;
  readonly line: TranscriptListRow;
}

/** A line as last drawn, and the run it was drawn from. */
interface DrawnLine<T> {
  readonly run: ReadonlyArray<T>;
  readonly line: TranscriptListRow;
}

/**
 * Things that happened between a surface's rows, drawn as lines among them,
 * as Slack draws members joining a channel (Tracy Bots, decision 174): a run
 * of items with no row of the list between them is ONE line, placed by time
 * among the rows. A row closes the run, and the next item opens a fresh line;
 * while a line is the last row, each new item folds into it, because nothing
 * has closed its run.
 *
 * `items` are oldest first. A row is placed by `createdAt`, and an item goes
 * before the first row that came after it. The lines own no ordinal, so
 * hydration, the minimap and find, which read ordinals and roles, see none of
 * them.
 *
 * A placeholder's time is not known, so the items between the last row drawn
 * before it and the next row drawn after it have no place yet: they are left
 * out until the rows around them hydrate, rather than collated across rows
 * nobody can see.
 *
 * The collator remembers what it drew last. A streamed token changes a row's
 * body and no row's place, so while the rows keep their kinds and times and
 * `items` is the same array, it lays the lines it already has back among the
 * new rows without reading an item. When the placement does move, a line
 * whose run is unchanged keeps its model, so the list redraws only the lines
 * that changed.
 */
export function createTimedLineCollator<T>(
  spec: TimedLineSpec<T>,
): TimedLineCollator<T> {
  let lastRows: readonly TranscriptListRow[] = [];
  let lastItems: ReadonlyArray<T> | null = null;
  let placed: readonly PlacedLine[] = [];
  let drawn = new Map<string, DrawnLine<T>>();
  return (rows, items) => {
    if (items.length === 0) {
      lastItems = items;
      lastRows = rows;
      placed = [];
      drawn = new Map();
      return rows;
    }
    if (items !== lastItems || !sameBoundaries(lastRows, rows)) {
      const next = new Map<string, DrawnLine<T>>();
      placed = placeRuns(rows, items, spec.timeOf).map(({ before, run }) => {
        const line = lineFor(spec, run, drawn);
        next.set(line.key, { run, line });
        return { before, line };
      });
      drawn = next;
      lastItems = items;
    }
    lastRows = rows;
    return interleave(rows, placed);
  };
}

/**
 * A line's row: a system row with the one special segment it draws, placed
 * at its run's first time, with no ordinal.
 */
export function timedLineRow(
  key: string,
  segment: MessageSegment,
  createdAt: number,
): TranscriptListRow {
  const model: ChatMessageModel = {
    id: key,
    role: "system",
    content: "",
    segments: [segment],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    runState: null,
    agentSenderInfo: null,
    agentMessage: null,
    sessionAnchor: null,
    steerBadge: null,
  };
  return { kind: "hydrated", key, ordinal: null, model, part: null };
}

/** The rows sit where they sat: same count, kinds and times, body aside. */
function sameBoundaries(
  previous: readonly TranscriptListRow[],
  rows: readonly TranscriptListRow[],
): boolean {
  if (previous.length !== rows.length) return false;
  for (let index = 0; index < rows.length; index += 1) {
    const before = previous[index];
    const after = rows[index];
    if (before === after) continue;
    if (before.kind !== after.kind) return false;
    if (
      before.kind === "hydrated" &&
      after.kind === "hydrated" &&
      before.model.createdAt !== after.model.createdAt
    ) {
      return false;
    }
  }
  return true;
}

function placeRuns<T>(
  rows: readonly TranscriptListRow[],
  items: ReadonlyArray<T>,
  timeOf: (item: T) => number,
): Array<{ readonly before: number; readonly run: T[] }> {
  const runs: Array<{ readonly before: number; readonly run: T[] }> = [];
  let next = 0;
  let unplaceable = false;
  const takeRunBefore = (time: number): T[] => {
    const run: T[] = [];
    while (next < items.length && timeOf(items[next]) < time) {
      run.push(items[next]);
      next += 1;
    }
    return run;
  };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === "placeholder") {
      unplaceable = true;
      continue;
    }
    const run = takeRunBefore(row.model.createdAt);
    if (run.length > 0 && !unplaceable) runs.push({ before: index, run });
    unplaceable = false;
  }
  const trailing = takeRunBefore(Number.POSITIVE_INFINITY);
  if (trailing.length > 0 && !unplaceable) {
    runs.push({ before: rows.length, run: trailing });
  }
  return runs;
}

function interleave(
  rows: readonly TranscriptListRow[],
  placed: readonly PlacedLine[],
): readonly TranscriptListRow[] {
  if (placed.length === 0) return rows;
  const merged: TranscriptListRow[] = [];
  let line = 0;
  rows.forEach((row, index) => {
    while (line < placed.length && placed[line].before === index) {
      merged.push(placed[line].line);
      line += 1;
    }
    merged.push(row);
  });
  for (; line < placed.length; line += 1) merged.push(placed[line].line);
  return merged;
}

/** The line drawn last for the same run, or a fresh one. */
function lineFor<T>(
  spec: TimedLineSpec<T>,
  run: ReadonlyArray<T>,
  drawn: ReadonlyMap<string, DrawnLine<T>>,
): TranscriptListRow {
  const previous = drawn.get(spec.keyOf(run));
  return previous !== undefined && spec.sameRun(previous.run, run)
    ? previous.line
    : spec.lineRowOf(run);
}
