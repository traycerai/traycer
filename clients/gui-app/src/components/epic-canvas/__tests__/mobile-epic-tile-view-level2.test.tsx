import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileEpicTileView } from "@/components/epic-canvas/mobile/mobile-epic-tile-view";
import { MobileEmptyPaneLevel2 } from "@/components/epic-canvas/mobile/mobile-empty-pane-level2";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useSurfaceSyncStore } from "@/stores/sync/surface-sync-store";
import { useTileMinimapStore } from "@/stores/tile-minimap";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  TilePane,
} from "@/stores/epics/canvas/types";
import {
  installShellForm,
  SHELL_WIDTH_COLUMN_256,
  SHELL_WIDTH_MENU,
  type ShellFormHarness,
} from "../../../../__tests__/mobile-level2-form-harness";

const TAB_ID = "level2-tab";
const EPIC_ID = "epic-1";

// The Epic projection the tile body, the bar's title and the list read.
vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: (id: string) => ({ id }),
  useEpicChatRecordListAuthoritative: () => true,
  useEpicTuiAgentRecordListAuthoritative: () => true,
  useEpicChatRetraction: () => null,
  useEpicTuiAgentRetraction: () => null,
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
  useEpicPermissionRole: () => "owner",
  useEpicSnapshotLoaded: () => true,
  useEpicHostTransportStatus: () => "open",
  useMaybeEpicTuiAgentHarnessId: () => null,
  useEpicTitle: () => "Release train",
}));

// The tile body is the external seam; the probe counts how often it mounts.
const bodyMounts = vi.hoisted(() => ({ mounted: 0, unmounted: 0 }));
vi.mock("@/components/epic-canvas/renderers/epic-node-tile", () => ({
  EpicNodeTile: ({ node }: { readonly node: EpicCanvasTileRef }) => {
    useEffect(() => {
      bodyMounts.mounted += 1;
      return () => {
        bodyMounts.unmounted += 1;
      };
    }, []);
    return <div data-testid={`tile-${node.id}`} />;
  },
}));

vi.mock("@/components/epic-canvas/canvas/pane-opener", () => ({
  PaneOpener: () => <div data-testid="pane-opener" />,
}));
vi.mock("@/components/epic-canvas/canvas/tab-strip", () => ({
  TabIcon: () => <span data-testid="tab-icon" />,
  TabStrip: () => null,
}));
vi.mock("@/components/epic-canvas/canvas/browser-tab-presentation", () => ({
  useBrowserTabPresentation: () => null,
}));

// The chat session is the external boundary; the bar's report is real.
vi.mock("@/hooks/chats/use-chat-stream-sync-state", () => ({
  useChatStreamSyncState: () => ({
    status: "reconnecting",
    hasContent: true,
    wake: () => undefined,
  }),
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

const epicHandle = vi.hoisted(() => ({
  hostId: "host-A",
  wakeTransport: () => undefined,
}));
vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => epicHandle,
  useOpenEpicHandle: () => epicHandle,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable", hostLabel: "host-A" }),
  resolvedHostLabel: (r: { status: string; hostLabel: string | null }) =>
    r.status === "checking" ? null : r.hostLabel,
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-directory-entry")
  >()),
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => null,
}));
vi.mock("@/lib/host", () => ({ useHostClient: () => null }));
vi.mock("@/components/epic-canvas/renderers/use-chat-tile-host-label", () => ({
  useChatTileHostLabel: () => null,
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

// Run the prepared focus mutation synchronously, as use-switcher-activate's
// suite does, so the real `openTile` seam and canvas store run.
vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () => (_epicId: string, _tabId: string, prepare: () => unknown) => {
      prepare();
    },
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => true,
  isMobileViewport: () => true,
}));

// Category bodies need the epic projection; the chats body is a row whose tap
// goes through the REAL `useSwitcherActivate`, the rest render nothing.
vi.mock("@/components/epic-canvas/mobile/switcher-agents-list", async () => {
  const { useSwitcherActivate } =
    await import("@/components/epic-canvas/mobile/use-switcher-activate");
  return {
    SwitcherAgentsList: (props: {
      readonly tabId: string;
      readonly onClose: () => void;
    }) => {
      const activate = useSwitcherActivate(props.tabId, props.onClose);
      return (
        <button
          type="button"
          onClick={() =>
            activate(() => ({
              id: "spec-2",
              instanceId: "unused",
              type: "spec",
              name: "Spec 2",
              hostId: "host-A",
            }))
          }
        >
          Open Spec 2
        </button>
      );
    },
  };
});
vi.mock("@/components/epic-canvas/mobile/switcher-terminals-list", () => ({
  SwitcherTerminalsList: () => null,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-browsers-list", () => ({
  SwitcherBrowsersList: () => null,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-simulators-list", () => ({
  SwitcherSimulatorsList: () => null,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-artifacts-list", () => ({
  SwitcherArtifactsList: () => null,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-comments-list", () => ({
  SwitcherCommentsList: () => null,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-panel-embed", () => ({
  SwitcherPanelEmbed: () => null,
}));

const CATEGORY_TABS = [
  "mobile-switcher-tab-chats",
  "mobile-switcher-tab-artifacts",
  "mobile-switcher-tab-terminals",
  "mobile-switcher-tab-browsers",
  "mobile-switcher-tab-simulators",
  "mobile-switcher-tab-git-diff",
  "mobile-switcher-tab-pull-requests",
  "mobile-switcher-tab-file-tree",
  "mobile-switcher-tab-sharing",
  "mobile-switcher-tab-comments",
];

const SPEC_1: EpicCanvasTileRef = {
  id: "spec-1",
  instanceId: "inst-1",
  type: "spec",
  name: "Spec 1",
  hostId: "host-A",
};
const SPEC_2: EpicCanvasTileRef = {
  id: "spec-2",
  instanceId: "inst-2",
  type: "spec",
  name: "Spec 2",
  hostId: "host-A",
};
const FILE: EpicCanvasTileRef = {
  id: "file-1",
  instanceId: "inst-file",
  type: "workspace-file",
  name: "main.ts",
  hostId: "host-A",
  workspacePath: "/ws",
  filePath: "/ws/main.ts",
};
const CHAT: EpicCanvasTileRef = {
  id: "chat-1",
  instanceId: "inst-chat",
  type: "chat",
  name: "A chat",
  hostId: "host-A",
};

function seed(
  tiles: ReadonlyArray<EpicCanvasTileRef>,
  active: string | null,
): void {
  const root: TilePane = {
    kind: "pane",
    id: "pane-A",
    tabInstanceIds: tiles.map((tile) => tile.instanceId),
    activeTabId: active,
    previewTabId: null,
    activationHistory: active === null ? [] : [active],
  };
  const canvas: EpicCanvasState = {
    root,
    activePaneId: "pane-A",
    tilesByInstanceId: Object.fromEntries(
      tiles.map((tile) => [tile.instanceId, tile]),
    ),
    sizesByGroupId: {},
  };
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: EPIC_ID, name: "Epic 1" } },
    canvasByTabId: { [TAB_ID]: canvas },
  });
}

function showTile(instanceId: string): void {
  act(() => {
    useEpicCanvasStore
      .getState()
      .prepareSetActiveTileTabFocusTarget(TAB_ID, "pane-A", instanceId);
  });
}

function categoryTabs(scope: HTMLElement): ReadonlyArray<string | null> {
  return within(scope)
    .getAllByRole("tab")
    .map((tab) => tab.getAttribute("data-testid"));
}

function renderView() {
  return render(<MobileEpicTileView epicId={EPIC_ID} tabId={TAB_ID} />);
}

const MINIMAP_SNAPSHOT = {
  items: [{ key: "a", label: "First", level: 1 as const }],
  currentIndex: 0,
};

function registerMinimap(tileInstanceId: string): void {
  useTileMinimapStore.getState().registerTarget({
    tileInstanceId,
    adapter: {
      title: "Messages",
      getSnapshot: () => MINIMAP_SNAPSHOT,
      subscribe: () => () => undefined,
      select: () => undefined,
    },
  });
}

describe("<MobileEpicTileView /> level 2 forms", () => {
  let shell: ShellFormHarness;

  beforeEach(() => {
    bodyMounts.mounted = 0;
    bodyMounts.unmounted = 0;
    shell = installShellForm(SHELL_WIDTH_COLUMN_256);
    seed([SPEC_1, SPEC_2, FILE, CHAT], "inst-1");
  });
  afterEach(() => {
    cleanup();
    shell.dispose();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useMobileSwitcherStore.setState({ openTabId: null, mountCountByTabId: {} });
    useLeftPanelStore.setState({
      activePanelIdByTabId: {},
      commentsPanelRevealedByTabId: {},
    });
    useSurfaceSyncStore.setState({ entries: {} });
    useTileMinimapStore.setState({
      targetsByTileInstanceId: {},
      nextRegistrationId: 1,
    });
  });

  describe("the column", () => {
    it("lists the categories, and a row changes the tile and leaves the column on screen", async () => {
      const user = userEvent.setup();
      renderView();
      const column = screen.getByRole("navigation", { name: "Release train" });
      expect(
        column.closest('[data-testid="mobile-tile-column"]'),
      ).not.toBeNull();
      expect(categoryTabs(column)).toEqual(CATEGORY_TABS);
      expect(screen.getByTestId("tile-spec-1")).not.toBeNull();

      await user.click(
        within(column).getByRole("button", { name: "Open Spec 2" }),
      );

      expect(screen.getByTestId("tile-spec-2")).not.toBeNull();
      expect(screen.queryByTestId("tile-spec-1")).toBeNull();
      expect(screen.getByTestId("mobile-tile-column")).not.toBeNull();
    });
  });

  describe("the menu", () => {
    beforeEach(() => shell.set({ width: SHELL_WIDTH_MENU, portrait: false }));

    async function openMenu() {
      const user = userEvent.setup();
      await user.click(screen.getByTestId("mobile-tile-menu-trigger"));
      return { user, menu: await screen.findByTestId("mobile-tile-menu") };
    }

    it("opens from the tile's name with the same categories, and a row changes the tile and closes it", async () => {
      renderView();
      expect(screen.queryByTestId("mobile-tile-column")).toBeNull();
      expect(screen.queryByTestId("mobile-tile-menu")).toBeNull();
      const { user, menu } = await openMenu();
      expect(categoryTabs(menu)).toEqual(CATEGORY_TABS);

      await user.click(
        within(menu).getByRole("button", { name: "Open Spec 2" }),
      );

      expect(screen.getByTestId("tile-spec-2")).not.toBeNull();
      expect(screen.queryByTestId("mobile-tile-menu")).toBeNull();
    });

    it("closes when a tile from an embedded panel is shown", async () => {
      renderView();
      await openMenu();
      showTile("inst-file");
      expect(screen.queryByTestId("mobile-tile-menu")).toBeNull();
    });

    it("stays open when a chat opens in the background", async () => {
      renderView();
      await openMenu();
      showTile("inst-chat");
      expect(screen.getByTestId("mobile-tile-menu")).not.toBeNull();
    });
  });

  describe("the tile bar", () => {
    it.each([
      ["column", SHELL_WIDTH_COLUMN_256],
      ["menu", SHELL_WIDTH_MENU],
    ])(
      "keeps the minimap button and the chat stream's report in the %s form",
      (_form, width) => {
        shell.set({ width, portrait: false });
        seed([SPEC_1, CHAT], "inst-chat");
        registerMinimap("inst-chat");
        renderView();
        expect(screen.getByTestId("content-minimap-button")).not.toBeNull();
        const published = Object.values(
          useSurfaceSyncStore.getState().entries,
        ).find((entry) => entry.key === "chat:host-A:chat-1");
        expect(published?.spell.syncing).toBe(true);
      },
    );
  });

  it("keeps one mount of the tile body across a column, menu and bar flip", () => {
    renderView();
    shell.set({ width: SHELL_WIDTH_MENU, portrait: false });
    shell.set({ width: SHELL_WIDTH_MENU, portrait: true });
    expect(bodyMounts.mounted).toBe(1);
    expect(bodyMounts.unmounted).toBe(0);
    expect(screen.getByTestId("tile-spec-1")).not.toBeNull();
  });

  describe("off the installed app", () => {
    it("keeps the bar and the sheet at a 750 window", () => {
      setPhoneLayoutOnly(false);
      renderView();
      expect(screen.getByTestId("mobile-current-tile-bar")).not.toBeNull();
      expect(screen.queryByTestId("mobile-tile-column")).toBeNull();
      expect(screen.queryByTestId("mobile-tile-menu-trigger")).toBeNull();
      act(() => useMobileSwitcherStore.getState().setOpen(TAB_ID, true));
      expect(categoryTabs(document.body)).toEqual(CATEGORY_TABS);
    });
  });

  describe("<MobileEmptyPaneLevel2 />", () => {
    function renderEmpty() {
      return render(
        <MobileEmptyPaneLevel2 epicId={EPIC_ID} tabId={TAB_ID}>
          <div data-testid="child" />
        </MobileEmptyPaneLevel2>,
      );
    }

    it("draws the column beside its children", () => {
      renderEmpty();
      expect(screen.getByTestId("mobile-tile-column")).not.toBeNull();
      expect(screen.getByTestId("child")).not.toBeNull();
    });

    it("draws a Switch tab trigger in the menu form", async () => {
      shell.set({ width: SHELL_WIDTH_MENU, portrait: false });
      renderEmpty();
      expect(screen.queryByTestId("mobile-tile-column")).toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Switch tab" }));
      expect(
        categoryTabs(await screen.findByTestId("mobile-tile-menu")),
      ).toEqual(CATEGORY_TABS);
    });

    it("renders just the children and the sheet at bar", () => {
      shell.set({ width: SHELL_WIDTH_COLUMN_256, portrait: true });
      const { container } = renderEmpty();
      expect(screen.getByTestId("child").parentElement).toBe(container);
      expect(screen.queryByTestId("mobile-tile-column")).toBeNull();
      expect(screen.queryByRole("button", { name: "Switch tab" })).toBeNull();
    });
  });
});
