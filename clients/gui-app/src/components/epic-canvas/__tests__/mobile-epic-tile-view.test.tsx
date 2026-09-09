import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileEpicTileView } from "@/components/epic-canvas/mobile/mobile-epic-tile-view";
import { AppConnectivityStripContext } from "@/components/layout/app-connectivity-strip-context";
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
  MobileCurrentTileBar: ({
    tile,
    outerStripShowing,
  }: {
    readonly tile: EpicCanvasTileRef;
    readonly outerStripShowing: boolean;
  }) => (
    <div
      data-testid="current-tile-bar"
      data-tile-id={tile.id}
      // Recorded so the view test can prove the bar is handed the SAME legs the
      // outer strip decided on. The tile bar suppresses its own strip off these;
      // if the view ever stopped passing them, the two strips would stack and
      // only this attribute would say so.
      data-outer-strip-showing={String(outerStripShowing)}
    />
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

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatList: () => ({
    data: undefined,
    isError: false,
    isPending: false,
    isFetching: false,
  }),
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
  });

  describe("stream-syncing strip", () => {
    function epicStrip(): HTMLElement | null {
      return screen.queryByTestId("epic-stream-syncing-bar");
    }

    it("stays silent while the Epic's own stream is open", () => {
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(epicStrip()).toBeNull();
    });

    it("says Syncing… while the Epic's stream comes back under a painted canvas", () => {
      epicSession.value = {
        transportStatus: "reconnecting",
        snapshotLoaded: true,
      };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(epicStrip()?.textContent).toContain("Syncing…");
      // The tile it describes is still on screen underneath, not replaced by a
      // skeleton - that is the whole state the strip exists to narrate.
      expect(screen.queryByTestId("tile-spec-1")).not.toBeNull();
    });

    it("stays silent on a cold open, where the skeleton already says loading", () => {
      epicSession.value = {
        transportStatus: "connecting",
        snapshotLoaded: false,
      };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(epicStrip()).toBeNull();
    });

    it("stays silent on a closed stream rather than animating forever", () => {
      epicSession.value = { transportStatus: "closed", snapshotLoaded: true };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(epicStrip()).toBeNull();
    });

    it("hands the tile bar its DECIDED answer, so the two never stack", () => {
      epicSession.value = {
        transportStatus: "reconnecting",
        snapshotLoaded: true,
      };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(epicStrip()).not.toBeNull();
      expect(
        screen
          .getByTestId("current-tile-bar")
          .getAttribute("data-outer-strip-showing"),
      ).toBe("true");
    });

    it("tells the tile bar it is silent when its own status is away but cold", () => {
      // The suppression signal is whether this strip is SPEAKING, not the raw
      // status behind it. An Epic still cold shows no strip, so reporting
      // "showing" here would silence the chat's strip too and leave a stale
      // transcript with nothing said about it at all.
      epicSession.value = {
        transportStatus: "reconnecting",
        snapshotLoaded: false,
      };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(epicStrip()).toBeNull();
      expect(
        screen
          .getByTestId("current-tile-bar")
          .getAttribute("data-outer-strip-showing"),
      ).toBe("false");
    });

    it("yields to the app-wide strip, leaving exactly one bar on screen", () => {
      // An app switch drops this client's whole transport, so the app-wide
      // strip and every stream below it report the same interruption in the
      // same tick. Three bars saying one thing is what the rule prevents.
      epicSession.value = {
        transportStatus: "reconnecting",
        snapshotLoaded: true,
      };
      seed(twoPaneCanvas("pane-A"));
      render(
        <AppConnectivityStripContext.Provider value>
          <MobileEpicTileView epicId="epic-1" tabId={VIEW_TAB_ID} />
        </AppConnectivityStripContext.Provider>,
      );
      expect(epicStrip()).toBeNull();
      // …and the tile below is told to stay quiet too, so the deferral reaches
      // all the way down rather than stopping here.
      expect(
        screen
          .getByTestId("current-tile-bar")
          .getAttribute("data-outer-strip-showing"),
      ).toBe("true");
    });

    it("takes over when the app-wide strip stops but its own stream is still away", () => {
      epicSession.value = {
        transportStatus: "reconnecting",
        snapshotLoaded: true,
      };
      seed(twoPaneCanvas("pane-A"));
      renderView();
      expect(epicStrip()).not.toBeNull();
    });

    it("shows no strip on an empty pane, which has no content to be stale", () => {
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
      expect(epicStrip()).toBeNull();
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
