import {
  SIDE_STRIP_VIEW_AT_TOP,
  TAB_OVERFLOW_AT_SIDE,
  type SurfaceGroupId,
} from "@/components/layout-editor/regions/region-grammar";
import {
  ABSENT,
  disabledBy,
  INDEPENDENT,
  LIVE,
  strictest,
  wideLayoutRow,
  type RowDependency,
  type RowRule,
} from "@/components/layout-editor/regions/row-availability";
import { isMobileFooterRowAvailable } from "@/lib/settings/settings-availability";

/**
 * The rows that belong to an AREA rather than to a region, as data: which
 * area draws each, whether before or after its lists, and what it depends on
 * (P1) - the same {@link RowDependency} a region's detail row declares, so
 * both are nested, ordered and greyed by one rule.
 *
 * The rows themselves are drawn by `inspector/rows/surface-placement-rows.tsx`,
 * one component per id; their words are the Settings search definitions'
 * (`layout-settings.definitions.ts`), whose `availableWhen` and these rules
 * call the same shell predicates, so search never offers a row the form
 * withholds.
 *
 * Declaration order is the order on screen. Under Placement, Tab overflow
 * comes first because the tabs ship at the top, where it is the live one.
 */

export type AreaRowId =
  | "tabStripPlacement"
  | "taskTabLayout"
  | "sideStripView"
  | "sidebarSide"
  | "resourceReadings"
  | "readingWidth"
  | "wideReadingWidth"
  | "toolbarStyle"
  | "mobileFooter";

export interface AreaRow {
  readonly id: AreaRowId;
  readonly surface: SurfaceGroupId;
  /** Before the area's lists, or after them. */
  readonly place: "leading" | "trailing";
  readonly depends: RowDependency;
}

const desktopLayoutRow: RowRule = (context) => wideLayoutRow(context.shell);

const DESKTOP_LAYOUT_ROW: RowDependency = {
  under: null,
  availability: desktopLayoutRow,
};

export const AREA_ROWS: ReadonlyArray<AreaRow> = [
  {
    id: "tabStripPlacement",
    surface: "topBar",
    place: "leading",
    depends: DESKTOP_LAYOUT_ROW,
  },
  {
    // A side strip stacks its tabs and never scrolls or shrinks them sideways.
    id: "taskTabLayout",
    surface: "topBar",
    place: "leading",
    depends: {
      under: "tabStripPlacement",
      availability: (context) =>
        strictest([
          desktopLayoutRow(context),
          context.arrangement.tabStripPlacement === "top"
            ? LIVE
            : disabledBy(TAB_OVERFLOW_AT_SIDE, null),
        ]),
    },
  },
  {
    id: "sideStripView",
    surface: "topBar",
    place: "leading",
    depends: {
      under: "tabStripPlacement",
      availability: (context) =>
        strictest([
          desktopLayoutRow(context),
          context.arrangement.tabStripPlacement === "top"
            ? disabledBy(SIDE_STRIP_VIEW_AT_TOP, null)
            : LIVE,
        ]),
    },
  },
  {
    id: "sidebarSide",
    surface: "sidebar",
    place: "leading",
    depends: DESKTOP_LAYOUT_ROW,
  },
  {
    id: "resourceReadings",
    surface: "sidebar",
    place: "trailing",
    depends: DESKTOP_LAYOUT_ROW,
  },
  {
    id: "readingWidth",
    surface: "chat",
    place: "leading",
    depends: DESKTOP_LAYOUT_ROW,
  },
  {
    // Kept in place while Comfortable, so the slider does not come and go
    // with the choice above it (C5).
    id: "wideReadingWidth",
    surface: "chat",
    place: "leading",
    depends: {
      under: "readingWidth",
      availability: (context) =>
        strictest([
          desktopLayoutRow(context),
          context.arrangement.readingWidth === "wide"
            ? LIVE
            : disabledBy("Set Reading width to Wide to use this.", null),
        ]),
    },
  },
  {
    // The whole toolbar row's chrome, on every layout (C3).
    id: "toolbarStyle",
    surface: "composer",
    place: "leading",
    depends: INDEPENDENT,
  },
  {
    // First in its area wherever it exists: while it is off, the phone layout
    // draws neither reading's settings, only the header's icons (U1).
    id: "mobileFooter",
    surface: "statusBar",
    place: "leading",
    depends: {
      under: null,
      availability: (context) =>
        isMobileFooterRowAvailable(context.shell) ? LIVE : ABSENT,
    },
  },
];
