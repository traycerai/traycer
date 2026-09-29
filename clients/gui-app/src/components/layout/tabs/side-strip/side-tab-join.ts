import { use } from "react";
import { usePublishSheetJoin } from "../sheet-join-context";
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import type { HeaderTab } from "@/stores/tabs/types";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import { useArrangementValue } from "@/lib/layout-overrides";
import { useMainPanelCollapsed } from "@/stores/epics/left-panel-store";
import type { SideRowFrame } from "./side-tab-row";
import { useWhollyInTabStrip } from "../use-wholly-in-tab-strip";

/**
 * Which pane of the task sheet the strip meets, so the join takes that pane's
 * fill: the epic sidebar panel when it sits on the strip's side, its collapsed
 * rail, or the canvas (every other surface, and the panel on the far side).
 */
export type SheetJoinPane = "panel" | "rail" | "canvas";

export interface SheetJoin {
  readonly edge: EdgeSide;
  readonly pane: SheetJoinPane;
}

/**
 * How an active row, tile or split pair joins its task's sheet, or `null`.
 * `tab` is the tab whose surface borders the strip (a pair's member on the
 * strip's side). CSS anchors follow the row's visual drag displacement.
 * Off while `node` (the row, tile or pair) is not wholly inside the row list:
 * the list clips a row scrolled partly out, and the bridge outside the list
 * cannot be clipped with it, so a half-hidden row is drawn as a plain active
 * row.
 */
export function useSideTabJoin(
  active: boolean,
  node: HTMLElement | null,
  tab: HeaderTab | null,
): SheetJoin | null {
  const edge = use(ColumnEdgeContext);
  const sidebarSide = useArrangementValue("sidebarSide");
  const collapsed = useMainPanelCollapsed(tab?.id ?? "");
  // The layout editor's session tab is its own solid amber object, never
  // joined: the join's fill would paint over it (audit F2), and the top strip
  // leaves it unjoined for the same reason (`TabChromeBackground`).
  const joins = edge !== null && active && tab?.kind !== "sample-workspace";
  const inList = useWhollyInTabStrip(node, joins);
  let pane: SheetJoinPane | null = null;
  if (joins && inList) {
    pane = "canvas";
    if (tab?.kind === "epic" && sidebarSide === edge) {
      pane = collapsed ? "rail" : "panel";
    }
  }
  usePublishSheetJoin(pane);
  return edge === null || pane === null ? null : { edge, pane };
}

/** The marker the sheet join in `index.css` keys on. */
export function joinedAttribute(joined: SheetJoin | null): SideRowFrame {
  return joined === null
    ? {}
    : { "data-sheet-joined": joined.edge, "data-join-pane": joined.pane };
}
