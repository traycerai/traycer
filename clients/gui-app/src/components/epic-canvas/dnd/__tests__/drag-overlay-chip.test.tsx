import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EpicRootDragOverlayContent } from "@/components/epic-canvas/dnd/drag-overlay-chip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
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

    afterEach(() => {
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
      render(<EpicRootDragOverlayContent />);

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
      render(<EpicRootDragOverlayContent />);

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      const indicator = within(overlay).getByTestId(
        "split-focus-indicator-split-1",
      );
      expect(indicator.dataset.focusedSide).toBe("right");
      const underline = within(overlay).getByTestId(
        "split-tab-group-underline-right-split-1",
      );
      expect(underline.className).not.toContain("bg-primary");
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
      render(<EpicRootDragOverlayContent />);

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
        render(<EpicRootDragOverlayContent />);

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
      render(<EpicRootDragOverlayContent />);

      const overlay = screen.getByTestId("header-tab-drag-overlay");
      expect(within(overlay).getByText("Solo Epic")).toBeTruthy();
      expect(screen.queryByTestId("split-focus-indicator-split-1")).toBeNull();
      expect(overlay.style.width).toBe("220px");
    });
  });
});
