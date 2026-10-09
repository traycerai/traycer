import { describe, expect, it } from "vitest";
import {
  regionValuesHidden,
  type AccessValues,
  type ReadingStyle,
} from "@/lib/layout/layout-values";
import {
  effectiveLayoutValues,
  PRESET_VALUES,
  type LayoutPresetId,
} from "@/lib/layout/layout-presets";
import {
  resolvePersistedOverrides,
  resolvePersistedRecordOverrides,
} from "@/lib/layout/layout-values-persist";
import type { RegionId } from "@/lib/layout/region-id";

describe("regionValuesHidden", () => {
  it("is true only for a shown leaf that says hidden, and never throws without one", () => {
    expect(regionValuesHidden({ shown: "hidden", size: "full" })).toBe(true);
    expect(regionValuesHidden({ shown: "shown", size: "full" })).toBe(false);
    const access: AccessValues = { size: "chip" };
    expect(regionValuesHidden(access)).toBe(false);
  });
});

describe("HideableRegionId (checked indirectly, since it is a compile-time type)", () => {
  it("access, model and toolActivity are the only regions whose default value bag has no shown leaf", () => {
    const regionIds = Object.keys(
      PRESET_VALUES.default,
    ) as ReadonlyArray<RegionId>;
    const unhideable = regionIds.filter(
      (id) => !("shown" in PRESET_VALUES.default[id]),
    );
    expect(unhideable.sort()).toEqual(["access", "model", "toolActivity"]);
  });
});

describe("what each preset ships", () => {
  it("ships Slider on Default and Compact, and List on Detailed", () => {
    expect(PRESET_VALUES.default.model.reasoningControl).toBe("slider");
    expect(PRESET_VALUES.compact.model.reasoningControl).toBe("slider");
    expect(PRESET_VALUES.detailed.model.reasoningControl).toBe("list");
  });

  // Chat display settings (audit R1, R3): Tool activity, Thinking and
  // Timestamps per preset.
  it("ships toolActivity, thinking and timestamps per preset", () => {
    // Default: toolActivity chip, thinking shown+chip, timestamps shown.
    expect(PRESET_VALUES.default.toolActivity).toEqual({ size: "chip" });
    expect(PRESET_VALUES.default.thinking).toEqual({
      shown: "shown",
      size: "chip",
    });
    expect(PRESET_VALUES.default.timestamps).toEqual({ shown: "shown" });
    // Compact: thinking and timestamps hidden, toolActivity still chip.
    expect(PRESET_VALUES.compact.toolActivity).toEqual({ size: "chip" });
    expect(PRESET_VALUES.compact.thinking.shown).toBe("hidden");
    expect(PRESET_VALUES.compact.timestamps.shown).toBe("hidden");
    // Detailed: toolActivity and thinking both full, thinking shown.
    expect(PRESET_VALUES.detailed.toolActivity).toEqual({ size: "full" });
    expect(PRESET_VALUES.detailed.thinking).toEqual({
      shown: "shown",
      size: "full",
    });
  });
});

describe("the density each preset ships for the two readings", () => {
  it.each(["default", "compact", "detailed"] as const)(
    "ships Auto on %s",
    (preset) => {
      expect(PRESET_VALUES[preset].usageLimits.density).toBe("auto");
      expect(PRESET_VALUES[preset].resourceMonitor.density).toBe("auto");
    },
  );

  it("turns Reset time off on Compact, and leaves it on elsewhere", () => {
    expect(PRESET_VALUES.compact.usageLimits.reset).toBe(false);
    expect(PRESET_VALUES.default.usageLimits.reset).toBe(true);
    expect(PRESET_VALUES.detailed.usageLimits.reset).toBe(true);
  });
});

describe("resolvePersistedOverrides carries a saved display over to density", () => {
  const readings = ["usageLimits", "resourceMonitor"] as const;

  it.each(readings)(
    "reads a record with no display or density on %s as nothing chosen",
    (region) => {
      expect(
        resolvePersistedOverrides({ [region]: { shown: "hidden" } })[region],
      ).toEqual({ shown: "hidden" });
    },
  );

  it.each(readings)("reads display `icon` on %s as Compact", (region) => {
    expect(
      resolvePersistedOverrides({ [region]: { display: "icon" } })[region],
    ).toEqual({ density: "compact" });
  });

  it.each(readings)("reads display `full` on %s as Auto", (region) => {
    expect(
      resolvePersistedOverrides({ [region]: { display: "full" } })[region],
    ).toEqual({ density: "auto" });
  });

  it.each(readings)("keeps a stored density on %s", (region) => {
    for (const density of ["auto", "compact", "detailed"] as const) {
      expect(
        resolvePersistedOverrides({ [region]: { density } })[region],
      ).toEqual({ density });
    }
  });

  it.each(readings)(
    "lets a stored density on %s win over a leftover display",
    (region) => {
      expect(
        resolvePersistedOverrides({
          [region]: { density: "detailed", display: "icon" },
        })[region],
      ).toEqual({ density: "detailed" });
    },
  );

  it.each(readings)(
    "drops a display or density on %s outside the unions",
    (region) => {
      expect(
        resolvePersistedOverrides({
          [region]: { display: "wide", density: "huge" },
        })[region],
      ).toBeUndefined();
    },
  );

  it("drops the usage bar, percent and word keys and keeps reset and amount", () => {
    expect(
      resolvePersistedOverrides({
        usageLimits: {
          bar: false,
          percent: false,
          word: false,
          reset: false,
          amount: "remaining",
        },
      }).usageLimits,
    ).toEqual({ reset: false, amount: "remaining" });
  });
});

describe("resolvePersistedRecordOverrides carries the saved bar and percent over to a Reading style", () => {
  /**
   * What the Reading style reads back as, resolved through the record's own
   * preset: the delta laid over that preset, as the app reads it. The earlier
   * presets had `percent` on everywhere and `bar` off on Compact alone.
   */
  function readBack(
    basePreset: LayoutPresetId,
    usageLimits: Record<string, unknown>,
  ): ReadingStyle {
    return effectiveLayoutValues(
      basePreset,
      resolvePersistedRecordOverrides({ usageLimits }, basePreset),
    ).usageLimits.readingStyle;
  }

  it.each<{
    readonly preset: LayoutPresetId;
    readonly stored: Record<string, unknown>;
    readonly style: ReadingStyle;
    readonly why: string;
  }>([
    { preset: "default", stored: {}, style: "bar", why: "no saved keys" },
    { preset: "detailed", stored: {}, style: "bar", why: "no saved keys" },
    {
      preset: "compact",
      stored: {},
      style: "percent",
      why: "Compact never had a bar, so its users keep seeing the percent",
    },
    {
      preset: "default",
      stored: { bar: false },
      style: "percent",
      why: "bar off leaves the percent",
    },
    {
      preset: "default",
      stored: { percent: false },
      style: "bar",
      why: "percent off leaves the bar",
    },
    {
      preset: "default",
      stored: { bar: false, percent: false },
      style: "bar",
      why: "both off says nothing, so the preset answers",
    },
    {
      preset: "default",
      stored: { bar: true, percent: true },
      style: "bar",
      why: "both on says nothing, so the preset answers",
    },
    {
      preset: "compact",
      stored: { bar: true },
      style: "both",
      why: "turning the bar on beside Compact's percent was a choice",
    },
    {
      preset: "detailed",
      stored: { bar: true, percent: true },
      style: "bar",
      why: "both on outside Compact is what nobody changed",
    },
    {
      preset: "compact",
      stored: { percent: false },
      style: "percent",
      why: "Compact's bar is off, so with percent off too both are off",
    },
    {
      preset: "detailed",
      stored: { percent: false, word: false },
      style: "bar",
      why: "the word has no style of its own",
    },
    {
      preset: "default",
      stored: { readingStyle: "full", bar: false },
      style: "full",
      why: "a stored style wins over the legacy keys",
    },
    {
      preset: "default",
      stored: { readingStyle: "wide", bar: false },
      style: "percent",
      why: "a style outside the union is not read, and the legacy keys answer",
    },
  ])("reads $why ($preset, $stored) as $style", ({ preset, stored, style }) => {
    expect(readBack(preset, stored)).toBe(style);
  });

  it("drops the legacy keys once they have been read", () => {
    expect(
      resolvePersistedRecordOverrides(
        { usageLimits: { bar: false, percent: true, word: true } },
        "default",
      ).usageLimits,
    ).toEqual({ readingStyle: "percent" });
  });
});

describe("resolvePersistedOverrides drops a legacy shown on Access/Model", () => {
  it("resolves a stored access record to size alone", () => {
    const overrides = resolvePersistedOverrides({
      access: { shown: "hidden", size: "chip" },
    });
    expect(overrides.access).toEqual({ size: "chip" });
  });

  it("resolves a stored model record to style alone", () => {
    const overrides = resolvePersistedOverrides({
      model: { shown: "hidden", style: "bars" },
    });
    expect(overrides.model).toEqual({ style: "bars" });
  });
});

describe("resolvePersistedOverrides on model.reasoningControl", () => {
  it("keeps a stored `slider` or `list`", () => {
    expect(
      resolvePersistedOverrides({ model: { reasoningControl: "slider" } })
        .model,
    ).toEqual({ reasoningControl: "slider" });
    expect(
      resolvePersistedOverrides({ model: { reasoningControl: "list" } }).model,
    ).toEqual({ reasoningControl: "list" });
  });

  it("drops a value outside the union rather than passing it through", () => {
    const overrides = resolvePersistedOverrides({
      model: { reasoningControl: "compact" },
    });
    expect(overrides.model).toBeUndefined();
  });
});

// Chat display settings (audit R1, R3).
describe("resolvePersistedOverrides on toolActivity/thinking/timestamps", () => {
  it("keeps a valid patch for each: toolActivity (Access's one-leaf size shape), thinking (shown and size), timestamps (shown alone)", () => {
    const overrides = resolvePersistedOverrides({
      toolActivity: { size: "full" },
      thinking: { shown: "hidden", size: "full" },
      timestamps: { shown: "hidden" },
    });
    expect(overrides.toolActivity).toEqual({ size: "full" });
    expect(overrides.thinking).toEqual({ shown: "hidden", size: "full" });
    expect(overrides.timestamps).toEqual({ shown: "hidden" });
  });

  it("drops a value outside each union rather than passing it through", () => {
    const overrides = resolvePersistedOverrides({
      toolActivity: { size: "medium" },
      thinking: { shown: "auto", size: "medium" },
      timestamps: { shown: "auto" },
    });
    expect(overrides.toolActivity).toBeUndefined();
    expect(overrides.thinking).toBeUndefined();
    expect(overrides.timestamps).toBeUndefined();
  });
});

describe("resolvePersistedOverrides migrates a stored `auto` off the seven plain rail panels (L-93 overturned)", () => {
  it("reads a stored auto on railAgents (and the other six) back as shown", () => {
    const overrides = resolvePersistedOverrides({
      railAgents: { shown: "auto" },
      railTerminals: { shown: "auto" },
      railBrowsers: { shown: "auto" },
      railArtifacts: { shown: "auto" },
      railGitDiff: { shown: "auto" },
      railFileTree: { shown: "auto" },
      railSharing: { shown: "auto" },
    });

    expect(overrides.railAgents).toEqual({ shown: "shown" });
    expect(overrides.railTerminals).toEqual({ shown: "shown" });
    expect(overrides.railBrowsers).toEqual({ shown: "shown" });
    expect(overrides.railArtifacts).toEqual({ shown: "shown" });
    expect(overrides.railGitDiff).toEqual({ shown: "shown" });
    expect(overrides.railFileTree).toEqual({ shown: "shown" });
    expect(overrides.railSharing).toEqual({ shown: "shown" });
  });

  it("keeps a stored auto on Pull requests and Comments, the two panels with a real rule", () => {
    const overrides = resolvePersistedOverrides({
      railPullRequests: { shown: "auto" },
      railComments: { shown: "auto" },
    });

    expect(overrides.railPullRequests).toEqual({ shown: "auto" });
    expect(overrides.railComments).toEqual({ shown: "auto" });
  });

  it("ignores a stored value this build has no case for, on either kind of rail panel", () => {
    const overrides = resolvePersistedOverrides({
      railAgents: { shown: "queue" },
      railFileTree: {},
      railPullRequests: { shown: "queue" },
    });

    expect(overrides.railAgents).toBeUndefined();
    expect(overrides.railFileTree).toBeUndefined();
    expect(overrides.railPullRequests).toBeUndefined();
  });

  it("still reads a plain shown/hidden literal straight through on both kinds", () => {
    const overrides = resolvePersistedOverrides({
      railAgents: { shown: "hidden" },
      railPullRequests: { shown: "shown" },
    });

    expect(overrides.railAgents).toEqual({ shown: "hidden" });
    expect(overrides.railPullRequests).toEqual({ shown: "shown" });
  });
});
