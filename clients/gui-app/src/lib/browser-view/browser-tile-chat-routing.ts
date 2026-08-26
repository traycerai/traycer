import {
  collectPanes,
  type TileLayoutNode,
  type TilePane,
} from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";

export function selectSiblingChatIdForBrowserTile(
  canvas: EpicCanvasState | null,
  browserInstanceId: string,
): string | null {
  if (canvas === null || canvas.root === null) return null;
  const panes = panesSharingGroupWithTile(canvas.root, browserInstanceId);
  const chatIds = panes.flatMap((pane) => activeChatIdInPane(canvas, pane));
  return chatIds[0] ?? null;
}

function panesSharingGroupWithTile(
  node: TileLayoutNode,
  tileInstanceId: string,
): readonly TilePane[] {
  if (node.kind === "pane") return [];
  const childWithTile = node.children.find((child) =>
    layoutContainsTile(child, tileInstanceId),
  );
  if (childWithTile === undefined) {
    return node.children.flatMap((child) =>
      panesSharingGroupWithTile(child, tileInstanceId),
    );
  }
  return node.children
    .flatMap((child) => collectPanes(child))
    .filter((pane) => !pane.tabInstanceIds.includes(tileInstanceId));
}

function layoutContainsTile(
  node: TileLayoutNode,
  tileInstanceId: string,
): boolean {
  if (node.kind === "pane") return node.tabInstanceIds.includes(tileInstanceId);
  return node.children.some((child) =>
    layoutContainsTile(child, tileInstanceId),
  );
}

function activeChatIdInPane(
  canvas: EpicCanvasState,
  pane: TilePane,
): readonly string[] {
  if (pane.activeTabId === null) return [];
  const tile = canvas.tilesByInstanceId[pane.activeTabId];
  if (tile === undefined || tile.type !== "chat") return [];
  return [tile.id];
}
