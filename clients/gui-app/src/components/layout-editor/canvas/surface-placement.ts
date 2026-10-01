import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { writeArrangementField } from "@/lib/layout/arrangement-gestures";
import type {
  EdgeSide,
  LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import type { SettingsRowDefinition } from "@/lib/settings-search/settings-definitions";
import type { PlacementSurfaceId } from "@/stores/layout/layout-editor-store";

/**
 * Where a placement surface can sit, and the one write that moves it (D14).
 *
 * The canvas's placement bar and its drop to an edge both read this table, and
 * both write through `writeArrangementField` - the writer the dock's
 * `TabStripPositionRow` and `SidebarSideRow` call - so the three can never
 * disagree about a value or skip the recorded gesture (L-18).
 */

export type PlacementEdge = "top" | EdgeSide;

export interface SurfacePlacementFacts {
  /** The edges the surface may take, in the order the bar draws them. */
  readonly edges: ReadonlyArray<PlacementEdge>;
  readonly current: (arrangement: LayoutArrangement) => PlacementEdge;
  readonly write: (edge: PlacementEdge) => void;
  /** The dock row's definition, whose availability the bar honours. */
  readonly row: SettingsRowDefinition;
}

export const SURFACE_PLACEMENT: Readonly<
  Record<PlacementSurfaceId, SurfacePlacementFacts>
> = {
  topBar: {
    edges: ["top", "left", "right"],
    current: (arrangement) => arrangement.tabStripPlacement,
    write: (edge) => {
      writeArrangementField("tabStripPlacement", edge);
    },
    row: LAYOUT.definitions.tabStripPlacement,
  },
  sidebar: {
    edges: ["left", "right"],
    current: (arrangement) => arrangement.sidebarSide,
    write: (edge) => {
      if (edge !== "top") writeArrangementField("sidebarSide", edge);
    },
    row: LAYOUT.definitions.sidebarSide,
  },
};

export const PLACEMENT_EDGE_LABELS: Readonly<Record<PlacementEdge, string>> = {
  top: "Top",
  left: "Left",
  right: "Right",
};

/**
 * The column edge a surface stands at, or `null` for the tab strip across the
 * top: what `ColumnEdgeContext` would say inside the surface, so the bar can
 * ask the overlay hook which way the content is (ticket 01).
 */
export function surfaceColumnEdge(
  surface: PlacementSurfaceId,
  arrangement: LayoutArrangement,
): EdgeSide | null {
  const edge = SURFACE_PLACEMENT[surface].current(arrangement);
  return edge === "top" ? null : edge;
}
