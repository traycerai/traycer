import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EpicRootDragOverlayContent } from "@/components/epic-canvas/dnd/drag-overlay-chip";
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
   * Native-view occlusion: a chip that is not inside a `[data-browser-overlay]`
   * element paints UNDER a live browser tile's `WebContentsView`, i.e. it is
   * invisible exactly while it is being dragged over one. The published-chat
   * chip shipped that way when the marker was pasted per chip, so the marker
   * now lives once on the shared overlay wrapper and these cases pin that every
   * variant renders inside it - the coordinator matches
   * `[data-browser-overlay]` and uses that element's own rect
   * (`collectBrowserOverlaySurfaces`), so an ancestor counts.
   */
  describe("native-view occlusion marker", () => {
    function overlayMarker(): HTMLElement {
      const markers = document.querySelectorAll<HTMLElement>(
        '[data-browser-overlay="drag-overlay"]',
      );
      // Exactly one: a per-chip marker re-added under this wrapper would nest a
      // second occlusion surface for the same chip, which is the shape the
      // published-chat miss came from.
      expect(markers.length).toBe(1);
      return markers.item(0);
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
      it(`marks the ${tile.type} chip for occlusion`, () => {
        startTileDrag(tile);
        render(<EpicRootDragOverlayContent />);

        const marker = overlayMarker();
        expect(marker.contains(screen.getByText(tile.name))).toBe(true);
      });
    });

    it("marks the git-diff chip for occlusion", () => {
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

    it("marks the workspace-folder chip for occlusion", () => {
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

    it("marks the left-panel rail chip for occlusion", () => {
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
});
