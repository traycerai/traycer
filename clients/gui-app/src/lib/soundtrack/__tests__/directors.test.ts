import { describe, expect, it } from "vitest";
import {
  RulesDirector,
  StaticDirector,
  type MixContext,
  type MixPlan,
} from "../directors";
import type { MixSignals } from "../signals";
import { AQUILO_1, type VariableTrack } from "../variable-sound";

const QUIET: MixSignals = {
  view: "home",
  working: 0,
  blocking: 0,
  failure: 0,
  done: 0,
};

function signalsOf(overrides: Partial<MixSignals>): MixSignals {
  return { ...QUIET, ...overrides };
}

const AQUILO_CONTEXT: MixContext = {
  track: AQUILO_1,
  state: AQUILO_1.states[0],
};

// Layers A and C only: the names a plan lifts B and D by are absent.
const TRACK_WITHOUT_B_AND_D: VariableTrack = {
  ...AQUILO_1,
  layers: AQUILO_1.layers.filter(
    (layer) => layer.name === "A" || layer.name === "C",
  ),
  states: [
    {
      ...AQUILO_1.states[0],
      layersProperties: [
        AQUILO_1.states[0].layersProperties[0],
        AQUILO_1.states[0].layersProperties[2],
      ],
    },
  ],
};

const rules = new RulesDirector();

function pauseMultiplierOf(overrides: Partial<MixSignals>): number {
  return rules.plan(signalsOf(overrides), AQUILO_CONTEXT).pauseMultiplier;
}

function layerCountOf(overrides: Partial<MixSignals>): number | null {
  return rules.plan(signalsOf(overrides), AQUILO_CONTEXT).enabledLayerCount;
}

function gainOf(plan: MixPlan, track: VariableTrack, name: string): number {
  const index = track.layers.findIndex((layer) => layer.name === name);
  return plan.layerGains[index];
}

describe("StaticDirector", () => {
  it("answers the same plan whatever the signals say", () => {
    const loud = signalsOf({
      view: "bot",
      working: 3,
      blocking: 4,
      failure: 2,
      done: 5,
    });
    const expected: MixPlan = {
      state: null,
      enabledLayerCount: null,
      heldLayers: [],
      pauseMultiplier: 1,
      layerGains: [1, 1, 1, 1],
      dim: false,
    };
    const director = new StaticDirector();
    expect(director.plan(loud, AQUILO_CONTEXT)).toEqual(expected);
    expect(director.plan(QUIET, AQUILO_CONTEXT)).toEqual(expected);
  });
});

describe("RulesDirector intensity, read through the pause multiplier", () => {
  it.each([
    { name: "nothing happening", signals: {}, intensity: 0.12 },
    { name: "one agent working", signals: { working: 1 }, intensity: 0.27 },
    {
      name: "work, a blocking row and a done row",
      signals: { working: 2, blocking: 1, done: 1 },
      intensity: 0.67,
    },
  ])("is 1.6 - 1.2 * intensity with $name", ({ signals, intensity }) => {
    expect(pauseMultiplierOf(signals)).toBeCloseTo(1.6 - 1.2 * intensity, 10);
  });

  it("stops at 0.4 once the terms reach 1", () => {
    const maxed = { working: 3, blocking: 2, failure: 1, done: 2 };
    expect(pauseMultiplierOf(maxed)).toBeCloseTo(0.4, 10);
    expect(pauseMultiplierOf({ ...maxed, working: 9, blocking: 9 })).toBe(
      pauseMultiplierOf(maxed),
    );
  });

  // A count past its cap adds nothing, and a count under it does.
  it.each([
    { term: "working", cap: 3 },
    { term: "blocking", cap: 2 },
    { term: "failure", cap: 1 },
    { term: "done", cap: 2 },
  ] as const)("counts $term up to $cap and no further", ({ term, cap }) => {
    expect(pauseMultiplierOf({ [term]: cap + 4 })).toBe(
      pauseMultiplierOf({ [term]: cap }),
    );
    expect(pauseMultiplierOf({ [term]: cap })).toBeLessThan(
      pauseMultiplierOf({ [term]: cap - 1 }),
    );
  });
});

describe("RulesDirector layer count", () => {
  it("follows intensity across the state's range", () => {
    // AQUILO_1's only state enables 2 to 4 layers.
    expect(layerCountOf({})).toBe(2);
    expect(layerCountOf({ working: 3 })).toBe(3);
    expect(layerCountOf({ working: 3, blocking: 2, failure: 1 })).toBe(4);
  });

  it("is null while no state is in force", () => {
    const plan = rules.plan(signalsOf({ working: 3 }), {
      track: AQUILO_1,
      state: null,
    });
    expect(plan.enabledLayerCount).toBeNull();
  });
});

describe("RulesDirector layers B, C and D and the dim", () => {
  it("holds B on while a row blocks, and lifts it with it", () => {
    const blocked = rules.plan(signalsOf({ blocking: 1 }), AQUILO_CONTEXT);
    const clear = rules.plan(QUIET, AQUILO_CONTEXT);
    expect(blocked.heldLayers).toEqual([1]);
    expect(clear.heldLayers).toEqual([]);
    expect(gainOf(blocked, AQUILO_1, "B")).toBeGreaterThan(
      gainOf(clear, AQUILO_1, "B"),
    );
  });

  it("dims the mix and lifts D to full while a row failed, and lets go with it", () => {
    const failed = rules.plan(signalsOf({ failure: 1 }), AQUILO_CONTEXT);
    const clear = rules.plan(QUIET, AQUILO_CONTEXT);
    expect(failed.dim).toBe(true);
    expect(clear.dim).toBe(false);
    expect(gainOf(failed, AQUILO_1, "D")).toBeGreaterThan(
      gainOf(clear, AQUILO_1, "D"),
    );
  });

  it("lifts C while a done row counts, and lets go with it", () => {
    const done = rules.plan(signalsOf({ done: 1 }), AQUILO_CONTEXT);
    const clear = rules.plan(QUIET, AQUILO_CONTEXT);
    expect(gainOf(done, AQUILO_1, "C")).toBeGreaterThan(
      gainOf(clear, AQUILO_1, "C"),
    );
    // The others stay where intensity puts them: only C answers to done.
    expect(gainOf(done, AQUILO_1, "A")).toBe(1);
  });

  it("raises D with intensity while nothing has failed", () => {
    const busy = rules.plan(signalsOf({ working: 3 }), AQUILO_CONTEXT);
    const clear = rules.plan(QUIET, AQUILO_CONTEXT);
    expect(gainOf(busy, AQUILO_1, "D")).toBeGreaterThan(
      gainOf(clear, AQUILO_1, "D"),
    );
  });

  it("answers one gain per layer, and holds nothing, on a track without B and D", () => {
    const plan = rules.plan(signalsOf({ blocking: 1, failure: 1, done: 1 }), {
      track: TRACK_WITHOUT_B_AND_D,
      state: TRACK_WITHOUT_B_AND_D.states[0],
    });
    expect(plan.heldLayers).toEqual([]);
    expect(plan.layerGains).toHaveLength(2);
    expect(gainOf(plan, TRACK_WITHOUT_B_AND_D, "A")).toBe(1);
    expect(gainOf(plan, TRACK_WITHOUT_B_AND_D, "C")).toBeGreaterThan(1);
    // The dim belongs to the mix and not to a layer, so it stands.
    expect(plan.dim).toBe(true);
  });
});
