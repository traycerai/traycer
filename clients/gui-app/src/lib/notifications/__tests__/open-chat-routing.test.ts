import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
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
import {
  __getOpenEpicRegistryForTests,
  getOpenEpicRegistry,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

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

function requirePane(tabId: string): TilePane {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) throw new Error("expected a canvas for tabId");
  if (canvas.root === null || canvas.root.kind !== "pane") {
    throw new Error("expected a single unsplit pane for this fixture");
  }
  return canvas.root;
}

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
    closedTilePayloadsByTabId: {},
    pendingCreateArtifactIds: new Set<string>(),
  });
});

describe("open-chat notification routing, same-id tile in the same canvas", () => {
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

/**
 * A closed same-id tile B on another host, in a canvas whose active tile A
 * shares the id, must actually be reopened and focused when a notification
 * targets it - not just navigated past while A stays on screen.
 */
describe("open-chat notification routing, an active tile A + a CLOSED same-id tile B in the same canvas", () => {
  it.each(["chat", "terminal-agent"] as const)(
    "reopens and focuses the closed %s tile B, leaving tile A intact",
    (tileType) => {
      const store = useEpicCanvasStore.getState();
      const tabId = store.openEpicTab("epic-1", "Epic 1");
      const openTile = makeOpenableNodeRef({
        id: "chat-1",
        instanceId: "inst-open-a",
        type: tileType,
        name: "A (open host)",
        hostId: "host-open",
      });
      const closedTile = makeOpenableNodeRef({
        id: "chat-1",
        instanceId: "inst-closed-b",
        type: tileType,
        name: "B (closed host)",
        hostId: "host-closed",
      });
      store.openTileInTab(tabId, openTile);
      store.openTileInTab(tabId, closedTile);
      const paneId = requirePane(tabId).id;
      store.closeCanvasTab(tabId, paneId, closedTile.instanceId);
      // Pin the precondition explicitly, regardless of what close defaults
      // the active tab to.
      store.setActiveTileTab(tabId, paneId, openTile.instanceId);

      const before = useEpicCanvasStore.getState();
      expect(
        before.canvasByTabId[tabId]?.tilesByInstanceId[closedTile.instanceId],
      ).toBeUndefined();
      expect(
        before.closedTilePayloadsByTabId[tabId]?.[closedTile.instanceId]?.node,
      ).toEqual(closedTile);
      expect(requirePane(tabId).activeTabId).toBe(openTile.instanceId);

      const navigate = vi.fn();
      const routed = routeNotificationForHost(
        navigate,
        { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
        1_000,
        { originHostId: "host-closed", effectiveHostId: "host-open" },
      );

      expect(routed).toBe(true);

      const after = useEpicCanvasStore.getState();
      const canvas = after.canvasByTabId[tabId];
      if (canvas === undefined) throw new Error("expected canvas after route");
      const reopenedB = Object.values(canvas.tilesByInstanceId).find(
        (tile) =>
          tile !== undefined &&
          tile.id === closedTile.id &&
          tile.hostId === closedTile.hostId,
      );
      if (reopenedB === undefined) {
        throw new Error("expected the closed tile to have been reopened");
      }
      // The reopen must consume the closed-payload entry, not leave a
      // now-live tile still occupying the tab's FIFO budget.
      expect(
        after.closedTilePayloadsByTabId[tabId]?.[closedTile.instanceId],
      ).toBeUndefined();
      expect(canvas.tilesByInstanceId[openTile.instanceId]).toEqual(openTile);
      // Re-read the pane fresh rather than reusing the pre-route `paneId`:
      // the reopen may not keep the same pane object/id.
      const finalPaneId = requirePane(tabId).id;
      expect(requirePane(tabId).activeTabId).toBe(reopenedB.instanceId);

      const intent: unknown = navigate.mock.calls.at(-1)?.[0];
      expect(intent).toMatchObject({
        params: { epicId: "epic-1", tabId },
        search: {
          focusArtifactId: "chat-1",
          focusPaneId: finalPaneId,
          focusTileInstanceId: reopenedB.instanceId,
        },
      });
    },
  );

  it("reopens a closed pending-create agent at its original instance and revives pending-create liveness", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic 1");
    const agent = makeOpenableNodeRef({
      id: "agent-1",
      instanceId: "inst-agent-1",
      type: "terminal-agent",
      name: "Pending agent",
      hostId: "host-closed",
    });
    store.markArtifactPendingCreate(agent.id);
    store.openTileInTab(tabId, agent);
    const paneId = requirePane(tabId).id;
    store.closeCanvasTab(tabId, paneId, agent.instanceId);

    // Real close already clears the LIVE pending set while preserving
    // `pendingCreate: true` on the cached closed payload (pinned elsewhere;
    // not re-asserted here).
    expect(
      useEpicCanvasStore.getState().pendingCreateArtifactIds.has(agent.id),
    ).toBe(false);

    const navigate = vi.fn();
    const routed = routeNotificationForHost(
      navigate,
      { kind: "chat", epicId: "epic-1", chatId: "agent-1" },
      1_000,
      { originHostId: "host-closed", effectiveHostId: "host-closed" },
    );

    expect(routed).toBe(true);
    const after = useEpicCanvasStore.getState();
    // Reuses the ORIGINAL instance, not a freshly minted one.
    expect(
      after.canvasByTabId[tabId]?.tilesByInstanceId[agent.instanceId],
    ).toEqual(agent);
    expect(
      after.closedTilePayloadsByTabId[tabId]?.[agent.instanceId],
    ).toBeUndefined();
    expect(after.pendingCreateArtifactIds.has(agent.id)).toBe(true);
  });

  it("closes the still-live tile and the old payload on confirmed delete, preserving a peer-host tile", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic 1");
    const peerHostTile = makeOpenableNodeRef({
      id: "chat-1",
      instanceId: "inst-open-a",
      type: "chat",
      name: "A (peer host)",
      hostId: "host-open",
    });
    const closedOld = makeOpenableNodeRef({
      id: "chat-1",
      instanceId: "inst-closed-b-old",
      type: "chat",
      name: "B (closed, older)",
      hostId: "host-closed",
    });
    // Left OPEN, not manually closed - proves the helper's own close (not a
    // pre-existing stale entry) is what the sweep must catch too.
    const liveB = makeOpenableNodeRef({
      id: "chat-1",
      instanceId: "inst-live-b",
      type: "chat",
      name: "B (still open)",
      hostId: "host-closed",
    });
    store.openTileInTab(tabId, peerHostTile);
    store.openTileInTab(tabId, closedOld);
    store.closeCanvasTab(tabId, requirePane(tabId).id, closedOld.instanceId);
    store.openTileInTab(tabId, liveB);

    const before = useEpicCanvasStore.getState();
    expect(
      before.closedTilePayloadsByTabId[tabId]?.[closedOld.instanceId]?.node,
    ).toEqual(closedOld);
    expect(
      before.canvasByTabId[tabId]?.tilesByInstanceId[liveB.instanceId],
    ).toEqual(liveB);

    store.closeConfirmedDeletedAgentTiles(
      "epic-1",
      "chat-1",
      "host-closed",
      "chat",
    );

    const after = useEpicCanvasStore.getState();
    expect(
      after.canvasByTabId[tabId]?.tilesByInstanceId[liveB.instanceId],
    ).toBeUndefined();
    expect(
      after.closedTilePayloadsByTabId[tabId]?.[closedOld.instanceId],
    ).toBeUndefined();
    expect(
      after.closedTilePayloadsByTabId[tabId]?.[liveB.instanceId],
    ).toBeUndefined();
    // A same-id row on another host is a different identity and is untouched.
    expect(
      after.canvasByTabId[tabId]?.tilesByInstanceId[peerHostTile.instanceId],
    ).toEqual(peerHostTile);

    const navigate = vi.fn();
    const routed = routeNotificationForHost(
      navigate,
      { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
      1_000,
      { originHostId: "host-closed", effectiveHostId: "host-open" },
    );
    expect(routed).toBe(false);
  });
});

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeDeadSessionMeta(epicId: string): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: epicId,
      title: "Epic test",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

/**
 * A live, loaded Epic session with an EMPTY tree - the projection a remote
 * deletion leaves behind once it has synced. No `tuiAgents`/`chats` entry is
 * ever seeded for the closed row this suite proves dead.
 */
function newDeadEpicSession(epicId: string, hostId: string): void {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId,
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  captured.value.onSnapshot(
    makeDeadSessionMeta(epicId),
    Y.encodeStateAsUpdate(new Y.Doc()),
  );
  getOpenEpicRegistry().acquireMounted(epicId, () => handle);
  const sessionHandle = getOpenEpicRegistry().peek(epicId);
  if (sessionHandle === null) throw new Error("expected a mounted session");
  // The check this suite exercises judges same-host-ness against the
  // SESSION's own stamped host, not the app-wide effective one.
  handleHostIds.set(sessionHandle, hostId);
}

describe("open-chat notification routing, a closed tile whose record is proven dead", () => {
  afterEach(() => {
    __getOpenEpicRegistryForTests().disposeAll();
  });

  it("does not reopen a proven-dead closed agent tile, and discards the stale payload", () => {
    const store = useEpicCanvasStore.getState();
    const tabId = store.openEpicTab("epic-1", "Epic 1");
    const closedAgent = makeOpenableNodeRef({
      id: "agent-1",
      instanceId: "inst-agent-1",
      type: "terminal-agent",
      name: "Deleted agent",
      hostId: "host-open",
    });
    store.openTileInTab(tabId, closedAgent);
    store.closeCanvasTab(tabId, requirePane(tabId).id, closedAgent.instanceId);
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[tabId]?.[
        closedAgent.instanceId
      ],
    ).toBeDefined();

    // A remote deletion has since synced: the session's own loaded tree no
    // longer carries this agent at all.
    newDeadEpicSession("epic-1", "host-open");

    const navigate = vi.fn();
    const routed = routeNotificationForHost(
      navigate,
      { kind: "chat", epicId: "epic-1", chatId: "agent-1" },
      1_000,
      { originHostId: "host-open", effectiveHostId: "host-open" },
    );

    expect(routed).toBe(false);
    const after = useEpicCanvasStore.getState();
    expect(
      after.canvasByTabId[tabId]?.tilesByInstanceId[closedAgent.instanceId],
    ).toBeUndefined();
    expect(
      after.closedTilePayloadsByTabId[tabId]?.[closedAgent.instanceId],
    ).toBeUndefined();
  });
});
