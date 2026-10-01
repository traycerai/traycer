import {
  alwaysAvailable,
  isLayoutEditorAvailable,
  isMobileFooterRowAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * Rows with no effect in the installed mobile app, which always draws its own
 * header and no tab strip or sidebar: the tab strip's placement, view and
 * overflow, the sidebar's side, the readings on agent rows (the phone's
 * switcher lists draw none), and the reading width (a phone is narrower than
 * even the Comfortable column).
 */
function isDesktopLayoutRowAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return !context.mobileApp;
}

/**
 * Where the app's own chrome sits and how much of it shows.
 *
 * The page is the full-width host for the SAME section tree the inspector
 * docks (L-03), so this collection describes only what search has to land on:
 * the page, the presets block, one anchor per surface group, and the rows
 * that belong to a surface rather than to a region.
 *
 * The regions themselves are not listed here. They come from
 * `components/layout-editor/layout-search.definitions.ts`, generated from the region
 * registry, because the registry is already the one description of a region's
 * name and its keywords and a second copy here could only drift from it.
 */
export const LAYOUT = defineSettingsSection("layout", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Layout",
    description:
      "Where the app's chrome sits and how much of it shows. Changes apply right away.",
    keywords: [
      "chrome",
      "customize",
      "footer",
      "header",
      "arrange",
      "position",
      "visibility",
    ],
  },
  /**
   * The page header's way into the canvas editor (L-15, L-33, H2), and the
   * coachmark target the "Appearance and layout" guide ends on (L-50). On no
   * area, so a search result for it picks none. Withheld where the editor can
   * never open, with the header action and the guide's step.
   */
  customizeEntry: {
    kind: "row",
    group: null,
    search: { anchor: "layout-customize" },
    label: "Customize layout",
    // What pressing it actually does (L-87): the editor always opens a sample
    // workspace, so the user's own task is never rearranged under them. The old
    // copy said "where it lives", which read as "in your task".
    description:
      "Point at the app's own chrome in a sample workspace and change it there. The areas on this page are the same set of settings.",
    availableWhen: isLayoutEditorAvailable,
    keywords: [
      "customize",
      "edit",
      "editor",
      "arrange",
      "move",
      "reorder",
      "drag",
      "visual",
    ],
  },
  // First on the page: the coarsest control here, and the one every section's
  // values are measured against ("Compact · Modified").
  presets: {
    kind: "group",
    search: { anchor: "layout-presets" },
    label: "Presets",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: [
      "preset",
      "compact",
      "detailed",
      "reset",
      "defaults",
      "density",
      "custom",
    ],
  },
  topBar: {
    kind: "group",
    search: { anchor: "layout-surface-top-bar" },
    label: "Task tabs",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["tabs", "home", "top bar", "title bar"],
  },
  /**
   * Where the task tabs sit: a surface-level row, because the tab strip is not
   * a region. Drawn by `TabStripPositionRow` on both hosts.
   */
  tabStripPlacement: {
    kind: "row",
    group: "topBar",
    search: { anchor: "layout-tab-strip-placement" },
    label: "Placement",
    description: "Across the top, or as a vertical strip at either edge.",
    availableWhen: isDesktopLayoutRowAvailable,
    keywords: [
      "vertical tabs",
      "side tabs",
      "left",
      "right",
      "top",
      "position",
    ],
  },
  /**
   * What the side strip shows (D8): a surface-level row beside Placement,
   * drawn by `SideStripViewRow` on both hosts.
   */
  sideStripView: {
    kind: "row",
    group: "topBar",
    search: { anchor: "layout-side-strip-view" },
    label: "Side tab view",
    description:
      "Tabs and agents also lists the open task's active agents under its tab, with what each is doing or needs from you.",
    availableWhen: isDesktopLayoutRowAvailable,
    keywords: [
      "view",
      "activity",
      "tabs only",
      "live agents",
      "agents",
      "needs you",
      "vertical tabs",
    ],
  },
  /**
   * How tabs fit a top strip. Settings-store state rather than arrangement,
   * drawn by `TabOverflowRow` on both hosts.
   */
  taskTabLayout: {
    kind: "row",
    group: "topBar",
    search: { anchor: "layout-task-tab-layout" },
    label: "Tab overflow",
    description:
      "Scroll keeps titles readable. Shrink to fit makes tabs narrower as you open more.",
    availableWhen: isDesktopLayoutRowAvailable,
    keywords: [
      "task tabs",
      "scroll",
      "shrink",
      "overflow",
      "hidden",
      "count",
      "chrome",
    ],
  },
  sidebar: {
    kind: "group",
    search: { anchor: "layout-surface-sidebar" },
    label: "Sidebar",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["rail", "panels", "icons", "order", "group"],
  },
  /**
   * Which side of the task canvas the sidebar takes: a surface-level row,
   * drawn by `SidebarSideRow` on both hosts.
   */
  sidebarSide: {
    kind: "row",
    group: "sidebar",
    search: { anchor: "layout-sidebar-side" },
    label: "Side",
    description: "Which side of the task canvas the sidebar sits on.",
    availableWhen: isDesktopLayoutRowAvailable,
    keywords: ["sidebar", "left", "right", "side"],
  },
  /**
   * The resource readings beside each agent and terminal row, drawn by
   * `ResourceReadingsRow` on both hosts. Whether rows print is this switch;
   * which readings is the Resource monitor's Metrics choice (L-174).
   */
  resourceReadings: {
    kind: "row",
    group: "sidebar",
    search: { anchor: "layout-resource-readings" },
    label: "Readings on agent rows",
    description:
      "Shows the metrics chosen under Usage and resources > Resource monitor.",
    availableWhen: isDesktopLayoutRowAvailable,
    keywords: [
      "resource",
      "readings",
      "cpu",
      "memory",
      "processes",
      "agent rows",
      "terminals",
    ],
  },
  chat: {
    kind: "group",
    search: { anchor: "layout-surface-chat" },
    label: "Chat",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["transcript", "minimap", "context"],
  },
  /**
   * How wide chat and artifacts read: a surface-level row, because the
   * content column is not a thing to point at. Drawn by `ReadingWidthRow` on
   * both hosts; presets leave it alone (it is arrangement, not density).
   */
  readingWidth: {
    kind: "row",
    group: "chat",
    search: { anchor: "layout-reading-width" },
    label: "Reading width",
    description: "Chat and artifacts. Wide suits a large monitor.",
    availableWhen: isDesktopLayoutRowAvailable,
    keywords: [
      "width",
      "wide",
      "column",
      "measure",
      "full width",
      "max width",
      "comfortable",
      "artifact",
    ],
  },
  composer: {
    kind: "group",
    search: { anchor: "layout-surface-composer" },
    label: "Composer",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["toolbar", "dock", "message box", "buttons"],
  },
  statusBar: {
    kind: "group",
    search: { anchor: "layout-surface-status-bar" },
    label: "Usage and resources",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["footer", "status bar", "strip", "usage", "resources"],
  },
  /*
   * There is no surface-tier row for where the strip's readings live any more
   * (L-156). "Show these in" moved both at once and said so in its own copy;
   * each reading now names its own bar and its own end of it, on its own
   * region row, which is where the page draws them - the same Position and
   * Side rows the inspector draws (L-03). A region's search entries are
   * generated from the registry
   * (`components/layout-editor/layout-search.definitions.ts`), so the two
   * picks are findable without an entry here.
   */
  /**
   * The grammar's surface tier (L-51): it belongs to no region, and it decides
   * whether the strip exists at all on a narrow viewport. Only the installed
   * mobile app withholds the footer by default, so only that build has the
   * switch; every other build draws the strip whenever a reading still names
   * it.
   */
  mobileFooter: {
    kind: "row",
    group: "statusBar",
    search: { anchor: "layout-mobile-footer" },
    label: "Status bar on small screens",
    description: null,
    availableWhen: isMobileFooterRowAvailable,
    keywords: ["footer", "phone", "mobile", "small screen", "status bar"],
  },
  /**
   * Last in the Presets area, and the only card with a tone: `Reset layout…`
   * puts every setting and the whole arrangement back, behind a confirm in
   * both hosts (L-108 overturned).
   */
  resetLayout: {
    kind: "group",
    search: { anchor: "layout-reset" },
    label: "Reset layout",
    description: null,
    breadcrumb: null,
    availableWhen: alwaysAvailable,
    keywords: ["reset", "default", "start over", "restore", "undo all"],
  },
  resetLayoutAction: {
    kind: "row",
    group: "resetLayout",
    // The card's own name and this row's are the same words, and two results
    // under one name on one page is a choice with no answer.
    search: { contributesTo: "resetLayout" },
    label: "Reset layout",
    description:
      "Every setting, and where everything sits, goes back to how the app shipped.",
    availableWhen: alwaysAvailable,
    keywords: [],
  },
});
