import { MIX_TUNING } from "./mix-tuning";
import type { MixSignals } from "./signals";
import type { State, VariableTrack } from "./variable-sound";

/**
 * What a director wants of the track sounding. Gains ramp at once; everything
 * that changes scheduling lands on the next grid tick, with the plays in flight
 * finishing on their own. The engine's random rolls stay random inside what a
 * plan narrows.
 */
export interface MixPlan {
  /** The state to be in; null leaves the one the engine rolled. */
  readonly state: string | null;
  /**
   * How many layers to keep on; null leaves the ones the engine rolled. Which
   * ones is the engine's roll adjusted at random by no more than it takes.
   */
  readonly enabledLayerCount: number | null;
  /** Indices of the layers on whatever the count says. */
  readonly heldLayers: readonly number[];
  readonly pauseMultiplier: number;
  /** One per layer of the track, in its order. */
  readonly layerGains: readonly number[];
  /** Whether the whole mix goes through the low-pass. */
  readonly dim: boolean;
}

/** The track a plan is for, which the view chose ahead of any director. */
export interface MixContext {
  readonly track: VariableTrack;
  /** The state in force; null before the first play and in the silence. */
  readonly state: State | null;
}

/**
 * The seam: signals in, a plan out, every 5 s and on every signal change. A
 * new director is one more entry in `MIX_DIRECTORS`, and neither the engine nor
 * the store changes.
 */
export interface MixDirector {
  plan(signals: MixSignals, context: MixContext): MixPlan;
}

/** Factorio's recipe: the view picks the track and nothing else moves the mix. */
export class StaticDirector implements MixDirector {
  plan(_signals: MixSignals, context: MixContext): MixPlan {
    return {
      state: null,
      enabledLayerCount: null,
      heldLayers: [],
      pauseMultiplier: 1,
      layerGains: context.track.layers.map(() => 1),
      dim: false,
    };
  }
}

function weighted(
  count: number,
  term: { readonly weight: number; readonly cap: number },
): number {
  return term.weight * Math.min(count, term.cap);
}

function intensityOf(signals: MixSignals): number {
  const { base, working, blocking, failure, done } = MIX_TUNING.intensity;
  return Math.min(
    1,
    base +
      weighted(signals.working, working) +
      weighted(signals.blocking, blocking) +
      weighted(signals.failure, failure) +
      weighted(signals.done, done),
  );
}

function layerGain(
  layerName: string,
  signals: MixSignals,
  intensity: number,
): number {
  const { B, C, D } = MIX_TUNING.layerGains;
  switch (layerName) {
    case "B":
      return signals.blocking > 0 ? B.held : B.rest;
    case "C":
      return signals.done > 0 ? C.lifted : C.rest;
    case "D":
      return signals.failure > 0
        ? D.dimmed
        : D.base + D.perIntensity * intensity;
    default:
      return 1;
  }
}

/** The feed and agent activity too: the busier the app, the fuller the mix. */
export class RulesDirector implements MixDirector {
  plan(signals: MixSignals, context: MixContext): MixPlan {
    const intensity = intensityOf(signals);
    const { calm, perIntensity, busy } = MIX_TUNING.pauseMultiplier;
    const { track, state } = context;
    return {
      state: null,
      enabledLayerCount: state === null ? null : layerCountAt(state, intensity),
      heldLayers:
        signals.blocking > 0
          ? track.layers.flatMap((layer, index) =>
              layer.name === "B" ? [index] : [],
            )
          : [],
      // Intensity is never negative, so `calm` is the ceiling already.
      pauseMultiplier: Math.max(busy, calm - perIntensity * intensity),
      layerGains: track.layers.map((layer) =>
        layerGain(layer.name, signals, intensity),
      ),
      dim: signals.failure > 0,
    };
  }
}

function layerCountAt(state: State, intensity: number): number {
  const [fewest, most] = state.numberOfEnabledLayers;
  return Math.round(fewest + (most - fewest) * intensity);
}

export const MIX_DIRECTORS = {
  static: new StaticDirector(),
  rules: new RulesDirector(),
} satisfies Record<string, MixDirector>;

export type MixDirectorId = keyof typeof MIX_DIRECTORS;
