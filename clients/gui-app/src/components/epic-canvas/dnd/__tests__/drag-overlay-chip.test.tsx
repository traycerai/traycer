import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EpicRootDragOverlayContent } from "@/components/epic-canvas/dnd/drag-overlay-chip";
import type {
  EpicCanvasGitDiffTileDragData,
  EpicCanvasManagedCommandOutputDragData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  GIT_DIFF_TILE_DND_TYPE,
  MANAGED_COMMAND_OUTPUT_DND_TYPE,
} from "@/components/epic-canvas/dnd/dnd";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
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
});
