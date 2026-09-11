import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import { EpicRootDragOverlayContent } from "@/components/epic-canvas/dnd/drag-overlay-chip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicRuntimeBinding,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { ChatProjection } from "@/stores/epics/open-epic/types";
import { createRecordingAccountingPort } from "@/stores/epics/open-epic/test-support/accounting-port-fixture";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import type {
  EpicCanvasArtifactTabDragData,
  EpicCanvasGitDiffTileDragData,
  EpicCanvasLeftPanelRailDragData,
  EpicCanvasManagedCommandOutputDragData,
  EpicCanvasWorkspaceFolderDragData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  ARTIFACT_TAB_DND_TYPE,
  GIT_DIFF_TILE_DND_TYPE,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  MANAGED_COMMAND_OUTPUT_DND_TYPE,
  WORKSPACE_FOLDER_DND_TYPE,
} from "@/components/epic-canvas/dnd/dnd";
import { LEFT_PANEL_DEFINITIONS } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import { makeBlankTileRef } from "@/stores/epics/canvas/tile-schema/blank-tile";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { makeCommGraphTileRef } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import { makePublishedChatTileRef } from "@/stores/epics/canvas/tile-schema/published-chat-tile";
import type {
  EpicArtifactRef,
  EpicCanvasTileRef,
  PrDetailTileRef,
  PrDiffTileRef,
  SnapshotDiffTileRef,
} from "@/stores/epics/canvas/types";
import {
  disposeManagedCommandChatSessions,
  installManagedCommandChatSession,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";

/** Stub host RPC data while keeping indicator selection and the overlay provider real. */
const hostIndicatorTestState = vi.hoisted(
  (): { data: HostNotificationsIndicatorStateResponse } => ({
    data: { epics: {}, chats: {} },
  }),
);

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: hostIndicatorTestState.data,
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

describe("<EpicRootDragOverlayContent />", () => {
  beforeEach(() => {
    useEpicDndStore.getState().dragEnded();
  });

  afterEach(() => {
    cleanup();
    disposeManagedCommandChatSessions();
    useEpicDndStore.getState().dragEnded();
  });

  function startShellDrag(monitoring: boolean | null): void {
    const tile = makeManagedCommandOutputTileRef({
      commandId: "cmd-1",
      hostId: "host-1",
    });
    if (monitoring !== null) {
      const session = installManagedCommandChatSession({
        epicId: "epic-1",
        chatId: "chat-1",
        hostId: "host-1",
      });
      session.setCommands([
        managedCommandSchema.parse({
          id: "cmd-1",
          monitoring,
          description: "deploy watcher",
          command: "tail -f deploy.log",
          cwd: "/work/repo",
          cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
          status: { state: "running", pid: 7, startedAtMs: 1 },
          chatId: "chat-1",
          relaunchOnHostRestart: false,
          createdAtMs: 1,
          updatedAtMs: 1,
        }),
      ]);
    }
    const source: EpicCanvasManagedCommandOutputDragData = {
      kind: MANAGED_COMMAND_OUTPUT_DND_TYPE,
      epicId: "epic-1",
      viewTabId: "view-tab-1",
      tile,
    };
    useEpicDndStore.getState().canvasDragStarted(source, tile);
  }

  it("names a dragged shell window the way its tab does, glyph included", () => {
    // The tile payload's own name is the surface ("Output"), which would have
    // the chip disagreeing with the strip it was torn out of.
    startShellDrag(true);
    render(<EpicRootDragOverlayContent />);

    expect(screen.getByText("Monitor · deploy watcher")).toBeTruthy();
    expect(document.querySelector("[data-monitor-icon='on']")).not.toBeNull();
  });

  it("keeps the payload's snapshot name when no live record answers", () => {
    startShellDrag(null);
    render(<EpicRootDragOverlayContent />);

    expect(screen.getByText("Output")).toBeTruthy();
    expect(document.querySelector("[data-monitor-icon='off']")).not.toBeNull();
  });

  it("renders a Git bundle drag as an intrinsically sized semantic chip", () => {
    const tile = makeGitBundleDiffTile({
      hostId: "host-1",
      runningDir: "/worktrees/right-click-context-menu/traycer",
      bundleGroup: "changes",
      repositoryContext: {
        workspaceLabel: "traycer-internal",
        repositoryLabel: "traycer",
      },
    });
    const source: EpicCanvasGitDiffTileDragData = {
      kind: GIT_DIFF_TILE_DND_TYPE,
      epicId: "epic-1",
      viewTabId: "view-tab-1",
      tile,
    };
    useEpicDndStore.getState().canvasDragStarted(source, tile);

    render(<EpicRootDragOverlayContent />);

    const chip = screen.getByTestId("git-diff-drag-overlay");
    expect(chip.className).toContain("w-max");
    expect(chip.getAttribute("aria-label")).toBe(
      "Changes: traycer-internal › traycer",
    );
    expect(screen.getByTestId("git-diff-drag-overlay-scope").textContent).toBe(
      "Changes",
    );
    expect(
      screen.getByTestId("git-diff-drag-overlay-subject").textContent,
    ).toBe("traycer-internal › traycer");
  });

  /**
   * One shared wrapper around every chip variant. Guest tiles are ordinary
   * DOM now, so this is stacking rather than native-view occlusion, but the
   * wrapper still has to be a single ancestor: a per-chip marker nested a
   * second surface for the same chip, which is the shape the published-chat
   * miss came from.
   */
  describe("drag overlay wrapper", () => {
    function overlayMarker(): HTMLElement {
      const markers = screen.getAllByTestId("drag-overlay-marker");
      // Exactly one: a per-chip marker re-added under this wrapper would nest a
      // second occlusion surface for the same chip, which is the shape the
      // published-chat miss came from.
      expect(markers.length).toBe(1);
      return markers[0];
    }

    function startTileDrag(tile: EpicCanvasTileRef): void {
      const source: EpicCanvasArtifactTabDragData = {
        kind: ARTIFACT_TAB_DND_TYPE,
        epicId: "epic-1",
        viewTabId: "view-tab-1",
        sourceGroupId: "group-1",
        tabId: tile.id,
        isPreview: false,
      };
      useEpicDndStore.getState().canvasDragStarted(source, tile);
    }

    const publishedChat = makePublishedChatTileRef({
      taskId: "task-1",
      chatId: "chat-1",
      ownerUserId: "user-1",
      ownerHostId: "host-2",
      name: "Published chat chip",
      hostId: "host-1",
    });
    const artifact: EpicArtifactRef = {
      id: "chat-1",
      instanceId: "instance-artifact",
      type: "chat",
      name: "Artifact chip",
      hostId: "host-1",
    };
    const prDetail: PrDetailTileRef = {
      id: "pr-detail-1",
      instanceId: "instance-pr-detail",
      type: "pr-detail",
      name: "PR detail chip",
      hostId: "host-1",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
      prNumber: 1,
    };
    const prDiff: PrDiffTileRef = {
      id: "pr-diff-1",
      instanceId: "instance-pr-diff",
      type: "pr-diff",
      name: "PR diff chip",
      hostId: "host-1",
      githubHost: "github.com",
      owner: "traycerai",
      repo: "traycer",
      prNumber: 1,
      view: { collapsedFileKeys: [] },
    };
    const snapshotDiff: SnapshotDiffTileRef = {
      id: "snapshot-diff-1",
      instanceId: "instance-snapshot-diff",
      type: "snapshot-diff",
      name: "Snapshot diff chip",
      hostId: "host-1",
      diff: {
        kind: "snapshot-cumulative",
        chatId: "chat-1",
        filePath: "src/index.ts",
      },
      view: { collapsedFilePaths: [] },
    };

    // Every chip variant that renders its tile's `name`, published-chat first:
    // that is the one the per-chip markers missed.
    const namedTileVariants: ReadonlyArray<EpicCanvasTileRef> = [
      publishedChat,
      artifact,
      prDetail,
      prDiff,
      snapshotDiff,
      makeCommGraphTileRef("epic-1"),
      makeBlankTileRef(),
      makeBrowserSessionTileRef({
        hostId: "host-1",
        sessionId: "session-1",
        tabId: "tab-1",
      }),
      makeManagedCommandOutputTileRef({ commandId: "cmd-1", hostId: "host-1" }),
    ];

    namedTileVariants.forEach((tile) => {
      it(`wraps the ${tile.type} chip`, () => {
        startTileDrag(tile);
        render(<EpicRootDragOverlayContent />);

        const marker = overlayMarker();
        expect(marker.contains(screen.getByText(tile.name))).toBe(true);
      });
    });

    it("wraps the git-diff chip", () => {
      const tile = makeGitBundleDiffTile({
        hostId: "host-1",
        runningDir: "/work/traycer",
        bundleGroup: "changes",
        repositoryContext: null,
      });
      startTileDrag(tile);
      render(<EpicRootDragOverlayContent />);

      const marker = overlayMarker();
      const chip = screen.getByTestId("git-diff-drag-overlay");
      expect(marker.contains(chip)).toBe(true);
    });

    it("wraps the workspace-folder chip", () => {
      const source: EpicCanvasWorkspaceFolderDragData = {
        kind: WORKSPACE_FOLDER_DND_TYPE,
        epicId: "epic-1",
        viewTabId: "view-tab-1",
        hostId: "host-1",
        workspacePath: "/work/traycer",
        folderPath: "src/",
        name: "Folder chip",
      };
      useEpicDndStore.getState().canvasDragStarted(source, null);
      render(<EpicRootDragOverlayContent />);

      const marker = overlayMarker();
      expect(marker.contains(screen.getByText("Folder chip"))).toBe(true);
    });

    it("wraps the left-panel rail chip", () => {
      const panel = LEFT_PANEL_DEFINITIONS[0];
      const source: EpicCanvasLeftPanelRailDragData = {
        kind: LEFT_PANEL_RAIL_ITEM_DND_TYPE,
        viewTabId: "view-tab-1",
        panelId: panel.id,
        origin: "rail",
      };
      useEpicDndStore.getState().canvasDragStarted(source, null);
      render(<EpicRootDragOverlayContent />);

      const marker = overlayMarker();
      expect(marker.contains(screen.getByText(panel.title))).toBe(true);
    });
  });

  describe("header-tab drag overlay for a split group", () => {
    const LEFT: TabRef = { kind: "epic", id: "epic-left" };
    const RIGHT: TabRef = { kind: "epic", id: "epic-right" };

    function seedSplitGroup(
      focusedSide: "left" | "right",
      right: { readonly kind: "tab" } | { readonly kind: "unavailable" },
    ): void {
      useEpicCanvasStore
        .getState()
        .seedEpic("epic-left", { tabId: "epic-left", name: "Left Epic" }, []);
      if (right.kind === "tab") {
        useEpicCanvasStore
          .getState()
          .seedEpic(
            "epic-right",
            { tabId: "epic-right", name: "Right Epic" },
            [],
          );
      }
      useTabsStore.setState({
        version: 2,
        items: [
          {
            kind: "split",
            id: "split-1",
            left: { kind: "tab", ref: LEFT },
            right:
              right.kind === "tab"
                ? { kind: "tab", ref: RIGHT }
                : {
                    kind: "unavailable",
                    previousRef: RIGHT,
                    label: "Tab unavailable",
                  },
            focusedSide,
            routeBackingSide: focusedSide,
            leftRatio: 0.5,
          },
        ],
        activeItemId: "split-1",
        stripOrder: right.kind === "tab" ? [LEFT, RIGHT] : [LEFT],
        systemTabs: { history: null, settings: null },
      });
    }

    let queryClient: QueryClient;

    // The shared visual reaches the notification-indicator hook, so every
    // header-tab overlay needs a QueryClient, even tests unrelated to it.
    function renderOverlay(): void {
      render(
        <QueryClientProvider client={queryClient}>
          <EpicRootDragOverlayContent />
        </QueryClientProvider>,
      );
    }

    beforeEach(() => {
      queryClient = new QueryClient();
    });

    afterEach(() => {
      queryClient.clear();
      useTabsStore.setState(useTabsStore.getInitialState(), true);
      useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    });

    it("keeps both members' titles at the measured group width, instead of collapsing to one stretched title", () => {
      seedSplitGroup("left", { kind: "tab" });
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "split-1",
          tabKind: "epic",
          tabId: "epic-left",
          index: 0,
        },
        480,
      );
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      expect(within(overlay).getByText("Left Epic")).toBeTruthy();
      expect(within(overlay).getByText("Right Epic")).toBeTruthy();
      expect(overlay.style.width).toBe("480px");
    });

    it("shows the focus icon and underline for the side the store says is focused", () => {
      seedSplitGroup("right", { kind: "tab" });
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "split-1",
          tabKind: "epic",
          tabId: "epic-right",
          index: 0,
        },
        480,
      );
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      const indicator = within(overlay).getByTestId(
        "split-focus-indicator-split-1",
      );
      expect(indicator.dataset.focusedSide).toBe("right");
      const underline = within(overlay).getByTestId(
        "split-tab-group-underline-right-split-1",
      );
      expect(underline.className).not.toContain("bg-primary");
      const leftUnderline = within(overlay).getByTestId(
        "split-tab-group-underline-left-split-1",
      );
      expect(leftUnderline.className).toContain("bg-primary");
    });

    it("preserves an unavailable placeholder member instead of collapsing it", () => {
      seedSplitGroup("left", { kind: "unavailable" });
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "split-1",
          tabKind: "epic",
          tabId: "epic-left",
          index: 0,
        },
        480,
      );
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      expect(within(overlay).getByText("Left Epic")).toBeTruthy();
      expect(within(overlay).getByText("Tab unavailable")).toBeTruthy();
    });

    function rect(left: number, top: number, right: number, bottom: number) {
      return {
        x: left,
        y: top,
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
        toJSON: () => ({}),
      };
    }

    it("offsets the preview root by the grabbed right member's position within the group frame", () => {
      seedSplitGroup("right", { kind: "tab" });

      // Supply the source nodes without mounting the full interactive strip.
      const frame = document.createElement("div");
      frame.setAttribute("data-strip-item-id", "split-1");
      const member = document.createElement("div");
      member.setAttribute("data-tab-kind", "epic");
      member.setAttribute("data-testid", "tab-epic-epic-right");
      frame.appendChild(member);
      document.body.appendChild(frame);
      const frameRectSpy = vi
        .spyOn(frame, "getBoundingClientRect")
        .mockReturnValue(rect(100, 0, 101, 40));
      const memberRectSpy = vi
        .spyOn(member, "getBoundingClientRect")
        .mockReturnValue(rect(340, 0, 341, 40));

      try {
        useEpicDndStore.getState().headerTabDragStarted(
          {
            kind: "header-tab",
            stripItemId: "split-1",
            tabKind: "epic",
            tabId: "epic-right",
            index: 0,
          },
          480,
        );
        renderOverlay();

        const overlay = screen.getByTestId("header-tab-drag-overlay");
        // frame.left (100) - member.left (340): the preview paints back at the
        // group's origin instead of the grabbed member's own, narrower slot.
        expect(overlay.style.transform).toBe("translateX(-240px)");
        expect(overlay.style.width).toBe("480px");
        expect(within(overlay).getByText("Left Epic")).toBeTruthy();
        expect(within(overlay).getByText("Right Epic")).toBeTruthy();
      } finally {
        frameRectSpy.mockRestore();
        memberRectSpy.mockRestore();
        frame.remove();
      }
    });

    it("still renders the plain single-title overlay for an ordinary (non-split) tab drag", () => {
      useEpicCanvasStore
        .getState()
        .seedEpic("epic-solo", { tabId: "epic-solo", name: "Solo Epic" }, []);
      useTabsStore.setState({
        version: 2,
        items: [
          {
            kind: "tab",
            id: "tab:epic:epic-solo",
            ref: { kind: "epic", id: "epic-solo" },
          },
        ],
        activeItemId: "tab:epic:epic-solo",
        stripOrder: [{ kind: "epic", id: "epic-solo" }],
        systemTabs: { history: null, settings: null },
      });
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "tab:epic:epic-solo",
          tabKind: "epic",
          tabId: "epic-solo",
          index: 0,
        },
        220,
      );
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      expect(within(overlay).getByText("Solo Epic")).toBeTruthy();
      // Regex, not the literal "split-1" id: an accidental split render under
      // any other id would still be a defect and must still fail this.
      expect(screen.queryByTestId(/^split-focus-indicator-/)).toBeNull();
      expect(overlay.style.width).toBe("220px");
    });

    it("renders as inactive when a different ordinary tab, not the split group, is the active strip item", () => {
      const OTHER: TabRef = { kind: "epic", id: "epic-other" };
      useEpicCanvasStore
        .getState()
        .seedEpic("epic-left", { tabId: "epic-left", name: "Left Epic" }, []);
      useEpicCanvasStore
        .getState()
        .seedEpic(
          "epic-right",
          { tabId: "epic-right", name: "Right Epic" },
          [],
        );
      useEpicCanvasStore
        .getState()
        .seedEpic(
          "epic-other",
          { tabId: "epic-other", name: "Other Epic" },
          [],
        );
      useTabsStore.setState({
        version: 2,
        items: [
          {
            kind: "split",
            id: "split-1",
            left: { kind: "tab", ref: LEFT },
            right: { kind: "tab", ref: RIGHT },
            focusedSide: "right",
            routeBackingSide: "right",
            leftRatio: 0.5,
          },
          { kind: "tab", id: "tab:epic:epic-other", ref: OTHER },
        ],
        activeItemId: "tab:epic:epic-other",
        stripOrder: [LEFT, RIGHT, OTHER],
        systemTabs: { history: null, settings: null },
      });
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "split-1",
          tabKind: "epic",
          tabId: "epic-right",
          index: 0,
        },
        480,
      );
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      expect(within(overlay).getByText("Left Epic")).toBeTruthy();
      expect(within(overlay).getByText("Right Epic")).toBeTruthy();
      expect(
        within(overlay).getByTestId("split-tab-divider-split-1"),
      ).toBeTruthy();
      const leftUnderline = within(overlay).getByTestId(
        "split-tab-group-underline-left-split-1",
      );
      const rightUnderline = within(overlay).getByTestId(
        "split-tab-group-underline-right-split-1",
      );
      expect(leftUnderline.className).toContain("bg-primary");
      expect(rightUnderline.className).toContain("bg-primary");
      expect(within(overlay).queryByTestId("tab-chrome-center")).toBeNull();

      act(() => {
        useTabsStore.setState({ activeItemId: "split-1" });
      });

      expect(
        within(overlay).queryByTestId("split-tab-divider-split-1"),
      ).toBeNull();
      expect(leftUnderline.className).toContain("bg-primary");
      expect(rightUnderline.className).not.toContain("bg-primary");
      expect(within(overlay).getByTestId("tab-chrome-center")).toBeTruthy();
    });

    (
      [
        { side: "left", origin: 100, groupOffset: 0 },
        { side: "right", origin: 340, groupOffset: -240 },
      ] as const
    ).forEach(({ side, origin, groupOffset }) => {
      it(`switches to just the grabbed ${side} member at its measured width on tear-off, and restores the full group on reentry`, () => {
        seedSplitGroup("right", { kind: "tab" });
        const draggedId = side === "left" ? "epic-left" : "epic-right";
        const draggedTitle = side === "left" ? "Left Epic" : "Right Epic";
        const otherTitle = side === "left" ? "Right Epic" : "Left Epic";

        const frame = document.createElement("div");
        frame.setAttribute("data-strip-item-id", "split-1");
        const member = document.createElement("div");
        member.setAttribute("data-tab-kind", "epic");
        member.setAttribute("data-testid", `tab-epic-${draggedId}`);
        frame.appendChild(member);
        document.body.appendChild(frame);
        const frameRectSpy = vi
          .spyOn(frame, "getBoundingClientRect")
          .mockReturnValue(rect(100, 0, 101, 40));
        const memberRectSpy = vi
          .spyOn(member, "getBoundingClientRect")
          .mockReturnValue(rect(origin, 0, origin + 190, 40));

        try {
          useEpicDndStore.getState().headerTabDragStarted(
            {
              kind: "header-tab",
              stripItemId: "split-1",
              tabKind: "epic",
              tabId: draggedId,
              index: 0,
            },
            480,
          );
          renderOverlay();
          const overlay = screen.getByTestId("header-tab-drag-overlay");

          expect(within(overlay).getByText("Left Epic")).toBeTruthy();
          expect(within(overlay).getByText("Right Epic")).toBeTruthy();
          expect(overlay.style.transform).toBe(`translateX(${groupOffset}px)`);
          expect(overlay.style.width).toBe("480px");

          act(() => {
            useEpicDndStore.getState().headerTearOffPreviewChanged(true);
          });

          expect(within(overlay).getByText(draggedTitle)).toBeTruthy();
          expect(within(overlay).queryByText(otherTitle)).toBeNull();
          expect(overlay.style.transform).toBe("translateX(0px)");
          expect(overlay.style.width).toBe("190px");

          // Captured once: re-mocking the rects after the first measurement
          // must not move either number in either direction below.
          frameRectSpy.mockReturnValue(rect(999, 0, 1000, 40));
          memberRectSpy.mockReturnValue(rect(2000, 0, 2500, 40));

          act(() => {
            useEpicDndStore.getState().headerTearOffPreviewChanged(false);
          });
          expect(within(overlay).getByText("Left Epic")).toBeTruthy();
          expect(within(overlay).getByText("Right Epic")).toBeTruthy();
          expect(overlay.style.transform).toBe(`translateX(${groupOffset}px)`);
          expect(overlay.style.width).toBe("480px");

          act(() => {
            useEpicDndStore.getState().headerTearOffPreviewChanged(true);
          });
          expect(overlay.style.transform).toBe("translateX(0px)");
          expect(overlay.style.width).toBe("190px");
        } finally {
          frameRectSpy.mockRestore();
          memberRectSpy.mockRestore();
          frame.remove();
        }
      });
    });

    it("resets headerTearOffPreview when a new drag starts or the current one ends", () => {
      seedSplitGroup("right", { kind: "tab" });
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "split-1",
          tabKind: "epic",
          tabId: "epic-right",
          index: 0,
        },
        480,
      );
      useEpicDndStore.getState().headerTearOffPreviewChanged(true);
      expect(useEpicDndStore.getState().headerTearOffPreview).toBe(true);

      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "split-1",
          tabKind: "epic",
          tabId: "epic-left",
          index: 0,
        },
        480,
      );
      expect(useEpicDndStore.getState().headerTearOffPreview).toBe(false);

      useEpicDndStore.getState().headerTearOffPreviewChanged(true);
      expect(useEpicDndStore.getState().headerTearOffPreview).toBe(true);

      useEpicDndStore.getState().dragEnded();
      expect(useEpicDndStore.getState().headerTearOffPreview).toBe(false);
    });
  });

  describe("header-tab overlay shares the strip's live visual", () => {
    const EPIC_ID = "epic-under-test";
    const PARTNER_ID = "epic-partner";

    function seedEpicTab(name: string): void {
      useEpicCanvasStore
        .getState()
        .seedEpic(EPIC_ID, { tabId: EPIC_ID, name }, []);
    }

    /** No inbound call is expected: these tests only ever write via `setState`. */
    const INERT_RUNTIME: EpicRuntimeBinding = {
      port: {
        call: () => {
          throw new Error("Unexpected runtime call");
        },
      },
      command: () => {},
      awarenessOut: () => {},
      currentUser: () => {},
      detach: () => {},
      dispose: () => {},
    };

    function liveChatsFor(
      liveAgentIds: ReadonlyArray<string>,
    ): Record<string, ChatProjection> {
      return Object.fromEntries(
        liveAgentIds.map((id) => [
          id,
          {
            id,
            title: id,
            parentId: null,
            createdAt: 1,
            updatedAt: 1,
            userId: null,
            hostId: "host-a",
            isTitleEditedByUser: false,
            docResident: null,
            settings: null,
            archivedAt: null,
          } satisfies ChatProjection,
        ]),
      );
    }

    /** Registers (or reuses) a real store for EPIC_ID and pushes live state onto it. */
    function registerLiveEpic(
      title: string,
      liveAgentIds: ReadonlyArray<string>,
    ): OpenEpicStoreHandle {
      const handle = __getOpenEpicRegistryForTests().acquire(EPIC_ID, () =>
        createOpenEpicStore({
          epicId: EPIC_ID,
          hostId: "test-host",
          userId: null,
          onRetryTransport: () => {},
          onWakeTransport: () => {},
          runtime: INERT_RUNTIME,
          accounting: createRecordingAccountingPort().port,
        }),
      );
      handle.store.setState({
        epic: { title, updatedAt: 1 },
        chats: { byId: liveChatsFor(liveAgentIds), allIds: liveAgentIds },
      });
      return handle;
    }

    interface Scenario {
      readonly label: string;
      readonly stripItemId: string;
      readonly seedTabs: (name: string) => void;
    }

    const scenarios: ReadonlyArray<Scenario> = [
      {
        label: "ordinary",
        stripItemId: `tab:epic:${EPIC_ID}`,
        seedTabs: (name) => {
          seedEpicTab(name);
          useTabsStore.setState({
            version: 2,
            items: [
              {
                kind: "tab",
                id: `tab:epic:${EPIC_ID}`,
                ref: { kind: "epic", id: EPIC_ID },
              },
            ],
            activeItemId: `tab:epic:${EPIC_ID}`,
            stripOrder: [{ kind: "epic", id: EPIC_ID }],
            systemTabs: { history: null, settings: null },
          });
        },
      },
      {
        label: "split",
        stripItemId: "split-under-test",
        seedTabs: (name) => {
          seedEpicTab(name);
          useEpicCanvasStore
            .getState()
            .seedEpic(PARTNER_ID, { tabId: PARTNER_ID, name: "Partner" }, []);
          useTabsStore.setState({
            version: 2,
            items: [
              {
                kind: "split",
                id: "split-under-test",
                left: { kind: "tab", ref: { kind: "epic", id: EPIC_ID } },
                right: { kind: "tab", ref: { kind: "epic", id: PARTNER_ID } },
                focusedSide: "left",
                routeBackingSide: "left",
                leftRatio: 0.5,
              },
            ],
            activeItemId: "split-under-test",
            stripOrder: [
              { kind: "epic", id: EPIC_ID },
              { kind: "epic", id: PARTNER_ID },
            ],
            systemTabs: { history: null, settings: null },
          });
        },
      },
    ];

    let queryClient: QueryClient;

    function renderOverlay(): void {
      render(
        <QueryClientProvider client={queryClient}>
          <EpicRootDragOverlayContent />
        </QueryClientProvider>,
      );
    }

    function startDrag(scenario: Scenario): void {
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: scenario.stripItemId,
          tabKind: "epic",
          tabId: EPIC_ID,
          index: 0,
        },
        400,
      );
    }

    beforeEach(() => {
      queryClient = new QueryClient();
    });

    afterEach(() => {
      cleanup();
      queryClient.clear();
      hostIndicatorTestState.data = { epics: {}, chats: {} };
      useTabsStore.setState(useTabsStore.getInitialState(), true);
      useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
      useEpicCanvasStore.getState().clearAllTitleGenerationPending();
      __getOpenEpicRegistryForTests().disposeAll();
      __resetAppLocalNotificationsStoreForTests();
      resetAgentActivity();
    });

    scenarios.forEach((scenario) => {
      describe(scenario.label, () => {
        it("shows the live registered title, not the stale projected one, and follows a live rename", () => {
          scenario.seedTabs("Stale Title");
          const handle = registerLiveEpic("Live Title", []);
          startDrag(scenario);
          renderOverlay();

          const overlay = screen.getByTestId("header-tab-drag-overlay");
          expect(within(overlay).getByText("Live Title")).toBeTruthy();
          expect(within(overlay).queryByText("Stale Title")).toBeNull();

          act(() => {
            handle.store.setState({
              epic: { title: "Renamed Title", updatedAt: 2 },
            });
          });
          expect(within(overlay).getByText("Renamed Title")).toBeTruthy();
          expect(within(overlay).queryByText("Live Title")).toBeNull();
        });

        it("shows the title-generating spinner while a title is pending", () => {
          scenario.seedTabs("Draft Title");
          useEpicCanvasStore
            .getState()
            .markEpicTitlePending(EPIC_ID, "Draft Title");
          startDrag(scenario);
          renderOverlay();

          const overlay = screen.getByTestId("header-tab-drag-overlay");
          expect(
            within(overlay).getByTestId(
              `header-tab-title-generating-${EPIC_ID}`,
            ),
          ).toBeTruthy();
        });

        it("shows the activity glyph while a chat is active", () => {
          scenario.seedTabs("Active Epic");
          registerLiveEpic("Active Epic", ["chat-active"]);
          publishAgentActivity([
            {
              hostId: "host-a",
              byEpic: {
                [EPIC_ID]: { working: ["chat-active"], turn: ["chat-active"] },
              },
            },
          ]);
          startDrag(scenario);
          renderOverlay();

          const overlay = screen.getByTestId("header-tab-drag-overlay");
          expect(
            within(overlay).getByTestId(`header-tab-activity-${EPIC_ID}`),
          ).toBeTruthy();
        });

        it("shows the app-local failure glyph", () => {
          scenario.seedTabs("Failing Epic");
          useAppLocalNotificationsStore.getState().activateIdentity("user-1");
          useAppLocalNotificationsStore.getState().upsert({
            id: "chat-failure",
            updatedAt: 1,
            readAt: null,
            kind: "stream.transport.error",
            sourceRef: "chat-1",
            payload: { kind: "chat", epicId: EPIC_ID, chatId: "chat-1" },
            message: "Chat failed",
            detail: null,
          });
          startDrag(scenario);
          renderOverlay();

          const overlay = screen.getByTestId("header-tab-drag-overlay");
          expect(
            within(overlay).getByTestId(`header-tab-failure-${EPIC_ID}`),
          ).toBeTruthy();
        });
      });
    });

    it("shows a host-driven indicator through the provider", () => {
      const ordinary = scenarios[0];
      ordinary.seedTabs("Host Indicator Epic");
      hostIndicatorTestState.data = {
        epics: {
          [EPIC_ID]: {
            pendingApproval: false,
            pendingInterview: false,
            unreadFailure: false,
            unreadDone: true,
            pendingFork: false,
          },
        },
        chats: {},
      };
      startDrag(ordinary);
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      expect(
        within(overlay).getByTestId(`header-tab-done-${EPIC_ID}`),
      ).toBeTruthy();
    });

    it("renders nothing when the strip item id no longer resolves, even with a valid tabId", () => {
      const ordinary = scenarios[0];
      ordinary.seedTabs("Orphaned Tab");
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "stale-strip-item-id",
          tabKind: "epic",
          tabId: EPIC_ID,
          index: 0,
        },
        400,
      );
      renderOverlay();

      expect(screen.queryByTestId("header-tab-drag-overlay")).toBeNull();
    });
  });
});
