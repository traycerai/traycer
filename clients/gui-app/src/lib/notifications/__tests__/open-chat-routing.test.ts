import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeNotificationForHost } from "@/lib/notifications/payload";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeOpenableNodeRef } from "@/stores/epics/canvas/types";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import type { TilePane } from "@/stores/epics/canvas/tile-tree";

/**
 * Ticket: a cloned agent can leave TWO tiles with the SAME chat id open in
 * the SAME canvas (tab) - one per host. `routeOpenChatNotification` (the
 * chat-kind arm of `routeNotificationForHost`) must find the tile bound to
 * the notification's TARGET host even when a same-id, wrong-host tile is
 * discovered first in the pane's tab order.
 *
 * Before the fix this used `findOpenArtifactInTab`, an ID-ONLY lookup: it
 * returns the FIRST same-id tile regardless of host, and the caller then
 * rejected the whole tab the moment that first match's host disagreed -
 * never trying the second, correctly-hosted tile in the same canvas. The fix
 * is `findOpenTileInTab`, which matches id AND host together.
 */
function seedCanvasWithTiles(tiles: readonly EpicCanvasTileRef[]): void {
  const pane: TilePane = {
    kind: "pane",
    id: "pane-1",
    tabInstanceIds: tiles.map((tile) => tile.instanceId),
    activeTabId: tiles[0].instanceId,
    previewTabId: null,
    activationHistory: tiles.map((tile) => tile.instanceId),
  };
  const canvas: EpicCanvasState = {
    activePaneId: "pane-1",
    root: pane,
    tilesByInstanceId: Object.fromEntries(
      tiles.map((tile) => [tile.instanceId, tile] as const),
    ),
    sizesByGroupId: {},
  };
  useEpicCanvasStore.setState({
    tabsById: {
      "view-tab-1": { tabId: "view-tab-1", epicId: "epic-1", name: "Epic 1" },
    },
    canvasByTabId: { "view-tab-1": canvas },
    openTabOrder: ["view-tab-1"],
  });
}

describe("open-chat notification routing, same-id tile in the same canvas", () => {
  beforeEach(async () => {
    __resetTabNavigationControllerForTesting();
    __resetTabSyncCoordinatorForTesting();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
    useEpicCanvasStore.setState({
      tabsById: {},
      canvasByTabId: {},
      openTabOrder: [],
    });
  });

  it("finds the SECOND same-id tile bound to the target host, when a wrong-host tile with the same id is discovered first", () => {
    // The wrong-host tile sits FIRST in the pane's tab order, so an id-only
    // lookup returns it before ever reaching the correctly-hosted one.
    const wrongHostTile = makeOpenableNodeRef({
      id: "chat-1",
      instanceId: "inst-wrong-host",
      type: "chat",
      name: "Chat (host-b copy)",
      hostId: "host-b",
    });
    const rightHostTile = makeOpenableNodeRef({
      id: "chat-1",
      instanceId: "inst-right-host",
      type: "chat",
      name: "Chat (host-a copy)",
      hostId: "host-a",
    });
    seedCanvasWithTiles([wrongHostTile, rightHostTile]);
    const navigate = vi.fn();

    const routed = routeNotificationForHost(
      navigate,
      { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      1_000,
      { originHostId: "host-a", effectiveHostId: "host-a" },
    );

    // A same-canvas match on the target host exists - this must be reported
    // as a real tile-bound route, not fall through to the hostless intent.
    expect(routed).toBe(true);
    const intent: unknown = navigate.mock.calls[0]?.[0];
    expect(intent).toMatchObject({
      params: { epicId: "epic-1", tabId: "view-tab-1" },
      search: {
        focusArtifactId: "chat-1",
        focusPaneId: "pane-1",
        focusTileInstanceId: rightHostTile.instanceId,
      },
    });
  });

  it("still refuses when only a wrong-host tile exists in the canvas (no host-a tile to fall back to)", () => {
    const wrongHostTile = makeOpenableNodeRef({
      id: "chat-1",
      instanceId: "inst-wrong-host",
      type: "chat",
      name: "Chat (host-b copy)",
      hostId: "host-b",
    });
    seedCanvasWithTiles([wrongHostTile]);
    const navigate = vi.fn();

    const routed = routeNotificationForHost(
      navigate,
      { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      1_000,
      { originHostId: "host-a", effectiveHostId: "host-a" },
    );

    // No host-a tile anywhere in the canvas: the route falls through to the
    // hostless epic intent, and is reported as not origin-bound.
    expect(routed).toBe(false);
    expect(navigate).toHaveBeenCalled();
  });
});
