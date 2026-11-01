import "../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileEpicTileView } from "@/components/epic-canvas/mobile/mobile-epic-tile-view";
import {
  SURFACE_SYNC_RANK,
  useSurfaceSyncStore,
  type SurfaceSyncEntry,
} from "@/stores/sync/surface-sync-store";
import { selectMobileTile } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { tileIntent, type TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  commitWithoutNavigation,
  MANUAL_TILE_OPEN,
  openTileWithNavigation,
} from "@/lib/canvas/tile-open/open-tile";
import { StableTileSurfaceHost } from "@/components/epic-canvas/surface-host/stable-tile-surface-host";
import { renderHostedChatSurfaceBody } from "@/components/epic-canvas/surface-host/hosted-chat-surface-body";
import { resetTileSurfaceMembershipForTesting } from "@/components/epic-canvas/surface-host/tile-surface-membership";
import { resetTileSurfaceEnvironmentRegistryForTesting } from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import { resetTileSurfaceGeometryCoordinatorForTesting } from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import type { HtmlArtifactVersionSelection } from "@traycer/protocol/host/epic/html-artifact-versions";
import {
  installShellForm,
  SHELL_WIDTH_COLUMN_256,
  SHELL_WIDTH_TWO_TILES,
  type ShellFormHarness,
} from "../../../../__tests__/mobile-level2-form-harness";
import type { ReactNode } from "react";
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

// The intent a stubbed tile body (or the stubbed tile list) opens when its
// button is pressed: the real `useEpicTileNavigation().openTile` carries it.
const pendingOpen = vi.hoisted(() => {
  const value: { intent: TileOpenIntent | null } = { intent: null };
  return { value };
});

// ActiveTabBody reads permission/snapshot/artifact state through epic-selectors;
// stub them so the shared tile body mounts without a HostRuntimeProvider /
// EpicSessionProvider (mirrors tab-group-view.test).
vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  // The rest answer as they do with no session (the retained chat's row in the
  // list reads a few of them).
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicArtifact: (id: string) => ({ id }),
  useEpicTitle: () => "Epic 1",
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
// The marker carries a button that opens `pendingOpen` through the real
// navigation hook, from inside the tile's body - where an open's slot is decided.
vi.mock("@/components/epic-canvas/renderers/epic-node-tile", async () => {
  const { useEpicTileNavigation } =
    await import("@/hooks/epic/use-epic-tile-navigation");
  return {
    EpicNodeTile: ({ node }: { readonly node: EpicCanvasTileRef }) => {
      const { openTile } = useEpicTileNavigation();
      return (
        <div data-testid={`tile-${node.id}`}>
          <button
            type="button"
            data-testid={`open-from-${node.id}`}
            onClick={() => {
              if (pendingOpen.value.intent !== null) {
                openTile(pendingOpen.value.intent);
              }
            }}
          />
        </div>
      );
    },
  };
});

// The task's tile list, as far as these cases go: its real head row (the last
// open tile) and one pick that opens `pendingOpen` from where the list is mounted.
vi.mock("@/components/epic-canvas/mobile/tile-switcher-list", async () => {
  const { SwitcherLastTileRow } =
    await import("@/components/epic-canvas/mobile/switcher-last-tile-row");
  const { useEpicTileNavigation } =
    await import("@/hooks/epic/use-epic-tile-navigation");
  return {
    TileSwitcherList: (props: {
      readonly epicId: string;
      readonly tabId: string;
      readonly onClose: () => void;
    }) => {
      const { openTile } = useEpicTileNavigation();
      return (
        <div>
          <SwitcherLastTileRow {...props} />
          <button
            type="button"
            data-testid="list-pick"
            onClick={() => {
              if (pendingOpen.value.intent !== null) {
                openTile(pendingOpen.value.intent);
              }
            }}
          />
        </div>
      );
    },
  };
});

// The empty-pane opener pulls the command-palette router/provider stack; stub
// it to a marker so the empty-canvas branch is observable in isolation.
vi.mock("@/components/epic-canvas/canvas/pane-opener", () => ({
  PaneOpener: () => <div data-testid="pane-opener" />,
}));

// The current-tile bar is covered by its own test; stub it here to a marker
// carrying the tile it was handed, so the view test can assert WHICH tile the
// bar reflects without pulling the bar's host/title hooks.
// It also draws the header's trailing controls and, where level 2 is the menu,
// the trigger that opens the tile's `MobileTileMenu`.
vi.mock("@/components/epic-canvas/mobile/mobile-current-tile-bar", async () => {
  const { MobileLevel2MenuTrigger } =
    await import("@/components/layout/shell/mobile-level2");
  return {
    MobileCurrentTileBar: (props: {
      readonly tile: EpicCanvasTileRef;
      readonly level2: unknown;
      readonly trailing: ReactNode;
    }) => (
      <div data-testid="current-tile-bar" data-tile-id={props.tile.id}>
        {props.level2 === "menu" ? (
          <MobileLevel2MenuTrigger
            testId={`menu-trigger-${props.tile.id}`}
            className={undefined}
          >
            {props.tile.name}
          </MobileLevel2MenuTrigger>
        ) : null}
        {props.trailing}
      </div>
    ),
  };
});

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
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));

// The canvas reads the chat host's directory row (the serving witness), which
// needs a host runtime this suite does not mount; no row is the answer for a
// host with no runtime.
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-directory-entry")
  >()),
  useHostDirectoryEntry: () => null,
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => null,
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));

// The banner's host name reads the account's environment lists, a query this
// provider-less suite has no client for; no fixture here is a chat tab.
vi.mock("@/components/epic-canvas/renderers/use-chat-tile-host-label", () => ({
  useChatTileHostLabel: () => null,
}));

// A hosted chat paints in the stable surface host, outside its pane. Its body is
// a probe that reports whether it is the active surface and opens `pendingOpen`
// through the real navigation hook from where the chat renders.
vi.mock("@/components/epic-canvas/renderers/browser-sessions-provider", () => ({
  BrowserOpenSessionsProvider: (props: { children: ReactNode }) =>
    props.children,
  BrowserSessionsHostProvider: (props: { children: ReactNode }) =>
    props.children,
}));
vi.mock("@/components/epic-canvas/renderers/tile-render", async () => {
  const { useEpicTileNavigation } =
    await import("@/hooks/epic/use-epic-tile-navigation");
  function HostedProbe(props: {
    readonly node: EpicCanvasTileRef;
    readonly isActive: boolean;
  }): ReactNode {
    const { openTile } = useEpicTileNavigation();
    return (
      <div
        data-testid={`hosted-${props.node.id}`}
        data-active={String(props.isActive)}
      >
        <input data-testid={`input-${props.node.id}`} />
        <button
          type="button"
          data-testid={`open-from-${props.node.id}`}
          onClick={() => {
            if (pendingOpen.value.intent !== null) {
              openTile(pendingOpen.value.intent);
            }
          }}
        />
      </div>
    );
  }
  return {
    renderTile: (props: {
      readonly node: EpicCanvasTileRef;
      readonly isActive: boolean;
    }) => <HostedProbe {...props} />,
  };
});

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
    activeTabId: VIEW_TAB_ID,
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
  describe("in the installed app", () => {
    let shell: ShellFormHarness;
    beforeEach(() => {
      shell = installShellForm(SHELL_WIDTH_TWO_TILES);
    });
    afterEach(() => {
      shell.dispose();
      pendingOpen.value = { intent: null };
    });

    function canvasOf() {
      const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
      if (canvas === undefined) throw new Error("canvas not seeded");
      return canvas;
    }

    function slot() {
      return useEpicCanvasStore.getState().mobileSecondaryTileByTabId[
        VIEW_TAB_ID
      ];
    }

    function showSecond(instanceId: string, transient: boolean): void {
      act(() => {
        useEpicCanvasStore
          .getState()
          .setMobileSecondaryTile(VIEW_TAB_ID, { instanceId, transient });
      });
    }

    function open(fromTestId: string, node: EpicCanvasTileRef): void {
      pendingOpen.value = {
        intent: tileIntent(node, { tabId: VIEW_TAB_ID }, "single", "direct_ui"),
      };
      fireEvent.click(screen.getByTestId(fromTestId));
    }

    function primaryPane(): HTMLElement {
      return screen.getByTestId("mobile-epic-tile-view");
    }

    function secondPane(): HTMLElement {
      return screen.getByTestId("mobile-epic-second-tile");
    }

    it("mounts two tiles with level 2 as the menu, each under its own header", () => {
      seed(twoPaneCanvas("pane-A"));
      showSecond("inst-3", false);
      renderView();
      expect(within(primaryPane()).queryByTestId("tile-spec-1")).not.toBeNull();
      expect(within(secondPane()).queryByTestId("tile-spec-3")).not.toBeNull();
      expect(screen.queryByTestId("mobile-tile-column")).toBeNull();
      expect(
        within(primaryPane())
          .getByTestId("current-tile-bar")
          .getAttribute("data-tile-id"),
      ).toBe("spec-1");
      expect(
        within(secondPane())
          .getByTestId("current-tile-bar")
          .getAttribute("data-tile-id"),
      ).toBe("spec-3");
    });

    it("lands an open from the first tile's body in the second, leaving the first and the activation alone", () => {
      seed(twoPaneCanvas("pane-A"));
      showSecond("inst-3", false);
      renderView();
      open("open-from-spec-1", spec(4));
      expect(slot()).toEqual({ instanceId: "inst-4", transient: true });
      expect(within(secondPane()).queryByTestId("tile-spec-4")).not.toBeNull();
      expect(within(primaryPane()).queryByTestId("tile-spec-1")).not.toBeNull();
      const canvas = canvasOf();
      expect(canvas.activePaneId).toBe("pane-A");
      const paneA = collectPanes(canvas.root).find((p) => p.id === "pane-A");
      expect(paneA?.activeTabId).toBe("inst-1");
    });

    it("lands an open from the second tile's body in the first, leaving the second", () => {
      seed(twoPaneCanvas("pane-A"));
      showSecond("inst-3", false);
      renderView();
      open("open-from-spec-3", spec(4));
      expect(within(primaryPane()).queryByTestId("tile-spec-4")).not.toBeNull();
      expect(within(secondPane()).queryByTestId("tile-spec-3")).not.toBeNull();
      expect(slot()).toEqual({ instanceId: "inst-3", transient: false });
    });

    it("replaces the first tile and keeps the slot empty at a one-tile width", () => {
      shell.set({ width: SHELL_WIDTH_COLUMN_256, portrait: false });
      seed(twoPaneCanvas("pane-A"));
      renderView();
      open("open-from-spec-1", spec(4));
      expect(within(primaryPane()).queryByTestId("tile-spec-4")).not.toBeNull();
      expect(screen.queryByTestId("mobile-epic-second-tile")).toBeNull();
      expect(slot()).toBeUndefined();
    });

    it("changes nothing when the first tile opens the one already beside it", () => {
      seed(twoPaneCanvas("pane-A"));
      showSecond("inst-3", false);
      renderView();
      const before = canvasOf();
      open("open-from-spec-1", spec(3));
      expect(canvasOf()).toBe(before);
      expect(slot()).toEqual({ instanceId: "inst-3", transient: false });
      expect(within(primaryPane()).queryByTestId("tile-spec-1")).not.toBeNull();
      expect(within(secondPane()).queryByTestId("tile-spec-3")).not.toBeNull();
    });

    it("takes a replaced transient second tile off the canvas, and keeps one that was already open", () => {
      seed(twoPaneCanvas("pane-A"));
      renderView();
      open("open-from-spec-1", spec(4));
      expect(canvasOf().tilesByInstanceId["inst-4"]).toBeDefined();
      open("open-from-spec-1", spec(5));
      expect(slot()).toEqual({ instanceId: "inst-5", transient: true });
      expect(canvasOf().tilesByInstanceId["inst-4"]).toBeUndefined();

      // spec-3 is open on the canvas already: shown beside, it is not transient.
      open("open-from-spec-1", spec(3));
      expect(slot()).toEqual({ instanceId: "inst-3", transient: false });
      expect(canvasOf().tilesByInstanceId["inst-5"]).toBeUndefined();
      open("open-from-spec-1", spec(6));
      expect(slot()).toEqual({ instanceId: "inst-6", transient: true });
      expect(canvasOf().tilesByInstanceId["inst-3"]).toBeDefined();
    });

    it("goes back to one tile and the column when the second is closed", () => {
      seed(twoPaneCanvas("pane-A"));
      showSecond("inst-3", false);
      renderView();
      expect(screen.queryByTestId("mobile-tile-column")).toBeNull();
      fireEvent.click(screen.getByTestId("mobile-secondary-tile-close"));
      expect(screen.queryByTestId("mobile-epic-second-tile")).toBeNull();
      expect(screen.queryByTestId("mobile-tile-column")).not.toBeNull();
    });

    it("unmounts the second tile below the two-tile width, keeps the first mounted, and trades places on its row", () => {
      seed(twoPaneCanvas("pane-A"));
      showSecond("inst-3", false);
      renderView();
      const firstPane = primaryPane();

      shell.set({ width: SHELL_WIDTH_COLUMN_256, portrait: false });
      expect(screen.queryByTestId("mobile-epic-second-tile")).toBeNull();
      expect(primaryPane()).toBe(firstPane);
      expect(screen.queryByTestId("switcher-last-tile-select")).not.toBeNull();

      shell.set({ width: SHELL_WIDTH_TWO_TILES, portrait: false });
      expect(screen.queryByTestId("mobile-epic-second-tile")).not.toBeNull();
      expect(screen.queryByTestId("switcher-last-tile-select")).toBeNull();

      shell.set({ width: SHELL_WIDTH_COLUMN_256, portrait: false });
      fireEvent.click(screen.getByTestId("switcher-last-tile-select"));
      shell.set({ width: SHELL_WIDTH_TWO_TILES, portrait: false });
      expect(within(primaryPane()).queryByTestId("tile-spec-3")).not.toBeNull();
      expect(within(secondPane()).queryByTestId("tile-spec-1")).not.toBeNull();
    });

    it("lands a pick made in the second tile's menu in the second tile", () => {
      seed(twoPaneCanvas("pane-A"));
      showSecond("inst-3", false);
      renderView();
      fireEvent.click(screen.getByTestId("menu-trigger-spec-3"));
      pendingOpen.value = {
        intent: tileIntent(
          spec(4),
          { tabId: VIEW_TAB_ID },
          "explicit",
          "direct_ui",
        ),
      };
      fireEvent.click(screen.getByTestId("list-pick"));
      expect(within(secondPane()).queryByTestId("tile-spec-4")).not.toBeNull();
      expect(within(primaryPane()).queryByTestId("tile-spec-1")).not.toBeNull();
    });
  });

  describe("outside the installed app", () => {
    afterEach(() => {
      pendingOpen.value = { intent: null };
      setPhoneLayoutOnly(false);
    });

    it("draws one tile for a filled slot, and an open replaces it", () => {
      seed(twoPaneCanvas("pane-A"));
      useEpicCanvasStore.getState().setMobileSecondaryTile(VIEW_TAB_ID, {
        instanceId: "inst-3",
        transient: false,
      });
      renderView();
      expect(screen.queryByTestId("mobile-epic-second-tile")).toBeNull();
      expect(renderedTileCount()).toBe(1);
      pendingOpen.value = {
        intent: tileIntent(
          spec(4),
          { tabId: VIEW_TAB_ID },
          "single",
          "direct_ui",
        ),
      };
      fireEvent.click(screen.getByTestId("open-from-spec-1"));
      expect(screen.queryByTestId("tile-spec-4")).not.toBeNull();
      expect(screen.queryByTestId("tile-spec-1")).toBeNull();
      expect(renderedTileCount()).toBe(1);
    });
  });
});

describe("<MobileEpicTileView /> with two tiles and chats painted by the stable host", () => {
  let shell: ShellFormHarness;

  function chat(n: number): EpicCanvasTileRef {
    return {
      id: `chat-${n}`,
      instanceId: `chat-inst-${n}`,
      type: "chat",
      name: `Chat ${n}`,
      hostId: "host-A",
    };
  }

  function versionOf(n: number): HtmlArtifactVersionSelection {
    return {
      entryPath: "index.html",
      versionNumber: n,
      manifest: {
        capturedAt: n,
        files: {
          "index.html": {
            sha256: String(n).repeat(64),
            byteLength: 10,
            mediaType: "text/html",
          },
        },
      },
    };
  }

  function html(n: number): EpicCanvasTileRef {
    return {
      id: "html-1",
      instanceId: "html-inst-1",
      type: "html",
      name: "Page",
      hostId: "host-A",
      htmlVersion: versionOf(n),
    };
  }

  /** One pane holding `tiles`; `history` spells out which were active, most recent first. */
  function paneCanvas(
    tiles: ReadonlyArray<EpicCanvasTileRef>,
    activeInstanceId: string,
    history: ReadonlyArray<string>,
  ): EpicCanvasState {
    return {
      root: {
        ...makePane("pane-A", tiles, activeInstanceId),
        activationHistory: history,
      },
      activePaneId: "pane-A",
      tilesByInstanceId: Object.fromEntries(
        tiles.map((tile) => [tile.instanceId, tile]),
      ),
      sizesByGroupId: {},
    };
  }

  function mountHosted(canvas: EpicCanvasState): void {
    seed(canvas);
    useEpicCanvasStore.setState({ openTabOrder: [VIEW_TAB_ID] });
    useTabsStore.setState({
      items: [
        {
          kind: "tab",
          id: "strip-1",
          ref: { kind: "epic", id: VIEW_TAB_ID },
        },
      ],
      activeItemId: "strip-1",
      stripOrder: [{ kind: "epic", id: VIEW_TAB_ID }],
    });
    render(
      <>
        <MobileEpicTileView epicId="epic-1" tabId={VIEW_TAB_ID} />
        <StableTileSurfaceHost renderRecordBody={renderHostedChatSurfaceBody} />
      </>,
    );
  }

  function reset(): void {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    resetTileSurfaceMembershipForTesting();
    resetTileSurfaceEnvironmentRegistryForTesting();
    resetTileSurfaceGeometryCoordinatorForTesting();
    pendingOpen.value = { intent: null };
  }

  function openFrom(
    testId: string,
    node: EpicCanvasTileRef,
    gesture: "single" | "explicit",
  ): void {
    pendingOpen.value = {
      intent: tileIntent(node, { tabId: VIEW_TAB_ID }, gesture, "direct_ui"),
    };
    fireEvent.click(screen.getByTestId(testId));
  }

  function showSecond(instanceId: string, transient: boolean): void {
    act(() => {
      useEpicCanvasStore
        .getState()
        .setMobileSecondaryTile(VIEW_TAB_ID, { instanceId, transient });
    });
  }

  function slot() {
    return useEpicCanvasStore.getState().mobileSecondaryTileByTabId[
      VIEW_TAB_ID
    ];
  }

  function canvasOf(): EpicCanvasState {
    const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
    if (canvas === undefined) throw new Error("canvas not seeded");
    return canvas;
  }

  function activeOf(chatId: string): string | null {
    return screen.getByTestId(`hosted-${chatId}`).getAttribute("data-active");
  }

  beforeEach(() => {
    reset();
    shell = installShellForm(SHELL_WIDTH_TWO_TILES);
  });
  afterEach(() => {
    cleanup();
    shell.dispose();
    reset();
  });

  describe("a chat in the second slot", () => {
    it("paints for a chat newly opened there, with no activation of its own", () => {
      mountHosted(paneCanvas([spec(1)], "inst-1", ["inst-1"]));
      openFrom("open-from-spec-1", chat(2), "single");
      expect(screen.queryByTestId("mobile-epic-second-tile")).not.toBeNull();
      expect(screen.queryByTestId("hosted-chat-2")).not.toBeNull();
      const pane = collectPanes(canvasOf().root)[0];
      expect(pane.activationHistory).not.toContain("chat-inst-2");
    });

    it("stays painted while the pane's retention window is full of two other chats", () => {
      mountHosted(
        paneCanvas([chat(1), chat(2), chat(3)], "chat-inst-1", [
          "chat-inst-1",
          "chat-inst-2",
        ]),
      );
      showSecond("chat-inst-3", false);
      expect(screen.queryByTestId("hosted-chat-3")).not.toBeNull();
    });
  });

  describe("an open from a hosted chat", () => {
    it("lands in the second slot from the first tile's chat, leaving the first tile", () => {
      mountHosted(paneCanvas([chat(1)], "chat-inst-1", ["chat-inst-1"]));
      openFrom("open-from-chat-1", spec(2), "single");
      expect(slot()?.instanceId).toBe("inst-2");
      expect(selectMobileTile(canvasOf())?.ref.id).toBe("chat-1");
    });

    it("replaces the first tile from the second tile's chat, leaving the second", () => {
      mountHosted(
        paneCanvas([spec(1), chat(1)], "inst-1", ["inst-1", "chat-inst-1"]),
      );
      showSecond("chat-inst-1", false);
      openFrom("open-from-chat-1", spec(2), "single");
      expect(
        within(screen.getByTestId("mobile-epic-tile-view")).queryByTestId(
          "tile-spec-2",
        ),
      ).not.toBeNull();
      expect(slot()?.instanceId).toBe("chat-inst-1");
      expect(screen.queryByTestId("hosted-chat-1")).not.toBeNull();
    });
  });

  describe("engaging a hosted chat", () => {
    function mountTwoChats(): void {
      mountHosted(
        paneCanvas([chat(1), chat(2)], "chat-inst-1", [
          "chat-inst-1",
          "chat-inst-2",
        ]),
      );
      showSecond("chat-inst-2", false);
    }

    it("hands the active surface over on a pointerdown, and back", () => {
      mountTwoChats();
      expect(activeOf("chat-1")).toBe("true");
      fireEvent.pointerDown(screen.getByTestId("input-chat-2"));
      expect(activeOf("chat-2")).toBe("true");
      expect(activeOf("chat-1")).toBe("false");
      fireEvent.pointerDown(screen.getByTestId("input-chat-1"));
      expect(activeOf("chat-1")).toBe("true");
      expect(activeOf("chat-2")).toBe("false");
    });

    it("hands the active surface over when focus alone moves into the other chat", () => {
      mountTwoChats();
      fireEvent.focusIn(screen.getByTestId("input-chat-2"));
      expect(activeOf("chat-2")).toBe("true");
      expect(activeOf("chat-1")).toBe("false");
    });

    it("keeps the first chat engaged after it is used while the second is away, once two tiles show again", () => {
      mountTwoChats();
      fireEvent.pointerDown(screen.getByTestId("input-chat-2"));
      expect(activeOf("chat-2")).toBe("true");
      shell.set({ width: SHELL_WIDTH_COLUMN_256, portrait: false });
      expect(screen.queryByTestId("mobile-epic-second-tile")).toBeNull();
      const firstInput = screen.getByTestId("input-chat-1");
      fireEvent.pointerDown(firstInput);
      act(() => firstInput.focus());
      shell.set({ width: SHELL_WIDTH_TWO_TILES, portrait: false });
      expect(document.activeElement).toBe(firstInput);
      expect(activeOf("chat-1")).toBe("true");
      expect(activeOf("chat-2")).toBe("false");
    });

    it("engages the first chat, not a new second tile, after the engaged second is closed and replaced", () => {
      mountTwoChats();
      fireEvent.pointerDown(screen.getByTestId("input-chat-2"));
      fireEvent.click(screen.getByTestId("mobile-secondary-tile-close"));
      openFrom("open-from-chat-1", spec(5), "single");
      expect(
        within(screen.getByTestId("mobile-epic-second-tile")).queryByTestId(
          "tile-spec-5",
        ),
      ).not.toBeNull();
      expect(activeOf("chat-1")).toBe("true");
    });

    it("engages the second chat when two tiles return with focus held in its retained input", () => {
      mountTwoChats();
      shell.set({ width: SHELL_WIDTH_COLUMN_256, portrait: false });
      act(() => screen.getByTestId("input-chat-2").focus());
      shell.set({ width: SHELL_WIDTH_TWO_TILES, portrait: false });
      expect(activeOf("chat-2")).toBe("true");
      expect(activeOf("chat-1")).toBe("false");
    });
  });

  describe("a preview", () => {
    it("moved to the second slot survives the first tile opening another preview", () => {
      shell.set({ width: SHELL_WIDTH_COLUMN_256, portrait: false });
      mountHosted(paneCanvas([spec(1)], "inst-1", ["inst-1"]));
      openFrom("open-from-spec-1", spec(2), "single");
      openFrom("list-pick", spec(1), "explicit");
      shell.set({ width: SHELL_WIDTH_TWO_TILES, portrait: false });
      openFrom("open-from-spec-1", spec(2), "explicit");
      const second = screen.getByTestId("mobile-epic-second-tile");
      openFrom("open-from-spec-2", spec(3), "single");
      expect(
        within(screen.getByTestId("mobile-epic-second-tile")).queryByTestId(
          "tile-spec-2",
        ),
      ).not.toBeNull();
      expect(screen.getByTestId("mobile-epic-second-tile")).toBe(second);
    });

    it("that was the first tile and traded to the second slot by the last-open row stays on screen", () => {
      shell.set({ width: SHELL_WIDTH_COLUMN_256, portrait: false });
      mountHosted(paneCanvas([spec(1)], "inst-1", ["inst-1"]));
      openFrom("open-from-spec-1", spec(2), "single");
      showSecond("inst-1", false);
      fireEvent.click(screen.getByTestId("switcher-last-tile-select"));
      shell.set({ width: SHELL_WIDTH_TWO_TILES, portrait: false });
      openFrom("open-from-spec-2", spec(3), "single");
      const first = screen.getByTestId("mobile-epic-tile-view");
      const second = screen.getByTestId("mobile-epic-second-tile");
      expect(within(first).queryByTestId("tile-spec-3")).not.toBeNull();
      expect(within(second).queryByTestId("tile-spec-2")).not.toBeNull();
    });
  });

  describe("an open that names an HTML version", () => {
    it.each([false, true])(
      "adopts it on the tile in the second slot (already displayed there: %s)",
      (displayed) => {
        mountHosted(paneCanvas([spec(1), html(1)], "inst-1", ["inst-1"]));
        if (displayed) showSecond("html-inst-1", false);
        openFrom("open-from-spec-1", html(2), "explicit");
        expect(canvasOf().tilesByInstanceId["html-inst-1"]).toMatchObject({
          htmlVersion: versionOf(2),
        });
        expect(slot()?.instanceId).toBe("html-inst-1");
      },
    );

    it("leaves how a tile got into the slot alone when it is opened there again", () => {
      mountHosted(paneCanvas([spec(1), spec(3)], "inst-1", ["inst-1"]));
      showSecond("inst-3", true);
      openFrom("open-from-spec-1", spec(3), "explicit");
      expect(slot()).toEqual({ instanceId: "inst-3", transient: true });
    });
  });

  it("focuses a tile in the second slot of a task behind another tab, instead of dropping the open", () => {
    seed(twoPaneCanvas("pane-A"));
    useEpicCanvasStore.setState({
      tabsById: {
        ...useEpicCanvasStore.getState().tabsById,
        "other-tab": { tabId: "other-tab", epicId: "epic-2", name: "Epic 2" },
      },
      canvasByTabId: {
        ...useEpicCanvasStore.getState().canvasByTabId,
        "other-tab": paneCanvas([spec(9)], "inst-9", ["inst-9"]),
      },
      activeTabId: "other-tab",
    });
    showSecond("inst-3", false);
    const target = openTileWithNavigation(
      tileIntent(spec(3), { tabId: VIEW_TAB_ID }, "explicit", "direct_ui"),
      commitWithoutNavigation,
      {
        ...MANUAL_TILE_OPEN,
        mobileTarget: { tabId: VIEW_TAB_ID, slot: "secondary" },
      },
    );
    expect(target).toMatchObject({
      paneId: "pane-B",
      tileInstanceId: "inst-3",
    });
  });
});
