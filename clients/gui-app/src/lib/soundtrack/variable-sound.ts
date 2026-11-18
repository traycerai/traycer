/**
 * Factorio 2.0's `variable_sound` prototype (FFF-407), in TypeScript names: the
 * format a composer delivers a track in. It mirrors only the fields the engine
 * plays. `composition_mode` is absent because every layer is "randomized", and
 * so are `alignment_samples` (carried in seconds) and the volume argument of
 * Lua's `sound_variations` (the caller sets per-layer gains on the player).
 *
 * The fields past Factorio's come from the commissioned composer's own
 * material: a run that opens and closes on its own samples and changes state on
 * a clock, layers a state fixes on or off, layers that play once, pause tables,
 * ordered sets and a fixed pan. Each has a value that means "not used" (null,
 * or an empty list), and a track that uses none of them plays as Factorio's
 * would. Where his words differ: his "time unit" is `alignmentSeconds`, his
 * "set" is a group, his "start" and "end" samples are the intro and outro.
 */

/**
 * An inclusive `[min, max]`. Pauses and offsets are seconds drawn uniformly;
 * `sequenceLength` and `numberOfEnabledLayers` are whole counts.
 */
export type Range = readonly [min: number, max: number];

/** One row of a pause table: picked with odds of `weight / Σ weight`. */
export interface WeightedRange {
  readonly range: Range;
  readonly weight: number;
}

/** A set, in the composer's word: some of a layer's variants, taking turns. */
export interface VariantGroup {
  readonly name: string;
  /** How many sample variants the group has; 1-based within the group. */
  readonly variants: number;
}

/**
 * What a layer is for, which is all a director reads of it. Under the rules
 * director a `pad` is held on, and lifted, while something waits for the
 * person; a `motif` is lifted while a finished row counts; a `texture` follows
 * how busy the app is, and comes up full under an unread failure, while the mix
 * is dimmed. An `event` is a stinger, which it leaves at 1 for now.
 */
export type LayerRole = "pad" | "motif" | "texture" | "event";

interface LayerFields {
  readonly name: string;
  /**
   * Its role, by which a director moves it; a layer's name means nothing to
   * one. Null: no director moves the layer, and it plays at 1.
   */
  readonly role: LayerRole | null;
  /** How many independent copies of the layer run; 1 when absent in Lua. */
  readonly sublayers: number;
  /**
   * Extra wait for the second and later sublayers, drawn once per sublayer and
   * measured from the track start rather than from the previous sublayer. A
   * track with three sublayers would be the first to tell the two readings
   * apart; the prototype reads it this way.
   */
  readonly sublayerStartingOffset: Range | null;
  /**
   * Where the layer sits in the stereo field for the whole track, from -1
   * (left) to 1 (right); null is the centre. Pan that moves belongs in the
   * samples.
   */
  readonly pan: number | null;
}

/** A layer whose variants are one pool, any of them due at any turn. */
export interface PooledLayer extends LayerFields {
  /** How many sample variants the layer has; variant ids are 1-based. */
  readonly variants: number;
  readonly groups?: never;
  readonly sequence?: never;
}

/**
 * A layer whose variants come in groups that take turns in a fixed order: with
 * `sequence` `["EA1", "EA2"]` it plays a random variant of EA1, then one of
 * EA2, then EA1 again. No group plays the same variant twice in a row.
 */
export interface GroupedLayer extends LayerFields {
  readonly variants?: never;
  readonly groups: readonly VariantGroup[];
  /**
   * Group names in the order they take turns, cycled for as long as the layer
   * plays; a name may come more than once. Every sample is one turn, and one
   * sample of `sequenceLength`.
   */
  readonly sequence: readonly string[];
}

/** A layer has one pool of variants or groups of them, never both. */
export type Layer = PooledLayer | GroupedLayer;

export interface LayerProperties {
  /**
   * Whether this state fixes the layer on (true) or off (false); null leaves
   * it to the roll. Layers fixed on count toward `numberOfEnabledLayers`, and
   * the roll makes up the rest from the null ones, as far as there are any. A
   * director cannot turn a fixed layer the other way.
   */
  readonly enabled: boolean | null;
  readonly startPause: Range;
  /** Lua omits this for a single-sample sequence; it is `[1, 1]` here. */
  readonly sequenceLength: Range;
  /** Lua omits this for a single-sample sequence; it is `[0, 0]` here. */
  readonly pauseBetweenSamples: Range;
  /**
   * One range, or a table of them for a pause that is mostly short with a long
   * tail: a row is picked by its weight, then the pause drawn within its range.
   */
  readonly pauseBetweenRepetitions: Range | readonly WeightedRange[];
  /**
   * How many sequences the layer plays in one run of the track, at most; with
   * a `sequenceLength` of `[1, 1]`, how many samples. Once it has, the layer
   * waits for the next run, whatever state comes. A run resumed after a stop is
   * the same run, and a sample the stop cut before it was heard does not count.
   * Null: no limit.
   */
  readonly playsPerRun: number | null;
}

export interface State {
  readonly name: string;
  /** One per layer of the track, in the same order. */
  readonly layersProperties: readonly LayerProperties[];
  readonly numberOfEnabledLayers: Range;
}

/**
 * A timed state change within a run: `afterSeconds` of track time from the
 * run's start, drawn once per run, the run moves to `state` and every layer's
 * gain takes `fadeSeconds` to its new level.
 */
export interface Phase {
  readonly afterSeconds: Range;
  readonly state: string;
  readonly fadeSeconds: number;
}

/**
 * A sample set heard once at a run's edge, outside the layers and the states:
 * one of its variants, at random. Its stems are named in the stem manifest as a
 * layer's are.
 */
export interface Bookend {
  readonly name: string;
  readonly variants: number;
  /** As a layer's `pan`. */
  readonly pan: number | null;
}

export interface VariableTrack {
  readonly kind?: "generative";
  readonly name: string;
  readonly title: string;
  /**
   * From the run's start, intro included. At this time no new sample starts.
   * Without an outro, the samples sounding ring on to their own ends, and the
   * run ends with the last one heard; one still sounding
   * `MIX_TUNING.ringOutCapSeconds` past this fades over
   * `MIX_TUNING.ringOutFadeSeconds`, and the run ends then.
   */
  readonly lengthSeconds: number;
  readonly alignmentSeconds: number;
  readonly layers: readonly Layer[];
  readonly states: readonly State[];
  /**
   * Plays on a run's first grid tick, and the layers start from its end, even
   * when the state changes while it sounds. A run resumed past track time 0
   * skips it, unless a stop cut it short: then it plays again from the resumed
   * position.
   */
  readonly intro: Bookend | null;
  /**
   * Plays on the first grid tick at or after `lengthSeconds`, while the layers'
   * last samples ring on under it: from the moment it is placed, every layer
   * fades to silence over the outro's own length, so the outro is what is left.
   * The run ends when it does, and whatever still sounds then fades out over
   * `MIX_TUNING.outroRingOutSeconds`. Null, or an outro that will not load: the
   * run rings out as `lengthSeconds` says.
   */
  readonly outro: Bookend | null;
  /**
   * A track with phases opens every run in its first state rather than a
   * random one, and the phases move it on, in time order. A phase that falls
   * during the intro waits for the intro's end. A run resumed past some phases
   * from a saved position opens in the latest one's state, and those phases do
   * not fire. Empty: every run rolls its state at random.
   */
  readonly phases: readonly Phase[];
}
