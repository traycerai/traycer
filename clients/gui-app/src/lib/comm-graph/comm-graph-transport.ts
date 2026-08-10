/**
 * Scrubber geometry for the on-canvas transport: where the playhead sits, where
 * each event's tick sits, and which event a click on the track means.
 *
 * PURE, and separated from the bar that draws it, because jsdom gives no layout
 * - a component test can prove a marker element exists but not that it is in the
 * right place. Everything positional is decided here, in functions that take
 * numbers and return numbers, and the component only spends the fractions.
 *
 * FRACTIONS, NOT PIXELS. The track is fluid, so positions are 0..1 along it and
 * the DOM turns them into percentages. Nothing here knows the track's width.
 *
 * THE TRACK IS EVENT TIME, NOT WALL TIME. It spans the first captured row to
 * the last, so a quiet epic does not render as a single tick pinned to one end,
 * and a long idle gap does not push every real exchange into a sliver. A degenerate
 * range (one row, or several sharing a millisecond) collapses to a single point
 * and every marker sits at the right edge - see `commGraphFractionForTimestamp`.
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
 * `null` for an empty log - the caller renders a disabled track rather than
 * inventing a range, because "no events yet" and "events spanning zero time"
 * are different situations and only one of them is scrubbable.
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

/**
 * 0 at the range start, 1 at its end, clamped outside.
 *
 * A ZERO-WIDTH RANGE RETURNS 1, deliberately: every row shares the newest
 * instant, so they all belong at the live edge. Returning 0 would park the
 * playhead at the left while the graph showed the newest state, which reads as
 * a broken scrubber rather than as a short session.
 */
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
 * One marker per event. NO BUCKETING, NO THINNING: the ticks are the log, and
 * dropping some because they crowd would quietly misreport how much happened.
 * Overlapping ticks at this size read as density, which is the honest picture.
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
 * Where the playhead sits. LIVE (`cursor === null`) is pinned to the right edge
 * - live is not a separate rendering mode, it is the playhead being at the end
 * of everything captured so far.
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
 * The row a click/drag at `fraction` means: the LAST event at or before that
 * point, so seeking is "show me the graph as of here" rather than "jump to the
 * nearest thing", and dragging left monotonically rewinds.
 *
 * Before the first event there is nothing to be as-of, so the first row is the
 * floor - a seek can land the cursor on row one but never behind it (that
 * position is what `followLive`/the right edge means, not an empty graph).
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
  // Binary search on timestamp only: the cursor that comes out of this is built
  // from a real row, so the `(timestamp, hostId, id)` tiebreak is inherited
  // rather than guessed at.
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

/**
 * Whether a cursor names the newest captured row.
 *
 * This is what "scrubbing to the end re-attaches live" is decided by, and it is
 * a comparison against the LOG rather than against the track: a row landing
 * while the user sits at the old end must leave them detached, not silently
 * drag them forward.
 */
export function commGraphCursorAtEnd(
  events: ReadonlyArray<CommGraphEvent>,
  cursor: CommGraphTimeCursor | null,
): boolean {
  if (cursor === null) return true;
  if (events.length === 0) return true;
  return compareCommGraphSortKeys(cursor, events[events.length - 1]) >= 0;
}

/**
 * The cursor's position in the array, as an index - what the slider reports and
 * what stepping arithmetic works in.
 *
 * LIVE IS THE LAST INDEX, not a sentinel: live means "as of the newest row", so
 * it occupies the same slot the newest row does. That is what makes stepping
 * forward off the end and re-attaching the same motion.
 *
 * A cursor naming a row that is not present (it never was, or the array has
 * been re-merged) resolves to the last row at or before it, matching the as-of
 * projection rather than reporting "not found".
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
