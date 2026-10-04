import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import {
  useLandingPaneAnchorStore,
  type LandingPaneAnchorState,
  type LandingPanelCoverage,
} from "@/components/home/terminal-panel/landing-pane-anchor-store";
import type { TabRef } from "@/stores/tabs/types";
import type { HeaderStripItem } from "@/stores/tabs/use-header-tabs";
import type { SheetJoinPane } from "./side-strip/side-tab-join";

/** The edge of its surface a tab joins: the top strip's, or a side strip's. */
export type JoinEdge = "top" | EdgeSide;

/**
 * What the rule reads of the start page's panel: what the panel RENDERS on
 * each draft, as the panel publishes it. Never the stored layout, which stays
 * open and maximized for a page that shows no panel at all.
 */
export type LandingPanelCoverages = LandingPaneAnchorState["panelCoverage"];

/**
 * The pane a surface shows along `edge`, which is the fill a tab joining it
 * there takes: the ground the surface's BODY paints at that edge, read per
 * kind.
 *
 * - A task's body (its shell, whose status row is its top) is `--background`.
 *   Beside a side strip it shows its canvas, unless its panel is on that
 *   side: `useSideTabJoin` names the panel or its rail then.
 * - A draft paints `--background`, under its terminal panel where one is
 *   rendered (`draftJoinPane`).
 * - Settings paints `--background`, with its rail (the sidebar's fill) down
 *   its left edge.
 * - Home and History paint nothing of their own and show their sheet's canvas.
 * - The session tab never joins; its arm keeps the switch total, so a new
 *   kind has to say what its surface paints.
 *
 * A side strip runs the whole length of the edge it joins, so a panel on that
 * side is what every row meets and the rule can name it. The top strip does
 * not: a panel that reaches the top edge (the task's sidebar, Settings' rail,
 * a docked terminal panel) is under only the tabs that happen to sit over it,
 * and a tab can straddle its edge. One fill cannot be both grounds and the
 * rule does not know where along the strip a tab is, so a top tab joins in the
 * body's ground wherever it sits. The palettes this app ships keep the sidebar
 * on the background, and the ones it derives or imports paint the canvas as
 * the background, so over such a panel the tab is the colour it was before
 * this rule.
 *
 * The rule names the ground of a surface that has settled. One that is still
 * loading, has failed or is migrating can paint another ground for as long as
 * that lasts, and the join does not follow it there; it never did.
 */
export function surfaceJoinPane(
  tab: TabRef,
  edge: JoinEdge,
  landing: LandingPanelCoverages,
): SheetJoinPane {
  switch (tab.kind) {
    case "epic":
      return edge === "top" ? "surface" : "canvas";
    case "draft":
      return draftJoinPane(landing.get(tab.id) ?? null, edge);
    case "settings":
      return edge === "left" ? "panel" : "surface";
    case "home":
    case "history":
    case "sample-workspace":
      return "canvas";
  }
}

/**
 * The start page's terminal panel is canvas and docks on the right: rendered,
 * it is what a right-hand strip meets, and covering the page it is what every
 * edge meets. `coverage` is `null` for a page that shows no panel. Canvas is
 * the panel's ground from md, which is where a tab joins; the phone overlay
 * is `--background` and has no join to match.
 */
function draftJoinPane(
  coverage: LandingPanelCoverage | null,
  edge: JoinEdge,
): SheetJoinPane {
  if (coverage === null) return "surface";
  return coverage === "full" || edge === "right" ? "canvas" : "surface";
}

/**
 * A top split pair's surfaces share the sheet under the pair's one box, so
 * the pair joins in `--background` when either of them paints it along the top
 * and in the canvas otherwise. `members` are the sides that hold a tab: an
 * empty or unavailable side shows the slot chooser, which paints neither, so
 * History beside one keeps History's canvas.
 */
export function splitPairJoinPane(
  members: ReadonlyArray<TabRef>,
  landing: LandingPanelCoverages,
): SheetJoinPane {
  return members.some(
    (member) => surfaceJoinPane(member, "top", landing) === "surface",
  )
    ? "surface"
    : "canvas";
}

/** The pair's pane from the strip's own projection of it, which holds the tabs. */
export function headerSplitJoinPane(
  item: Extract<HeaderStripItem, { readonly kind: "split" }>,
  landing: LandingPanelCoverages,
): SheetJoinPane {
  return splitPairJoinPane(
    [item.left, item.right].flatMap((member) =>
      member.kind === "tab" ? [member.tab] : [],
    ),
    landing,
  );
}

/**
 * The pane a top strip item joins, from the strip's own projection of it. The
 * sliding selection box reads it for the item it flies to, which composes the
 * two rules that item's resting box and drag overlay read, so all three wear
 * one fill.
 */
export function headerItemJoinPane(
  item: HeaderStripItem,
  landing: LandingPanelCoverages,
): SheetJoinPane {
  return item.kind === "split"
    ? headerSplitJoinPane(item, landing)
    : surfaceJoinPane(item.tab, "top", landing);
}

/** `surfaceJoinPane`, following what the start page's panel renders; `null` for no tab. */
export function useSurfaceJoinPane(
  tab: TabRef | null,
  edge: JoinEdge,
): SheetJoinPane | null {
  return useLandingPaneAnchorStore((state) =>
    tab === null ? null : surfaceJoinPane(tab, edge, state.panelCoverage),
  );
}

/** `headerItemJoinPane`, following what the panel renders; `null` for no item. */
export function useHeaderItemJoinPane(
  item: HeaderStripItem | null,
): SheetJoinPane | null {
  return useLandingPaneAnchorStore((state) =>
    item === null ? null : headerItemJoinPane(item, state.panelCoverage),
  );
}

/** `headerSplitJoinPane`, following what the start page's panel renders. */
export function useHeaderSplitJoinPane(
  item: Extract<HeaderStripItem, { readonly kind: "split" }>,
): SheetJoinPane {
  return useLandingPaneAnchorStore((state) =>
    headerSplitJoinPane(item, state.panelCoverage),
  );
}
