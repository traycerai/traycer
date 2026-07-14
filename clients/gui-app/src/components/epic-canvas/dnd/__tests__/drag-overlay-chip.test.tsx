import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EpicRootDragOverlayContent } from "@/components/epic-canvas/dnd/drag-overlay-chip";
import type { EpicCanvasGitDiffTileDragData } from "@/components/epic-canvas/dnd/dnd";
import { GIT_DIFF_TILE_DND_TYPE } from "@/components/epic-canvas/dnd/dnd";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";

describe("<EpicRootDragOverlayContent />", () => {
  beforeEach(() => {
    useEpicDndStore.getState().dragEnded();
  });

  afterEach(() => {
    cleanup();
    useEpicDndStore.getState().dragEnded();
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
