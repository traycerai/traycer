/**
 * Factorio 2.0's `variable_sound` prototype (FFF-407), in TypeScript names: the
 * format a composer delivers a track in. It mirrors only the fields the engine
 * plays. `composition_mode` is absent because every layer is "randomized", and
 * so are `alignment_samples` (carried in seconds) and the volume argument of
 * Lua's `sound_variations` (the caller sets per-layer gains on the player).
 */

/**
 * An inclusive `[min, max]`. Pauses and offsets are seconds drawn uniformly;
 * `sequenceLength` and `numberOfEnabledLayers` are whole counts.
 */
export type Range = readonly [min: number, max: number];

export interface Layer {
  readonly name: string;
  /** How many sample variants the layer has; variant ids are 1-based. */
  readonly variants: number;
  /** How many independent copies of the layer run; 1 when absent in Lua. */
  readonly sublayers: number;
  /**
   * Extra wait for the second and later sublayers, drawn once per sublayer and
   * measured from the track start rather than from the previous sublayer. A
   * track with three sublayers would be the first to tell the two readings
   * apart; the prototype reads it this way.
   */
  readonly sublayerStartingOffset: Range | null;
}

export interface LayerProperties {
  readonly startPause: Range;
  /** Lua omits this for a single-sample sequence; it is `[1, 1]` here. */
  readonly sequenceLength: Range;
  /** Lua omits this for a single-sample sequence; it is `[0, 0]` here. */
  readonly pauseBetweenSamples: Range;
  readonly pauseBetweenRepetitions: Range;
}

export interface State {
  readonly name: string;
  /** One per layer of the track, in the same order. */
  readonly layersProperties: readonly LayerProperties[];
  readonly numberOfEnabledLayers: Range;
}

export interface VariableTrack {
  readonly name: string;
  readonly title: string;
  readonly lengthSeconds: number;
  readonly alignmentSeconds: number;
  readonly layers: readonly Layer[];
  readonly states: readonly State[];
}

/** `aquilo-1.lua` from Space Age, transcribed. Numbers only, no audio. */
export const AQUILO_1: VariableTrack = {
  name: "aquilo-1",
  title: "Aquilo 1 - -77.7  Celsius",
  lengthSeconds: 300,
  alignmentSeconds: 1,
  layers: [
    { name: "A", variants: 1, sublayers: 1, sublayerStartingOffset: null },
    { name: "B", variants: 4, sublayers: 1, sublayerStartingOffset: null },
    { name: "C", variants: 16, sublayers: 2, sublayerStartingOffset: [10, 15] },
    { name: "D", variants: 8, sublayers: 1, sublayerStartingOffset: null },
  ],
  states: [
    {
      name: "begin",
      layersProperties: [
        {
          startPause: [0, 15],
          sequenceLength: [1, 1],
          pauseBetweenSamples: [0, 0],
          pauseBetweenRepetitions: [0, 3],
        },
        {
          startPause: [0, 15],
          sequenceLength: [1, 4],
          pauseBetweenSamples: [0, 3],
          pauseBetweenRepetitions: [10, 15],
        },
        {
          startPause: [0, 15],
          sequenceLength: [2, 4],
          pauseBetweenSamples: [0, 3],
          pauseBetweenRepetitions: [15, 30],
        },
        {
          startPause: [0, 15],
          sequenceLength: [1, 1],
          pauseBetweenSamples: [0, 0],
          pauseBetweenRepetitions: [5, 10],
        },
      ],
      numberOfEnabledLayers: [2, 4],
    },
  ],
};
