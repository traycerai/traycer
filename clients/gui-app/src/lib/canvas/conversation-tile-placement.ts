import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/**
 * Where a freshly-created conversation (chat or terminal agent) tile should
 * land on the canvas. Carried from the creation trigger (sidebar `+`, in-pane
 * PaneOpener, ⌘K palette) through the New Conversation modal to the open seam,
 * so every entry point reuses the same modal but keeps its own placement.
 *
 *  - `active-tile`   - open/focus in the active group (dedup-aware). Sidebar
 *                      `+`, ⌘K "New chat in active tile" / "New terminal agent".
 *  - `split`         - split `groupId` and drop a fresh instance on the given
 *                      edge. ⌘K "New chat in split (right|bottom)". Chat only.
 *  - `target-group`  - fresh instance into an explicit pane (no dedup). In-pane
 *                      PaneOpener "Create new chat" / "Create new TUI agent".
 */
export type ConversationTilePlacement =
  | { readonly kind: "active-tile" }
  | {
      readonly kind: "split";
      readonly groupId: string;
      readonly position: "right" | "bottom";
    }
  | { readonly kind: "target-group"; readonly groupId: string };

export const ACTIVE_TILE_PLACEMENT: ConversationTilePlacement = {
  kind: "active-tile",
};

/**
 * The subset of canvas-store actions needed to open a tile at a placement.
 * Passing them in (rather than reaching for the store) keeps the open seam
 * pure and unit-testable from both the chat handoff driver and the command
 * actions.
 */
export interface ConversationTileOpeners {
  readonly openTileInTab: (tabId: string, node: EpicCanvasTileRef) => void;
  readonly openTileInPane: (
    tabId: string,
    paneId: string,
    node: EpicCanvasTileRef,
  ) => void;
  readonly splitPaneWithNode: (
    tabId: string,
    targetPaneId: string,
    position: "right" | "bottom",
    node: EpicCanvasTileRef,
  ) => void;
}

export function openChatNodeWithPlacement(
  openers: ConversationTileOpeners,
  tabId: string,
  node: EpicCanvasTileRef,
  placement: ConversationTilePlacement,
): void {
  if (placement.kind === "target-group") {
    openers.openTileInPane(tabId, placement.groupId, node);
    return;
  }
  if (placement.kind === "split") {
    openers.splitPaneWithNode(
      tabId,
      placement.groupId,
      placement.position,
      node,
    );
    return;
  }
  openers.openTileInTab(tabId, node);
}
