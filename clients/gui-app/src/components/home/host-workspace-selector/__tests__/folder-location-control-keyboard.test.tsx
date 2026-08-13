import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import { FolderLocationControl } from "@/components/home/host-workspace-selector/folder-location-control";
import type { WorkspaceRunItem } from "@/components/home/host-workspace-selector/workspace-run-item";

const SUMMARY: WorktreeWorkspaceSummary = {
  workspacePath: "/repo",
  isGitRepo: true,
  repoIdentifier: { owner: "acme", repo: "app" },
  mainBranch: "development",
  worktrees: [
    {
      worktreePath: "/repo",
      branch: "development",
      head: null,
      isMain: true,
      isLocked: false,
    },
    ...Array.from({ length: 6 }, (_unused, index) => ({
      worktreePath: `/wt/feature-${index}`,
      branch: index === 4 ? "feature/target" : `feature/${index}`,
      head: null,
      isMain: false,
      isLocked: false,
    })),
  ],
  scripts: null,
};

function workspaceRunItem(
  onEmit: WorkspaceRunItem["onEmit"],
): WorkspaceRunItem {
  return {
    key: "/repo",
    displayName: "repo",
    displayPath: "/repo",
    unresolved: false,
    metadataPending: false,
    missing: false,
    isGitRepo: true,
    mode: "worktree",
    branchLabel: "feature/new",
    summary: SUMMARY,
    currentIntent: null,
    defaultNewBranchName: "traycer/swift-otter",
    branchPrefixWarning: null,
    repoIdentifier: { owner: "acme", repo: "app" },
    isPrimary: true,
    canChangePrimary: true,
    makePrimaryDisabled: false,
    makePrimaryDisabledReason: null,
    hostClient: null,
    modeDisabled: false,
    modeDisabledReason: null,
    removeDisabled: false,
    removeDisabledReason: null,
    removePending: false,
    onSelectMode: () => undefined,
    onEmit,
    onLocate: null,
    onMakePrimary: () => undefined,
    onRemove: null,
  };
}

describe("FolderLocationControl keyboard navigation", () => {
  afterEach(cleanup);

  it("moves from the populated search input into the filtered worktree options", async () => {
    const onEmit = vi.fn();
    render(
      <FolderLocationControl
        item={workspaceRunItem(onEmit)}
        uncommittedByPath={new Map()}
        boundaryEl={null}
        readOnly={false}
      />,
    );

    fireEvent.pointerDown(screen.getByLabelText("Choose run location"), {
      button: 0,
      ctrlKey: false,
    });
    const existingWorktree = await screen.findByTestId(
      "folder-location-existing",
    );
    existingWorktree.focus();
    fireEvent.keyDown(existingWorktree, { key: "ArrowRight" });

    const search = await screen.findByRole("textbox", {
      name: "Search worktrees",
    });
    search.focus();
    fireEvent.change(search, { target: { value: "no matching worktree" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);

    fireEvent.change(search, { target: { value: "feature" } });
    const first = screen.getByTestId("folder-location-import-/wt/feature-0");
    const second = screen.getByTestId("folder-location-import-/wt/feature-1");
    const last = screen.getByTestId("folder-location-import-/wt/feature-5");

    search.focus();
    fireEvent.keyDown(search, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(last));

    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(first));

    fireEvent.keyDown(first, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(second));

    fireEvent.keyDown(second, { key: "Enter" });
    expect(onEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "import",
        worktreePath: "/wt/feature-1",
      }),
    );
  });
});
