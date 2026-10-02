import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import {
  landingPanelLayoutFor,
  useLandingPanelStore,
  type LandingPanelLayout,
  type LandingPanelStoreState,
} from "@/stores/home/landing-panel-store";
import { flattenStripItemRefs, type StripItem } from "@/stores/tabs/layout";
import type { TabRef } from "@/stores/tabs/types";
import type { HeaderStripItem } from "@/stores/tabs/use-header-tabs";
import type { SheetJoinPane } from "./side-strip/side-tab-join";

/** The edge of its surface a tab joins: the top strip's, or a side strip's. */
export type JoinEdge = "top" | EdgeSide;

/** What the rule reads of the start page's panel: where each draft's sits. */
export type LandingPanelLayouts = Pick<
  LandingPanelStoreState,
  "layoutsByLandingPageId" | "fallbackLayout"
>;

/**
 * The pane a surface shows along `edge`, which is the fill a tab joining it
 * there takes: what the surface PAINTS at that edge, read per kind.
 *
 * - A task's top row (its status row and the head of its panel) is
 *   `--background`. Beside a side strip it shows its canvas, unless its panel
 *   is on that side: `useSideTabJoin` names the panel or its rail then.
 * - A draft paints `--background`, under its terminal panel where that is
 *   open (`draftJoinPane`).
 * - Settings paints `--background`, with its rail (the sidebar's fill) down
 *   its left edge.
 * - Home and History paint nothing of their own and show their sheet's canvas.
 * - The session tab never joins; its arm keeps the switch total, so a new
 *   kind has to say what its surface paints.
 */
export function surfaceJoinPane(
  tab: TabRef,
  edge: JoinEdge,
  landing: LandingPanelLayouts,
): SheetJoinPane {
  switch (tab.kind) {
    case "epic":
      return edge === "top" ? "surface" : "canvas";
    case "draft":
      return draftJoinPane(landingPanelLayoutFor(landing, tab.id), edge);
    case "settings":
      return edge === "left" ? "panel" : "surface";
    case "home":
    case "history":
    case "sample-workspace":
      return "canvas";
  }
}

/**
 * The start page's terminal panel is canvas and docks on the right: open, it
 * is what a right-hand strip meets, and maximized it covers the whole page.
 * Docked, it is under only the top tabs that sit over it, which still join in
 * the page's own ground.
 */
function draftJoinPane(
  layout: LandingPanelLayout,
  edge: JoinEdge,
): SheetJoinPane {
  if (!layout.panelOpen) return "surface";
  return layout.maximized || edge === "right" ? "canvas" : "surface";
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
  landing: LandingPanelLayouts,
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
  landing: LandingPanelLayouts,
): SheetJoinPane {
  return splitPairJoinPane(
    [item.left, item.right].flatMap((member) =>
      member.kind === "tab" ? [member.tab] : [],
    ),
    landing,
  );
}

/** The pane a top strip item joins. An item that is gone was a task's. */
export function stripItemJoinPane(
  item: StripItem | undefined,
  landing: LandingPanelLayouts,
): SheetJoinPane {
  if (item === undefined) return "surface";
  return item.kind === "split"
    ? splitPairJoinPane(flattenStripItemRefs(item), landing)
    : surfaceJoinPane(item.ref, "top", landing);
}

/** `surfaceJoinPane`, following the start page's panel; `null` for no tab. */
export function useSurfaceJoinPane(
  tab: TabRef | null,
  edge: JoinEdge,
): SheetJoinPane | null {
  return useLandingPanelStore((state) =>
    tab === null ? null : surfaceJoinPane(tab, edge, state),
  );
}

/** `headerSplitJoinPane`, following the start page's panel. */
export function useHeaderSplitJoinPane(
  item: Extract<HeaderStripItem, { readonly kind: "split" }>,
): SheetJoinPane {
  return useLandingPanelStore((state) => headerSplitJoinPane(item, state));
}
