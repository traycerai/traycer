import { beforeEach, describe, expect, it } from "vitest";
import type { QuickVerbId } from "@/components/layout-editor/regions/region-grammar";
import {
  sanitizeAnalyticsProperties,
  Analytics,
  AnalyticsEvent,
} from "@/lib/analytics";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import {
  layoutDurationBucket,
  layoutEditorSessionChangeSummary,
  layoutSnapshotProperties,
  LAYOUT_SETTING_PROPERTY_KEYS,
  type LayoutSnapshotProperties,
} from "@/lib/layout/layout-diff";
import { PRESET_VALUES } from "@/lib/layout/layout-presets";
import { LAYOUT_VALUE_ENUM_MEMBERS } from "@/lib/layout/layout-values";
import { claimLayoutSnapshotWindow } from "@/lib/layout/layout-snapshot-gate";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { DEFAULT_LAYOUT_SNAPSHOT } from "@/stores/layout/layout-store";

const LAYOUT_SNAPSHOT_KEY = persistKey(STORE_KEYS.layoutSnapshot);

beforeEach(() => {
  window.localStorage.removeItem(LAYOUT_SNAPSHOT_KEY);
});

/**
 * Swaps the WHOLE `window.localStorage` reference for one whose named methods
 * throw, runs `run`, and always restores the original - `Object.defineProperty`
 * on an individual method of jsdom's Proxy-backed `Storage` does not reliably
 * intercept the module's own calls (see the two "storage unavailable" tests).
 */
function withThrowingLocalStorage(
  throwingMethods: ReadonlyArray<"getItem" | "setItem">,
  run: () => void,
): void {
  const original = window.localStorage;
  const backing = new Map<string, string>();
  const throwing = (): never => {
    throw new Error("storage disabled");
  };
  const replacement: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: throwingMethods.includes("getItem")
      ? throwing
      : (key) => backing.get(key) ?? null,
    key: (index) => Array.from(backing.keys())[index] ?? null,
    removeItem: (key) => {
      backing.delete(key);
    },
    setItem: throwingMethods.includes("setItem")
      ? throwing
      : (key, value) => {
          backing.set(key, value);
        },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: replacement,
  });
  try {
    run();
  } finally {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: original,
    });
  }
}

describe("layoutSnapshotProperties (L-46, L-54, L-55)", () => {
  it("reports every declared setting as 'default' on an untouched snapshot", () => {
    const properties = layoutSnapshotProperties(DEFAULT_LAYOUT_SNAPSHOT);

    for (const key of LAYOUT_SETTING_PROPERTY_KEYS) {
      expect(properties[key as keyof LayoutSnapshotProperties]).toBe("default");
    }
    // The agent rows' own switch (G7) is a declared setting of its own.
    expect(LAYOUT_SETTING_PROPERTY_KEYS).toContain(
      "layout_resource_monitor_agent_rows",
    );
    expect(properties.changed_from_default_count).toBe(0);
    expect(properties.base_preset).toBe("default");
    expect(properties.layout_usage_host).toBe("status-bar");
    expect(properties.layout_usage_side).toBe("left");
    expect(properties.layout_minimap_side).toBe("right");
    expect(properties.layout_resource_host).toBe("status-bar");
    expect(properties.layout_resource_side).toBe("right");
    expect(properties.layout_dock_reordered).toBe(false);
    expect(properties.layout_toolbar_left_reordered).toBe(false);
    expect(properties.layout_toolbar_right_reordered).toBe(false);
    expect(properties.layout_rail_reordered).toBe(false);
    expect(properties.layout_usage_providers_reordered).toBe(false);
  });

  it("reports a scalar leaf's literal value once it differs, never omitting the key", () => {
    const snapshot: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      overrides: { mic: { shown: "hidden" } },
    };

    const properties = layoutSnapshotProperties(snapshot);

    expect(properties.layout_mic_shown).toBe("hidden");
    expect(properties.changed_from_default_count).toBe(1);
    // Every other declared key is still present and still "default" - the
    // event is dense, never sparse (L-55). The fifteen beside the per-setting
    // keys are the built-ins the snapshot carries: the preset, the count, the
    // four placement fields the two bar readings pick (L-156), the tab strip
    // placement, the sidebar side (S-01, S-06) and the strip's view (D8), the
    // minimap side and the five reorder flags.
    expect(Object.keys(properties)).toHaveLength(
      LAYOUT_SETTING_PROPERTY_KEYS.length + 15,
    );
  });

  it("reports a boolean leaf as 'true'/'false', never a JS boolean", () => {
    const snapshot: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      overrides: { resourceMonitor: { memory: true } },
    };

    const properties = layoutSnapshotProperties(snapshot);

    expect(properties.layout_resource_monitor_memory).toBe("true");
    expect(typeof properties.layout_resource_monitor_memory).toBe("string");
  });

  it("reports the list leaf (pinnedFields) as 'changed', never the list itself", () => {
    const snapshot: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      overrides: { contextUsage: { pinnedFields: ["cacheRead"] } },
    };

    const properties = layoutSnapshotProperties(snapshot);

    expect(properties.layout_context_usage_pinned_fields).toBe("changed");
    expect(JSON.stringify(properties)).not.toContain("cacheRead");
  });

  it("diffs against the SHIPPED Default, not the base preset", () => {
    // Compact changes several values off the shipped Default; a snapshot
    // whose base IS Compact with no further overrides must still report
    // those as non-default, because the denominator is the shipped Default.
    const snapshot: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      basePreset: "compact",
    };

    const properties = layoutSnapshotProperties(snapshot);

    expect(properties.base_preset).toBe("compact");
    expect(properties.layout_usage_limits_reset).toBe("false");
    expect(properties.layout_mic_shown).toBe("hidden");
    expect(properties.changed_from_default_count).toBeGreaterThan(0);
  });

  it("reports each reorder group's own boolean, independent of the others", () => {
    const snapshot: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        toolbarLeft: [...DEFAULT_ARRANGEMENT.toolbarLeft].reverse(),
      },
    };

    const properties = layoutSnapshotProperties(snapshot);

    expect(properties.layout_toolbar_left_reordered).toBe(true);
    expect(properties.layout_dock_reordered).toBe(false);
    expect(properties.layout_rail_reordered).toBe(false);
    expect(properties.layout_toolbar_right_reordered).toBe(false);
    expect(properties.layout_usage_providers_reordered).toBe(false);
  });

  it("never carries shownProfiles, providerLimits, hiddenProviders or limitKeys", () => {
    const snapshot: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        hiddenProviders: ["claude-code"],
        providerLimits: {
          "claude-code": { limitKeys: ["five-hour"] },
        },
        shownProfiles: { "host-1": { "claude-code": ["profile-a"] } },
      },
    };

    const properties = layoutSnapshotProperties(snapshot);
    const serialized = JSON.stringify(properties);

    // `layoutSnapshotProperties` only ever writes the declared key set
    // (`LAYOUT_SETTING_PROPERTY_KEYS` plus the fifteen built-in
    // arrangement/count fields the key-count test above pins), so these
    // fields never reach the event even though the type's index signature
    // would allow reading them.
    expect(properties.shownProfiles).toBeUndefined();
    expect(properties.providerLimits).toBeUndefined();
    expect(serialized).not.toContain("profile-a");
    expect(serialized).not.toContain("five-hour");
    expect(serialized).not.toContain("claude-code");
  });
});

/**
 * `layout_snapshot` is in `STRICT_EVENTS`, so a single declared property whose
 * value fails its validator drops the WHOLE event - for every user, with the
 * registry, the completeness suite and the compile all green (G3-03). These
 * drive the real builders through the real sanitizer, which is the only place
 * that verdict is reached.
 */
describe("the layout payloads survive the analytics sanitizer", () => {
  it("sends a snapshot carrying one value from every enum in the model", () => {
    const snapshot: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      basePreset: "compact",
      overrides: {
        // Visibility (twice: mic, and railAgents now that the seven plain
        // rail panels default to shown rather than carrying the tri-state
        // rule), RegionSize, RailVisibility's one non-default member left on
        // a panel that still has one (railComments), ModelStyle, ContextStyle,
        // AmountMode, a boolean leaf and the one list leaf.
        mic: { shown: "hidden" },
        runningAgents: { shown: "hidden", size: "chip" },
        railAgents: { shown: "hidden" },
        railComments: { shown: "hidden" },
        model: { style: "bars-text", reasoningControl: "list" },
        contextUsage: {
          style: "ring-only",
          pinBreakdown: true,
          pinnedFields: ["cacheRead"],
          compactButton: "hidden",
        },
        usageLimits: { amount: "remaining", density: "compact" },
        resourceMonitor: { memory: true, cpu: false },
      },
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        usageHost: "header",
        usageSide: "right",
        minimapSide: "left",
        resourceHost: "header",
        resourceSide: "left",
      },
    };

    const properties = layoutSnapshotProperties(snapshot);

    expect(properties.layout_model_style).toBe("bars-text");
    expect(properties.layout_model_reasoning_control).toBe("list");
    expect(properties.layout_rail_agents_shown).toBe("hidden");
    expect(properties.layout_rail_comments_shown).toBe("hidden");
    expect(properties.layout_context_usage_style).toBe("ring-only");
    expect(properties.layout_context_usage_pinned_fields).toBe("changed");
    expect(properties.layout_usage_limits_amount).toBe("remaining");
    expect(properties.layout_running_agents_size).toBe("chip");
    expect(
      Analytics.getInstance().track(AnalyticsEvent.LayoutSnapshot, properties),
    ).toBe(true);
  });

  // The two artefacts are independent: the model owns the enums, `analytics.ts`
  // owns the allowlist. Breaking the derivation between them is what this sees.
  it("accepts every enum value some LayoutValues leaf can hold", () => {
    const base = layoutSnapshotProperties(DEFAULT_LAYOUT_SNAPSHOT);
    const settingKey = LAYOUT_SETTING_PROPERTY_KEYS[0];
    expect(LAYOUT_VALUE_ENUM_MEMBERS.length).toBeGreaterThan(0);

    for (const member of LAYOUT_VALUE_ENUM_MEMBERS) {
      expect(
        sanitizeAnalyticsProperties(AnalyticsEvent.LayoutSnapshot, {
          ...base,
          [settingKey]: member,
        }),
        `${settingKey} = ${member}`,
      ).not.toBeNull();
    }
  });

  // `top / left / layered` is the shipped Default itself.
  it("sends a snapshot with each tab strip placement, sidebar side and strip view (D8), sanitized intact", () => {
    const placements = ["top", "left", "right"] as const;
    const sides = ["left", "right"] as const;
    const views = ["layered", "activity"] as const;
    for (const tabStripPlacement of placements) {
      for (const sidebarSide of sides) {
        for (const sideStripView of views) {
          const properties = layoutSnapshotProperties({
            ...DEFAULT_LAYOUT_SNAPSHOT,
            arrangement: {
              ...DEFAULT_ARRANGEMENT,
              tabStripPlacement,
              sidebarSide,
              sideStripView,
            },
          });
          const label = `${tabStripPlacement} / ${sidebarSide} / ${sideStripView}`;

          expect(properties.layout_tab_strip_placement).toBe(tabStripPlacement);
          expect(properties.layout_sidebar_side).toBe(sidebarSide);
          expect(properties.layout_side_strip_view).toBe(sideStripView);
          // The acceptance is that the payload passes the real sanitizer
          // INTACT - not merely that `track` returns `true`, which a
          // sanitizer that silently dropped one property to make the event
          // valid would still satisfy.
          expect(
            sanitizeAnalyticsProperties(
              AnalyticsEvent.LayoutSnapshot,
              properties,
            ),
            label,
          ).toEqual(properties);
          expect(
            Analytics.getInstance().track(
              AnalyticsEvent.LayoutSnapshot,
              properties,
            ),
            label,
          ).toBe(true);
        }
      }
    }
  });

  it("drops the whole event on a tab strip placement, sidebar side or strip view this build does not know", () => {
    const base = layoutSnapshotProperties(DEFAULT_LAYOUT_SNAPSHOT);

    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.LayoutSnapshot, {
        ...base,
        layout_tab_strip_placement: "bottom",
      }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.LayoutSnapshot, {
        ...base,
        layout_sidebar_side: "top",
      }),
    ).toBeNull();
    expect(
      sanitizeAnalyticsProperties(AnalyticsEvent.LayoutSnapshot, {
        ...base,
        layout_side_strip_view: "focused",
      }),
    ).toBeNull();
  });

  it("sends layout_quick_verb for every verb the menu offers", () => {
    // Keyed by `QuickVerbId`, so a verb added to the menu is a compile error
    // here until it has a row - rather than a hand-copied list that the
    // allowlist in `analytics.ts` could drift from unseen.
    const verbs: Readonly<Record<QuickVerbId, QuickVerbId>> = {
      hide: "hide",
      show: "show",
      chip: "chip",
      full: "full",
    };
    for (const verb of Object.values(verbs)) {
      expect(
        Analytics.getInstance().track(AnalyticsEvent.LayoutQuickVerb, {
          region: "runningAgents",
          verb,
          undone: verb === "hide",
        }),
      ).toBe(true);
    }
  });
});

describe("structural parity: LayoutValues cannot drift from the declared properties", () => {
  it("declares exactly one layout_<region>_<key> property per LayoutValues leaf", () => {
    // Counted off the model's own value bags, not off the walk the payload
    // builder and the allowlist share: a leaf that walk dropped would vanish
    // from both at once and pass every check derived from them.
    const regionIds = Object.keys(PRESET_VALUES.default) as ReadonlyArray<
      keyof typeof PRESET_VALUES.default
    >;
    const expectedCount = regionIds.reduce(
      (total, region) =>
        total + Object.keys(PRESET_VALUES.default[region]).length,
      0,
    );

    expect(LAYOUT_SETTING_PROPERTY_KEYS).toHaveLength(expectedCount);
    // No duplicate names: two regions or keys that snake-cased onto the same
    // property name would silently merge two settings into one property.
    expect(new Set(LAYOUT_SETTING_PROPERTY_KEYS).size).toBe(expectedCount);
  });

  it("names every declared property with the layout_<region>_<key> convention", () => {
    for (const key of LAYOUT_SETTING_PROPERTY_KEYS) {
      expect(key.startsWith("layout_")).toBe(true);
      expect(key).toMatch(/^layout_[a-z0-9_]+$/);
    }
  });

  it("drops the Access/Model Shown properties and gains the agent-rows one (G6, G7)", () => {
    expect(LAYOUT_SETTING_PROPERTY_KEYS).not.toContain("layout_access_shown");
    expect(LAYOUT_SETTING_PROPERTY_KEYS).not.toContain("layout_model_shown");
    expect(LAYOUT_SETTING_PROPERTY_KEYS).toContain(
      "layout_resource_monitor_agent_rows",
    );
  });

  it("keeps the event's built-in properties out of the per-setting key list", () => {
    const reserved = [
      "base_preset",
      "changed_from_default_count",
      "layout_usage_host",
      "layout_usage_side",
      "layout_minimap_side",
      "layout_resource_host",
      "layout_resource_side",
      "layout_tab_strip_placement",
      "layout_sidebar_side",
      "layout_side_strip_view",
      "layout_dock_reordered",
      "layout_toolbar_left_reordered",
      "layout_toolbar_right_reordered",
      "layout_rail_reordered",
      "layout_usage_providers_reordered",
    ];
    for (const name of reserved) {
      expect(LAYOUT_SETTING_PROPERTY_KEYS).not.toContain(name);
    }
  });
});

describe("the 24h compare-and-set (L-54, C-46)", () => {
  it("claims again once 24h have fully elapsed, and not one millisecond sooner", () => {
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    expect(claimLayoutSnapshotWindow(0)).toBe(true);

    expect(claimLayoutSnapshotWindow(TWENTY_FOUR_HOURS_MS - 1)).toBe(false);
    expect(claimLayoutSnapshotWindow(TWENTY_FOUR_HOURS_MS)).toBe(true);
  });

  it("refuses rather than throws when storage is fully unavailable", () => {
    // jsdom's `Storage` is Proxy-backed, so shadowing `getItem`/`setItem` as
    // own properties on the existing object does not reliably intercept the
    // module's own `localStorage.getItem(...)` calls - the whole
    // `window.localStorage` reference has to be replaced, the same way
    // `installMockLocalStorage` (`__tests__/test-browser-apis.ts`) does it.
    withThrowingLocalStorage(["getItem", "setItem"], () => {
      expect(claimLayoutSnapshotWindow(1_000)).toBe(false);
    });
  });

  it("refuses when the write cannot persist, even though the read succeeded", () => {
    // The write failing is the case that must not send: sending here would
    // re-claim on every future launch, since the timestamp never lands.
    withThrowingLocalStorage(["setItem"], () => {
      expect(claimLayoutSnapshotWindow(1_000)).toBe(false);
    });
  });
});

describe("layoutDurationBucket", () => {
  it("buckets at the documented edges", () => {
    expect(layoutDurationBucket(0)).toBe("under_10s");
    expect(layoutDurationBucket(9_999)).toBe("under_10s");
    expect(layoutDurationBucket(10_000)).toBe("10s_to_1m");
    expect(layoutDurationBucket(59_999)).toBe("10s_to_1m");
    expect(layoutDurationBucket(60_000)).toBe("1m_to_5m");
    expect(layoutDurationBucket(299_999)).toBe("1m_to_5m");
    expect(layoutDurationBucket(300_000)).toBe("over_5m");
    expect(layoutDurationBucket(1_000_000)).toBe("over_5m");
  });
});

describe("the session change summary", () => {
  it("counts only the regions whose effective values actually moved", () => {
    const entry = DEFAULT_LAYOUT_SNAPSHOT;
    const exit: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      overrides: { mic: { shown: "hidden" }, minimap: { shown: "hidden" } },
    };

    expect(
      layoutEditorSessionChangeSummary(entry, exit).regionsTouchedCount,
    ).toBe(2);
  });

  it("counts a region touched exactly once regardless of how many keys it changed", () => {
    const entry = DEFAULT_LAYOUT_SNAPSHOT;
    const exit: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      overrides: {
        usageLimits: { density: "compact", reset: false, amount: "remaining" },
      },
    };

    const summary = layoutEditorSessionChangeSummary(entry, exit);

    expect(summary.regionsTouchedCount).toBe(1);
    expect(summary.changedCount).toBe(3);
  });

  it("counts changed_count against the base preset, matching what a reset would revert", () => {
    // A preset switch with no further edits is zero VALUE changes, even
    // though every leaf's literal value differs from Compact's own base.
    const exit: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      basePreset: "compact",
    };

    const summary = layoutEditorSessionChangeSummary(
      DEFAULT_LAYOUT_SNAPSHOT,
      exit,
    );

    expect(summary.changedCount).toBe(0);
    expect(summary.regionsTouchedCount).toBeGreaterThan(0);
  });
});
