import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraggable } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import { EpicRootDragOverlayContent } from "@/components/epic-canvas/dnd/drag-overlay-chip";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import { EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE } from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import {
  HEADER_TAB_DND_TYPE,
  getHeaderTabDragId,
  type HeaderTabDragData,
} from "@/components/layout/tabs/header-tab-dnd";
import { HEADER_STRIP_SCROLL_TEST_ID } from "@/components/layout/tabs/header-strip-geometry";
import {
  publishTabDetachHandler,
  resetTabDetachHandler,
} from "@/components/layout/tabs/tab-detach-channel";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
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

    /**
     * A rail icon drags as its own tile (`LEFT_PANEL_RAIL_TILE_CLASS`, so
     * `size-9`), not the old titled chip: a chip three tiles wide covered the
     * neighbours and the drop line the user was aiming at.
     */
    it("wraps the left-panel rail tile, drawn with no title text", () => {
      const panel = LEFT_PANEL_DEFINITIONS.find(
        (definition) => definition.id === "terminals",
      );
      if (panel === undefined) throw new Error("no terminals panel definition");
      const source: EpicCanvasLeftPanelRailDragData = {
        kind: LEFT_PANEL_RAIL_ITEM_DND_TYPE,
        viewTabId: "view-tab-1",
        panelId: panel.id,
        origin: "rail",
      };
      useEpicDndStore.getState().canvasDragStarted(source, null);
      render(<EpicRootDragOverlayContent />);

      const marker = overlayMarker();
      const overlay = screen.getByTestId("left-panel-rail-drag-overlay");
      expect(marker.contains(overlay)).toBe(true);
      expect(overlay.className).toContain("size-9");
      expect(overlay.querySelector("svg")).not.toBeNull();
      expect(screen.queryByText(panel.title)).toBeNull();
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
      __resetTabNavigationControllerForTesting();
    });

    afterEach(() => {
      queryClient.clear();
      resetTabDetachHandler();
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
        { width: 480, height: 36 },
        "x",
        null,
      );
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      expect(within(overlay).getByText("Left Epic")).toBeTruthy();
      expect(within(overlay).getByText("Right Epic")).toBeTruthy();
      expect(overlay.style.width).toBe("480px");
    });

    it("shows the focus icon and box for the side the store says is focused", () => {
      seedSplitGroup("right", { kind: "tab" });
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "split-1",
          tabKind: "epic",
          tabId: "epic-right",
          index: 0,
        },
        { width: 480, height: 36 },
        "x",
        null,
      );
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      const indicator = within(overlay).getByTestId(
        "split-focus-indicator-split-1",
      );
      expect(indicator.dataset.focusedSide).toBe("right");
      // F4 round 2 dropped the group underline; the focused member's own box
      // is now what says which side is focused.
      const leftMember = overlay.querySelector<HTMLElement>(
        '[data-split-member="left"]',
      );
      const rightMember = overlay.querySelector<HTMLElement>(
        '[data-split-member="right"]',
      );
      if (leftMember === null || rightMember === null) {
        throw new Error("expected both split members");
      }
      expect(within(leftMember).queryByTestId("tab-chrome-box")).toBeNull();
      expect(within(rightMember).getByTestId("tab-chrome-box")).toBeTruthy();
    });

    it("carries the captured manual appearance and notification snapshot into the split preview", () => {
      seedSplitGroup("left", { kind: "tab" });
      useEpicDndStore.getState().headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "split-1",
          tabKind: "epic",
          tabId: "epic-left",
          index: 0,
        },
        { width: 480, height: 36 },
        "x",
        {
          appearance: { color: "#654321", icon: "🚀" },
          indicatorState: {
            unreadFailure: false,
            unreadNonTerminalFailure: false,
            unreadTerminalFailure: false,
            pendingFork: false,
            pendingApproval: true,
            pendingInterview: false,
            unreadDone: false,
          },
        },
      );
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      expect(within(overlay).getByText("🚀")).toBeTruthy();
      // `--swatch-border`, not `borderTopColor` - see the note in
      // `tab-strip-drag-overlay.test.tsx`.
      expect(
        within(overlay)
          .getByTestId("tab-chrome-box")
          .style.getPropertyValue("--swatch-border"),
      ).toBe("#654321");
      expect(
        within(overlay).getByTestId("header-tab-approval-epic-left"),
      ).toBeTruthy();
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
        { width: 480, height: 36 },
        "x",
        null,
      );
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      expect(within(overlay).getByText("Left Epic")).toBeTruthy();
      expect(within(overlay).getByText("Tab unavailable")).toBeTruthy();
    });

    interface Rect {
      readonly x: number;
      readonly y: number;
      readonly left: number;
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
      readonly width: number;
      readonly height: number;
      readonly toJSON: () => Record<string, never>;
    }

    /** `(left, top, width, height)` - the shape `getBoundingClientRect` returns. */
    function rect(
      left: number,
      top: number,
      width: number,
      height: number,
    ): Rect {
      return {
        x: left,
        y: top,
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
      };
    }

    function withRouter(harness: () => ReactNode) {
      const rootRoute = createRootRoute({ component: harness });
      const home = createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => null,
      });
      return createRouter({
        routeTree: rootRoute.addChildren([home]),
        history: createMemoryHistory({ initialEntries: ["/"] }),
      });
    }

    /**
     * A minimal real strip: the FRAME carries `data-strip-item-id`, each
     * member is its own `useDraggable` root carrying the `data-tab-kind`/
     * `data-testid` pair `SplitTabDragOverlay`'s own width capture looks up -
     * the same shape `header-strip-drag-overlay-origin.test.tsx` uses for the
     * frame-vs-member origin fix, extended so the REAL overlay component (not
     * a bare positioned wrapper) can resolve its dragged member too.
     */
    function SplitFrameStrip(): ReactNode {
      const dataFor = (tabId: string): HeaderTabDragData => ({
        kind: HEADER_TAB_DND_TYPE,
        stripItemId: "split-1",
        tabKind: "epic",
        tabId,
        index: 0,
      });
      const { setNodeRef: setLeftRef, listeners: leftListeners } = useDraggable(
        {
          id: getHeaderTabDragId("epic", "epic-left"),
          data: dataFor("epic-left"),
        },
      );
      const { setNodeRef: setRightRef, listeners: rightListeners } =
        useDraggable({
          id: getHeaderTabDragId("epic", "epic-right"),
          data: dataFor("epic-right"),
        });
      return (
        <div
          data-testid={HEADER_STRIP_SCROLL_TEST_ID}
          data-strip-axis="x"
          data-strip-edge="top"
        >
          <div data-strip-item-id="split-1" data-strip-item-mergeable="false">
            <button
              ref={setLeftRef}
              data-tab-kind="epic"
              data-testid="tab-epic-epic-left"
              {...leftListeners}
            >
              left
            </button>
            <button
              ref={setRightRef}
              data-tab-kind="epic"
              data-testid="tab-epic-epic-right"
              {...rightListeners}
            >
              right
            </button>
          </div>
        </div>
      );
    }

    interface SplitDragRects {
      readonly stripRect: Rect;
      readonly frameRect: Rect;
      readonly leftMemberRect: Rect;
      readonly rightMemberRect: Rect;
    }

    interface SplitDragMount {
      readonly leftEl: HTMLElement;
      readonly rightEl: HTMLElement;
      readonly setFrameRect: (next: Rect) => void;
      readonly setMemberRect: (side: "left" | "right", next: Rect) => void;
    }

    /** Mounts the REAL `RootDndProvider` + `EpicRootDragOverlayContent` over `SplitFrameStrip`. */
    async function mountRealSplitDrag(
      rects: SplitDragRects,
    ): Promise<SplitDragMount> {
      const router = withRouter(() => (
        <QueryClientProvider client={queryClient}>
          <RootDndProvider>
            <SplitFrameStrip />
          </RootDndProvider>
        </QueryClientProvider>
      ));
      await act(async () => {
        render(<RouterProvider router={router} />);
        await router.load();
      });
      const strip = screen.getByTestId(HEADER_STRIP_SCROLL_TEST_ID);
      vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(rects.stripRect);
      const frame = strip.querySelector<HTMLElement>(
        '[data-strip-item-id="split-1"]',
      );
      if (frame === null) throw new Error("expected split frame");
      const frameSpy = vi
        .spyOn(frame, "getBoundingClientRect")
        .mockReturnValue(rects.frameRect);
      const leftEl = screen.getByTestId("tab-epic-epic-left");
      const rightEl = screen.getByTestId("tab-epic-epic-right");
      const leftSpy = vi
        .spyOn(leftEl, "getBoundingClientRect")
        .mockReturnValue(rects.leftMemberRect);
      const rightSpy = vi
        .spyOn(rightEl, "getBoundingClientRect")
        .mockReturnValue(rects.rightMemberRect);
      return {
        leftEl,
        rightEl,
        setFrameRect: (next) => frameSpy.mockReturnValue(next),
        setMemberRect: (side, next) =>
          (side === "left" ? leftSpy : rightSpy).mockReturnValue(next),
      };
    }

    interface Drag {
      readonly source: HTMLElement;
      readonly pointerId: number;
    }

    /** Press at `(x, y)` on `source`, then cross the activation distance along x. */
    function pressAndActivate(
      source: HTMLElement,
      x: number,
      y: number,
      pointerId: number,
    ): Drag {
      act(() => {
        fireEvent.pointerDown(source, {
          pointerId,
          isPrimary: true,
          button: 0,
          clientX: x,
          clientY: y,
        });
      });
      act(() => {
        fireEvent.pointerMove(source, {
          pointerId,
          clientX: x + EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE + 50,
          clientY: y,
        });
      });
      return { source, pointerId };
    }

    function moveTo(drag: Drag, x: number, y: number): void {
      act(() => {
        fireEvent.pointerMove(drag.source, {
          pointerId: drag.pointerId,
          clientX: x,
          clientY: y,
        });
      });
    }

    function releaseAt(drag: Drag, x: number, y: number): void {
      act(() => {
        fireEvent.pointerUp(drag.source, {
          pointerId: drag.pointerId,
          clientX: x,
          clientY: y,
        });
      });
    }

    /** The one fixed, translate3d-transformed element dnd-kit's `DragOverlay` positions. */
    function outerOverlayElement(): HTMLElement {
      const overlays = [...document.querySelectorAll<HTMLElement>("*")].filter(
        (node) =>
          node.style.position === "fixed" &&
          node.style.transform.startsWith("translate3d("),
      );
      expect(overlays.length).toBe(1);
      return overlays[0];
    }

    /**
     * The overlay's EFFECTIVE rendered position: the outer dnd-kit wrapper's
     * frozen `top`/`left` plus its `translate3d`, PLUS any leftover transform
     * on `SplitTabDragOverlay`'s own root (`header-tab-drag-overlay`) - which
     * must be empty now that the frame-vs-member correction lives solely on
     * the outer wrapper (the deleted DOM `translateX` hack). Summing both
     * catches a regression that reintroduces a correction on the inner
     * element too, which would double it, rather than reading only the layer
     * that happens to still be right.
     */
    function renderedOverlayPosition(): { top: number; left: number } {
      const outer = outerOverlayElement();
      const match = /^translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\)/.exec(
        outer.style.transform,
      );
      if (match === null) {
        throw new Error(
          `unexpected overlay transform: ${outer.style.transform}`,
        );
      }
      const inner = within(outer).getByTestId("header-tab-drag-overlay");
      const innerMatch = /translateX\(([-\d.]+)px\)/.exec(
        inner.style.transform,
      );
      const innerOffset = innerMatch === null ? 0 : Number(innerMatch[1]);
      return {
        top: parseFloat(outer.style.top) + Number(match[2]),
        left: parseFloat(outer.style.left) + Number(match[1]) + innerOffset,
      };
    }

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
        { width: 220, height: 36 },
        "x",
        null,
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
        { width: 480, height: 36 },
        "x",
        null,
      );
      renderOverlay();

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      expect(within(overlay).getByText("Left Epic")).toBeTruthy();
      expect(within(overlay).getByText("Right Epic")).toBeTruthy();
      expect(
        within(overlay).getByTestId("split-tab-divider-split-1"),
      ).toBeTruthy();
      expect(within(overlay).queryByTestId("tab-chrome-box")).toBeNull();

      act(() => {
        useTabsStore.setState({ activeItemId: "split-1" });
      });

      expect(
        within(overlay).queryByTestId("split-tab-divider-split-1"),
      ).toBeNull();
      expect(within(overlay).getByTestId("tab-chrome-box")).toBeTruthy();
    });

    [
      { side: "left", origin: 100 } as const,
      { side: "right", origin: 340 } as const,
    ].forEach(({ side, origin }) => {
      it(`switches to just the grabbed ${side} member at its measured width on tear-off, and restores the full group on reentry`, async () => {
        seedSplitGroup("right", { kind: "tab" });
        const requestOpen = vi.fn();
        publishTabDetachHandler({ isAvailable: true, requestOpen });
        const draggedTitle = side === "left" ? "Left Epic" : "Right Epic";
        const otherTitle = side === "left" ? "Right Epic" : "Left Epic";

        const mount = await mountRealSplitDrag({
          stripRect: rect(0, 0, 1000, 40),
          frameRect: rect(100, 0, 480, 40),
          leftMemberRect: rect(100, 0, 190, 40),
          rightMemberRect: rect(340, 0, 190, 40),
        });
        const draggedEl = side === "left" ? mount.leftEl : mount.rightEl;

        const drag = pressAndActivate(draggedEl, origin, 16, 32);
        moveTo(drag, origin + 10, 16); // +10px right of press

        // Only exists once the drag is active - `EpicRootDragOverlayContent`
        // renders nothing for a null `activeHeaderTab`.
        const overlay = screen.getByTestId("header-tab-drag-overlay");
        expect(within(overlay).getByText("Left Epic")).toBeTruthy();
        expect(within(overlay).getByText("Right Epic")).toBeTruthy();
        expect(renderedOverlayPosition()).toEqual({ top: 0, left: 110 });
        expect(overlay.style.width).toBe("480px");

        // Past the strip's band on the cross axis (y): the app's own
        // `onDragMove` effect flips the store flag AFTER this event's
        // modifier already ran, so the overlay only reflects tear-off on the
        // NEXT dnd-kit-driven position update - a second move at the same
        // point exercises exactly that (mirrors the vertical-strip sibling
        // regression in `header-strip-drag-overlay-origin.test.tsx`).
        moveTo(drag, origin + 10, 200);
        expect(useEpicDndStore.getState().headerTearOffPreview).toBe(true);
        moveTo(drag, origin + 10, 200);

        expect(within(overlay).getByText(draggedTitle)).toBeTruthy();
        expect(within(overlay).queryByText(otherTitle)).toBeNull();
        expect(overlay.style.width).toBe("190px");
        // Tear-off keeps the grabbed member under the pointer.
        expect(renderedOverlayPosition()).toEqual({
          top: 0,
          left: origin + 10,
        });

        // Captured once: re-mocking the rects after the first measurement
        // must not move either number in either direction below.
        mount.setFrameRect(rect(999, 0, 1, 40));
        mount.setMemberRect(side, rect(2000, 0, 1, 40));

        moveTo(drag, origin + 10, 16);
        expect(useEpicDndStore.getState().headerTearOffPreview).toBe(false);
        moveTo(drag, origin + 10, 16);

        expect(within(overlay).getByText("Left Epic")).toBeTruthy();
        expect(within(overlay).getByText("Right Epic")).toBeTruthy();
        expect(overlay.style.width).toBe("480px");
        expect(renderedOverlayPosition()).toEqual({ top: 0, left: 110 });

        // A second tear-off: still member-relative, still the ORIGINALLY
        // captured width, immune to the remock above.
        moveTo(drag, origin + 10, 200);
        moveTo(drag, origin + 10, 200);
        expect(overlay.style.width).toBe("190px");
        expect(renderedOverlayPosition()).toEqual({
          top: 0,
          left: origin + 10,
        });

        releaseAt(drag, origin + 10, 200);
        expect(requestOpen).toHaveBeenCalledTimes(1);
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
        { width: 480, height: 36 },
        "x",
        null,
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
        { width: 480, height: 36 },
        "x",
        null,
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
        { width: 400, height: 36 },
        "x",
        null,
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
        { width: 400, height: 36 },
        "x",
        null,
      );
      renderOverlay();

      expect(screen.queryByTestId("header-tab-drag-overlay")).toBeNull();
    });
  });
});
