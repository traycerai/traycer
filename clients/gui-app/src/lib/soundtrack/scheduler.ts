import { spanHolds, spanOf, turnsOf, type VariantSpan } from "./variant-groups";
import type {
  Layer,
  LayerProperties,
  Range,
  State,
  VariableTrack,
  WeightedRange,
} from "./variable-sound";

/** A uniform draw in [0, 1). */
export type RandomSource = () => number;

export interface ScheduledPlay {
  readonly layerIndex: number;
  readonly sublayerIndex: number;
  /**
   * 1-based, as `Layer.variants` counts them; a grouped layer numbers its
   * groups' variants on from one group to the next.
   */
  readonly variant: number;
  /** Track time, on the grid. */
  readonly startAt: number;
}

export interface TrackSchedulerOptions {
  readonly track: VariableTrack;
  readonly state: State;
  readonly random: RandomSource;
  /** Applied from the first draw; change it later with `setPauseMultiplier`. */
  readonly pauseMultiplier: number;
}

/** A sample's place in its layer's order of starts. */
interface LayerStart {
  readonly startAt: number;
  readonly variant: number;
}

/**
 * Which sublayer a cursor is for, and what it has done in this run, which a
 * state move or a resume keeps.
 */
interface CursorOrigin {
  readonly layer: Layer;
  readonly layerIndex: number;
  readonly sublayerIndex: number;
  /** Sequences it has started, which `playsPerRun` caps. */
  readonly sequencesStarted: number;
  /** Its place in the layer's turns of groups. */
  readonly turn: number;
}

interface SublayerCursor {
  readonly layerIndex: number;
  readonly sublayerIndex: number;
  readonly layer: Layer;
  readonly properties: LayerProperties;
  /** The groups in the order they take turns; one pool on a pooled layer. */
  readonly turns: readonly VariantSpan[];
  /** Earliest track time of the next sample, before snapping to the grid. */
  nextAt: number;
  samplesLeftInSequence: number;
  /** Whether a sample of the sequence under way has played or been skipped. */
  inSequence: boolean;
  sequencesStarted: number;
  turn: number;
  /** Decided and handed out, its duration not back yet. */
  pending: ScheduledPlay | null;
  /** The variant it last started, so not a draw that was skipped or sent back. */
  lastVariant: number | null;
  /**
   * When its last reported sample ends, a skipped one ending where it starts;
   * a state entered meanwhile waits for it.
   */
  soundingUntil: number;
}

// A value already on the grid must stay on its tick; without this, 0.3 / 0.1
// reads as just over 3 and would snap one tick late.
const GRID_TOLERANCE = 1e-9;

export function drawSeconds(range: Range, random: RandomSource): number {
  return range[0] + random() * (range[1] - range[0]);
}

function isRange(pause: Range | readonly WeightedRange[]): pause is Range {
  return typeof pause[0] === "number";
}

/** A row by its weight; one of weight 0 or less is never picked. */
function pickRow(table: readonly WeightedRange[], random: RandomSource): Range {
  const total = table.reduce((sum, row) => sum + Math.max(row.weight, 0), 0);
  let left = random() * total;
  let picked = table[0].range;
  for (const row of table) {
    if (row.weight <= 0) continue;
    // The last row that can be picked stands if rounding leaves a sliver over.
    picked = row.range;
    if (left < row.weight) break;
    left -= row.weight;
  }
  return picked;
}

/** One range drawn uniformly, or a table's row picked by weight and drawn. */
function drawPause(
  pause: Range | readonly WeightedRange[],
  random: RandomSource,
): number {
  return drawSeconds(isRange(pause) ? pause : pickRow(pause, random), random);
}

function drawCount(range: Range, random: RandomSource): number {
  return Math.floor(range[0] + random() * (range[1] - range[0] + 1));
}

/** The grid tick at or after `trackTime`. */
export function snapUp(trackTime: number, alignment: number): number {
  // Math.max because the ceiling of a tiny negative is -0.
  return Math.max(
    0,
    Math.ceil(trackTime / alignment - GRID_TOLERANCE) * alignment,
  );
}

function tickAfter(trackTime: number, alignment: number): number {
  return (Math.floor(trackTime / alignment + GRID_TOLERANCE) + 1) * alignment;
}

function playedOut(
  properties: LayerProperties,
  sequencesStarted: number,
): boolean {
  return (
    properties.playsPerRun !== null &&
    sequencesStarted >= properties.playsPerRun
  );
}

/** Layers the state fixes on, then as many of the rest as the count leaves. */
function rollEnabledLayers(state: State, random: RandomSource): boolean[] {
  const fixed = state.layersProperties.map((properties) => properties.enabled);
  const free = fixed.flatMap((enabled, index) =>
    enabled === null ? [index] : [],
  );
  const fixedOn = fixed.filter((enabled) => enabled === true).length;
  const count = Math.min(
    Math.max(drawCount(state.numberOfEnabledLayers, random) - fixedOn, 0),
    free.length,
  );
  const order = [...free];
  const enabled = fixed.map((on) => on === true);
  for (let picked = 0; picked < count; picked += 1) {
    const swap = picked + Math.floor(random() * (order.length - picked));
    [order[picked], order[swap]] = [order[swap], order[picked]];
    enabled[order[picked]] = true;
  }
  return enabled;
}

/**
 * The variants a sample at `startAt` must not be: whatever starts on that very
 * tick, or else the start just before it, and the start just after it.
 */
function neighbourVariants(
  starts: readonly LayerStart[],
  startAt: number,
): ReadonlySet<number> {
  const ordered = starts.toSorted((a, b) => a.startAt - b.startAt);
  const sameTick = ordered.filter((start) => start.startAt === startAt);
  const neighbours = [
    ...(sameTick.length > 0
      ? sameTick
      : ordered.filter((start) => start.startAt < startAt).slice(-1)),
    ...ordered.filter((start) => start.startAt > startAt).slice(0, 1),
  ];
  return new Set(neighbours.map((start) => start.variant));
}

function assertStateFitsTrack(track: VariableTrack, state: State): void {
  if (state.layersProperties.length !== track.layers.length) {
    throw new Error(
      `State "${state.name}" of track "${track.name}" has ${String(state.layersProperties.length)} layer properties for ${String(track.layers.length)} layers`,
    );
  }
  for (const { pauseBetweenRepetitions: pause } of state.layersProperties) {
    if (!isRange(pause) && !pause.some((row) => row.weight > 0)) {
      throw new Error(
        `State "${state.name}" of track "${track.name}" has a pause table with no row to pick`,
      );
    }
  }
}

/**
 * Decides which sample starts when, in track time, for one track. It holds no
 * audio and no clock: a consumer asks with `advance`, and reports each decided
 * sample back with `confirm` or `skip`, because a sample's length comes from
 * decoded audio and places the next one on that sublayer. Until the report
 * arrives, that sublayer decides nothing further.
 */
export class TrackScheduler {
  private readonly track: VariableTrack;
  private readonly random: RandomSource;
  private state: State;
  /** The state still in force until a move to `state` reaches its tick. */
  private outgoing: { readonly state: State; readonly until: number } | null =
    null;
  private enabled: boolean[];
  private pauseMultiplier: number;
  private cursors: SublayerCursor[] = [];
  /** Where the last restart put the layers, which a move never goes before. */
  private restartedFrom = 0;
  /**
   * Per layer, the starts confirmed so far, in which no variant is ever beside
   * itself. Rule 2 is about what is heard, and a pending play may yet move or be
   * skipped, so it never separates two of these.
   */
  private confirmedByLayer: LayerStart[][] = [];
  /** Each play reported, and whether it opened a sequence, for `takeBack`. */
  private readonly counted = new WeakMap<ScheduledPlay, boolean>();

  constructor(options: TrackSchedulerOptions) {
    const { track, state } = options;
    assertStateFitsTrack(track, state);
    this.track = track;
    this.state = state;
    this.random = options.random;
    this.pauseMultiplier = options.pauseMultiplier;
    this.enabled = rollEnabledLayers(state, options.random);
    this.restartAt(0);
  }

  /**
   * Starts every sublayer over from `trackTime` with fresh start pauses, as a
   * resume does, and no later move starts one earlier. The state and the
   * enabled flags stand, and so does what the run has played, whatever
   * `trackTime` is: a layer that has had its `playsPerRun` stays quiet, and a
   * grouped layer goes on with the group that was due. Only `takeBack` gives a
   * play back. A play still awaiting its report is forgotten, and reporting it
   * later does nothing.
   */
  restartAt(trackTime: number): void {
    this.outgoing = null;
    this.restartedFrom = trackTime;
    this.confirmedByLayer = this.track.layers.map(() => []);
    const previous = this.cursors;
    this.cursors = this.track.layers.flatMap((layer, layerIndex) =>
      Array.from({ length: layer.sublayers }, (_, sublayerIndex) => {
        const cursor = previous.find(
          (candidate) =>
            candidate.layerIndex === layerIndex &&
            candidate.sublayerIndex === sublayerIndex,
        );
        return this.createCursor(
          {
            layer,
            layerIndex,
            sublayerIndex,
            sequencesStarted: cursor?.sequencesStarted ?? 0,
            turn: cursor?.turn ?? 0,
          },
          trackTime,
        );
      }),
    );
  }

  /**
   * A stop cut these plays before they sounded, so each gives back what it
   * counted: its turn of the groups, and the sequence it opened, if it did. The
   * plays the stop let sound stand for the rest of the run. Pass every play the
   * stop cut and no other; one this scheduler did not count, or has taken back
   * already, changes nothing. The sublayers go on from the next `restartAt`.
   */
  takeBack(plays: readonly ScheduledPlay[]): void {
    for (const play of plays) {
      const opened = this.counted.get(play);
      const cursor = this.cursors.find(
        (candidate) =>
          candidate.layerIndex === play.layerIndex &&
          candidate.sublayerIndex === play.sublayerIndex,
      );
      if (opened === undefined || cursor === undefined) continue;
      this.counted.delete(play);
      // A sublayer's plays start in the order it reports them, so the ones a
      // stop cut are its latest, and a step back for each lands on the first.
      cursor.turn =
        (cursor.turn + cursor.turns.length - 1) % cursor.turns.length;
      if (opened) cursor.sequencesStarted -= 1;
    }
  }

  /**
   * Moves to `state` on the next grid tick after `trackTime`, as a state start:
   * enabled layers are rolled now, so the caller can override them right after,
   * and every sublayer waits a fresh start pause. It waits from that tick, or
   * from the end of the sample it has sounding, which plays out, and never from
   * before where the last restart put it. No sublayer sits out a pause drawn
   * from the old state, and none overlaps itself. A play still awaiting its
   * report is forgotten, as in `restartAt`; one already decided and reported
   * still starts, within the player's lookahead.
   */
  enterState(state: State, trackTime: number): void {
    assertStateFitsTrack(this.track, state);
    const landsAt = tickAfter(trackTime, this.track.alignmentSeconds);
    this.outgoing = { state: this.stateAt(trackTime), until: landsAt };
    this.state = state;
    this.enabled = rollEnabledLayers(state, this.random);
    this.cursors = this.cursors.map((cursor) => ({
      ...this.createCursor(
        cursor,
        Math.max(landsAt, cursor.soundingUntil, this.restartedFrom),
      ),
      // The samples either side of the move are still back to back.
      lastVariant: cursor.lastVariant,
      soundingUntil: cursor.soundingUntil,
    }));
  }

  /** The state in force at `trackTime`; a move counts from the tick it lands on. */
  stateAt(trackTime: number): State {
    return this.outgoing !== null && trackTime < this.outgoing.until
      ? this.outgoing.state
      : this.state;
  }

  /** The state new decisions draw from, which a move switches at once. */
  decidingState(): State {
    return this.state;
  }

  enabledLayers(): readonly boolean[] {
    return this.enabled;
  }

  /**
   * The caller's override. The scheduler writes the flags only when rolling. A
   * layer that is off decides nothing, and its next sample stays where it was:
   * if that time goes by meanwhile, `confirm` moves the sample to the next tick.
   * A layer the state fixes on or off keeps that, whatever the caller asks.
   */
  setLayerEnabled(layerIndex: number, enabled: boolean): void {
    if (this.state.layersProperties[layerIndex].enabled !== null) return;
    this.enabled[layerIndex] = enabled;
  }

  /** Scales the pause draws from here on; waits already drawn stand. */
  setPauseMultiplier(multiplier: number): void {
    this.pauseMultiplier = multiplier;
  }

  /** Decides the plays that start at or before `untilTrackTime`. */
  advance(untilTrackTime: number): readonly ScheduledPlay[] {
    const alignment = this.track.alignmentSeconds;
    const plays: ScheduledPlay[] = [];
    for (const cursor of this.cursors) {
      if (cursor.pending !== null || cursor.nextAt > untilTrackTime) continue;
      if (!this.enabled[cursor.layerIndex]) continue;
      const startAt = snapUp(cursor.nextAt, alignment);
      if (startAt >= this.track.lengthSeconds) {
        cursor.nextAt = Number.POSITIVE_INFINITY;
        continue;
      }
      if (startAt > untilTrackTime) continue;
      const variant = this.pickVariant(cursor, startAt);
      if (variant === null) {
        cursor.nextAt = tickAfter(startAt, alignment);
        continue;
      }
      const play: ScheduledPlay = {
        layerIndex: cursor.layerIndex,
        sublayerIndex: cursor.sublayerIndex,
        variant,
        startAt,
      };
      cursor.pending = play;
      plays.push(play);
    }
    return plays;
  }

  /**
   * The sample is ready and `durationSeconds` long. Answers the track time it
   * starts at, which is later than decided if its audio came back after
   * `notBeforeTrackTime` passed its tick: the same variant then takes the next
   * tick rather than being dropped, so that a slow first decode does not spend
   * the rest of the pool on samples that all arrive late too. Answers null if
   * it must not start: past the track's end, forgotten by `restartAt`, or beside
   * a confirmed start of the same variant in its group, as it can be when it
   * moved or when the play between them has not reported. In that last case the
   * sublayer draws again on the next tick, from the same group.
   */
  confirm(
    play: ScheduledPlay,
    durationSeconds: number,
    notBeforeTrackTime: number,
  ): number | null {
    const cursor = this.claimPending(play);
    if (cursor === null) return null;
    const startAt =
      play.startAt >= notBeforeTrackTime
        ? play.startAt
        : snapUp(notBeforeTrackTime, this.track.alignmentSeconds);
    if (startAt >= this.track.lengthSeconds) {
      cursor.nextAt = Number.POSITIVE_INFINITY;
      return null;
    }
    const group = spanOf(cursor.layer, play.variant);
    if (
      group.count > 1 &&
      neighbourVariants(
        this.confirmedByLayer[play.layerIndex].filter((start) =>
          spanHolds(group, start.variant),
        ),
        startAt,
      ).has(play.variant)
    ) {
      cursor.nextAt = tickAfter(startAt, this.track.alignmentSeconds);
      return null;
    }
    this.confirmedByLayer[play.layerIndex].push({
      startAt,
      variant: play.variant,
    });
    cursor.lastVariant = play.variant;
    cursor.soundingUntil = startAt + durationSeconds;
    this.placeNext(cursor, play, startAt, durationSeconds);
    return startAt;
  }

  /**
   * The sample cannot play. It still counts in its sequence, as a sample with
   * no length, so a missing stem leaves a hole and not a shift in the layer.
   */
  skip(play: ScheduledPlay): void {
    const cursor = this.claimPending(play);
    if (cursor === null) return;
    // A move still waits for the hole, so no later report starts before it.
    cursor.soundingUntil = play.startAt;
    this.placeNext(cursor, play, play.startAt, 0);
  }

  private createCursor(
    origin: CursorOrigin,
    fromTrackTime: number,
  ): SublayerCursor {
    const { layer, layerIndex, sublayerIndex } = origin;
    const properties = this.state.layersProperties[layerIndex];
    // The offset separates sublayers, so a busy mix's shorter pauses leave it.
    const offset =
      sublayerIndex > 0 && layer.sublayerStartingOffset !== null
        ? drawSeconds(layer.sublayerStartingOffset, this.random)
        : 0;
    const nextAt =
      fromTrackTime +
      drawSeconds(properties.startPause, this.random) * this.pauseMultiplier +
      offset;
    return {
      layerIndex,
      sublayerIndex,
      layer,
      properties,
      turns: turnsOf(layer),
      // A sequence a move cut short counts as played.
      nextAt: playedOut(properties, origin.sequencesStarted)
        ? Number.POSITIVE_INFINITY
        : nextAt,
      samplesLeftInSequence: drawCount(properties.sequenceLength, this.random),
      inSequence: false,
      sequencesStarted: origin.sequencesStarted,
      turn: origin.turn,
      pending: null,
      lastVariant: null,
      soundingUntil: 0,
    };
  }

  /** What the layer has confirmed, and what it has decided but not heard yet. */
  private startsOfLayer(layerIndex: number): readonly LayerStart[] {
    return [
      ...this.confirmedByLayer[layerIndex],
      ...this.cursors.flatMap((cursor) =>
        cursor.layerIndex === layerIndex && cursor.pending !== null
          ? [cursor.pending]
          : [],
      ),
    ];
  }

  private claimPending(play: ScheduledPlay): SublayerCursor | null {
    const cursor = this.cursors.find((candidate) => candidate.pending === play);
    if (cursor === undefined) return null;
    cursor.pending = null;
    return cursor;
  }

  /**
   * A variant of the group whose turn it is (a pooled layer is one group).
   * Never one beside the same one, in the order the group's samples are heard,
   * nor where there are enough variants the sublayer's own last: the first is
   * the rule, and the second keeps a sublayer from repeating itself around its
   * neighbour. The starts confirmed either side count with no regard for a
   * pending play between them, which separates nothing; pending plays count
   * too, so that they do not clash when they report. Answers null if no variant
   * can start on this tick.
   */
  private pickVariant(cursor: SublayerCursor, startAt: number): number | null {
    const group = cursor.turns[cursor.turn];
    if (group.count === 1) return group.first;
    const inGroup = (start: LayerStart): boolean =>
      spanHolds(group, start.variant);
    const taken = new Set([
      ...neighbourVariants(
        this.confirmedByLayer[cursor.layerIndex].filter(inGroup),
        startAt,
      ),
      ...neighbourVariants(
        this.startsOfLayer(cursor.layerIndex).filter(inGroup),
        startAt,
      ),
    ]);
    const others = Array.from(
      { length: group.count },
      (_, index) => group.first + index,
    ).filter((variant) => !taken.has(variant));
    if (others.length === 0) return null;
    const fresh = others.filter((variant) => variant !== cursor.lastVariant);
    const pool = fresh.length > 0 ? fresh : others;
    return pool[Math.floor(this.random() * pool.length)];
  }

  private placeNext(
    cursor: SublayerCursor,
    play: ScheduledPlay,
    startAt: number,
    durationSeconds: number,
  ): void {
    // It has had its turn, so any still waiting decide ahead of it. In a fixed
    // order, the first sublayers could take every variant on every tick and a
    // later one would never play.
    this.cursors = [
      ...this.cursors.filter((other) => other !== cursor),
      cursor,
    ];
    const { properties } = cursor;
    cursor.turn = (cursor.turn + 1) % cursor.turns.length;
    this.counted.set(play, !cursor.inSequence);
    if (!cursor.inSequence) {
      cursor.inSequence = true;
      cursor.sequencesStarted += 1;
    }
    cursor.samplesLeftInSequence -= 1;
    let pause: Range | readonly WeightedRange[] =
      properties.pauseBetweenSamples;
    if (cursor.samplesLeftInSequence <= 0) {
      cursor.inSequence = false;
      if (playedOut(properties, cursor.sequencesStarted)) {
        cursor.nextAt = Number.POSITIVE_INFINITY;
        return;
      }
      cursor.samplesLeftInSequence = drawCount(
        properties.sequenceLength,
        this.random,
      );
      pause = properties.pauseBetweenRepetitions;
    }
    const nextAt =
      startAt +
      durationSeconds +
      drawPause(pause, this.random) * this.pauseMultiplier;
    // A sample with no length and no pause must not take the same tick again.
    cursor.nextAt =
      nextAt > startAt ? nextAt : startAt + this.track.alignmentSeconds;
  }
}
