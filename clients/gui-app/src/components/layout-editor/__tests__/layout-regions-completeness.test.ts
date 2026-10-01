import { describe, expect, it } from "vitest";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import {
  quickVerbLabel,
  quickVerbToast,
} from "@/components/layout-editor/regions/quick-verbs";
import {
  LAYOUT_REGION_IDS,
  regionFacts,
  regionStateWord,
} from "@/components/layout-editor/regions/region-facts";
import { layoutFindResults } from "@/components/layout-editor/regions/region-filter-match";
import { SURFACE_GROUPS } from "@/components/layout-editor/regions/region-grammar";
import {
  positionAxisChanged,
  positionRowChanged,
  revertPositionAxis,
  revertPositionRow,
} from "@/components/layout-editor/regions/region-position-rows";
import {
  type LayoutOverrides,
  type LayoutValues,
} from "@/lib/layout/layout-values";
import {
  effectiveLayoutValues,
  PRESET_VALUES,
  SHIPPED_DEFAULT_VALUES,
} from "@/lib/layout/layout-presets";
import type { RegionId } from "@/lib/layout/region-id";
import { DEFAULT_LAYOUT_SNAPSHOT } from "@/stores/layout/layout-store";

/**
 * What the registry owes every caller that walks it.
 *
 * The reverse direction - a grammar row naming a key its region does not have
 * - is a compile error by construction (C-20), so it is deliberately not
 * tested here.
 */

/** The state words the vocabulary allows (L-33, L-47). Nothing else may appear. */
const STATE_WORDS: ReadonlyArray<string> = [
  "Shown",
  "Hidden",
  "Auto",
  "Chip",
  "Full row",
  "Icon only",
  "Icon and label",
  "Left",
  "Right",
  // The two bar readings say both halves of where they are (L-156).
  "Status bar, left",
  "Status bar, right",
  "Tab strip, left",
  "Tab strip, right",
  "Tab strip, start",
  "Tab strip, end",
  "Text",
  "Ring and number",
  "Ring only",
  "Bars",
  "Bars and text",
  // Tool activity and Thinking's disclosure default (audit R1, R3).
  "Open",
  "Closed",
];

/**
 * `shown` and `size` are the header's own display control rather than a
 * grammar row (L-08, L-128 overturned): `RegionDisplayControl` draws both off
 * the value shape directly, so they are the leaves a section does not reach
 * through `rows`.
 */
const HEADER_KEYS: ReadonlySet<string> = new Set(["shown", "size"]);

/**
 * `resourceMonitor.agentRows` tunes the SIDEBAR (the readings on each agent
 * and terminal row), not the monitor itself (G7): its control now lives on
 * `ResourceReadingsRow`, a Sidebar-surface row rather than one of this
 * region's own grammar rows.
 */
const SURFACE_OWNED_LEAVES: Readonly<
  Partial<Record<RegionId, ReadonlyArray<string>>>
> = {
  resourceMonitor: ["agentRows"],
};

const EVERY_REGION_HIDDEN: LayoutOverrides = {
  homeTab: { shown: "hidden" },
  usageLimits: { shown: "hidden" },
  resourceMonitor: { shown: "hidden" },
  minimap: { shown: "hidden" },
  contextUsage: { shown: "hidden" },
  thinking: { shown: "hidden" },
  timestamps: { shown: "hidden" },
  runningAgents: { shown: "hidden" },
  changedFiles: { shown: "hidden" },
  background: { shown: "hidden" },
  todo: { shown: "hidden" },
  attachImage: { shown: "hidden" },
  // Access, Model and Tool activity have no Shown (G6) - each floor is never
  // hidden.
  mic: { shown: "hidden" },
  railAgents: { shown: "hidden" },
  railTerminals: { shown: "hidden" },
  railBrowsers: { shown: "hidden" },
  railArtifacts: { shown: "hidden" },
  railGitDiff: { shown: "hidden" },
  railPullRequests: { shown: "hidden" },
  railFileTree: { shown: "hidden" },
  railSharing: { shown: "hidden" },
  railComments: { shown: "hidden" },
};

/** Every value set a preset or the Shown switch can put a region in. */
const REACHABLE_VALUES: ReadonlyArray<LayoutValues> = [
  PRESET_VALUES.default,
  PRESET_VALUES.compact,
  PRESET_VALUES.detailed,
  effectiveLayoutValues("default", EVERY_REGION_HIDDEN),
];

const MOVED_ARRANGEMENT = {
  ...DEFAULT_ARRANGEMENT,
  usageHost: "header" as const,
  usageSide: "right" as const,
  resourceHost: "header" as const,
  resourceSide: "left" as const,
  minimapSide: "left" as const,
};

/** Whether `query` finds `id` through Find a setting - by name, option, state or keyword. */
function findsRegion(query: string, id: RegionId): boolean {
  return layoutFindResults(query, DEFAULT_LAYOUT_SNAPSHOT).some(
    (result) => result.region === id,
  );
}

/** Which value keys a region's grammar rows can write. */
function keysReachableFromRows(region: RegionId): ReadonlyArray<string> {
  const entry = LAYOUT_REGIONS[region];
  return entry.rows.flatMap((row): string[] => {
    if (row.kind === "style") {
      return row.examples.flatMap((example) => Object.keys(example.patch));
    }
    if (row.kind === "fine-tune") {
      return row.rows.flatMap((fineTuneRow): string[] => {
        const control = fineTuneRow.control;
        return control.kind === "checks"
          ? control.options.map((option) => option.key)
          : [control.key];
      });
    }
    return [];
  });
}

describe("the region registry covers every region", () => {
  it("lists all twenty-five regions, grouped by surface", () => {
    expect(LAYOUT_REGION_IDS).toHaveLength(25);
    expect(new Set(LAYOUT_REGION_IDS).size).toBe(25);
    const surfaceOrder = LAYOUT_REGION_IDS.map(
      (id) => regionFacts(id).surface,
    ).map((surface) =>
      SURFACE_GROUPS.findIndex((group) => group.id === surface),
    );
    expect(surfaceOrder).toEqual([...surfaceOrder].sort((a, b) => a - b));
    expect(surfaceOrder).not.toContain(-1);
  });

  it("gives every region a name, a place and something to search it by", () => {
    for (const id of LAYOUT_REGION_IDS) {
      const entry = regionFacts(id);
      expect(entry.name.length, id).toBeGreaterThan(0);
      expect(entry.where.length, id).toBeGreaterThan(0);
      expect(entry.keywords.length, id).toBeGreaterThan(0);
      expect(findsRegion(entry.name, id), id).toBe(true);
      for (const keyword of entry.keywords) {
        expect(findsRegion(keyword, id), `${id}:${keyword}`).toBe(true);
      }
    }
  });

  /**
   * The dock's membership, asked of the registry rather than of the model
   * (L-139, L-142). Todo became a member with exactly the semantics the
   * other three have, so the claim is that nothing about their grammar reads
   * differently - not that one more id exists somewhere. Message queue is
   * deliberately NOT one of these (G1-G2): it is a fixed slot, never a dock
   * region.
   */
  it("gives every dock member the same size-and-order grammar", () => {
    const dockMembers = LAYOUT_REGION_IDS.filter((id) =>
      regionFacts(id).rows.some(
        (row) => row.kind === "position-order" && row.group === "dock",
      ),
    );
    expect([...dockMembers].sort()).toEqual([
      "background",
      "changedFiles",
      "runningAgents",
      "todo",
    ]);
    for (const id of dockMembers) {
      const entry = regionFacts(id);
      expect(entry.surface, id).toBe("composer");
      // Full row / Chip is `RegionDisplayControl`'s own display control now
      // (L-128 overturned), read off the value shape rather than off a
      // grammar row (there is no more "size" row kind).
      expect("size" in SHIPPED_DEFAULT_VALUES[id], id).toBe(true);
      expect(entry.quickVerbs.includes("chip"), id).toBe(true);
      expect(entry.quickVerbs.includes("full"), id).toBe(true);
    }
  });

  it("names the rail panels after the sidebar's own titles", () => {
    expect(regionFacts("railAgents").name).toBe("Agents");
    expect(regionFacts("railPullRequests").name).toBe("Pull Requests");
    expect(regionFacts("railGitDiff").name).toBe("Git Diff");
  });

  it("spells out the presence rule only where a panel has one", () => {
    expect(regionFacts("railPullRequests").hint).toBe(
      "Auto: appears when this task has pull requests.",
    );
    expect(regionFacts("railComments").hint).toBe(
      "Auto: appears after you open or start a comment on the active artifact.",
    );
    for (const id of ["railAgents", "railTerminals", "railFileTree"] as const) {
      expect(regionFacts(id).hint, id).toBeNull();
    }
  });
});

describe("every value leaf is reachable from a row", () => {
  it("leaves nothing but the header's own display control off the grammar", () => {
    for (const id of LAYOUT_REGION_IDS) {
      const surfaceOwned = SURFACE_OWNED_LEAVES[id] ?? [];
      const leaves = Object.keys(SHIPPED_DEFAULT_VALUES[id]).filter(
        (key) => !HEADER_KEYS.has(key) && !surfaceOwned.includes(key),
      );
      const reachable = new Set(keysReachableFromRows(id));
      for (const leaf of leaves) {
        expect(reachable.has(leaf), `${id}.${leaf}`).toBe(true);
      }
    }
  });

  it("pairs each metric check with the key it writes", () => {
    const fineTune = LAYOUT_REGIONS.resourceMonitor.rows.find(
      (row) => row.kind === "fine-tune",
    );
    expect(fineTune?.kind).toBe("fine-tune");
    const metricsRow =
      fineTune?.kind === "fine-tune"
        ? fineTune.rows.find((row) => row.id === "metrics")
        : undefined;
    const control = metricsRow?.control ?? null;
    expect(control?.kind).toBe("checks");
    if (control?.kind !== "checks") return;
    expect(control.options.map((option) => option.key)).toEqual([
      "cpu",
      "memory",
      "processes",
      "ramShare",
    ]);
    expect(control.options.map((option) => option.label)).toEqual([
      "CPU",
      "Memory",
      "Processes",
      "RAM share",
    ]);
  });
});

describe("state words", () => {
  it("stays inside the vocabulary for every reachable combination", () => {
    for (const id of LAYOUT_REGION_IDS) {
      for (const values of REACHABLE_VALUES) {
        for (const arrangement of [DEFAULT_ARRANGEMENT, MOVED_ARRANGEMENT]) {
          const word = regionStateWord(id, values, arrangement);
          expect(STATE_WORDS, `${id}: ${word}`).toContain(word);
        }
      }
    }
  });

  it("says Hidden wherever the region is switched off", () => {
    const hidden = effectiveLayoutValues("default", EVERY_REGION_HIDDEN);
    for (const id of LAYOUT_REGION_IDS) {
      // Access and Model have no Shown (G6) - never reads Hidden.
      if (!("shown" in SHIPPED_DEFAULT_VALUES[id])) continue;
      expect(regionStateWord(id, hidden, DEFAULT_ARRANGEMENT), id).toBe(
        "Hidden",
      );
    }
  });

  it("reads the position out of the arrangement, not out of the values", () => {
    const values = PRESET_VALUES.default;
    // Both halves, because both are the answer to "where is it" (L-156): a
    // row that said only "Tab strip" left the end it is on unsaid.
    expect(regionStateWord("usageLimits", values, DEFAULT_ARRANGEMENT)).toBe(
      "Status bar, left",
    );
    expect(regionStateWord("usageLimits", values, MOVED_ARRANGEMENT)).toBe(
      "Tab strip, right",
    );
    expect(regionStateWord("minimap", values, DEFAULT_ARRANGEMENT)).toBe(
      "Right",
    );
    expect(regionStateWord("minimap", values, MOVED_ARRANGEMENT)).toBe("Left");
    expect(
      regionStateWord("resourceMonitor", values, DEFAULT_ARRANGEMENT),
    ).toBe("Status bar, right");
    expect(regionStateWord("resourceMonitor", values, MOVED_ARRANGEMENT)).toBe(
      "Tab strip, left",
    );
  });

  it("distinguishes the density readings a preset produces", () => {
    expect(
      regionStateWord(
        "runningAgents",
        PRESET_VALUES.compact,
        DEFAULT_ARRANGEMENT,
      ),
    ).toBe("Chip");
    expect(
      regionStateWord(
        "runningAgents",
        PRESET_VALUES.default,
        DEFAULT_ARRANGEMENT,
      ),
    ).toBe("Full row");
    expect(
      regionStateWord("model", PRESET_VALUES.detailed, DEFAULT_ARRANGEMENT),
    ).toBe("Bars and text");
    expect(
      regionStateWord(
        "contextUsage",
        PRESET_VALUES.compact,
        DEFAULT_ARRANGEMENT,
      ),
    ).toBe("Ring only");
    expect(
      regionStateWord(
        "railPullRequests",
        PRESET_VALUES.default,
        DEFAULT_ARRANGEMENT,
      ),
    ).toBe("Auto");
  });
});

describe("quick verbs", () => {
  it("offers chip and full exactly where the region has a Size leaf", () => {
    for (const id of LAYOUT_REGION_IDS) {
      const entry = regionFacts(id);
      const sized = "size" in SHIPPED_DEFAULT_VALUES[id];
      expect(entry.quickVerbs.includes("chip"), id).toBe(sized);
      expect(entry.quickVerbs.includes("full"), id).toBe(sized);
    }
  });

  it("names the region in the copy that reads better with it", () => {
    expect(quickVerbLabel("hide", "minimap", "Minimap")).toBe("Hide Minimap");
    expect(quickVerbLabel("chip", "changedFiles", "Changed files")).toBe(
      "Show as chip",
    );
    expect(quickVerbToast("chip", "changedFiles", "Changed files")).toBe(
      "Changed files is a chip",
    );
    expect(quickVerbToast("full", "changedFiles", "Changed files")).toBe(
      "Changed files is a full row",
    );
    // Access's size reads as its own words, the ones its control uses (C11).
    expect(quickVerbLabel("chip", "access", "Access")).toBe("Show icon only");
    expect(quickVerbLabel("full", "access", "Access")).toBe(
      "Show icon and label",
    );
    expect(quickVerbToast("chip", "access", "Access")).toBe(
      "Access shows its icon only",
    );
    expect(quickVerbToast("full", "access", "Access")).toBe(
      "Access shows its icon and label",
    );
  });
});

describe("the Position row against the default arrangement (L-57)", () => {
  it("is unchanged on the shipped arrangement", () => {
    for (const id of LAYOUT_REGION_IDS) {
      expect(positionRowChanged(DEFAULT_LAYOUT_SNAPSHOT, id), id).toBe(false);
    }
  });

  it("notices a host, a side and an order move on the region that owns it", () => {
    const moved = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: MOVED_ARRANGEMENT,
    };
    expect(positionRowChanged(moved, "usageLimits")).toBe(true);
    expect(positionRowChanged(moved, "minimap")).toBe(true);
    expect(positionRowChanged(moved, "resourceMonitor")).toBe(true);
    expect(positionRowChanged(moved, "homeTab")).toBe(false);

    const reordered = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        dock: [...DEFAULT_ARRANGEMENT.dock].reverse(),
      },
    };
    expect(positionRowChanged(reordered, "runningAgents")).toBe(true);
    expect(positionRowChanged(reordered, "attachImage")).toBe(false);
  });

  it("puts one region's Position rows back and leaves the others alone", () => {
    const moved = {
      ...MOVED_ARRANGEMENT,
      dock: [...DEFAULT_ARRANGEMENT.dock].reverse(),
    };
    const reverted = revertPositionRow(moved, "minimap");
    expect(reverted.minimapSide).toBe(DEFAULT_ARRANGEMENT.minimapSide);
    expect(reverted.resourceSide).toBe("left");
    expect(reverted.usageHost).toBe("header");
    expect(reverted.dock).toEqual([...DEFAULT_ARRANGEMENT.dock].reverse());

    const dockBack = revertPositionRow(moved, "background");
    expect(dockBack.dock).toEqual(DEFAULT_ARRANGEMENT.dock);
    expect(dockBack.minimapSide).toBe("left");

    // A bar reading has two Position rows now, and the whole-region revert
    // puts both of its own back without touching the other reading (L-156).
    const usageBack = revertPositionRow(moved, "usageLimits");
    expect(usageBack.usageHost).toBe(DEFAULT_ARRANGEMENT.usageHost);
    expect(usageBack.usageSide).toBe(DEFAULT_ARRANGEMENT.usageSide);
    expect(usageBack.resourceHost).toBe("header");
    expect(usageBack.resourceSide).toBe("left");
  });

  /**
   * L-133 on the two readings' rows: a revert belongs to the ROW it sits on,
   * so putting the side back must not also bring the reading down a bar.
   */
  it("measures and reverts one axis at a time", () => {
    const moved = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: MOVED_ARRANGEMENT,
    };

    expect(positionAxisChanged(moved, "resourceMonitor", "position-host")).toBe(
      true,
    );
    expect(positionAxisChanged(moved, "resourceMonitor", "position-side")).toBe(
      true,
    );
    // The usage cluster moved bar but not, in this fixture, off the shipped
    // left - so its side row has nothing to put back.
    expect(
      positionAxisChanged(
        { ...moved, arrangement: { ...MOVED_ARRANGEMENT, usageSide: "left" } },
        "usageLimits",
        "position-side",
      ),
    ).toBe(false);

    const sideBack = revertPositionAxis(
      MOVED_ARRANGEMENT,
      "resourceMonitor",
      "position-side",
    );
    expect(sideBack.resourceSide).toBe(DEFAULT_ARRANGEMENT.resourceSide);
    expect(sideBack.resourceHost).toBe("header");
    expect(sideBack.usageSide).toBe("right");
  });
});
