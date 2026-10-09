import { describe, expect, it } from "vitest";
import {
  arrangementChangeLine,
  sessionChangeLines,
  styleChangeLines,
} from "@/components/layout-editor/inspector/layout-change-lines";
import { orderGroupListLabel } from "@/components/layout-editor/regions/surface-groups";
import {
  DEFAULT_ARRANGEMENT,
  DEFAULT_DOCK_ORDER,
  DEFAULT_TOOLBAR_LEFT,
  USAGE_PROVIDER_IDS,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import {
  layoutChanges,
  revertSession,
  revertSessionLine,
  type LayoutChange,
} from "@/lib/layout/layout-diff";
import {
  effectiveLayoutValues,
  PRESET_LABELS,
} from "@/lib/layout/layout-presets";
import type { LayoutOverrides } from "@/lib/layout/layout-values";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import { providerDisplayName } from "@/lib/provider-ordering";
import { DEFAULT_LAYOUT_SNAPSHOT } from "@/stores/layout/layout-store";

/**
 * `styleChangeLines` (item 7): a region's display (`shown`/`size`) is ONE
 * setting even though it is stored as two keys, so it is one line with both
 * changes folded in; every other key is its own line, read and reverted on
 * its own.
 */

function changeKey(change: LayoutChange): string {
  return change.kind === "value" ? change.key : change.kind;
}

function snapshotWithOverrides(overrides: LayoutOverrides): LayoutSnapshot {
  return { ...DEFAULT_LAYOUT_SNAPSHOT, overrides };
}

function lines(snapshot: LayoutSnapshot) {
  const changes = layoutChanges(snapshot);
  const values = effectiveLayoutValues(snapshot.basePreset, snapshot.overrides);
  return styleChangeLines(changes.styles, snapshot, values);
}

describe("a display change and a style change are two separate lines", () => {
  it("names each in the form's own words, and reverts only its own setting", () => {
    const snapshot = snapshotWithOverrides({
      contextUsage: { style: "ring-only", shown: "hidden" },
    });

    const result = lines(snapshot);
    expect(result).toHaveLength(2);

    const display = result.find((line) => line.label === "Context usage");
    const style = result.find((line) => line.label === "Context usage style");
    if (display === undefined || style === undefined) {
      throw new Error("expected both a display and a style line");
    }

    expect(display.current).toBe("Hidden");
    expect(display.baseline).toBe("Default: Shown");
    expect(display.changes.map(changeKey)).toEqual(["shown"]);

    expect(style.current).toBe("Ring only");
    expect(style.baseline).toBe("Default: Text");
    expect(style.changes.map(changeKey)).toEqual(["style"]);
  });
});

describe("a non-`style`-keyed style row (Model's Reasoning control)", () => {
  it("names the line by the row's own label, and words the value by its example", () => {
    const snapshot = snapshotWithOverrides({
      model: { reasoningControl: "list" },
    });

    const result = lines(snapshot);
    const line = result.find((entry) => entry.key === "model.reasoningControl");
    if (line === undefined) throw new Error("expected a reasoningControl line");

    expect(line.label).toBe("Model: Reasoning control");
    expect(line.current).toBe("List");
    expect(line.baseline).toBe("Default: Slider");
    expect(line.changes.map(changeKey)).toEqual(["reasoningControl"]);
  });
});

describe("a dock member's Chip+Hidden is one setting, not two", () => {
  it("folds shown and size into one line, reverted as one step", () => {
    const snapshot = snapshotWithOverrides({
      runningAgents: { shown: "hidden", size: "chip" },
    });

    const result = lines(snapshot);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Running agents");
    expect(result[0].current).toBe("Hidden");
    expect(result[0].changes.map(changeKey).sort()).toEqual(["shown", "size"]);
  });
});

describe("Tool activity and Thinking read Open and Closed, not a dock row's words", () => {
  it("words each line by its own control's options", () => {
    const snapshot = snapshotWithOverrides({
      toolActivity: { size: "full" },
      thinking: { size: "full" },
    });

    const result = lines(snapshot);
    expect(
      result.map((line) => [line.label, line.current, line.baseline]),
    ).toEqual([
      ["Tool activity", "Open", "Default: Closed"],
      ["Thinking", "Open", "Default: Closed"],
    ]);
  });
});

describe("a value stored in another region's bag is named for the row that sets it", () => {
  it("reads Model's toolbarStyle as the Composer's Toolbar style, in the example's words", () => {
    const result = lines(
      snapshotWithOverrides({ model: { toolbarStyle: "bordered" } }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Toolbar style");
    expect(result[0].current).toBe("Bordered");
    expect(result[0].baseline).toBe("Default: Flat");
    expect(result[0].changes.map(changeKey)).toEqual(["toolbarStyle"]);
  });

  it("reads the Resource monitor's agentRows as the Sidebar's readings row", () => {
    const result = lines(
      snapshotWithOverrides({ resourceMonitor: { agentRows: true } }),
    );

    expect(result.map((line) => line.label)).toEqual([
      "Readings on agent rows",
    ]);
  });

  it("keeps a region's own style line apart from the toolbar's", () => {
    const result = lines(
      snapshotWithOverrides({
        model: { toolbarStyle: "bordered", style: "bars" },
      }),
    );

    expect(result.map((line) => line.label).sort()).toEqual([
      "Model style",
      "Toolbar style",
    ]);
  });
});

describe("the pinned breakdown's order (C2)", () => {
  const reordered: LayoutArrangement = {
    ...DEFAULT_ARRANGEMENT,
    pinnedContextFieldOrder: [
      ...DEFAULT_ARRANGEMENT.pinnedContextFieldOrder,
    ].reverse(),
  };

  it("is one arrangement line, named for the row that drags it, reverted on its own", () => {
    const line = arrangementChangeLine({ kind: "pinnedFieldOrder" });

    expect(line.label).toBe("Context usage: Breakdown order");
    expect(line.current).toBe("Reordered");
    expect(line.baseline).toBe("Default order");
    expect(line.changes).toEqual([{ kind: "pinnedFieldOrder" }]);
  });

  it("is one session line, and its revert goes back to the order the session opened with", () => {
    const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
    const current = sessionSnapshot("default", {}, reordered);

    const { arrangement } = sessionChangeLines(entry, current);

    expect(arrangement).toEqual([
      {
        key: "pinnedFieldOrder",
        label: "Context usage: Breakdown order",
        before: null,
        after: "Reordered",
        revert: { kind: "changes", changes: [{ kind: "pinnedFieldOrder" }] },
      },
    ]);
    expect(
      revertSessionLine(current, entry, arrangement[0].revert).arrangement
        .pinnedContextFieldOrder,
    ).toEqual(DEFAULT_ARRANGEMENT.pinnedContextFieldOrder);
  });
});

describe("arrangementChangeLine - Reading width", () => {
  it("labels the field, its current word and its shipped default", () => {
    const line = arrangementChangeLine({
      kind: "field",
      field: "readingWidth",
      current: "wide",
      baseline: "comfortable",
    });

    expect(line.label).toBe("Reading width");
    expect(line.current).toBe("Wide");
    expect(line.baseline).toBe("Default: Comfortable");
  });
});

/**
 * `wideReadingWidthPx` is a continuous number, not one of a small option set
 * like `readingWidth` above - `fieldWord` formats it directly rather than
 * looking it up in `FIELD_OPTIONS`.
 */
describe("arrangementChangeLine - Wide column width", () => {
  it("words a changed px value as itself, not through the option table", () => {
    const line = arrangementChangeLine({
      kind: "field",
      field: "wideReadingWidthPx",
      current: 1240,
      baseline: DEFAULT_ARRANGEMENT.wideReadingWidthPx,
    });

    expect(line.label).toBe("Wide column width");
    expect(line.current).toBe("1240px");
    expect(line.baseline).toBe(
      `Default: ${DEFAULT_ARRANGEMENT.wideReadingWidthPx}px`,
    );
  });
});

function sessionSnapshot(
  basePreset: LayoutSnapshot["basePreset"],
  overrides: LayoutOverrides,
  arrangement: LayoutArrangement,
): LayoutSnapshot {
  return { basePreset, overrides, arrangement };
}

/**
 * `sessionChangeLines` (session changes row): what an editor session has
 * changed since it opened, measured against the ENTRY snapshot rather than
 * the last-applied preset - so a layout already modified before the session
 * began reads as no changes at all, unlike the preset-based View changes list.
 */
describe("sessionChangeLines", () => {
  describe("identical entry and current", () => {
    it("reads no changes in either list", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);

      const lines = sessionChangeLines(entry, current);

      expect(lines.styles).toEqual([]);
      expect(lines.arrangement).toEqual([]);
    });
  });

  describe("a display change", () => {
    it("names the region and words Shown/Hidden, with a value revert", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        { minimap: { shown: "hidden" } },
        DEFAULT_ARRANGEMENT,
      );

      const lines = sessionChangeLines(entry, current);

      expect(lines.styles).toEqual([
        {
          key: "minimap.display",
          label: "Minimap",
          before: "Shown",
          after: "Hidden",
          revert: {
            kind: "changes",
            changes: [
              {
                kind: "value",
                region: "minimap",
                key: "shown",
                current: "hidden",
                baseline: "shown",
              },
            ],
          },
        },
      ]);
    });

    it("folds a region's shown AND size both changing into one line", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        { runningAgents: { shown: "hidden", size: "chip" } },
        DEFAULT_ARRANGEMENT,
      );

      const lines = sessionChangeLines(entry, current);

      expect(lines.styles).toHaveLength(1);
      expect(lines.styles[0].key).toBe("runningAgents.display");
      expect(lines.styles[0].label).toBe("Running agents");
    });
  });

  describe("a preset switch", () => {
    it("puts a Preset line first, then the values it visibly moved, each with its own revert", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot("compact", {}, DEFAULT_ARRANGEMENT);

      const lines = sessionChangeLines(entry, current);

      expect(lines.styles[0]).toEqual({
        key: "preset",
        label: "Preset",
        before: PRESET_LABELS.default,
        after: PRESET_LABELS.compact,
        revert: { kind: "preset" },
      });

      // Timestamps and Microphone are both Shown under Default and Hidden
      // under Compact - values the switch visibly moved.
      expect(lines.styles).toContainEqual({
        key: "timestamps.display",
        label: "Timestamps",
        before: "Shown",
        after: "Hidden",
        revert: {
          kind: "changes",
          changes: [
            {
              kind: "value",
              region: "timestamps",
              key: "shown",
              current: "hidden",
              baseline: "shown",
            },
          ],
        },
      });
      expect(lines.styles).toContainEqual({
        key: "mic.display",
        label: "Microphone",
        before: "Shown",
        after: "Hidden",
        revert: {
          kind: "changes",
          changes: [
            {
              kind: "value",
              region: "mic",
              key: "shown",
              current: "hidden",
              baseline: "shown",
            },
          ],
        },
      });

      // Minimap and Home tab read identically under both presets, so a
      // switch between them names no line for either.
      expect(lines.styles.some((line) => line.label === "Minimap")).toBe(false);
      expect(lines.styles.some((line) => line.label === "Home tab")).toBe(
        false,
      );
    });
  });

  describe("an entry already modified against its preset", () => {
    it("reads no changes when the session itself changed nothing (the point of this list)", () => {
      const overrides: LayoutOverrides = { mic: { shown: "hidden" } };
      const entry = sessionSnapshot("default", overrides, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        overrides,
        DEFAULT_ARRANGEMENT,
      );

      const lines = sessionChangeLines(entry, current);

      expect(lines.styles).toEqual([]);
      expect(lines.arrangement).toEqual([]);
    });
  });

  describe("an arrangement field change", () => {
    it("names the field and words its before/after, with a field revert", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        {},
        {
          ...DEFAULT_ARRANGEMENT,
          sidebarSide: "right",
        },
      );

      const lines = sessionChangeLines(entry, current);

      expect(lines.arrangement).toContainEqual({
        key: "sidebarSide",
        label: "Sidebar side",
        before: "Left",
        after: "Right",
        revert: {
          kind: "changes",
          changes: [
            {
              kind: "field",
              field: "sidebarSide",
              current: "right",
              baseline: "left",
            },
          ],
        },
      });
    });
  });

  describe("a reordered order group", () => {
    it("reads before: null, after: Reordered, with an order revert", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        {},
        {
          ...DEFAULT_ARRANGEMENT,
          dock: [...DEFAULT_DOCK_ORDER].reverse(),
        },
      );

      const lines = sessionChangeLines(entry, current);

      expect(lines.arrangement).toContainEqual({
        key: "order.dock",
        label: `${orderGroupListLabel("dock")} order`,
        before: null,
        after: "Reordered",
        revert: {
          kind: "changes",
          changes: [{ kind: "order", group: "dock" }],
        },
      });
    });
  });

  describe("a provider hidden", () => {
    it("reads Shown/Hidden, Automatic limits, with a provider revert", () => {
      const [providerId] = USAGE_PROVIDER_IDS;
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        {},
        {
          ...DEFAULT_ARRANGEMENT,
          hiddenProviders: [providerId],
        },
      );

      const lines = sessionChangeLines(entry, current);

      expect(lines.arrangement).toContainEqual({
        key: `provider.${providerId}`,
        label: providerDisplayName(providerId),
        before: "Shown, Automatic limits",
        after: "Hidden, Automatic limits",
        revert: {
          kind: "changes",
          changes: [{ kind: "provider", providerId }],
        },
      });
    });
  });

  describe("a change made and then reverted to the entry value", () => {
    it("reads no changes, even though `current` is a different object", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const changed: LayoutArrangement = {
        ...DEFAULT_ARRANGEMENT,
        sidebarSide: "right",
      };
      const reverted: LayoutArrangement = {
        ...changed,
        sidebarSide: DEFAULT_ARRANGEMENT.sidebarSide,
      };
      const current = sessionSnapshot("default", {}, reverted);

      const lines = sessionChangeLines(entry, current);

      expect(lines.styles).toEqual([]);
      expect(lines.arrangement).toEqual([]);
    });
  });

  describe("dividerSeq alone differing", () => {
    it("reads no changes: it is bookkeeping, not a setting", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        {},
        {
          ...DEFAULT_ARRANGEMENT,
          dividerSeq: DEFAULT_ARRANGEMENT.dividerSeq + 5,
        },
      );

      const lines = sessionChangeLines(entry, current);

      expect(lines.styles).toEqual([]);
      expect(lines.arrangement).toEqual([]);
    });
  });
});

/**
 * `revertSessionLine` / `revertSession`: what one line's revert, or the
 * level's "Revert all", puts back - exactly that line (or everything), and
 * nothing else the session also changed.
 */
describe("revertSessionLine", () => {
  function styleKeys(snapshot: LayoutSnapshot, entry: LayoutSnapshot) {
    return sessionChangeLines(entry, snapshot).styles.map((line) => line.key);
  }

  function arrangementKeys(snapshot: LayoutSnapshot, entry: LayoutSnapshot) {
    return sessionChangeLines(entry, snapshot).arrangement.map(
      (line) => line.key,
    );
  }

  describe("a value line, including a display line with shown AND size", () => {
    it("reverts only that region's line, leaving an unrelated one in place", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        {
          runningAgents: { shown: "hidden", size: "chip" },
          mic: { shown: "hidden" },
        },
        DEFAULT_ARRANGEMENT,
      );
      const lines = sessionChangeLines(entry, current);
      const line = lines.styles.find(
        (entry) => entry.key === "runningAgents.display",
      );
      if (line === undefined) throw new Error("expected a display line");

      const result = revertSessionLine(current, entry, line.revert);

      expect(result.overrides.runningAgents).toBeUndefined();
      expect(styleKeys(result, entry)).toEqual(["mic.display"]);
    });
  });

  describe("a value line reverted after the preset changed mid-session", () => {
    it("writes the entry's value as an override against the CURRENT preset, leaving the preset switch and the other moved values in place", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      // A pure preset switch: Compact's own `timestamps.shown` is "hidden",
      // which differs from Default's "shown" - the entry's value.
      const current = sessionSnapshot("compact", {}, DEFAULT_ARRANGEMENT);
      const lines = sessionChangeLines(entry, current);
      const line = lines.styles.find(
        (entry) => entry.key === "timestamps.display",
      );
      if (line === undefined) throw new Error("expected a timestamps line");

      const result = revertSessionLine(current, entry, line.revert);

      // Compact's own base ("hidden") differs from the entry's value
      // ("shown"), so the revert has to WRITE an override rather than merely
      // dropping one.
      expect(result.basePreset).toBe("compact");
      expect(result.overrides.timestamps).toEqual({ shown: "shown" });

      const afterKeys = styleKeys(result, entry);
      expect(afterKeys).not.toContain("timestamps.display");
      // The preset switch itself, and the other value it visibly moved,
      // survive this one line's revert untouched.
      expect(afterKeys).toContain("preset");
      expect(afterKeys).toContain("mic.display");
    });
  });

  describe("a field line", () => {
    it("reverts only that field, leaving another field change in place", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        {},
        {
          ...DEFAULT_ARRANGEMENT,
          sidebarSide: "right",
          minimapSide: "left",
        },
      );
      const lines = sessionChangeLines(entry, current);
      const line = lines.arrangement.find(
        (entry) => entry.key === "sidebarSide",
      );
      if (line === undefined) throw new Error("expected a sidebarSide line");

      const result = revertSessionLine(current, entry, line.revert);

      expect(result.arrangement.sidebarSide).toBe(
        DEFAULT_ARRANGEMENT.sidebarSide,
      );
      expect(result.arrangement.minimapSide).toBe("left");
      expect(arrangementKeys(result, entry)).toEqual(["minimapSide"]);
    });
  });

  describe("an order line", () => {
    it("reverts only that group's order, leaving another group's reorder in place", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        {},
        {
          ...DEFAULT_ARRANGEMENT,
          dock: [...DEFAULT_DOCK_ORDER].reverse(),
          toolbarLeft: [...DEFAULT_TOOLBAR_LEFT].reverse(),
        },
      );
      const lines = sessionChangeLines(entry, current);
      const line = lines.arrangement.find(
        (entry) => entry.key === "order.dock",
      );
      if (line === undefined) throw new Error("expected an order.dock line");

      const result = revertSessionLine(current, entry, line.revert);

      expect(result.arrangement.dock).toEqual(DEFAULT_DOCK_ORDER);
      expect(result.arrangement.toolbarLeft).toEqual(
        [...DEFAULT_TOOLBAR_LEFT].reverse(),
      );
      expect(arrangementKeys(result, entry)).toEqual(["order.toolbarLeft"]);
    });
  });

  describe("a provider line", () => {
    const [providerA, providerB] = USAGE_PROVIDER_IDS;

    it("reverts a hidden provider without touching another provider's picked limits", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        {},
        {
          ...DEFAULT_ARRANGEMENT,
          hiddenProviders: [providerA],
          providerLimits: { [providerB]: { limitKeys: ["custom-key"] } },
        },
      );
      const lines = sessionChangeLines(entry, current);
      const line = lines.arrangement.find(
        (entry) => entry.key === `provider.${providerA}`,
      );
      if (line === undefined) throw new Error("expected a provider line");

      const result = revertSessionLine(current, entry, line.revert);

      expect(result.arrangement.hiddenProviders).not.toContain(providerA);
      expect(result.arrangement.providerLimits[providerB]).toEqual({
        limitKeys: ["custom-key"],
      });
      expect(arrangementKeys(result, entry)).toEqual([`provider.${providerB}`]);
    });

    it("reverts a provider's picked limits without touching another provider's hidden state", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "default",
        {},
        {
          ...DEFAULT_ARRANGEMENT,
          hiddenProviders: [providerA],
          providerLimits: { [providerB]: { limitKeys: ["custom-key"] } },
        },
      );
      const lines = sessionChangeLines(entry, current);
      const line = lines.arrangement.find(
        (entry) => entry.key === `provider.${providerB}`,
      );
      if (line === undefined) throw new Error("expected a provider line");

      const result = revertSessionLine(current, entry, line.revert);

      expect(result.arrangement.providerLimits[providerB]).toBeUndefined();
      expect(result.arrangement.hiddenProviders).toContain(providerA);
      expect(arrangementKeys(result, entry)).toEqual([`provider.${providerA}`]);
    });
  });

  describe("the preset line", () => {
    it("restores basePreset and overrides, but leaves an arrangement change made afterward in place", () => {
      const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
      const current = sessionSnapshot(
        "compact",
        {},
        {
          ...DEFAULT_ARRANGEMENT,
          sidebarSide: "right",
        },
      );
      const lines = sessionChangeLines(entry, current);
      const line = lines.styles.find((entry) => entry.key === "preset");
      if (line === undefined) throw new Error("expected a preset line");

      const result = revertSessionLine(current, entry, line.revert);

      expect(result.basePreset).toBe(entry.basePreset);
      expect(result.overrides).toEqual(entry.overrides);
      expect(result.arrangement.sidebarSide).toBe("right");

      expect(styleKeys(result, entry)).toEqual([]);
      expect(arrangementKeys(result, entry)).toEqual(["sidebarSide"]);
    });
  });
});

describe("revertSession", () => {
  it("leaves zero lines in either list", () => {
    const entry = sessionSnapshot("default", {}, DEFAULT_ARRANGEMENT);
    const current = sessionSnapshot(
      "compact",
      {},
      {
        ...DEFAULT_ARRANGEMENT,
        sidebarSide: "right",
        hiddenProviders: [USAGE_PROVIDER_IDS[0]],
      },
    );

    const result = revertSession(current, entry);
    const lines = sessionChangeLines(entry, result);

    expect(lines.styles).toEqual([]);
    expect(lines.arrangement).toEqual([]);
  });

  it("keeps dividerSeq at max(entry, current) when the session raised it", () => {
    const entry = sessionSnapshot(
      "default",
      {},
      {
        ...DEFAULT_ARRANGEMENT,
        dividerSeq: 3,
      },
    );
    const current = sessionSnapshot(
      "default",
      {},
      {
        ...DEFAULT_ARRANGEMENT,
        dividerSeq: 9,
      },
    );

    const result = revertSession(current, entry);

    expect(result.arrangement.dividerSeq).toBe(9);
  });

  it("keeps dividerSeq at max(entry, current) when the entry's was already higher", () => {
    const entry = sessionSnapshot(
      "default",
      {},
      {
        ...DEFAULT_ARRANGEMENT,
        dividerSeq: 9,
      },
    );
    const current = sessionSnapshot(
      "default",
      {},
      {
        ...DEFAULT_ARRANGEMENT,
        dividerSeq: 3,
      },
    );

    const result = revertSession(current, entry);

    expect(result.arrangement.dividerSeq).toBe(9);
  });
});
