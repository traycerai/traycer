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
 * THE TRACK MEASURES REPLAY TIME, NOT WALL TIME - the time PLAYBACK will spend
 * getting there, which is the only quantity a scrubber under a player is
 * actually about.
 *
 * It used to be wall time normalized to the session, and the note here claimed
 * "a long idle gap does not push every real exchange into a sliver", which was
 * simply untrue of `(t - start) / (end - start)`: an epic worked in bursts over
 * an afternoon rendered as five smears of unreadable ticks separated by half a
 * track of nothing, which is what round 2's feedback asked about ("why do we
 * have these big gaps in the timeline? it doesn't need the gaps").
 *
 * The transport has ALWAYS been event-paced: one row per tick, `BASE_STEP_MS`
 * each, whatever the real interval was. So a two-hour idle costs exactly one
 * step to cross and a two-hundred-millisecond reply costs the same step. An
 * axis that gave the idle half the bar was measuring something the player does
 * not spend. Each gap now contributes `min(gap, BASE_STEP_MS)`: one step is
 * the MOST a gap can be worth, however long the epic sat still.
 *
 * WHICH IS A CEILING, NOT A CONVERSION, and the difference is worth being
 * exact about. Every row costs one tick to replay, while the track gives it
 * `min(gap, BASE_STEP_MS)` - so a stretch of track never takes LONGER to cross
 * than it looks like it will, and for anything idler than a step the two are
 * equal. Below a step the track deliberately understates: four messages in the
 * same second cost four ticks to replay and are drawn almost on top of each
 * other, because that is what makes them four readable ticks rather than one.
 *
 * That understatement is the point of `commGraphTransportMarkers`'s refusal to
 * bucket - sub-step gaps are rendered PROPORTIONALLY, so four messages in a
 * second still pack tighter than four a second apart, and a pointer can still
 * land on one of them. What is TRIMMED is only the part of a gap that playback
 * refuses to replay, which is the part that was smearing the bursts into
 * unreadable smudges to begin with.
 *
 * A degenerate track (one row, or several sharing a millisecond) collapses to a
 * single point and every marker sits at the right edge - see
 * `commGraphTrackFraction`.
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

/**
 * One playback step, in milliseconds - the tick the cursor advances a row on at
 * 1x, and therefore the longest a single gap can be worth on the track.
 *
 * HERE RATHER THAN BESIDE THE TICK because it is now two things at once: the
 * transport's pace and the axis's unit. A copy in each would be a copy that
 * drifts, and the drift would be a scrubber that no longer described the
 * playback it sits under.
 *
 * Exported onwards by the transport hook, because an animated renderer has to
 * fit a per-row animation inside one step: reading the same constant is what
 * keeps an envelope from still being in flight when the cursor has moved on.
 */
export const BASE_STEP_MS = 700;

/**
 * The shortest tick playback will schedule, however fast it is asked to go.
 *
 * A step is not just a cursor write: the renderer draws a row's motion inside
 * it - an envelope crossing the floor, a character turning - and below about a
 * tenth of a second that motion is a flicker rather than a thing you can see
 * happen. Timers have a floor of their own near there too, so asking for a
 * twenty-millisecond tick buys nothing but a backlog.
 */
export const MIN_TICK_MS = 90;

export interface CommGraphPlaybackPace {
  /** Milliseconds between ticks. */
  readonly tickMs: number;
  /** How many rows the cursor advances on each tick. */
  readonly rowsPerTick: number;
}

/**
 * HOW FAST `speed` ACTUALLY PLAYS, once the tick floor is taken into account.
 *
 * Up to the floor, speed shortens the tick and the cursor still advances one
 * row at a time. Past it the tick STOPS shrinking and speed buys rows per tick
 * instead - so 16x really is four times 4x, rather than 4x with a shorter
 * timer that the timer refuses to honour.
 *
 * The cost of a multi-row tick is that the rows in the middle of one are never
 * drawn, so their envelopes never fly. That is the right trade at the speeds
 * that reach it: at 16x a row is on screen for forty-odd milliseconds, which is
 * already too short to watch anything cross a floor. What a reader is doing at
 * that speed is skimming to somewhere, and the graph still lands on every state
 * the moment they stop.
 */
export function commGraphPlaybackPace(speed: number): CommGraphPlaybackPace {
  const perRow = BASE_STEP_MS / Math.max(speed, Number.EPSILON);
  if (perRow >= MIN_TICK_MS) return { tickMs: perRow, rowsPerTick: 1 };
  // CEIL, NOT ROUND. Rounding to the NEAREST whole number of rows returns the
  // tick closest to the floor, which is as often just under it as just over -
  // at 16x and at 32x it returned 87.5ms, and a floor that the function
  // defining it steps through is not a floor. Ceiling costs a slightly longer
  // tick at those rungs and nothing else: `tickMs / rowsPerTick` is exactly
  // `perRow` either way, so the per-row pace this is measured by, and the
  // ladder's monotonicity with it, are untouched.
  const rowsPerTick = Math.max(1, Math.ceil(MIN_TICK_MS / perRow));
  return { tickMs: perRow * rowsPerTick, rowsPerTick };
}

/**
 * Where every captured row sits along the track, in replay milliseconds.
 *
 * `offsets[i]` is how much replay time separates row `i` from row zero, so the
 * array is non-decreasing and `totalMs` is its last entry. Built once per
 * change to the log rather than derived per marker: it is a prefix sum, and the
 * bar asks for a position n times a frame.
 */
export interface CommGraphTransportTrack {
  readonly offsets: ReadonlyArray<number>;
  readonly totalMs: number;
}

/**
 * `null` for an empty log - the caller renders a disabled track rather than
 * inventing one, because "no events yet" and "events spanning zero time" are
 * different situations and only one of them is scrubbable.
 */
export function commGraphTransportTrack(
  events: ReadonlyArray<CommGraphEvent>,
): CommGraphTransportTrack | null {
  if (events.length === 0) return null;
  const offsets: number[] = [0];
  let total = 0;
  for (let i = 1; i < events.length; i += 1) {
    // The array is sorted by `(timestamp, hostId, id)`, so a gap is never
    // negative - but two rows CAN share a millisecond, and clamping at zero
    // costs nothing and keeps the sum monotone whatever the merge produces.
    const gap = events[i].timestamp - events[i - 1].timestamp;
    total += Math.min(Math.max(gap, 0), BASE_STEP_MS);
    offsets.push(total);
  }
  return { offsets, totalMs: total };
}

/**
 * 0 at the track's start, 1 at its end, clamped outside.
 *
 * A ZERO-LENGTH TRACK RETURNS 1, deliberately: every row shares the newest
 * instant, so they all belong at the live edge. Returning 0 would park the
 * playhead at the left while the graph showed the newest state, which reads as
 * a broken scrubber rather than as a short session.
 */
function clampFraction(fraction: number): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 1;
  return fraction;
}

/**
 * The position of row `index`, as a fraction of the whole track.
 *
 * An index outside the log clamps to an end rather than throwing: the bar reads
 * this with whatever `commGraphCursorIndex` returned, and that resolves a
 * cursor naming an absent row rather than reporting one.
 */
export function commGraphTrackFraction(
  track: CommGraphTransportTrack,
  index: number,
): number {
  if (track.totalMs <= 0) return 1;
  if (index <= 0) return 0;
  const last = track.offsets.length - 1;
  if (index >= last) return 1;
  return clampFraction(track.offsets[index] / track.totalMs);
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
  track: CommGraphTransportTrack,
): ReadonlyArray<CommGraphTransportMarker> {
  return events.map((event, index) => ({
    key: commGraphEventKey(event),
    fraction: commGraphTrackFraction(track, index),
    event,
  }));
}

/**
 * Where the playhead sits. LIVE (`cursor === null`) is pinned to the right edge
 * - live is not a separate rendering mode, it is the playhead being at the end
 * of everything captured so far.
 *
 * THROUGH THE CURSOR'S ROW, not its timestamp. On a trimmed axis a bare
 * timestamp no longer locates anything: two rows an hour apart with nothing
 * between them are one step apart on the track, and there is no arithmetic that
 * recovers which of them a raw instant meant. `commGraphCursorIndex` already
 * answers that question - including for a cursor naming a row that is no longer
 * in the array - so the playhead asks it rather than inventing a second rule.
 */
export function commGraphPlayheadFraction(
  events: ReadonlyArray<CommGraphEvent>,
  cursor: CommGraphTimeCursor | null,
  track: CommGraphTransportTrack | null,
): number {
  if (track === null) return 1;
  if (cursor === null) return 1;
  return commGraphTrackFraction(track, commGraphCursorIndex(events, cursor));
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
  track: CommGraphTransportTrack,
  fraction: number,
): CommGraphEvent | null {
  if (events.length === 0) return null;
  const targetMs = track.totalMs * clampFraction(fraction);
  // Binary search the OFFSETS, which is the same search the old wall-clock axis
  // ran against timestamps - the axis moved, the rule did not. The cursor that
  // comes out is built from a real row, so the `(timestamp, hostId, id)`
  // tiebreak is inherited rather than guessed at.
  const offsets = track.offsets;
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] <= targetMs) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return events[0];
  // `offsets` is built from `events`, so an index into one indexes the other -
  // unless a caller paired a stale track with a newer log, which the bar cannot
  // do (it derives both from the same array in the same memo).
  return events[Math.min(low - 1, events.length - 1)];
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
