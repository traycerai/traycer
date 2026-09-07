/**
 * Scrubber geometry for the on-canvas transport: where the playhead sits, where each event's tick sits, and which event a click on the track means.
 */
import {
  commGraphEventKey,
  commGraphUpperBoundIndex,
} from "@/lib/comm-graph/comm-graph-timeline";
import {
  compareCommGraphSortKeys,
  type CommGraphEvent,
} from "@/lib/comm-graph/comm-graph-events";
import type { CommGraphTimeCursor } from "@/lib/comm-graph/comm-graph-timeline";

export interface CommGraphTimeRange {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * `null` for an empty log - the caller renders a disabled track rather than inventing a range, because "no events yet" and "events spanning zero time" are different situations and only one of them is scrubbable.
 */
export function commGraphTimeRange(
  events: ReadonlyArray<CommGraphEvent>,
): CommGraphTimeRange | null {
  if (events.length === 0) return null;
  // The array is sorted by `(timestamp, hostId, id)`, so the ends are the ends.
  return {
    startMs: events[0].timestamp,
    endMs: events[events.length - 1].timestamp,
  };
}

/** 0 at the range start, 1 at its end, clamped outside. */
function clampFraction(fraction: number): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 1;
  return fraction;
}

export function commGraphFractionForTimestamp(
  timestampMs: number,
  range: CommGraphTimeRange,
): number {
  const span = range.endMs - range.startMs;
  if (span <= 0) return 1;
  const fraction = (timestampMs - range.startMs) / span;
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 1;
  return fraction;
}

export interface CommGraphTransportMarker {
  /** Stable per-row identity - `id` is monotonic PER HOST, never globally. */
  readonly key: string;
  readonly fraction: number;
  readonly event: CommGraphEvent;
}

/**
 * One marker per event.
 * NO BUCKETING, NO THINNING: the ticks are the log, and dropping some because they crowd would quietly misreport how much happened.
 */
export function commGraphTransportMarkers(
  events: ReadonlyArray<CommGraphEvent>,
  range: CommGraphTimeRange,
): ReadonlyArray<CommGraphTransportMarker> {
  return events.map((event) => ({
    key: commGraphEventKey(event),
    fraction: commGraphFractionForTimestamp(event.timestamp, range),
    event,
  }));
}

/**
 * Where the playhead sits.
 * LIVE (`cursor === null`) is pinned to the right edge
 */
export function commGraphPlayheadFraction(
  cursor: CommGraphTimeCursor | null,
  range: CommGraphTimeRange | null,
): number {
  if (range === null) return 1;
  if (cursor === null) return 1;
  return commGraphFractionForTimestamp(cursor.timestamp, range);
}

/**
 * The row a click/drag at `fraction` means: the LAST event at or before that point, so seeking is "show me the graph as of here" rather than "jump to the nearest thing", and dragging left monotonically rewinds.
 */
export function commGraphEventAtFraction(
  events: ReadonlyArray<CommGraphEvent>,
  range: CommGraphTimeRange,
  fraction: number,
): CommGraphEvent | null {
  if (events.length === 0) return null;
  const span = range.endMs - range.startMs;
  const clamped = clampFraction(fraction);
  const targetMs = range.startMs + span * clamped;
  // Binary search on timestamp only: the cursor that comes out of this is built from a real row, so the `(timestamp, hostId, id)` tiebreak is inherited rather than guessed at.
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid].timestamp <= targetMs) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return events[0];
  return events[low - 1];
}

/** Whether a cursor names the newest captured row. */
export function commGraphCursorAtEnd(
  events: ReadonlyArray<CommGraphEvent>,
  cursor: CommGraphTimeCursor | null,
): boolean {
  if (cursor === null) return true;
  if (events.length === 0) return true;
  return compareCommGraphSortKeys(cursor, events[events.length - 1]) >= 0;
}

/**
 * The cursor's position in the array, as an index - what the slider reports and what stepping arithmetic works in.
 */
export function commGraphCursorIndex(
  events: ReadonlyArray<CommGraphEvent>,
  cursor: CommGraphTimeCursor | null,
): number {
  if (events.length === 0) return -1;
  if (cursor === null) return events.length - 1;
  const upper = commGraphUpperBoundIndex(events, cursor);
  // Before every row: the graph is as-of the first row, never as-of nothing.
  return upper === 0 ? 0 : upper - 1;
}
