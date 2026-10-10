import type { LucideIcon } from "lucide-react";
import type {
  LayoutArrangement,
  OrderGroupId,
  BarHost,
  ReadingWidth,
  SideStripView,
  TaskTabLayout,
  TabStripPlacement,
} from "@/lib/layout/layout-arrangement";
import type { LayoutValues } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";
import type {
  LayoutFacts,
  RegionRule,
  RowDependency,
  ShellGate,
} from "@/components/layout-editor/regions/row-availability";

/**
 * The grammar every region's section is written in (L-08), and the few row
 * shapes and option sets more than one surface reuses.
 *
 * A section is not written per region anywhere: a region declares its rows in
 * the fixed grammar order and one renderer draws them, which is what keeps the
 * docked inspector and the full-width `Settings > Layout` host the same form
 * (L-03). Every row is generic over the region id, so a row naming a key the
 * region does not have is a compile error rather than a runtime test (C-20).
 *
 * The regions themselves are the five per-surface tables beside this file; the
 * index that joins them is `layout-regions.ts`.
 */

export type SurfaceGroupId =
  | "topBar"
  | "sidebar"
  | "chat"
  | "composer"
  | "statusBar";

/** The index's groups, in the order a reader meets them top to bottom. */
export const SURFACE_GROUPS: ReadonlyArray<{
  readonly id: SurfaceGroupId;
  readonly label: string;
}> = [
  { id: "topBar", label: "Task tabs" },
  { id: "sidebar", label: "Sidebar" },
  { id: "chat", label: "Chat" },
  { id: "composer", label: "Composer" },
  { id: "statusBar", label: "Usage and resources" },
];

/**
 * What a right-click on a customizable element offers (L-19).
 *
 * `hide` and `show` are one pair rather than one verb because the menu names
 * the region ("Hide Minimap"), so which of the two is offered is a question
 * about the region's current state, not about which verbs it has.
 */
export type QuickVerbId = "hide" | "show" | "chip" | "full";

export type LayoutRegionIcon = LucideIcon;

export interface SegmentOption {
  readonly value: string;
  readonly label: string;
}

/**
 * How one detail row is operated.
 *
 * `switch` is an independent boolean feature; a `Visibility` is a `segment`
 * like every other visibility choice. `checks` is one boolean key per option,
 * for fields shown at the same time. `field-checks` is the other shape a check
 * list has: ONE key holding the set of what is checked, drawn as a sortable
 * list whose order is `arrangement.pinnedContextFieldOrder` (C2) - the pinned
 * breakdown's rows are the one list of its kind.
 */
export type ControlSpec<K extends RegionId> =
  | { readonly kind: "switch"; readonly key: keyof LayoutValues[K] & string }
  | {
      readonly kind: "segment";
      readonly key: keyof LayoutValues[K] & string;
      readonly options: ReadonlyArray<SegmentOption>;
    }
  | {
      readonly kind: "checks";
      readonly options: ReadonlyArray<CheckOption<K>>;
    }
  | {
      readonly kind: "field-checks";
      readonly key: keyof LayoutValues[K] & string;
      readonly options: ReadonlyArray<SegmentOption>;
    };

export interface CheckOption<K extends RegionId> {
  readonly key: keyof LayoutValues[K] & string;
  readonly label: string;
}

export interface FineTuneRow<K extends RegionId> {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  /**
   * Whether an active row opens the real transient surface this setting is
   * about, pinned and inert on the canvas (L-27) - the only way to see a
   * change that lands inside a popover or a hover card. The section renderer
   * owns the pinning; this is what tells it which row asks for one.
   */
  readonly pinsTransient: boolean;
  /**
   * The row it sits under and when it applies (P1, `row-availability.ts`),
   * including whether it stays live while its region is Hidden
   * (`liveOutsideGate`).
   */
  readonly depends: RowDependency;
  readonly control: ControlSpec<K>;
}

/** One named value of a single-value style enum, drawn as the real thing. */
export interface StyleExample<K extends RegionId> {
  readonly id: string;
  readonly label: string;
  readonly patch: Partial<LayoutValues[K]>;
}

/**
 * The ids a region's detail rows go by among themselves, which is what a
 * `depends.under` names: a fine-tune row's `id`, a style row's `key`, and
 * these two for the position rows.
 */
export const LOCATION_ROW_ID = "location";
export const SIDE_ROW_ID = "side";

export type GrammarRow<K extends RegionId> =
  // A bar reading's one Location picker (a bar and an end of it, in one row).
  | { readonly kind: "position-host"; readonly depends: RowDependency }
  // The minimap's edge of the transcript.
  | {
      readonly kind: "position-side";
      readonly description: string;
      readonly depends: RowDependency;
    }
  // Names its group and nothing else: how the list is operated, whether its
  // boundaries are items and what is pinned inside it are facts about the
  // GROUP, and they live once in `surface-groups.ts` rather than once per
  // member (D1-D4, D8).
  | { readonly kind: "position-order"; readonly group: OrderGroupId }
  | {
      readonly kind: "style";
      /** The one key every example writes, and the row's own label. */
      readonly key: keyof LayoutValues[K] & string;
      readonly label: string;
      /** A sentence under the label, or `null` where the pictures say it. */
      readonly description: string | null;
      /**
       * Where each example's name sits: `end` beside a small picture, `above`
       * over one wide enough to want the card's whole width.
       */
      readonly labelPlacement: "end" | "above";
      readonly examples: ReadonlyArray<StyleExample<K>>;
      readonly depends: RowDependency;
    }
  | { readonly kind: "fine-tune"; readonly rows: ReadonlyArray<FineTuneRow<K>> }
  | { readonly kind: "children"; readonly level: "usage-providers" };

export interface LayoutRegion<K extends RegionId> {
  readonly id: K;
  readonly name: string;
  readonly surface: SurfaceGroupId;
  readonly icon: LayoutRegionIcon;
  readonly where: string;
  /**
   * The BAR each of the two movable readings names, one sentence per bar
   * (L-156). The side is the other half of their position and comes from the
   * arrangement, so it is composed in `regionWhere` rather than written into
   * four sentences here. `null` for a region that lives where it lives.
   */
  readonly whereByHost: Readonly<Record<BarHost, string>> | null;
  /**
   * The presence rule a region follows when nobody has chosen for it (L-47),
   * spelled out in its row. `null` means the region has no rule, which is also
   * what makes its Shown control a plain switch rather than the tri-state one.
   */
  readonly hint: string | null;
  readonly keywords: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<GrammarRow<K>>;
  /**
   * Whether this shell can ever draw the region. Where it says no, the region
   * is no row in its list and no search result: the form and search both read
   * this, and nothing else answers it.
   */
  readonly shellGate: ShellGate;
  /**
   * When the region's own row applies (P1) where its gate lets it be drawn:
   * `disabled` greys its display control with the reason.
   */
  readonly availability: RegionRule;
  readonly quickVerbs: ReadonlyArray<QuickVerbId>;
  /**
   * The region's state in a word or two. It reads the same facts its row's
   * rule does, so the canvas chip and Find never call a region Shown while
   * its row says it is off (the Microphone with Voice input off).
   */
  readonly stateWord: (
    values: LayoutValues[K],
    arrangement: LayoutArrangement,
    facts: LayoutFacts,
  ) => string;
}

// ── Shared option sets ──────────────────────────────────────────────────────

/** A dock row's one display control: `size` and `shown` read together. */
export const DOCK_DISPLAY_OPTIONS: ReadonlyArray<SegmentOption> = [
  { value: "full", label: "Full row" },
  { value: "chip", label: "Chip" },
  { value: "hidden", label: "Hidden" },
];

/** Access's `size`, which has no Hidden (G6). */
export const ACCESS_DISPLAY_OPTIONS: ReadonlyArray<SegmentOption> = [
  { value: "full", label: "Icon and label" },
  { value: "chip", label: "Icon only" },
];

/**
 * Tool activity's `size`, which has no Hidden. Open and Closed rather than
 * Expanded and Collapsed: Thinking's three options have to fit beside its name
 * and revert in the 380px inspector. The long words stay as search keywords.
 */
export const DISCLOSURE_OPTIONS: ReadonlyArray<SegmentOption> = [
  { value: "full", label: "Open" },
  { value: "chip", label: "Closed" },
];

/** Thinking's `size` and `shown` read together, as a dock row's are. */
export const DISCLOSURE_HIDDEN_OPTIONS: ReadonlyArray<SegmentOption> = [
  ...DISCLOSURE_OPTIONS,
  { value: "hidden", label: "Hidden" },
];

/** How wide the transcript, the composer and an artifact read. */
export const READING_WIDTH_OPTIONS: ReadonlyArray<{
  readonly value: ReadingWidth;
  readonly label: string;
}> = [
  { value: "comfortable", label: "Comfortable" },
  { value: "wide", label: "Wide" },
];

export const SHOWN_HIDDEN_OPTIONS: ReadonlyArray<SegmentOption> = [
  { value: "shown", label: "Shown" },
  { value: "hidden", label: "Hidden" },
];

/** Pull requests and Comments only (L-93 overturned). */
export const AUTO_SHOWN_HIDDEN_OPTIONS: ReadonlyArray<SegmentOption> = [
  { value: "auto", label: "Auto" },
  ...SHOWN_HIDDEN_OPTIONS,
];

/** Where the task tabs sit; the Tabs surface's Position row and tab menus. */
export const TAB_STRIP_PLACEMENT_OPTIONS: ReadonlyArray<{
  readonly value: TabStripPlacement;
  readonly label: string;
}> = [
  { value: "top", label: "Top" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

export const SIDE_STRIP_VIEW_OPTIONS: ReadonlyArray<{
  readonly value: SideStripView;
  readonly label: string;
}> = [
  { value: "layered", label: "Tabs only" },
  { value: "activity", label: "Tabs and agents" },
];

/** Why Side tab view does nothing at the top: its row and the canvas both say it. */
export const SIDE_STRIP_VIEW_AT_TOP =
  "Set Placement to Left or Right to use this.";

/** Why Tab overflow does nothing while the tabs are a side strip. */
export const TAB_OVERFLOW_AT_SIDE = "Set Placement to Top to use this.";

/** Why it shows nothing on the collapsed rail, which the canvas says. */
export const SIDE_STRIP_VIEW_COLLAPSED =
  "Shows when the tab strip is expanded.";

/** How tabs fit a horizontal strip. */
export const TAB_OVERFLOW_OPTIONS: ReadonlyArray<{
  readonly value: TaskTabLayout;
  readonly label: string;
}> = [
  { value: "scroll", label: "Scroll" },
  { value: "shrink", label: "Shrink to fit" },
];

export const EDGE_SIDE_OPTIONS: ReadonlyArray<SegmentOption> = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

/**
 * The two bars a reading can live in, as the change list words them. The
 * `header` value is the tab strip's bar in every placement - across the top
 * beside the tabs, or the vertical strip's foot - so it is named for the tab
 * strip; the stored value stays `"header"` (L-133). The form itself picks a
 * place through `reading-placement.ts`.
 */
export const BAR_HOST_OPTIONS: ReadonlyArray<SegmentOption> = [
  { value: "status-bar", label: "Status bar" },
  { value: "header", label: "Tab strip" },
];

// ── Shared verb sets ────────────────────────────────────────────────────────

export const SHOW_HIDE_VERBS: ReadonlyArray<QuickVerbId> = ["hide", "show"];
export const SIZED_VERBS: ReadonlyArray<QuickVerbId> = [
  "hide",
  "show",
  "chip",
  "full",
];
/** A region that resizes but never hides: the Access pill (G6). */
export const SIZE_ONLY_VERBS: ReadonlyArray<QuickVerbId> = ["chip", "full"];
