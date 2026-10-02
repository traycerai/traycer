import { describe, expect, it } from "vitest";
import { surfaceChanged } from "@/components/layout-editor/regions/surface-diff";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
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
