import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import { CONTEXT_USAGE_ROW_KEYS } from "@/lib/context-usage-rows";
import type { ContextBreakdownField } from "@/lib/layout/layout-values";
import {
  DEFAULT_RAIL,
  DEFAULT_RAIL_DIVIDER_SEQ,
  RAIL_REGION_IDS,
  railDividerId,
  MAX_RAIL_STACK_MEMBERS,
  areRailsEqual,
  normalizeRail,
  railRegionForLeftPanelId,
  railStackId,
  railStackMembers,
  railStackOf,
  type RailEntry,
} from "@/lib/layout/rail";
import type { LeftPanelId } from "@/lib/left-panel-ids";
import type {
  DockRegionId,
  RailRegionId,
  ToolbarRegionId,
} from "@/lib/layout/region-id";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * Where every region LIVES: order, side and host, and the per-provider picks
 * that are a choice about what is read rather than about how much of it shows.
 *
 * The counterpart of `layout-values.ts`, and the reason a preset cannot move
 * anything: nothing in this file is reachable from a `LayoutValues`, so a
 * density is density by construction (L-20).
 *
 * The shape, the shipped defaults, the accessors and the writers only. The
 * invariants an arrangement is held to and the read of a stored one are in
 * `arrangement-persist.ts`; the rail's own shape is `rail.ts`.
 */

/** Which of the two bars hosts a reading that can live in either (L-156). */
export type BarHost = "status-bar" | "header";

/** Which end of its surface an edge-anchored region sits at. */
export type EdgeSide = "left" | "right";

/**
 * Where the header task tabs draw: horizontal at the top (today's layout), or
 * a vertical strip at either edge (S-01, S-02).
 */
export type TabStripPlacement = "top" | EdgeSide;

/**
 * What the vertical strip shows (D8): `layered` keeps it to tabs, `activity`
 * also lists the active task's live agents under its row.
 */
export type SideStripView = "layered" | "activity";

/** How the task tabs fit when there are more than the strip holds. */
export type TaskTabLayout = "scroll" | "shrink";

/**
 * The measure the transcript, the composer and an artifact's body share:
 * `comfortable` is the shipped column, `wide` the one for a large monitor.
 */
export type ReadingWidth = "comfortable" | "wide";

/**
 * `wide`'s own floor: today's fixed wide column (`max-w-5xl`), so the slider
 * never reads narrower than what picking "Wide" has always meant.
 */
export const WIDE_READING_WIDTH_MIN_PX = 1024;

/**
 * The slider's own ceiling - generously past any real monitor, so in practice
 * a user hits the VIEWPORT clamp (`useReadingWidthStyle`) before this. It only
 * bounds the control itself, never what actually renders.
 */
export const WIDE_READING_WIDTH_MAX_PX = 3000;

/** A "how much of the window" control: coarse steps, not fine precision. */
export const WIDE_READING_WIDTH_STEP_PX = 16;

/**
 * The two regions that name a bar AND an end of it, each for itself (L-156).
 *
 * In this order, which is the order a cluster holding both draws them: usage
 * limits lead, the resource monitor follows. One list rather than a rule
 * repeated per surface, so the strip, the header, the depictions and the
 * miniature cannot disagree about which comes first.
 */
export type BarRegionId = "usageLimits" | "resourceMonitor";

export const BAR_REGION_IDS: ReadonlyArray<BarRegionId> = [
  "usageLimits",
  "resourceMonitor",
];

/** Where one of the two readings draws: a bar, and an end of it. */
export interface BarPlacement {
  readonly host: BarHost;
  readonly side: EdgeSide;
}

/** Every list a drag can reorder. */
export type OrderGroupId =
  | "dock"
  | "toolbarLeft"
  | "toolbarRight"
  | "rail"
  | "usageProviders";

export const ORDER_GROUP_IDS: ReadonlyArray<OrderGroupId> = [
  "dock",
  "toolbarLeft",
  "toolbarRight",
  "rail",
  "usageProviders",
];

/**
 * The order groups a CANVAS drag can reorder: the ones whose every member
 * draws its own element beside its siblings, which is what there is to pick up.
 *
 * The rail is one of them since L-115 (which supersedes L-68 and L-82 and
 * restores L-25): its icon column is the cluster, and every divider in
 * `arrangement.rail` is drawn as a real element there, so a drop between two
 * icons names the two entries it landed between and the boundary a panel
 * crossed is unambiguous.
 *
 * `usageProviders` is still the inspector list's alone: it is a list of
 * segments inside ONE region, so its members carry no identity of their own on
 * the canvas to place by.
 */
export type CanvasOrderGroupId =
  | "dock"
  | "toolbarLeft"
  | "toolbarRight"
  | "rail";

const CANVAS_ORDER_GROUP_IDS: ReadonlyArray<CanvasOrderGroupId> = [
  "dock",
  "toolbarLeft",
  "toolbarRight",
  "rail",
];

/**
 * Which of one provider's limits its usage segment draws.
 *
 * `limitKeys` are explicit picks by `windowKey`, and an EMPTY list is
 * Automatic - the tightest limit at the moment of drawing, which can name a
 * different window from one reading to the next. The two modes are exclusive
 * by construction, so there is one field and not two: a stored `automatic`
 * boolean beside the list was a second representation of `limitKeys.length
 * === 0`, which is how two fields for one fact come to disagree (R1-15).
 * Nothing draws nothing - a provider the user wants gone has its own Shown
 * switch.
 */
export interface StatusBarProviderLimitSelection {
  readonly limitKeys: ReadonlyArray<string>;
}

/**
 * Every configured provider's selection. A provider with no entry has never
 * been configured, which {@link statusBarProviderLimitSelection} reads as the
 * automatic default.
 */
export type StatusBarProviderLimits = Readonly<
  Partial<Record<RateLimitProviderId, StatusBarProviderLimitSelection>>
>;

/**
 * The accounts one provider's segments describe, on one host: profile ids, with
 * `null` standing for the provider's ambient login. A provider with no entry
 * has nothing checked.
 */
export type StatusBarHostShownProfiles = Readonly<
  Partial<Record<RateLimitProviderId, ReadonlyArray<string | null>>>
>;

/**
 * Per host, then per provider. Keyed by `hostId` because a profile id names a
 * credential on ONE machine - the same id on another host is a different
 * account, or nothing at all.
 */
export type StatusBarShownProfiles = Readonly<
  Record<string, StatusBarHostShownProfiles>
>;

export interface LayoutArrangement {
  readonly dock: ReadonlyArray<DockRegionId>;
  readonly toolbarLeft: ReadonlyArray<ToolbarRegionId>;
  readonly toolbarRight: ReadonlyArray<ToolbarRegionId>;
  readonly rail: ReadonlyArray<RailEntry>;
  readonly usageProviders: ReadonlyArray<RateLimitProviderId>;
  readonly hiddenProviders: ReadonlyArray<RateLimitProviderId>;
  readonly providerLimits: StatusBarProviderLimits;
  readonly shownProfiles: StatusBarShownProfiles;
  /**
   * The two readings' four picks, two per region: which bar, and which end of
   * it (L-156). They are four independent fields rather than one shared
   * placement because moving one reading must never move the other - which is
   * what a single `usageHost` did, taking the resource monitor with it and
   * removing the strip underneath both.
   */
  readonly usageHost: BarHost;
  readonly usageSide: EdgeSide;
  readonly resourceHost: BarHost;
  readonly resourceSide: EdgeSide;
  readonly minimapSide: EdgeSide;
  /**
   * Which readings the "Toggle status bar" command last sent up, so the next
   * press can put exactly those back (L-160).
   *
   * Empty whenever the strip is the one holding them, which is also the
   * shipped value: it is written by that one command and cleared by it, and
   * every other writer of a host leaves it alone - a stale set is harmless,
   * because a press only ever brings DOWN what is in it and the strip is
   * where a reading not in it already is.
   */
  readonly statusBarParked: ReadonlyArray<BarRegionId>;
  readonly pinnedContextFieldOrder: ReadonlyArray<ContextBreakdownField>;
  /**
   * Whether the status bar is drawn on a mobile VIEWPORT, where the shell
   * otherwise withholds it whatever the two hosts say (L-51). Here rather than
   * in a region's value bag because it decides whether a SURFACE exists.
   */
  readonly mobileFooter: boolean;
  /** Only ever increases, so a divider id is never reused. */
  readonly dividerSeq: number;
  /**
   * Where the header task tabs draw, on every desktop window at once (S-11):
   * top, or a vertical strip at the left or right edge.
   *
   * The EFFECTIVE placement this window draws with also depends on whether
   * the mobile header stands in its place - `useTabStripPlacement` is the one
   * hook that folds the two together; readers of this field alone get the
   * STORED pick (editor rows, Settings, the depictions, the palette toggle).
   */
  readonly tabStripPlacement: TabStripPlacement;
  /**
   * Which side of the epic canvas the per-epic sidebar draws on, independent
   * of the tab strip's own placement (S-06).
   */
  readonly sidebarSide: EdgeSide;
  /** What the vertical strip shows (D8); ignored while the tabs are at the top. */
  readonly sideStripView: SideStripView;
  /** Tab overflow: scroll the tabs, or shrink them to fit. */
  readonly taskTabLayout: TaskTabLayout;
  /**
   * How wide chat and artifacts read. Arrangement rather than a value: a
   * preset is density, how much a region says, and this is how much of the
   * window the content column takes - it depends on the monitor, not on how
   * much chrome someone wants, so a density switch must leave it alone.
   */
  readonly readingWidth: ReadingWidth;
  /**
   * How wide the `wide` column reads, in px - meaningful only while
   * `readingWidth` is `"wide"`. Defaults to today's fixed wide column, so
   * picking "Wide" with the slider untouched changes nothing visually.
   * `useReadingWidthStyle` still viewport-clamps it, so this is a ceiling the
   * user is choosing, not a guaranteed rendered width.
   */
  readonly wideReadingWidthPx: number;
}

/** Every provider that reports account rate limits, in the strip's own order. */
export const USAGE_PROVIDER_IDS: ReadonlyArray<RateLimitProviderId> =
  rateLimitCapableProviderIdSchema.options;

/**
 * Today's dock order, top to bottom.
 *
 * Todo OPENS the list because that is where `ChatLowerDock` already draws it -
 * the joined frame is Todo, then the three rows that were reorderable before
 * L-142 made all of them so. A default is what a user who never opens the
 * editor sees, so it has to be today's frame rather than the order the rows
 * happened to be added in. The Message queue is not in it: it is not a dock
 * member, and always sits below every row, directly on the composer (G1-G2).
 *
 * `mergeOrder` reads this as the canonical sequence. Todo has no canonical
 * predecessor, so a dock order written before it existed rehydrates with it
 * at the FRONT, and a stored `queue` from before G1-G2 is an id this build
 * does not know and is dropped.
 */
export const DEFAULT_DOCK_ORDER: ReadonlyArray<DockRegionId> = [
  "todo",
  "changedFiles",
  "runningAgents",
  "background",
];

/**
 * Every toolbar region in VISUAL READING ORDER across both clusters, which is
 * what `mergeOrder` needs as its canonical sequence: a region that has to be
 * re-inserted lands beside the neighbours it renders beside, whichever cluster
 * it belongs to.
 */
export const TOOLBAR_REGION_IDS: ReadonlyArray<ToolbarRegionId> = [
  "attachImage",
  "access",
  "model",
  "mic",
];

export const DEFAULT_TOOLBAR_LEFT: ReadonlyArray<ToolbarRegionId> = [
  "attachImage",
  "access",
];

/** `model` is always here: the picker anchors the footer controls. */
export const DEFAULT_TOOLBAR_RIGHT: ReadonlyArray<ToolbarRegionId> = [
  "model",
  "mic",
];

/**
 * Which canvas order group a region's element belongs to, or `null` for a
 * region the canvas cannot reorder.
 *
 * Membership is a MODEL fact rather than a registry one, and it is static:
 * `normalizeArrangement` puts a toolbar region found in the wrong cluster back
 * where it belongs, so a dock region is one because its id is a
 * `DockRegionId`, and the default lists are where that is written down.
 *
 * It lives here rather than being read off the region registry's own
 * `position-order` row for a second reason, which is load order:
 * `useLayoutRegion` stamps the attribute this answers, and the registry
 * reaches the app's real leaves through `region-depiction.tsx` - leaves that
 * call `useLayoutRegion`. Asking the registry from the hook would close that
 * circle and leave the depictions half-initialised.
 */
export function canvasOrderGroupForRegion(
  regionId: string,
): CanvasOrderGroupId | null {
  if (DEFAULT_DOCK_ORDER.some((id) => id === regionId)) return "dock";
  if (DEFAULT_TOOLBAR_LEFT.some((id) => id === regionId)) return "toolbarLeft";
  if (DEFAULT_TOOLBAR_RIGHT.some((id) => id === regionId))
    return "toolbarRight";
  if (RAIL_REGION_IDS.some((id) => id === regionId)) return "rail";
  return null;
}

/**
 * The same group read back off an element, for the half of a rail cluster that
 * is NOT a region: a divider is a member of the rail's order with a member id
 * and no region id, so the group a press belongs to is the one stamped on the
 * element rather than one looked up from a region (L-115).
 */
export function canvasOrderGroupOf(value: string): CanvasOrderGroupId | null {
  return CANVAS_ORDER_GROUP_IDS.find((id) => id === value) ?? null;
}

export const DEFAULT_ARRANGEMENT: LayoutArrangement = {
  dock: DEFAULT_DOCK_ORDER,
  toolbarLeft: DEFAULT_TOOLBAR_LEFT,
  toolbarRight: DEFAULT_TOOLBAR_RIGHT,
  rail: DEFAULT_RAIL,
  usageProviders: USAGE_PROVIDER_IDS,
  hiddenProviders: [],
  providerLimits: {},
  shownProfiles: {},
  usageHost: "status-bar",
  usageSide: "left",
  resourceHost: "status-bar",
  resourceSide: "right",
  minimapSide: "right",
  statusBarParked: [],
  pinnedContextFieldOrder: CONTEXT_USAGE_ROW_KEYS,
  mobileFooter: false,
  dividerSeq: DEFAULT_RAIL_DIVIDER_SEQ,
  tabStripPlacement: "top",
  sidebarSide: "left",
  sideStripView: "layered",
  taskTabLayout: "scroll",
  readingWidth: "comfortable",
  wideReadingWidthPx: WIDE_READING_WIDTH_MIN_PX,
};

/** What a provider draws until told otherwise: its tightest limit, and only that. */
export const AUTOMATIC_LIMIT_SELECTION: StatusBarProviderLimitSelection = {
  limitKeys: [],
};

/**
 * Whether a stored selection says anything the DEFAULT does not.
 *
 * The one definition of "this provider is on Automatic", read by the writer
 * that refuses to store it (`provider-level.tsx`) and by the predicate that
 * decides whether a provider counts as changed (`layout-diff.ts`). Both used
 * to answer from PRESENCE, which made a return to Automatic a permanent mark
 * on a layout byte-identical to the shipped one (R1-03).
 */
export function isAutomaticLimitSelection(
  selection: StatusBarProviderLimitSelection,
): boolean {
  return selection.limitKeys.length === 0;
}

/**
 * The selection one provider is on, with the default standing in for a provider
 * that has never been configured - which is how a provider connected later
 * shows its tightest limit without a visit to the editor.
 */
export function statusBarProviderLimitSelection(
  providerLimits: StatusBarProviderLimits,
  providerId: RateLimitProviderId,
): StatusBarProviderLimitSelection {
  return providerLimits[providerId] ?? AUTOMATIC_LIMIT_SELECTION;
}

/** One shared empty list, so an unchecked provider never allocates. */
const NO_SHOWN_PROFILE_IDS: ReadonlyArray<string | null> = [];

/**
 * The checked accounts one provider has on one host, or the empty list. The one
 * read path, so nothing else has to know the map is two levels deep.
 */
export function statusBarShownProfileIds(
  shownProfiles: StatusBarShownProfiles,
  hostId: string | null,
  providerId: RateLimitProviderId,
): ReadonlyArray<string | null> {
  if (hostId === null) return NO_SHOWN_PROFILE_IDS;
  return shownProfiles[hostId]?.[providerId] ?? NO_SHOWN_PROFILE_IDS;
}

// ── The two bar readings (L-156) ────────────────────────────────────────────

/**
 * The same id read back as one of the two, for a caller holding a `RegionId`
 * (or a string off the DOM). `null` for every other region, which is what
 * keeps "has a bar and a side" a fact about the model rather than a list
 * repeated in the inspector, the registry and the depictions.
 */
export function asBarRegionId(region: string): BarRegionId | null {
  return BAR_REGION_IDS.find((id) => id === region) ?? null;
}

/** Where one reading draws right now, as the one pair both axes make. */
export function barPlacement(
  arrangement: LayoutArrangement,
  region: BarRegionId,
): BarPlacement {
  return region === "usageLimits"
    ? { host: arrangement.usageHost, side: arrangement.usageSide }
    : { host: arrangement.resourceHost, side: arrangement.resourceSide };
}

/** One reading moved to the other bar, leaving the other reading alone. */
export function withBarHost(
  arrangement: LayoutArrangement,
  region: BarRegionId,
  host: BarHost,
): LayoutArrangement {
  return region === "usageLimits"
    ? { ...arrangement, usageHost: host }
    : { ...arrangement, resourceHost: host };
}

/** One reading moved to the other end of its bar, on its own. */
export function withBarSide(
  arrangement: LayoutArrangement,
  region: BarRegionId,
  side: EdgeSide,
): LayoutArrangement {
  return region === "usageLimits"
    ? { ...arrangement, usageSide: side }
    : { ...arrangement, resourceSide: side };
}

/**
 * What ONE cluster holds, in drawing order.
 *
 * Every surface that draws a cluster - the strip, the header, the settings
 * band, the preset miniature - asks this rather than testing the two fields
 * itself, so "usage limits precede the resource monitor when they share a
 * bar and a side" (L-156) is written once.
 */
export function barClusterRegions(
  arrangement: LayoutArrangement,
  host: BarHost,
  side: EdgeSide,
): ReadonlyArray<BarRegionId> {
  return barClusterRegionsAt(
    {
      usageLimits: barPlacement(arrangement, "usageLimits"),
      resourceMonitor: barPlacement(arrangement, "resourceMonitor"),
    },
    host,
    side,
  );
}

/**
 * {@link barClusterRegions} for the two LIVE surfaces, which hold the four
 * fields rather than the arrangement.
 *
 * The strip and the header subscribe field by field through the override seam
 * (there is deliberately no whole-arrangement hook, G1-14), so they arrive
 * with placements in hand; the order and the membership rule are still this
 * module's.
 */
export function barClusterRegionsAt(
  placements: Readonly<Record<BarRegionId, BarPlacement>>,
  host: BarHost,
  side: EdgeSide,
): ReadonlyArray<BarRegionId> {
  return BAR_REGION_IDS.filter(
    (region) =>
      placements[region].host === host && placements[region].side === side,
  );
}

/** The readings one bar is holding, in the model's own order. */
function barRegionsIn(
  arrangement: LayoutArrangement,
  host: BarHost,
): ReadonlyArray<BarRegionId> {
  return BAR_REGION_IDS.filter(
    (region) => barPlacement(arrangement, region).host === host,
  );
}

/**
 * The status bar surface toggled, and its own inverse (L-160).
 *
 * A press sends whatever the strip is holding to the header and REMEMBERS
 * that set; the next press brings exactly that set back down and forgets it.
 * So a mixed arrangement - the gauge up, the readout down, which is the
 * arrangement L-156 exists to let a person build - survives the round trip
 * instead of being flattened into "both down" by the second press.
 *
 * With nothing remembered and an empty strip the answer is both, which is the
 * only sensible reading of "show the status bar" for a user who emptied it
 * some other way. Sides are never touched: this command is about the surface.
 */
export function toggleStatusBarSurface(
  arrangement: LayoutArrangement,
): LayoutArrangement {
  const inStrip = barRegionsIn(arrangement, "status-bar");
  if (inStrip.length > 0) {
    return {
      ...movedToBar(arrangement, inStrip, "header"),
      statusBarParked: inStrip,
    };
  }
  const returning =
    arrangement.statusBarParked.length > 0
      ? arrangement.statusBarParked
      : BAR_REGION_IDS;
  return {
    ...movedToBar(arrangement, returning, "status-bar"),
    statusBarParked: [],
  };
}

function movedToBar(
  arrangement: LayoutArrangement,
  regions: ReadonlyArray<BarRegionId>,
  host: BarHost,
): LayoutArrangement {
  return regions.reduce(
    (current, region) => withBarHost(current, region, host),
    arrangement,
  );
}

/**
 * Whether the strip has anything to hold, which is whether it exists at all on
 * a desktop viewport.
 *
 * Either reading keeps it: since L-156 the two pick their bar separately, so
 * usage moved up no longer takes the strip - and the monitor - with it.
 */
export function statusBarHostsAnyRegion(
  arrangement: LayoutArrangement,
): boolean {
  return (
    arrangement.usageHost === "status-bar" ||
    arrangement.resourceHost === "status-bar"
  );
}

/**
 * Whether the status bar strip is on screen: the ONE answer to that question,
 * read by the shell that mounts it and by every control that only makes sense
 * while it is mounted.
 *
 * A mobile VIEWPORT, not a mobile build: a narrow desktop window behaves the
 * same way. Mobile ignores both hosts entirely and answers with `mobileFooter`
 * (L-51), which is off by default - and it ignores them for the CONTENTS too
 * (L-162): a footer switched on draws both readings whichever bar each of
 * them names, because the phone has one bar and a footer that honoured a
 * header pick would silently drop a readout. Its ends are fixed as well -
 * usage left, resources right - since an end picked for a desktop bar says
 * nothing about the phone's. The picks are kept, not overridden, so the
 * desktop window they were made in still honours them.
 */
export function statusBarShown(
  arrangement: LayoutArrangement,
  isMobileViewport: boolean,
): boolean {
  return isMobileViewport
    ? arrangement.mobileFooter
    : statusBarHostsAnyRegion(arrangement);
}

// ── The tab strip's placement (S-01, S-02, S-05, S-25) ──────────────────────

/**
 * The edge a vertical strip draws at, or `null` for the horizontal `top`
 * placement - the only placement helper (there is deliberately no separate
 * `isSideTabStrip` boolean).
 */
export function sideTabStripEdge(
  placement: TabStripPlacement,
): EdgeSide | null {
  return placement === "top" ? null : placement;
}

/**
 * Whether the strip lists the active task's live agents under its row (D9):
 * only the expanded vertical strip in the Activity view has room for them.
 */
export function liveAgentsInStrip(
  placement: TabStripPlacement,
  stripCollapsed: boolean,
  view: SideStripView,
): boolean {
  return placement !== "top" && !stripCollapsed && view === "activity";
}

/**
 * The palette's "Toggle vertical tabs" command (S-25): `top` becomes `left`,
 * the default side for a vertical strip (S-05); either side becomes `top`.
 */
export function toggleVerticalTabs(
  placement: TabStripPlacement,
): TabStripPlacement {
  return placement === "top" ? "left" : "top";
}

// ── Reordering ──────────────────────────────────────────────────────────────

/**
 * One item taken out of a list and put back at another index, clamped.
 *
 * The single reordering primitive: a keyboard nudge, a pointer drop in the
 * inspector's list and a canvas drop all reduce to it, so "what does moving an
 * item do" has one answer and one set of tests.
 */
export function movedWithin<T>(
  list: ReadonlyArray<T>,
  fromIndex: number,
  toIndex: number,
): ReadonlyArray<T> {
  const item = list[fromIndex];
  if (item === undefined) return list;
  const remaining = list.filter((_entry, index) => index !== fromIndex);
  const insertAt = Math.min(Math.max(toIndex, 0), remaining.length);
  return [...remaining.slice(0, insertAt), item, ...remaining.slice(insertAt)];
}

/**
 * One canvas drop written back into a group's FULL order (4.7).
 *
 * Stated as "`fromId` lands on this side of `toId`" rather than as a pair of
 * indices, because the canvas shows only the members that are currently drawn
 * and an index into what it showed is not an index into what is stored
 * (G3-01). Placing by id needs no correspondence between the two orders at
 * all: the member the user had hold of is the one that moves, and every other
 * member - drawn or not - keeps its place relative to its neighbours.
 *
 * In the rail the member may be a DIVIDER rather than a panel, which is how a
 * divider is re-placed on the canvas (L-115, L-155): the id is the entry's,
 * and both kinds place the same way.
 */
export function moveCanvasOrderMember(input: {
  readonly arrangement: LayoutArrangement;
  readonly group: CanvasOrderGroupId;
  /** The member that was picked up, by the id off the element in hand. */
  readonly fromId: string;
  /** The member it was dropped across. */
  readonly toId: string;
  /** Which side of `toId` it landed on. */
  readonly placeAfter: boolean;
}): LayoutArrangement {
  const { arrangement, group } = input;
  switch (group) {
    case "dock":
      return {
        ...arrangement,
        dock: placedBeside(arrangement.dock, input),
      };
    case "toolbarLeft":
      return {
        ...arrangement,
        toolbarLeft: placedBeside(arrangement.toolbarLeft, input),
      };
    case "toolbarRight":
      return {
        ...arrangement,
        toolbarRight: placedBeside(arrangement.toolbarRight, input),
      };
    case "rail":
      // The canvas drags what the rail draws, and a stack draws as one group
      // icon (G3): the group moves whole and lands beside a group, never
      // between its two panels.
      return {
        ...arrangement,
        // The canvas's rail draws a stack as its one icon, so a drag of it
        // carries the whole stack.
        rail: railPlacedBeside(arrangement.rail, input, "stack"),
      };
  }
}

/** Where a member was picked up and where it was put down. */
interface CanvasOrderDrop {
  readonly fromId: string;
  readonly toId: string;
  readonly placeAfter: boolean;
}

/**
 * One member taken out of the stored list and put back beside another. The
 * rail, whose members are entries and whose stacks move whole, has its own
 * ({@link railPlacedBeside}).
 *
 * The ids arrive as strings off the DOM and are only ever used to SELECT from
 * the stored list, never to build one, so an id this build does not know moves
 * nothing rather than narrowing something away (G1-23).
 */
function placedBeside<Id extends string>(
  full: ReadonlyArray<Id>,
  drop: CanvasOrderDrop,
): ReadonlyArray<Id> {
  const { fromId, toId, placeAfter } = drop;
  const moved = full.find((item) => item === fromId);
  if (moved === undefined || fromId === toId) return full;
  const remaining = full.filter((item) => item !== moved);
  const anchor = remaining.findIndex((item) => item === toId);
  if (anchor < 0) return full;
  const insertAt = placeAfter ? anchor + 1 : anchor;
  return [...remaining.slice(0, insertAt), moved, ...remaining.slice(insertAt)];
}

/**
 * The rail entries that stand together: a stacked panel's whole stack, or the
 * one entry. Indexes into `rail`, first and last.
 */
function railBlockAt(
  rail: ReadonlyArray<RailEntry>,
  index: number,
): readonly [number, number] {
  const entry = rail[index];
  if (entry.kind !== "panel") return [index, index];
  const stack = railStackOf(rail, entry.id);
  if (stack === null) return [index, index];
  const positions = rail.flatMap((candidate, position) =>
    candidate.kind === "panel" && stack.members.includes(candidate.id)
      ? [position]
      : [],
  );
  return [Math.min(...positions), Math.max(...positions)];
}

/**
 * The rail with one panel taken out of whatever stack names it. The panel
 * stays where it stands; `normalizeRail` dissolves a stack left with one
 * member.
 */
function withoutStackMember(
  rail: ReadonlyArray<RailEntry>,
  regionId: RailRegionId,
): ReadonlyArray<RailEntry> {
  return rail.map((entry): RailEntry => {
    if (entry.kind !== "stack") return entry;
    const members = railStackMembers(entry.id);
    if (members === null || !members.includes(regionId)) return entry;
    return {
      kind: "stack",
      id: railStackId(members.filter((member) => member !== regionId)),
    };
  });
}

/**
 * What a rail drag carries (L-181): the rail's icon stands for its whole
 * stack, so dragging it carries the stack; a panel's SECTION HEADER is one
 * panel, which is how a member is reordered within its stack or taken out.
 */
export type RailDragCarry = "stack" | "panel";

/**
 * One rail entry put beside another.
 *
 * A carried STACK lands before or after the target's whole stack, and onto
 * itself moves nothing. A carried PANEL beside another member of its own
 * stack stays in it and only changes place; anywhere else it leaves its stack
 * and lands before or after the target's whole stack, never between another
 * stack's members, because before and after only reorder (L-168).
 */
function railPlacedBeside(
  rail: ReadonlyArray<RailEntry>,
  drop: CanvasOrderDrop,
  carry: RailDragCarry,
): ReadonlyArray<RailEntry> {
  const placed = railPlacedBesideRaw(rail, drop, carry);
  // A drop that lands the carried entries where they already stand answers
  // the rail it was given, so a caller's identity guard spends no write or
  // undo step on it. Compared normalized: the mover leaves a stack entry where
  // `normalizeRail` would re-place it.
  return areRailsEqual(normalizeRail(placed), normalizeRail(rail))
    ? rail
    : placed;
}

function railPlacedBesideRaw(
  rail: ReadonlyArray<RailEntry>,
  drop: CanvasOrderDrop,
  carry: RailDragCarry,
): ReadonlyArray<RailEntry> {
  const fromIndex = rail.findIndex((entry) => entry.id === drop.fromId);
  const toIndex = rail.findIndex((entry) => entry.id === drop.toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return rail;
  const moved = rail[fromIndex];
  const [blockStart, blockEnd] = railBlockAt(rail, fromIndex);
  const inOwnBlock = toIndex >= blockStart && toIndex <= blockEnd;
  if (carry === "stack") {
    if (inOwnBlock) return rail;
    const carried = rail.slice(blockStart, blockEnd + 1);
    const remaining = rail.filter(
      (_, index) => index < blockStart || index > blockEnd,
    );
    const [anchorStart, anchorEnd] = railBlockAt(
      remaining,
      remaining.indexOf(rail[toIndex]),
    );
    const insertAt = drop.placeAfter ? anchorEnd + 1 : anchorStart;
    return [
      ...remaining.slice(0, insertAt),
      ...carried,
      ...remaining.slice(insertAt),
    ];
  }
  if (inOwnBlock) {
    const remaining = rail.filter((_, index) => index !== fromIndex);
    const anchor = remaining.indexOf(rail[toIndex]);
    const insertAt = drop.placeAfter ? anchor + 1 : anchor;
    return [
      ...remaining.slice(0, insertAt),
      moved,
      ...remaining.slice(insertAt),
    ];
  }
  const source =
    moved.kind === "panel" ? withoutStackMember(rail, moved.id) : rail;
  const remaining = source.filter((_, index) => index !== fromIndex);
  const [anchorStart, anchorEnd] = railBlockAt(
    remaining,
    remaining.indexOf(source[toIndex]),
  );
  const insertAt = drop.placeAfter ? anchorEnd + 1 : anchorStart;
  return [...remaining.slice(0, insertAt), moved, ...remaining.slice(insertAt)];
}

// ── The rail's writers ──────────────────────────────────────────────────────
// Arrangement in, arrangement out. The rail's own shape is `rail.ts`, which
// knows nothing of an arrangement; these are the three gestures that put a new
// rail back beside the rest of one, and they live here for that reason.

/**
 * One entry dragged to a new index, panels and dividers alike, since the rail
 * is one flat list (L-155).
 */
export function moveRailEntry(
  arrangement: LayoutArrangement,
  entryId: string,
  toIndex: number,
): LayoutArrangement {
  const fromIndex = arrangement.rail.findIndex((entry) => entry.id === entryId);
  if (fromIndex < 0) return arrangement;
  return {
    ...arrangement,
    rail: movedWithin(arrangement.rail, fromIndex, toIndex),
  };
}

/**
 * A panel reordered among panels alone, `toIndex` counted the same way: the
 * phone's flat chip bar draws no divider or stack, so a move there must
 * leave both exactly where they are - every divider and stack stays
 * immediately after the SAME panel it already followed, wherever that panel
 * now stands, rather than after whatever panel now occupies its old ARRAY
 * slot. `normalizeRail` then keeps or splits a stack whose members the new
 * order no longer holds adjacent.
 */
export function movePanelAmongPanels(
  arrangement: LayoutArrangement,
  panelId: string,
  toIndex: number,
): LayoutArrangement {
  const panelIds = arrangement.rail.flatMap((entry) =>
    entry.kind === "panel" ? [entry.id] : [],
  );
  const fromIndex = panelIds.findIndex((id) => id === panelId);
  if (fromIndex < 0) return arrangement;
  const reordered = movedWithin(panelIds, fromIndex, toIndex);
  const markersAfter = new Map<RailRegionId | null, RailEntry[]>();
  let anchor: RailRegionId | null = null;
  for (const entry of arrangement.rail) {
    if (entry.kind === "panel") {
      anchor = entry.id;
      continue;
    }
    markersAfter.set(anchor, [...(markersAfter.get(anchor) ?? []), entry]);
  }
  const rail: RailEntry[] = [...(markersAfter.get(null) ?? [])];
  for (const id of reordered) {
    rail.push({ kind: "panel", id });
    rail.push(...(markersAfter.get(id) ?? []));
  }
  return { ...arrangement, rail: normalizeRail(rail) };
}

/** A new divider at `index`, on an id no divider has held before. */
export function insertRailDivider(
  arrangement: LayoutArrangement,
  index: number,
): LayoutArrangement {
  const dividerSeq = arrangement.dividerSeq + 1;
  const insertAt = Math.min(Math.max(index, 0), arrangement.rail.length);
  const rail = [
    ...arrangement.rail.slice(0, insertAt),
    { kind: "divider" as const, id: railDividerId(dividerSeq) },
    ...arrangement.rail.slice(insertAt),
  ];
  return { ...arrangement, rail, dividerSeq };
}

/** One divider taken out of the flat rail; the panels stay put (L-155). */
export function removeRailDivider(
  arrangement: LayoutArrangement,
  entryId: string,
): LayoutArrangement {
  const rail = arrangement.rail.filter(
    (entry) => !(entry.kind === "divider" && entry.id === entryId),
  );
  if (rail.length === arrangement.rail.length) return arrangement;
  return { ...arrangement, rail };
}

/**
 * One rail icon's stack, or one panel, placed beside another panel, for the
 * app's own sidebar drag.
 *
 * The same mover the editor's canvas drop uses, reached the same way
 * (R5R-06): the drag at rest and the drag in a session differ in what the
 * user grabs, not in what a drop means, and two copies of "take it out and
 * put it back beside that one" would drift the first time either is fixed.
 * The sidebar speaks panel ids, so what is added here is the bijection onto
 * the rail's region ids, and the one fact only the sidebar knows: whether the
 * user grabbed the rail's icon, which carries its whole stack, or one panel's
 * section header (L-181).
 */
export function moveRailPanelBeside(
  arrangement: LayoutArrangement,
  drop: {
    readonly sourcePanelId: LeftPanelId;
    readonly targetPanelId: LeftPanelId;
    readonly placeAfter: boolean;
    readonly carry: RailDragCarry;
  },
): LayoutArrangement {
  const rail = railPlacedBeside(
    arrangement.rail,
    {
      fromId: railRegionForLeftPanelId(drop.sourcePanelId),
      toId: railRegionForLeftPanelId(drop.targetPanelId),
      placeAfter: drop.placeAfter,
    },
    drop.carry,
  );
  return rail === arrangement.rail ? arrangement : { ...arrangement, rail };
}

/** The panels a drag carries: the source's whole stack, or just the source. */
function carriedMembers(
  rail: ReadonlyArray<RailEntry>,
  sourceId: RailRegionId,
  carry: RailDragCarry,
): ReadonlyArray<RailRegionId> {
  if (carry === "panel") return [sourceId];
  return railStackOf(rail, sourceId)?.members ?? [sourceId];
}

/**
 * What a drop onto the middle of a rail icon would do (L-181): `join` adds the
 * carried panels to the target's stack (or makes a stack with it), `full` is
 * refused because the result would pass {@link MAX_RAIL_STACK_MEMBERS}, and
 * `same` does nothing because the carried panels are already stacked with the
 * target. The rail draws the join cue, a refusal cue, or nothing, from this
 * answer, and the writer obeys the same one.
 */
export type RailStackJoin = "join" | "full" | "same";

export function railStackJoin(
  rail: ReadonlyArray<RailEntry>,
  sourcePanelId: LeftPanelId,
  targetPanelId: LeftPanelId,
  carry: RailDragCarry,
): RailStackJoin {
  const targetId = railRegionForLeftPanelId(targetPanelId);
  const carried = carriedMembers(
    rail,
    railRegionForLeftPanelId(sourcePanelId),
    carry,
  );
  const target = railStackOf(rail, targetId)?.members ?? [targetId];
  if (carried.some((member) => target.includes(member))) return "same";
  return target.length + carried.length > MAX_RAIL_STACK_MEMBERS
    ? "full"
    : "join";
}

/**
 * The carried panels added to another's stack, which is what a drop onto the
 * middle of a rail icon means (L-168, L-181). A target standing alone makes a
 * stack with them.
 *
 * The carried panels land directly after the target stack's last member, in
 * their own order, so the panels the user aimed at keep their places and the
 * ones they carried are the ones that move - the same promise every other rail
 * drop makes. A single panel carried out of another stack leaves it (L-170).
 * Anything {@link railStackJoin} does not answer `join` for returns the
 * arrangement it was given, so the caller's own "did this change anything"
 * guard spends no undo step on it.
 */
export function stackRailPanels(
  arrangement: LayoutArrangement,
  sourcePanelId: LeftPanelId,
  targetPanelId: LeftPanelId,
  carry: RailDragCarry,
): LayoutArrangement {
  if (
    railStackJoin(arrangement.rail, sourcePanelId, targetPanelId, carry) !==
    "join"
  )
    return arrangement;
  const targetId = railRegionForLeftPanelId(targetPanelId);
  const carried = carriedMembers(
    arrangement.rail,
    railRegionForLeftPanelId(sourcePanelId),
    carry,
  );
  // The carried panels' own stack goes with them: a whole stack is re-minted
  // into the target's, and a single member simply leaves its old one.
  const released = carried.reduce(
    (rail, member) => withoutStackMember(rail, member),
    arrangement.rail,
  );
  const moved = carried.flatMap((member) =>
    released.filter((entry) => entry.kind === "panel" && entry.id === member),
  );
  const remaining = released.filter((entry) => !moved.includes(entry));
  const stack = railStackOf(remaining, targetId);
  const members = stack?.members ?? [targetId];
  const lastIndex = Math.max(
    ...members.map((member) =>
      remaining.findIndex(
        (entry) => entry.kind === "panel" && entry.id === member,
      ),
    ),
  );
  if (lastIndex < 0) return arrangement;
  const id = railStackId([...members, ...carried]);
  const placed = [
    ...remaining.slice(0, lastIndex + 1),
    ...moved,
    ...remaining.slice(lastIndex + 1),
  ];
  return {
    ...arrangement,
    rail:
      stack === null
        ? placed.flatMap((entry): RailEntry[] =>
            entry.kind === "panel" && entry.id === targetId
              ? [entry, { kind: "stack", id }]
              : [entry],
          )
        : placed.map((entry): RailEntry =>
            entry.kind === "stack" && entry.id === stack.id
              ? { kind: "stack", id }
              : entry,
          ),
  };
}

/**
 * The panel directly below this one's stack (or below this panel, standing
 * alone), when the list's "Stack with the panel below" can join the two
 * (L-168, L-181): this panel is the last of its stack, the next entry is a
 * panel rather than a divider, and the two stacks together stay within
 * {@link MAX_RAIL_STACK_MEMBERS}. `null` otherwise.
 */
export function railPanelToStackBelow(
  rail: ReadonlyArray<RailEntry>,
  regionId: RailRegionId,
): RailRegionId | null {
  const index = rail.findIndex(
    (entry) => entry.kind === "panel" && entry.id === regionId,
  );
  if (index < 0) return null;
  const [, blockEnd] = railBlockAt(rail, index);
  if (blockEnd !== index) return null;
  const below = rail.at(index + 1);
  if (below === undefined || below.kind !== "panel") return null;
  const count = (id: RailRegionId): number =>
    railStackOf(rail, id)?.members.length ?? 1;
  return count(regionId) + count(below.id) <= MAX_RAIL_STACK_MEMBERS
    ? below.id
    : null;
}

/**
 * This panel's stack (or this panel) joined with the one directly below it,
 * with no panel moving: the list gesture never reorders (L-170).
 */
export function stackRailPanelWithBelow(
  arrangement: LayoutArrangement,
  regionId: RailRegionId,
): LayoutArrangement {
  const below = railPanelToStackBelow(arrangement.rail, regionId);
  if (below === null) return arrangement;
  const membersOf = (id: RailRegionId): ReadonlyArray<RailRegionId> =>
    railStackOf(arrangement.rail, id)?.members ?? [id];
  const members = [...membersOf(regionId), ...membersOf(below)];
  const rail = arrangement.rail.filter(
    (entry) =>
      !(
        entry.kind === "stack" &&
        railStackMembers(entry.id)?.some((member) => members.includes(member))
      ),
  );
  const first = rail.findIndex(
    (entry) => entry.kind === "panel" && entry.id === members[0],
  );
  return {
    ...arrangement,
    rail: [
      ...rail.slice(0, first + 1),
      { kind: "stack", id: railStackId(members) },
      ...rail.slice(first + 1),
    ],
  };
}

/** A whole stack taken apart; every panel stays where it is (L-168). */
export function unstackRail(
  arrangement: LayoutArrangement,
  entryId: string,
): LayoutArrangement {
  const rail = arrangement.rail.filter(
    (entry) => !(entry.kind === "stack" && entry.id === entryId),
  );
  if (rail.length === arrangement.rail.length) return arrangement;
  return { ...arrangement, rail };
}

/**
 * One member taken out of its stack (L-181), with as little movement as that
 * allows: the first or last member stays where it stands, just outside, and a
 * middle member steps out to just after the stack, since standing where it
 * was would split the others. Taking one out of a two-member stack dissolves
 * it.
 */
export function unstackRailPanel(
  arrangement: LayoutArrangement,
  regionId: RailRegionId,
): LayoutArrangement {
  const stack = railStackOf(arrangement.rail, regionId);
  if (stack === null) return arrangement;
  const released = withoutStackMember(arrangement.rail, regionId);
  const middle =
    stack.members[0] !== regionId && stack.members.at(-1) !== regionId;
  if (!middle) return { ...arrangement, rail: released };
  const index = released.findIndex(
    (entry) => entry.kind === "panel" && entry.id === regionId,
  );
  const [, blockEnd] = railBlockAt(arrangement.rail, index);
  const moved = released[index];
  const remaining = released.filter((_, position) => position !== index);
  return {
    ...arrangement,
    rail: [
      ...remaining.slice(0, blockEnd),
      moved,
      ...remaining.slice(blockEnd),
    ],
  };
}

/** Whether this panel is in a stack right now. */
export function isStackedRailPanel(
  rail: ReadonlyArray<RailEntry>,
  regionId: RailRegionId,
): boolean {
  return railStackOf(rail, regionId) !== null;
}

/**
 * The same carry onto the rail's end, which is the rail's own empty space: a
 * rail icon's whole stack, or one panel, which leaves its stack (L-181).
 */
export function moveRailPanelToEnd(
  arrangement: LayoutArrangement,
  sourcePanelId: LeftPanelId,
  carry: RailDragCarry,
): LayoutArrangement {
  const regionId = railRegionForLeftPanelId(sourcePanelId);
  const fromIndex = arrangement.rail.findIndex(
    (entry) => entry.kind === "panel" && entry.id === regionId,
  );
  if (fromIndex < 0) return arrangement;
  if (carry === "stack") {
    const [start, end] = railBlockAt(arrangement.rail, fromIndex);
    return {
      ...arrangement,
      rail: [
        ...arrangement.rail.slice(0, start),
        ...arrangement.rail.slice(end + 1),
        ...arrangement.rail.slice(start, end + 1),
      ],
    };
  }
  const released = withoutStackMember(arrangement.rail, regionId);
  const moved = released[fromIndex];
  return {
    ...arrangement,
    rail: [...released.filter((entry) => entry !== moved), moved],
  };
}
