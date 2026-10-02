import { LAYOUT_REGION_LIST } from "@/components/layout-editor/regions/region-facts";
import type { SurfaceGroupId } from "@/components/layout-editor/regions/region-grammar";
import type { OrderGroupId } from "@/lib/layout/layout-arrangement";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * The tier above the region registry: what a SURFACE owns (L-92, L-95).
 *
 * The inspector can filter, because something is selected. The full-width page
 * cannot, so it has to group - and the organising unit there is the surface,
 * with the region as a ROW inside it. That single move deletes every repeat the
 * owner found: a shared group control has exactly one place to live once the
 * group itself is the section.
 *
 * So the facts that belong to a LIST rather than to any one member live here
 * and not in `regions/*`: the reorder instruction the nine rail regions used to
 * carry nine copies of, the "here or on the canvas" line the composer's eight
 * carried eight, and the pinned-right note that the Model region alone happened
 * to state for the whole right cluster (D1-D4, D8). The docked inspector reads
 * the same table, so neither host owns a second copy of the words.
 */

export interface OrderGroupFacts {
  /** The heading above the list. */
  readonly label: string;
  /** How this list is operated, said once by the list (D8). */
  readonly description: string;
  /** A rule about the whole group, said by the group rather than by a member. */
  readonly note: string | null;
  /** Whether this group's dividers are items of its own (L-155): the rail. */
  readonly dividers: boolean;
}

export const ORDER_GROUPS: Readonly<Record<OrderGroupId, OrderGroupFacts>> = {
  dock: {
    label: "Above the message box",
    description: "Drag to reorder, here or on the canvas.",
    // The Message queue is fixed and has no setting (G1-G2), so the list it
    // sits under says where it is.
    note: "The message queue stays next to the message box.",
    dividers: false,
  },
  toolbarLeft: {
    label: "Toolbar left",
    description: "Drag to reorder, here or on the canvas.",
    note: null,
    dividers: false,
  },
  toolbarRight: {
    label: "Toolbar right",
    description: "Drag to reorder, here or on the canvas.",
    // Said by the cluster the rule is about. It used to be drawn by the Model
    // region's own Position row, which meant the Microphone's copy of the same
    // list silently omitted it (D4).
    note: "The model chip stays on the right.",
    dividers: false,
  },
  rail: {
    label: "Panels",
    // The rail's icons are canvas-draggable too now (L-115), so its line says
    // what the other three canvas groups' lines say, plus the two things only
    // this list can do (L-155, L-168).
    description:
      "Drag to reorder, here or on the canvas. Drop one icon onto the middle of another to stack them in one panel. Add a divider to space icons apart.",
    note: null,
    dividers: true,
  },
  usageProviders: {
    label: "Profiles",
    description:
      "Drag providers to order. Hidden profiles stay in the popover.",
    note: null,
    dividers: false,
  },
};

/**
 * The order lists a surface draws, in reading order.
 *
 * `usageProviders` is a list of PROVIDERS rather than of regions. It is the
 * Profiles list of the Usage limits section, which draws it itself
 * (`usage-resources-form.tsx`), so the Status bar surface has none of its own.
 */
export const SURFACE_ORDER_GROUPS: Readonly<
  Record<SurfaceGroupId, ReadonlyArray<OrderGroupId>>
> = {
  topBar: [],
  sidebar: ["rail"],
  chat: [],
  composer: ["dock", "toolbarLeft", "toolbarRight"],
  statusBar: [],
};

/**
 * The label a screen reader hears for one of these lists, and the change
 * list's name for its order. The rail's heading "Panels" leans on the Sidebar
 * area around it, which a row's own context does not carry, so it says it here.
 */
export function orderGroupListLabel(group: OrderGroupId): string {
  return group === "rail" ? "Sidebar panels" : ORDER_GROUPS[group].label;
}

/**
 * The rail list's line on a phone, which has no rail: the list orders the tab
 * switcher's flat chip bar, where stacks and dividers mean nothing.
 */
export const PHONE_RAIL_INSTRUCTION =
  "Drag to reorder. Turn a panel off to move it into More.";

/**
 * How a list is operated AND whatever rule holds for the whole of it, as one
 * line for the header that introduces it.
 *
 * The note used to be drawn under the list, where it read as a footnote to the
 * card rather than as a rule about the list (redesign 4.8). It is the list
 * header's business in both hosts now - the page's card header and the dock's
 * Position row - so it is joined here rather than in either of them.
 */
export function orderGroupInstruction(group: OrderGroupId): string {
  const facts = ORDER_GROUPS[group];
  return facts.note === null
    ? facts.description
    : `${facts.description} ${facts.note}`;
}

/**
 * One surface's regions that sit in no order list - the rows a surface card
 * draws directly, above or beside its lists.
 *
 * Derived rather than listed: a region joins a list by declaring a
 * `position-order` row, and a second hand-written list here could only drift
 * from that one.
 */
export function looseSurfaceRegions(
  surface: SurfaceGroupId,
): ReadonlyArray<RegionId> {
  return LAYOUT_REGION_LIST.filter(
    (region) =>
      region.surface === surface &&
      !region.rows.some((row) => row.kind === "position-order"),
  ).map((region) => region.id);
}
