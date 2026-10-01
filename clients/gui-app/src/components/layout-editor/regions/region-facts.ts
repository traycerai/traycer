import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import {
  SURFACE_GROUPS,
  type LayoutRegionIcon,
  type QuickVerbId,
  type SurfaceGroupId,
} from "@/components/layout-editor/regions/region-grammar";
import {
  asBarRegionId,
  barPlacement,
  sideTabStripEdge,
  type BarHost,
  type LayoutArrangement,
  type OrderGroupId,
} from "@/lib/layout/layout-arrangement";
import type { LayoutValues } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * The registry as a caller walking EVERY region can read it.
 *
 * `LayoutRegion<K>` has no useful supertype - `stateWord` takes the region's
 * own bag, so widening `K` to `RegionId` makes it uncallable -
 * which means a caller that walks all the regions (the index, the filter, the
 * search entries) reads them through this face, and a caller holding ONE id
 * indexes {@link LAYOUT_REGIONS} and gets the generic entry back.
 */

/**
 * One region's row as the section RENDERER receives it: the union over every
 * region, so a key-typed member still carries the keys its own region has.
 *
 * The other face of {@link RegionRowFacts}, which drops those keys for the
 * callers that only ask what KIND a row is.
 */
export type AnyGrammarRow = (typeof LAYOUT_REGIONS)[RegionId]["rows"][number];

/**
 * A region's row, with only what a caller walking EVERY region can ask about.
 *
 * Which keys a control writes is the part that cannot survive the walk, since
 * `keyof LayoutValues[K]` collapses to what all twenty-six regions share.
 */
export type RegionRowFacts =
  | {
      readonly kind: "position-host" | "position-side" | "children";
    }
  | { readonly kind: "style"; readonly key: string; readonly label: string }
  | { readonly kind: "position-order"; readonly group: OrderGroupId }
  | {
      readonly kind: "fine-tune";
      readonly rows: ReadonlyArray<{
        readonly label: string;
        readonly control:
          | {
              readonly kind: "checks";
              readonly options: ReadonlyArray<{ readonly label: string }>;
            }
          | { readonly kind: "switch" | "segment" | "field-checks" };
      }>;
    };

/** The part of a region that does not depend on its value bag. */
export interface RegionFacts {
  readonly id: RegionId;
  readonly name: string;
  readonly surface: SurfaceGroupId;
  readonly icon: LayoutRegionIcon;
  readonly where: string;
  readonly whereByHost: Readonly<Record<BarHost, string>> | null;
  readonly hint: string | null;
  readonly keywords: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<RegionRowFacts>;
  readonly quickVerbs: ReadonlyArray<QuickVerbId>;
}

const REGION_FACTS: Readonly<Record<RegionId, RegionFacts>> = LAYOUT_REGIONS;

export function regionFacts(region: RegionId): RegionFacts {
  return REGION_FACTS[region];
}

/**
 * The line under a region's name: where it sits right now.
 *
 * Static for every region but the two readings that pick a bar and an end of
 * it (L-156); for those it is composed from the placement, so one sentence
 * per bar in the registry covers all four answers and the side is never
 * written down twice.
 *
 * While the tabs are a vertical strip there is no header: Home sits above the
 * tabs, and a header-hosted reading sits in the strip's foot, where the stored
 * `left` / `right` read as start and end in the stack.
 */
export function regionWhere(
  region: RegionId,
  arrangement: LayoutArrangement,
): string {
  const facts = regionFacts(region);
  const vertical = sideTabStripEdge(arrangement.tabStripPlacement) !== null;
  if (region === "homeTab" && vertical) return "Tab strip - above the tabs";
  const barRegion = asBarRegionId(region);
  if (facts.whereByHost === null || barRegion === null) {
    return facts.where;
  }
  const placement = barPlacement(arrangement, barRegion);
  if (vertical && placement.host === "header") {
    return `Tab strip foot - ${placement.side === "left" ? "start" : "end"}`;
  }
  return `${facts.whereByHost[placement.host]} - ${placement.side} side`;
}

/**
 * Every region grouped by surface, which is the index's own order (L-06).
 *
 * Within a surface the declaration order stands, except on the sidebar, where
 * the rail's current order is the one on screen - the index sorts that group
 * against `arrangement.rail` rather than baking an order in here.
 */
export const LAYOUT_REGION_LIST: ReadonlyArray<RegionFacts> =
  SURFACE_GROUPS.flatMap((group) =>
    Object.values(REGION_FACTS).filter((region) => region.surface === group.id),
  );

export const LAYOUT_REGION_IDS: ReadonlyArray<RegionId> =
  LAYOUT_REGION_LIST.map((region) => region.id);

/**
 * One region's state word, for a caller holding an id rather than a literal.
 *
 * The indirection through a locally annotated function is what lets the
 * indexed accesses resolve together: `LAYOUT_REGIONS[region]` and
 * `values[region]` are the same `K`, and stating that once is what makes the
 * call well typed for every region at once.
 */
export function regionStateWord<K extends RegionId>(
  region: K,
  values: LayoutValues,
  arrangement: LayoutArrangement,
): string {
  const stateWord: (
    regionValues: LayoutValues[K],
    regionArrangement: LayoutArrangement,
  ) => string = LAYOUT_REGIONS[region].stateWord;
  return stateWord(values[region], arrangement);
}

/** Device-local settings that the compact toolbar/footer actually honors. */
export function regionRowAvailable(
  regionId: RegionId,
  row: RegionRowFacts,
  narrow: boolean,
): boolean {
  if (!narrow) return true;
  if (row.kind === "position-host") return false;
  // The phone footer draws usage at its start and resources at its end,
  // whatever end was picked (L-162), so a bar reading's Alignment decides
  // nothing there.
  if (row.kind === "position-side" && asBarRegionId(regionId) !== null)
    return false;
  if (
    row.kind === "position-order" &&
    (row.group === "toolbarLeft" || row.group === "toolbarRight")
  )
    return false;
  // The compact toolbar draws the model chip one way; its picker footer is
  // the same picker's, so Reasoning control still applies there.
  return regionId !== "model" || row.kind !== "style" || row.key !== "style";
}
