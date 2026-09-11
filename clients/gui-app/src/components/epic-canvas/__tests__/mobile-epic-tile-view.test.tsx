import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileEpicTileView } from "@/components/epic-canvas/mobile/mobile-epic-tile-view";
import {
  SURFACE_SYNC_RANK,
  useSurfaceSyncStore,
  type SurfaceSyncEntry,
} from "@/stores/sync/surface-sync-store";
import { selectMobileTile } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  TileGroup,
  TileLayoutNode,
  TilePane,
} from "@/stores/epics/canvas/types";

const VIEW_TAB_ID = "view-tab-1";

// The Epic session's two legs, per test. The stream-syncing strip is a pure
// function of them, so they are the only thing its cases vary.
const epicSession = vi.hoisted(() => {
  const value: {
    transportStatus: StreamConnectionStatus;
    snapshotLoaded: boolean;
  } = { transportStatus: "open", snapshotLoaded: true };
  return { value };
});

// ActiveTabBody reads permission/snapshot/artifact state through epic-selectors;
// stub them so the shared tile body mounts without a HostRuntimeProvider /
// EpicSessionProvider (mirrors tab-group-view.test).
vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: (id: string) => ({ id }),
  useEpicChatRecordListAuthoritative: () => true,
  useEpicChatRetraction: () => null,
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
  useEpicPermissionRole: () => "owner",
  useEpicSnapshotLoaded: () => epicSession.value.snapshotLoaded,
  useEpicHostTransportStatus: () => epicSession.value.transportStatus,
  useMaybeEpicTuiAgentHarnessId: () => null,
}));

// The real tile bodies pull the full chat/host machinery; the single-tile view
// only needs to prove WHICH tile renders, so stub the render seam to a marker.
vi.mock("@/components/epic-canvas/renderers/epic-node-tile", () => ({
  EpicNodeTile: ({ node }: { readonly node: EpicCanvasTileRef }) => (
    <div data-testid={`tile-${node.id}`} />
  ),
}));

// The empty-pane opener pulls the command-palette router/provider stack; stub
// it to a marker so the empty-canvas branch is observable in isolation.
vi.mock("@/components/epic-canvas/canvas/pane-opener", () => ({
  PaneOpener: () => <div data-testid="pane-opener" />,
}));

// The current-tile bar is covered by its own test; stub it here to a marker
// carrying the tile it was handed, so the view test can assert WHICH tile the
// bar reflects without pulling the bar's host/title hooks.
vi.mock("@/components/epic-canvas/mobile/mobile-current-tile-bar", () => ({
  MobileCurrentTileBar: ({ tile }: { readonly tile: EpicCanvasTileRef }) => (
    <div data-testid="current-tile-bar" data-tile-id={tile.id} />
  ),
}));

// The bottom-sheet is a leaf of the view but out of this test's scope; it pulls
// the resolved-theme context (and much more), so stub it to nothing.
vi.mock("@/components/epic-canvas/mobile/tab-switcher-sheet", () => ({
  TabSwitcherSheet: () => null,
}));

// ActiveTabBody's published-copy fallback (`usePublishedChatFallbackRef`)
// reads reachability, the active host, the host client, cloud chats, and the
// chat session registry through these hook seams, unconditionally on every
// render regardless of tab type - stubbed the same way `tab-group-view.test`
// stubs them so this provider-less suite never reaches `useQueryClient`. None
// of this file's fixtures are chat tabs, so every seam here answers the
// "nothing special" default.
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable", hostLabel: "host-A" }),
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => null,
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));

// A bound Epic session, so the published wake has something real to reach.
const epicHandleMock = vi.hoisted(() => ({
  hostId: "host-A",
  wakeTransport: vi.fn(),
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => epicHandleMock,
  useOpenEpicHandle: () => epicHandleMock,
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatList: () => ({
    data: undefined,
    isError: false,
    isPending: false,
    isFetching: false,
  }),
  useCloudChatHasCloudAuthorization: () => true,
  cloudChatListAuthorizesRecordSweep: () => false,
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionHandle: () => null,
  useExistingChatSessionFatalClose: () => null,
}));

function spec(n: number): EpicCanvasTileRef {
  return {
    id: `spec-${n}`,
    instanceId: `inst-${n}`,
    type: "spec",
    name: `Spec ${n}`,
    hostId: "host-A",
  };
}

function makePane(
  id: string,
  tiles: ReadonlyArray<EpicCanvasTileRef>,
  activeTabId: string | null,
): TilePane {
  return {
    kind: "pane",
    id,
    tabInstanceIds: tiles.map((tile) => tile.instanceId),
    activeTabId,
    previewTabId: null,
    activationHistory: activeTabId === null ? [] : [activeTabId],
  };
}

// A persisted TWO-pane split: pane-A (spec-1 active, spec-2) beside pane-B
// (spec-3 active). Mobile must pick exactly one without touching the tree.
function twoPaneCanvas(activePaneId: string | null): EpicCanvasState {
  const root: TileGroup = {
    kind: "group",
    id: "root-group",
    direction: "horizontal",
    children: [
      makePane("pane-A", [spec(1), spec(2)], "inst-1"),
      makePane("pane-B", [spec(3)], "inst-3"),
    ],
  };
  return {
    root,
    activePaneId,
    tilesByInstanceId: {
      "inst-1": spec(1),
      "inst-2": spec(2),
      "inst-3": spec(3),
    },
    sizesByGroupId: { "root-group": [0.5, 0.5] },
  };
}

function seed(canvas: EpicCanvasState): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: { tabId: VIEW_TAB_ID, epicId: "epic-1", name: "Epic 1" },
    },
    canvasByTabId: { [VIEW_TAB_ID]: canvas },
  });
}

function renderView() {
  return render(<MobileEpicTileView epicId="epic-1" tabId={VIEW_TAB_ID} />);
}

function renderedTileCount(): number {
  return document.querySelectorAll('[data-testid^="tile-"]').length;
}

function paneIds(root: TileLayoutNode | null): ReadonlyArray<string> {
  return collectPanes(root).map((pane) => pane.id);
}

describe("selectMobileTile", () => {
  it("returns null for an empty (rootless) canvas", () => {
    expect(
      selectMobileTile({
        root: null,
        activePaneId: null,
        tilesByInstanceId: {},
        sizesByGroupId: {},
      }),
    ).toBeNull();
  });

  it("picks the active pane's active tab", () => {
    const selection = selectMobileTile(twoPaneCanvas("pane-B"));
    expect(selection?.paneId).toBe("pane-B");
    expect(selection?.ref.id).toBe("spec-3");
  });

  it("falls back to the first pane when there is no active pane", () => {
    const selection = selectMobileTile(twoPaneCanvas(null));
    expect(selection?.paneId).toBe("pane-A");
    expect(selection?.ref.id).toBe("spec-1");
  });

  it("falls back to the first tab instance when the pane has no active tab", () => {
    const selection = selectMobileTile({
      root: makePane("pane-A", [spec(1), spec(2)], null),
      activePaneId: "pane-A",
      tilesByInstanceId: { "inst-1": spec(1), "inst-2": spec(2) },
      sizesByGroupId: {},
    });
    expect(selection?.ref.id).toBe("spec-1");
  });

  it("skips an emptied active pane and picks the next pane holding a tile", () => {
    const root: TileGroup = {
      kind: "group",
      id: "g",
      direction: "horizontal",
      children: [
        makePane("pane-A", [], null),
        makePane("pane-B", [spec(3)], "inst-3"),
      ],
    };
    const selection = selectMobileTile({
      root,
      activePaneId: "pane-A",
      tilesByInstanceId: { "inst-3": spec(3) },
      sizesByGroupId: {},
    });
    expect(selection?.paneId).toBe("pane-B");
    expect(selection?.ref.id).toBe("spec-3");
  });
});

describe("<MobileEpicTileView />", () => {
  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    epicSession.value = { transportStatus: "open", snapshotLoaded: true };
    useSurfaceSyncStore.setState({ entries: {} });
    epicHandleMock.wakeTransport.mockClear();
  });

  describe("stream-syncing report", () => {
    // Entries are keyed by PUBLISHER token, not by surface, so a lookup finds
    // the one whose `key` names this surface.
    function published(): SurfaceSyncEntry | undefined {
      return Object.values(useSurfaceSyncStore.getState().entries).find(
        (entry) => entry.key === "epic:host-A:epic-1",
      );
    }

    it("reports nothing running while the Epic's own stream is open", () => {
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(published()?.spell.syncing).toBe(false);
    });

    it("reports a running spell while its stream comes back under a painted canvas", () => {
      epicSession.value = {
        transportStatus: "reconnecting",
        snapshotLoaded: true,
      };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(published()?.spell.syncing).toBe(true);
      expect(published()?.rank).toBe(SURFACE_SYNC_RANK.epic);
      expect(published()?.label).toBe("Task");
      // The tile it describes is still on screen underneath, not replaced by a
      // skeleton - that is the whole state the report exists to narrate.
      expect(screen.queryByTestId("tile-spec-1")).not.toBeNull();
    });

    it("carries the Epic session's OWN wake, so Retry reaches this Epic's socket", () => {
      // A null handle publishes a null wake, which renders no Retry at all -
      // so the wired path needs a bound session to be worth anything.
      epicSession.value = {
        transportStatus: "reconnecting",
        snapshotLoaded: true,
      };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(published()?.wake).not.toBeNull();
      published()?.wake?.();
      expect(epicHandleMock.wakeTransport).toHaveBeenCalledTimes(1);
      // The key is host-scoped: an epic id is host-minted, so the bare id
      // names a different Epic on another machine.
      expect(published()?.key).toBe("epic:host-A:epic-1");
    });

    it("renders no bar of its own", () => {
      epicSession.value = {
        transportStatus: "reconnecting",
        snapshotLoaded: true,
      };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(screen.queryByTestId("epic-stream-syncing-bar")).toBeNull();
    });

    it("reports nothing on a cold open, where the skeleton already says loading", () => {
      epicSession.value = {
        transportStatus: "connecting",
        snapshotLoaded: false,
      };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(published()?.spell.syncing).toBe(false);
    });

    it("reports nothing on a closed stream rather than animating forever", () => {
      epicSession.value = { transportStatus: "closed", snapshotLoaded: true };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(published()?.spell.syncing).toBe(false);
    });

    it("still reports on an empty pane - the Epic's own data is what is stale", () => {
      epicSession.value = {
        transportStatus: "reconnecting",
        snapshotLoaded: true,
      };
      seed({
        root: makePane("pane-A", [], null),
        activePaneId: "pane-A",
        tilesByInstanceId: {},
        sizesByGroupId: {},
      });
      renderView();
      expect(screen.queryByTestId("pane-opener")).not.toBeNull();
      // Deliberate change from when the bar lived inside this view. The report
      // is about the EPIC's stream - the tab list and the switcher's contents -
      // not about whichever tile happens to be open, and an empty pane is a
      // surface the user is about to open a tab from. `snapshotLoaded` is the
      // Epic's own, so it is still true here.
      expect(published()?.spell.syncing).toBe(true);
    });
  });

  it("renders exactly one tile - the active pane's active tile", () => {
    seed(twoPaneCanvas("pane-A"));
    renderView();
    expect(screen.queryByTestId("tile-spec-1")).not.toBeNull();
    expect(screen.queryByTestId("tile-spec-2")).toBeNull();
    expect(screen.queryByTestId("tile-spec-3")).toBeNull();
    expect(renderedTileCount()).toBe(1);
  });

  it("shows the active pane's tile in a multi-split layout (picks exactly one)", () => {
    seed(twoPaneCanvas("pane-B"));
    renderView();
    expect(screen.queryByTestId("tile-spec-3")).not.toBeNull();
    expect(renderedTileCount()).toBe(1);
  });

  it("performs zero writes to the persisted split layout when viewed", () => {
    seed(twoPaneCanvas("pane-A"));
    const before = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    renderView();
    const after = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    // Reference-identical: rendering the mobile view mutates neither the split
    // tree nor the group sizes.
    expect(after).toBe(before);
    expect(after?.root).toBe(before?.root);
    expect(after?.sizesByGroupId).toBe(before?.sizesByGroupId);
  });

  it("hands the current tile to the current-tile bar", () => {
    seed(twoPaneCanvas("pane-B"));
    renderView();
    expect(
      screen.getByTestId("current-tile-bar").getAttribute("data-tile-id"),
    ).toBe("spec-3");
  });

  it("swaps the rendered tile when activation moves to another pane", () => {
    seed(twoPaneCanvas("pane-A"));
    renderView();
    expect(screen.queryByTestId("tile-spec-1")).not.toBeNull();
    const before = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];

    // Same store transition `useMobileEpicTiles.selectTile` drives.
    act(() => {
      useEpicCanvasStore
        .getState()
        .prepareSetActiveTileTabFocusTarget(VIEW_TAB_ID, "pane-B", "inst-3");
    });

    expect(screen.queryByTestId("tile-spec-3")).not.toBeNull();
    expect(renderedTileCount()).toBe(1);
    const after = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    // The split STRUCTURE + sizes are unchanged - only activation moved.
    expect(paneIds(after?.root ?? null)).toEqual(["pane-A", "pane-B"]);
    expect(after?.sizesByGroupId).toEqual(before?.sizesByGroupId);
  });

  it("renders the inline opener (not a blank screen) for an empty pane", () => {
    // A non-null root whose only pane holds no tiles - the user closed the last
    // tab. selectMobileTile returns null; the view must still offer an
    // affordance, not a dead-end.
    seed({
      root: makePane("pane-A", [], null),
      activePaneId: "pane-A",
      tilesByInstanceId: {},
      sizesByGroupId: {},
    });
    renderView();
    expect(screen.queryByTestId("pane-opener")).not.toBeNull();
    expect(renderedTileCount()).toBe(0);
  });
});
