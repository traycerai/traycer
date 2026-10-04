import { describe, expect, it } from "vitest";
import {
  regionRowChanged,
  revertedRegionRow,
  surfaceChanged,
} from "@/components/layout-editor/regions/surface-diff";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import { CONTEXT_USAGE_ROW_KEYS } from "@/lib/context-usage-rows";
import type { RegionId } from "@/lib/layout/region-id";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import { DEFAULT_LAYOUT_SNAPSHOT } from "@/stores/layout/layout-store";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";

const ALL_SURFACES: ReadonlyArray<SurfaceGroupId> = [
  "topBar",
  "sidebar",
  "chat",
  "composer",
  "statusBar",
];

/** Every surface but the one under test, for the isolation half of each case. */
function otherSurfaces(surface: SurfaceGroupId): ReadonlyArray<SurfaceGroupId> {
  return ALL_SURFACES.filter((entry) => entry !== surface);
}

/** One snapshot that moves exactly one thing, and the surface it must light. */
interface LitCase {
  readonly name: string;
  readonly surface: SurfaceGroupId;
  readonly snapshot: LayoutSnapshot;
}

function withOverrides(overrides: LayoutSnapshot["overrides"]): LayoutSnapshot {
  return { ...DEFAULT_LAYOUT_SNAPSHOT, overrides };
}

function withArrangement(
  arrangement: Partial<LayoutSnapshot["arrangement"]>,
): LayoutSnapshot {
  return {
    ...DEFAULT_LAYOUT_SNAPSHOT,
    arrangement: { ...DEFAULT_ARRANGEMENT, ...arrangement },
  };
}

// Home tab carries no Position row and topBar owns no order group
// (`SURFACE_ORDER_GROUPS.topBar` is empty), so topBar has no region-level
// "Position move" distinct from its surface-only fields. Chat has one
// order-less region with a Position row (Minimap) and it reads the very field
// that is chat's own surface-only field (`minimapSide`), so one row covers
// both. Composer owns no surface-only field (`SURFACE_FIELDS_CHANGED.composer`
// is `() => false`), so the page never offers Reset on Composer unless a value
// or an order moved.
const LIT_CASES: ReadonlyArray<LitCase> = [
  {
    name: "topBar: a value change on its one region (Home tab)",
    surface: "topBar",
    snapshot: withOverrides({ homeTab: { shown: "shown" } }),
  },
  {
    name: "topBar: the Position field (tab strip placement)",
    surface: "topBar",
    snapshot: withArrangement({ tabStripPlacement: "left" }),
  },
  {
    name: "topBar: the View field (side strip view)",
    surface: "topBar",
    snapshot: withArrangement({ sideStripView: "activity" }),
  },
  {
    name: "sidebar: a value change on a rail region",
    surface: "sidebar",
    snapshot: withOverrides({ railComments: { shown: "hidden" } }),
  },
  {
    name: "sidebar: reordering the rail (a Position move)",
    surface: "sidebar",
    snapshot: withArrangement({
      rail: [...DEFAULT_ARRANGEMENT.rail].reverse(),
    }),
  },
  {
    name: "sidebar: the Side field",
    surface: "sidebar",
    snapshot: withArrangement({ sidebarSide: "right" }),
  },
  {
    name: "chat: a value change on Context usage (no Position row)",
    surface: "chat",
    snapshot: withOverrides({ contextUsage: { style: "ring" } }),
  },
  {
    name: "chat: moving the minimap's side, both as the region's Position row and as the surface's own field",
    surface: "chat",
    snapshot: withArrangement({ minimapSide: "left" }),
  },
  {
    name: "chat: the wide column width (C5)",
    surface: "chat",
    snapshot: withArrangement({ wideReadingWidthPx: 1600 }),
  },
  {
    name: "chat: the pinned breakdown's field order (C2)",
    surface: "chat",
    snapshot: withArrangement({
      pinnedContextFieldOrder: [...CONTEXT_USAGE_ROW_KEYS].reverse(),
    }),
  },
  {
    // `agentRows` is stored in the Resource monitor's bag but is a Sidebar row.
    name: "sidebar: the agent rows' readings, though they live in the Resource monitor's values (T4)",
    surface: "sidebar",
    snapshot: withOverrides({ resourceMonitor: { agentRows: false } }),
  },
  {
    // `toolbarStyle` is stored in the Model bag but is a Composer area row.
    name: "composer: the toolbar's style, though it lives in Model's values (T4)",
    surface: "composer",
    snapshot: withOverrides({ model: { toolbarStyle: "bordered" } }),
  },
  {
    name: "composer: a value change on Todo's size",
    surface: "composer",
    snapshot: withOverrides({ todo: { size: "chip" } }),
  },
  {
    name: "composer: reordering the dock (a Position move)",
    surface: "composer",
    snapshot: withArrangement({
      dock: [...DEFAULT_ARRANGEMENT.dock].reverse(),
    }),
  },
  {
    name: "statusBar: a value change on Usage limits",
    surface: "statusBar",
    snapshot: withOverrides({ usageLimits: { reset: false } }),
  },
  {
    name: "statusBar: moving Usage limits to the tab strip's bar (a Position move)",
    surface: "statusBar",
    snapshot: withArrangement({ usageHost: "header" }),
  },
  {
    name: "statusBar: hiding a provider (a surface-only field)",
    surface: "statusBar",
    snapshot: withArrangement({
      hiddenProviders: [DEFAULT_ARRANGEMENT.usageProviders[0]],
    }),
  },
  {
    name: "statusBar: turning on the small-screen footer (a surface-only field)",
    surface: "statusBar",
    snapshot: withArrangement({ mobileFooter: true }),
  },
];

/**
 * `surfaceChanged` has three disjuncts (a region's value, a region's Position
 * row / its group's order, and the surface's own arrangement fields). Every
 * case below moves exactly one of them and checks both that the surface under
 * test lights up AND that no other surface does - a shared field wired to the
 * wrong surface, or an `||` collapsed to the wrong operand, would still pass a
 * test that only checked the positive side.
 */
describe("surfaceChanged", () => {
  it.each(LIT_CASES)(
    "$name lights it, and no other surface",
    ({ surface, snapshot }) => {
      expect(surfaceChanged(snapshot, surface)).toBe(true);
      for (const other of otherSurfaces(surface)) {
        expect(surfaceChanged(snapshot, other), other).toBe(false);
      }
    },
  );

  it("statusBar: a provider stored as Automatic does not light it", () => {
    const snapshot: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        providerLimits: {
          [DEFAULT_ARRANGEMENT.usageProviders[0]]: { limitKeys: [] },
        },
      },
    };
    expect(surfaceChanged(snapshot, "statusBar")).toBe(false);
  });
});

/**
 * T2: an ORDER belongs to its list, not to one row in it. One drag shifts the
 * index of every row below it, so a per-row reading lit many dots and each
 * revert put the whole group back; the list's header owns both now.
 */
describe("a row's own dot and revert never carry an order (T2)", () => {
  const MOVED: ReadonlyArray<{
    readonly group: string;
    readonly surface: SurfaceGroupId;
    readonly members: ReadonlyArray<RegionId>;
    readonly arrangement: Partial<LayoutSnapshot["arrangement"]>;
    readonly field: "rail" | "dock" | "toolbarLeft" | "toolbarRight";
  }> = [
    {
      group: "rail",
      surface: "sidebar",
      field: "rail",
      members: DEFAULT_ARRANGEMENT.rail.flatMap((entry) =>
        entry.kind === "panel" ? [entry.id] : [],
      ),
      arrangement: { rail: [...DEFAULT_ARRANGEMENT.rail].reverse() },
    },
    {
      group: "dock",
      surface: "composer",
      field: "dock",
      members: DEFAULT_ARRANGEMENT.dock,
      arrangement: { dock: [...DEFAULT_ARRANGEMENT.dock].reverse() },
    },
    {
      group: "toolbarLeft",
      surface: "composer",
      field: "toolbarLeft",
      members: DEFAULT_ARRANGEMENT.toolbarLeft,
      arrangement: {
        toolbarLeft: [...DEFAULT_ARRANGEMENT.toolbarLeft].reverse(),
      },
    },
    {
      group: "toolbarRight",
      surface: "composer",
      field: "toolbarRight",
      members: DEFAULT_ARRANGEMENT.toolbarRight,
      arrangement: {
        toolbarRight: [...DEFAULT_ARRANGEMENT.toolbarRight].reverse(),
      },
    },
  ];

  it.each(MOVED)(
    "$group: no member row shows a changed dot, and a row's revert leaves the order alone",
    ({ members, arrangement, field, surface }) => {
      const snapshot = withArrangement(arrangement);

      for (const region of members) {
        expect(regionRowChanged(snapshot, region), region).toBe(false);
        expect(
          revertedRegionRow(snapshot, region).arrangement[field],
          region,
        ).toEqual(snapshot.arrangement[field]);
      }
      // The order is still seen, by the area that holds the list: that dot
      // and the header's revert are where it shows.
      expect(surfaceChanged(snapshot, surface)).toBe(true);
    },
  );

  it("a host move still lights its row, and the row's revert puts the host back and the Profiles order stays", () => {
    const reversed = [...DEFAULT_ARRANGEMENT.usageProviders].reverse();
    const snapshot = withArrangement({
      usageHost: "header",
      usageProviders: reversed,
    });

    expect(regionRowChanged(snapshot, "usageLimits")).toBe(true);

    const reverted = revertedRegionRow(snapshot, "usageLimits").arrangement;

    expect(reverted.usageHost).toBe(DEFAULT_ARRANGEMENT.usageHost);
    expect(reverted.usageProviders).toEqual(reversed);
  });

  it("a Profiles reorder alone leaves the Usage limits row dark, while a hidden provider lights it", () => {
    const reversed = [...DEFAULT_ARRANGEMENT.usageProviders].reverse();

    expect(
      regionRowChanged(
        withArrangement({ usageProviders: reversed }),
        "usageLimits",
      ),
    ).toBe(false);
    expect(
      regionRowChanged(
        withArrangement({
          usageProviders: reversed,
          hiddenProviders: [DEFAULT_ARRANGEMENT.usageProviders[0]],
        }),
        "usageLimits",
      ),
    ).toBe(true);
  });
});

describe("the Context usage row carries the pinned breakdown's order (C2)", () => {
  const reordered = withArrangement({
    pinnedContextFieldOrder: [...CONTEXT_USAGE_ROW_KEYS].reverse(),
  });

  it("lights the row's dot, and no other region's", () => {
    expect(regionRowChanged(reordered, "contextUsage")).toBe(true);
    expect(regionRowChanged(reordered, "minimap")).toBe(false);
  });

  it("puts the order back from the row's revert, together with the row's own values", () => {
    const snapshot: LayoutSnapshot = {
      ...reordered,
      overrides: { contextUsage: { style: "ring" } },
    };

    const reverted = revertedRegionRow(snapshot, "contextUsage");

    expect(reverted.arrangement.pinnedContextFieldOrder).toEqual(
      DEFAULT_ARRANGEMENT.pinnedContextFieldOrder,
    );
    expect(regionRowChanged(reverted, "contextUsage")).toBe(false);
  });
});

/**
 * T4: two values live in another region's bag but are rows of another area.
 * Their area's dot counts them and the owning region's row does not, so a
 * revert on that row cannot undo a setting it does not show.
 */
describe("a value another area's row sets is not its owner's (T4)", () => {
  const agentRowsOff: LayoutSnapshot = {
    ...DEFAULT_LAYOUT_SNAPSHOT,
    overrides: { resourceMonitor: { agentRows: false } },
  };
  const toolbarBordered: LayoutSnapshot = {
    ...DEFAULT_LAYOUT_SNAPSHOT,
    overrides: { model: { toolbarStyle: "bordered" } },
  };

  it("lights neither Resource monitor's row nor Model's row, only the area that draws it", () => {
    expect(regionRowChanged(agentRowsOff, "resourceMonitor")).toBe(false);
    expect(regionRowChanged(toolbarBordered, "model")).toBe(false);
    expect(surfaceChanged(agentRowsOff, "sidebar")).toBe(true);
    expect(surfaceChanged(agentRowsOff, "statusBar")).toBe(false);
    expect(surfaceChanged(toolbarBordered, "composer")).toBe(true);
  });

  it("keeps the value on the owner's revert while the owner's own values go back", () => {
    const snapshot: LayoutSnapshot = {
      ...DEFAULT_LAYOUT_SNAPSHOT,
      overrides: {
        resourceMonitor: { agentRows: false, cpu: false },
        model: { toolbarStyle: "bordered", style: "bars" },
      },
    };

    expect(regionRowChanged(snapshot, "resourceMonitor")).toBe(true);
    expect(regionRowChanged(snapshot, "model")).toBe(true);

    const monitor = effectiveLayoutValues(
      "default",
      revertedRegionRow(snapshot, "resourceMonitor").overrides,
    ).resourceMonitor;
    const model = effectiveLayoutValues(
      "default",
      revertedRegionRow(snapshot, "model").overrides,
    ).model;

    expect(monitor.cpu).toBe(true);
    expect(monitor.agentRows).toBe(false);
    expect(model.style).toBe("text");
    expect(model.toolbarStyle).toBe("bordered");
  });
});
