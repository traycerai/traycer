import type {
  Layer,
  LayerProperties,
  Range,
  State,
  VariableTrack,
} from "./variable-sound";

/** A uniform draw in [0, 1). */
export type RandomSource = () => number;

export interface ScheduledPlay {
  readonly layerIndex: number;
  readonly sublayerIndex: number;
  /** 1-based, as `Layer.variants` counts them. */
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

interface SublayerCursor {
  readonly layerIndex: number;
  readonly sublayerIndex: number;
  readonly layer: Layer;
  readonly properties: LayerProperties;
  /** Earliest track time of the next sample, before snapping to the grid. */
  nextAt: number;
  samplesLeftInSequence: number;
  /** Decided and handed out, its duration not back yet. */
  pending: ScheduledPlay | null;
  lastVariant: number | null;
}

// A value already on the grid must stay on its tick; without this, 0.3 / 0.1
// reads as just over 3 and would snap one tick late.
const GRID_TOLERANCE = 1e-9;

export function drawSeconds(range: Range, random: RandomSource): number {
  return range[0] + random() * (range[1] - range[0]);
}

function drawCount(range: Range, random: RandomSource): number {
  return Math.floor(range[0] + random() * (range[1] - range[0] + 1));
}

function snapUp(trackTime: number, alignment: number): number {
  // Math.max because the ceiling of a tiny negative is -0.
  return Math.max(
    0,
    Math.ceil(trackTime / alignment - GRID_TOLERANCE) * alignment,
  );
}

function tickAfter(trackTime: number, alignment: number): number {
  return (Math.floor(trackTime / alignment + GRID_TOLERANCE) + 1) * alignment;
}

function rollEnabledLayers(
  track: VariableTrack,
  state: State,
  random: RandomSource,
): boolean[] {
  const count = Math.min(
    drawCount(state.numberOfEnabledLayers, random),
    track.layers.length,
  );
  const order = track.layers.map((_, index) => index);
  const enabled = track.layers.map(() => false);
  for (let picked = 0; picked < count; picked += 1) {
    const swap = picked + Math.floor(random() * (order.length - picked));
    [order[picked], order[swap]] = [order[swap], order[picked]];
    enabled[order[picked]] = true;
  }
  return enabled;
}

/**
 * Decides which sample starts when, in track time, for one state of one track.
 * It holds no audio and no clock: a consumer asks with `advance`, and reports
 * each decided sample back with `confirm` or `skip`, because a sample's length
 * comes from decoded audio and places the next one on that sublayer. Until the
 * report arrives, that sublayer decides nothing further.
 */
export class TrackScheduler {
  readonly state: State;
  private readonly track: VariableTrack;
  private readonly random: RandomSource;
  private readonly enabled: boolean[];
  private pauseMultiplier: number;
  private cursors: SublayerCursor[] = [];
  private lastVariantByLayer: (number | null)[] = [];

  constructor(options: TrackSchedulerOptions) {
    const { track, state } = options;
    if (state.layersProperties.length !== track.layers.length) {
      throw new Error(
        `State "${state.name}" of track "${track.name}" has ${String(state.layersProperties.length)} layer properties for ${String(track.layers.length)} layers`,
      );
    }
    this.track = track;
    this.state = state;
    this.random = options.random;
    this.pauseMultiplier = options.pauseMultiplier;
    this.enabled = rollEnabledLayers(track, state, options.random);
    this.restartAt(0);
  }

  /**
   * Starts every sublayer over from `trackTime` with fresh start pauses, as a
   * resume does. The state and the enabled flags stand. A play still awaiting
   * its report is forgotten, and reporting it later does nothing.
   */
  restartAt(trackTime: number): void {
    this.lastVariantByLayer = this.track.layers.map(() => null);
    this.cursors = this.track.layers.flatMap((layer, layerIndex) =>
      Array.from({ length: layer.sublayers }, (_, sublayerIndex) =>
        this.createCursor(layer, layerIndex, sublayerIndex, trackTime),
      ),
    );
  }

  enabledLayers(): readonly boolean[] {
    return this.enabled;
  }

  /** The caller's override. The scheduler writes the flags only when rolling. */
  setLayerEnabled(layerIndex: number, enabled: boolean): void {
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
      if (!this.enabled[cursor.layerIndex]) {
        // Stay just ahead of the window, so that enabling the layer lands on
        // the coming tick instead of catching up on a tick already gone.
        cursor.nextAt = tickAfter(untilTrackTime, alignment);
        continue;
      }
      const startAt = snapUp(cursor.nextAt, alignment);
      if (startAt >= this.track.lengthSeconds) {
        cursor.nextAt = Number.POSITIVE_INFINITY;
        continue;
      }
      if (startAt > untilTrackTime) continue;
      const play: ScheduledPlay = {
        layerIndex: cursor.layerIndex,
        sublayerIndex: cursor.sublayerIndex,
        variant: this.pickVariant(cursor),
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
   * it must not start: past the track's end, or forgotten by `restartAt`.
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
    this.placeNext(cursor, startAt, durationSeconds);
    return startAt;
  }

  /**
   * The sample cannot play. It still counts in its sequence, as a sample with
   * no length, so a missing stem leaves a hole and not a shift in the layer.
   */
  skip(play: ScheduledPlay): void {
    const cursor = this.claimPending(play);
    if (cursor !== null) this.placeNext(cursor, play.startAt, 0);
  }

  private createCursor(
    layer: Layer,
    layerIndex: number,
    sublayerIndex: number,
    fromTrackTime: number,
  ): SublayerCursor {
    const properties = this.state.layersProperties[layerIndex];
    // The offset separates sublayers, so a busy mix's shorter pauses leave it.
    const offset =
      sublayerIndex > 0 && layer.sublayerStartingOffset !== null
        ? drawSeconds(layer.sublayerStartingOffset, this.random)
        : 0;
    return {
      layerIndex,
      sublayerIndex,
      layer,
      properties,
      nextAt:
        fromTrackTime +
        drawSeconds(properties.startPause, this.random) * this.pauseMultiplier +
        offset,
      samplesLeftInSequence: drawCount(properties.sequenceLength, this.random),
      pending: null,
      lastVariant: null,
    };
  }

  private claimPending(play: ScheduledPlay): SublayerCursor | null {
    const cursor = this.cursors.find((candidate) => candidate.pending === play);
    if (cursor === undefined) return null;
    cursor.pending = null;
    return cursor;
  }

  /**
   * Never repeats the layer's last sample, across its sublayers, nor where
   * there are enough variants the sublayer's own: the first is the rule, and
   * the second keeps a sublayer from repeating itself around its neighbour.
   */
  private pickVariant(cursor: SublayerCursor): number {
    const lastOfLayer = this.lastVariantByLayer[cursor.layerIndex];
    const others = Array.from(
      { length: cursor.layer.variants },
      (_, index) => index + 1,
    ).filter((variant) => variant !== lastOfLayer);
    const fresh = others.filter((variant) => variant !== cursor.lastVariant);
    const pool = fresh.length > 0 ? fresh : others;
    const variant =
      pool.length > 0 ? pool[Math.floor(this.random() * pool.length)] : 1;
    this.lastVariantByLayer[cursor.layerIndex] = variant;
    cursor.lastVariant = variant;
    return variant;
  }

  private placeNext(
    cursor: SublayerCursor,
    startAt: number,
    durationSeconds: number,
  ): void {
    const { properties } = cursor;
    cursor.samplesLeftInSequence -= 1;
    let pause = properties.pauseBetweenSamples;
    if (cursor.samplesLeftInSequence <= 0) {
      cursor.samplesLeftInSequence = drawCount(
        properties.sequenceLength,
        this.random,
      );
      pause = properties.pauseBetweenRepetitions;
    }
    const nextAt =
      startAt +
      durationSeconds +
      drawSeconds(pause, this.random) * this.pauseMultiplier;
    // A sample with no length and no pause must not take the same tick again.
    cursor.nextAt =
      nextAt > startAt ? nextAt : startAt + this.track.alignmentSeconds;
  }
}
