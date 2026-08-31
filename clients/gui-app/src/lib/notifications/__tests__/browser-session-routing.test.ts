import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isNotificationPayloadRoutable,
  parseNotificationPayload,
  routeNotificationForHost,
} from "@/lib/notifications/payload";
import { notificationPayloadRequiresOriginHost } from "@/hooks/notifications/use-notification-activation";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import type { TilePane } from "@/stores/epics/canvas/tile-tree";

const PARKED_PAYLOAD = {
  kind: "browser_human_needed",
  epicId: "epic-1",
  chatId: "chat-1",
  sessionId: "session-9",
  tabId: "browser-tab-3",
  reason: "sign in to example.com",
};

function seedCanvasWithTile(tile: EpicCanvasTileRef, hostId: string): void {
  const pane: TilePane = {
    kind: "pane",
    id: "pane-1",
    tabInstanceIds: [tile.instanceId],
    activeTabId: tile.instanceId,
    previewTabId: null,
    activationHistory: [tile.instanceId],
  };
  const canvas: EpicCanvasState = {
    activePaneId: "pane-1",
    root: pane,
    tilesByInstanceId: { [tile.instanceId]: tile },
    sizesByGroupId: {},
  };
  useEpicCanvasStore.setState({
    tabsById: {
      "view-tab-1": { tabId: "view-tab-1", epicId: "epic-1", name: "Epic 1" },
    },
    canvasByTabId: { "view-tab-1": canvas },
    openTabOrder: ["view-tab-1"],
  });
  // The tile's own host, restated at the seed: the two cases below differ only
  // in which host the seeded tile is on, and a helper that never asserted it
  // would let a builder change silently make both cases the same case.
  expect(tile.hostId).toBe(hostId);
}

/**
 * Ticket 11: a parked browser session's notification deep-links to the tile
 * showing that session, on the host the session lives on. It is the terminal
 * row's shape - an exact tile addressed by id - not a chat row's.
 */
describe("parked browser session notification routing", () => {
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

  it("parses the persisted payload into a tile-addressed route", () => {
    expect(parseNotificationPayload(PARKED_PAYLOAD)).toEqual({
      kind: "browserSession",
      epicId: "epic-1",
      sessionId: "session-9",
      tabId: "browser-tab-3",
    });
    // A row that cannot name its tile is not a deep link.
    expect(
      parseNotificationPayload({ ...PARKED_PAYLOAD, tabId: "" }),
    ).toBeNull();
    expect(
      isNotificationPayloadRoutable({
        kind: "browserSession",
        epicId: "epic-1",
        sessionId: "session-9",
        tabId: "browser-tab-3",
      }),
    ).toBe(true);
  });

  it("focuses the open tile on the session's own host", () => {
    const tile = makeBrowserSessionTileRef({
      hostId: "host-a",
      sessionId: "session-9",
      tabId: "browser-tab-3",
    });
    seedCanvasWithTile(tile, "host-a");
    const navigate = vi.fn();

    const routed = routeNotificationForHost(
      navigate,
      {
        kind: "browserSession",
        epicId: "epic-1",
        sessionId: "session-9",
        tabId: "browser-tab-3",
      },
      1_000,
      { originHostId: "host-a", effectiveHostId: "host-a" },
    );

    expect(routed).toBe(true);
    // The EXACT view tab holding the tile, with the tile's own pane/instance
    // as the nested focus - not a same-epic sibling resolved by MRU.
    const intent: unknown = navigate.mock.calls[0]?.[0];
    expect(intent).toMatchObject({
      params: { epicId: "epic-1", tabId: "view-tab-1" },
      search: {
        focusArtifactId: tile.id,
        focusPaneId: "pane-1",
        focusTileInstanceId: tile.instanceId,
      },
    });
  });

  it("refuses to credit a same-id tile bound to a different host", () => {
    const tile = makeBrowserSessionTileRef({
      hostId: "host-b",
      sessionId: "session-9",
      tabId: "browser-tab-3",
    });
    seedCanvasWithTile(tile, "host-b");
    const navigate = vi.fn();

    // The session lives on host-a for life; a host-b tile with a colliding id
    // must not consume the activation. Navigation still happens (opening the
    // epic is useful), but it is reported as NOT origin-bound.
    const routed = routeNotificationForHost(
      navigate,
      {
        kind: "browserSession",
        epicId: "epic-1",
        sessionId: "session-9",
        tabId: "browser-tab-3",
      },
      1_000,
      { originHostId: "host-a", effectiveHostId: "host-a" },
    );

    expect(routed).toBe(false);
    expect(navigate).toHaveBeenCalled();
  });

  it("requires its origin host, like a prompt", () => {
    expect(
      notificationPayloadRequiresOriginHost({
        kind: "browserSession",
        epicId: "epic-1",
        sessionId: "session-9",
        tabId: "browser-tab-3",
      }),
    ).toBe(true);
  });
});
