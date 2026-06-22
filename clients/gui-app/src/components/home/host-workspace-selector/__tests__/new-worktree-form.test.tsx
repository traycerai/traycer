import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";

// Drive the form's model from a fixed listBranches payload, no live host.
let branchesData:
  | {
      readonly branches: ReadonlyArray<{
        readonly name: string;
        readonly isCurrent: boolean;
        readonly isRemoteOnly: boolean;
      }>;
      readonly uncommittedFileCount: number;
    }
  | undefined;
let branchesLoading = false;

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: branchesData, isLoading: branchesLoading }),
}));

import { NewWorktreeForm } from "../new-worktree-form";

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
  ],
  scripts: null,
};

function renderForm(
  onEmit: (intent: WorktreeFolderIntent) => void,
  currentIntent: WorktreeFolderIntent | null,
): void {
  renderFormWithSummary(onEmit, currentIntent, SUMMARY);
}

function renderFormWithSummary(
  onEmit: (intent: WorktreeFolderIntent) => void,
  currentIntent: WorktreeFolderIntent | null,
  summary: WorktreeWorkspaceSummary,
): void {
  render(
    <TooltipProvider>
      <NewWorktreeForm
        hostClient={null}
        workspacePath="/repo"
        repoIdentifier={{ owner: "acme", repo: "app" }}
        isPrimary
        summary={summary}
        currentIntent={currentIntent}
        defaultNewBranchName="traycer/swift-otter"
        onEmit={onEmit}
        onCommitted={() => undefined}
      />
    </TooltipProvider>,
  );
}

async function selectSource(name: string): Promise<void> {
  // The source list is inline in the form (always rendered) — pick a row from it.
  const listbox = await screen.findByRole("listbox", {
    name: "Worktree source branch",
  });
  fireEvent.click(within(listbox).getByText(name));
}

afterEach(() => {
  cleanup();
  branchesData = undefined;
  branchesLoading = false;
});

describe("NewWorktreeForm — new-branch name", () => {
  it("working tree source: name required (prefilled), forks on Select", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    // Working tree is the default source → name prefilled with the generated
    // default, placeholder reads "required", Select enabled.
    expect(screen.getByDisplayValue("traycer/swift-otter")).toBeTruthy();
    expect(
      screen
        .getByTestId("new-worktree-branch-name")
        .getAttribute("placeholder"),
    ).toBe("New branch name (required)");
    fireEvent.click(screen.getByTestId("new-worktree-select"));
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "development",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("working tree source: clearing the name disables Select and Enter is inert", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn();
    renderForm(onEmit, null);
    const name = screen.getByTestId("new-worktree-branch-name");
    fireEvent.change(name, { target: { value: "  " } });
    expect(
      screen.getByTestId("new-worktree-select").hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onEmit).not.toHaveBeenCalled();
  });

  it("dirty tree: the 'Working tree' carry source forks WITH carryUncommittedChanges", async () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 3,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    // A dirty tree exposes "Working tree · development" above the clean fork.
    await selectSource("Working tree · development");
    expect(screen.getByDisplayValue("traycer/swift-otter")).toBeTruthy();
    fireEvent.click(screen.getByTestId("new-worktree-select"));
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "development",
          carryUncommittedChanges: true,
        },
      },
    ]);
  });

  it("dirty tree: the default clean fork still forks WITHOUT carry (start fresh)", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 3,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    // Default selection is the clean current-branch fork even when dirty.
    fireEvent.click(screen.getByTestId("new-worktree-select"));
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "development",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("remote source: prefilled name uses the source-specific generated default", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    await selectSource("origin/release-9");
    const name = screen.getByTestId("new-worktree-branch-name");
    expect((name as HTMLInputElement).value).toBe("release-9");
    expect(screen.queryByDisplayValue("traycer/swift-otter")).toBeNull();

    fireEvent.click(screen.getByTestId("new-worktree-select"));
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "release-9",
          source: "origin/release-9",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("does not move a newly selected source to the top until the next open", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, null);
    await selectSource("origin/release-9");
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("development");
  });

  it("moves the staged source to the top on open", () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "release-9",
        source: "origin/release-9",
        carryUncommittedChanges: false,
      },
    });
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("origin/release-9");
  });

  it("local branch source: name required, prefilled, and forks from the source", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    await selectSource("chore/cleanup");
    const name = screen.getByTestId("new-worktree-branch-name");
    expect((name as HTMLInputElement).value).toBe("traycer/swift-otter");
    expect(name.getAttribute("placeholder")).toBe("New branch name (required)");
    const select = screen.getByTestId("new-worktree-select");
    expect(select.hasAttribute("disabled")).toBe(false);
    fireEvent.click(select);
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "chore/cleanup",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("local branch source: clearing the name disables Select", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn();
    renderForm(onEmit, null);
    await selectSource("chore/cleanup");
    const name = screen.getByTestId("new-worktree-branch-name");
    fireEvent.change(name, { target: { value: "  " } });
    expect(
      screen.getByTestId("new-worktree-select").hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onEmit).not.toHaveBeenCalled();
  });

  it("local branch source: a typed name forks from the selected branch", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    await selectSource("chore/cleanup");
    fireEvent.change(screen.getByTestId("new-worktree-branch-name"), {
      target: { value: "feat/forked" },
    });
    fireEvent.click(screen.getByTestId("new-worktree-select"));
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "feat/forked",
          source: "chore/cleanup",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("checked-out sibling branch appears as a selectable source", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "existing_branch_1", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderFormWithSummary((intent) => emitted.push(intent), null, {
      ...SUMMARY,
      worktrees: [
        ...SUMMARY.worktrees,
        {
          worktreePath: "/repo-existing-branch-1",
          branch: "existing_branch_1",
          sourceBranch: "development",
          head: null,
          isMain: false,
          isLocked: false,
        },
      ],
    });
    await selectSource("existing_branch_1");
    fireEvent.click(screen.getByTestId("new-worktree-select"));
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "existing_branch_1",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("arrow keys + Enter select the active source (keyboard nav)", () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    const search = screen.getByRole("combobox", { name: "Search branches" });
    // Default active = the selected current-branch fork (development, index 0);
    // ArrowDown moves to chore/cleanup, Enter selects it WITHOUT leaving the box.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByTestId("new-worktree-select"));
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "chore/cleanup",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("keeps the source options out of the Tab order (tabIndex -1)", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, null);
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("shows a spinner inside the source list while branches are loading", () => {
    branchesLoading = true;
    branchesData = undefined;
    renderForm(() => undefined, null);
    // The popover content is present immediately with a loading affordance, and
    // no branch options render until the fetch resolves.
    expect(screen.getByText("Loading branches…")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("shows the staged new-branch name on open, not a fresh default", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/keep-me",
        source: "development",
        carryUncommittedChanges: false,
      },
    });
    expect(screen.getByDisplayValue("feat/keep-me")).toBeTruthy();
    expect(screen.queryByDisplayValue("traycer/swift-otter")).toBeNull();
  });

  it("disables Select when the form matches the staged worktree, re-enables on edit", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/saved",
        source: "development",
        carryUncommittedChanges: false,
      },
    });
    const select = screen.getByTestId("new-worktree-select");
    expect(select.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByTestId("new-worktree-branch-name"), {
      target: { value: "feat/changed" },
    });
    expect(select.hasAttribute("disabled")).toBe(false);
  });
});

describe("NewWorktreeForm — close on commit", () => {
  function renderWithCommit(onCommitted: () => void): void {
    render(
      <TooltipProvider>
        <NewWorktreeForm
          hostClient={null}
          workspacePath="/repo"
          repoIdentifier={{ owner: "acme", repo: "app" }}
          isPrimary
          summary={SUMMARY}
          currentIntent={null}
          defaultNewBranchName="traycer/swift-otter"
          onEmit={() => undefined}
          onCommitted={onCommitted}
        />
      </TooltipProvider>,
    );
  }

  it("calls onCommitted after a successful Select", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onCommitted = vi.fn();
    renderWithCommit(onCommitted);
    fireEvent.click(screen.getByTestId("new-worktree-select"));
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("calls onCommitted on Enter in the name field", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onCommitted = vi.fn();
    renderWithCommit(onCommitted);
    fireEvent.keyDown(screen.getByTestId("new-worktree-branch-name"), {
      key: "Enter",
    });
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("does not call onCommitted when the form is invalid", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onCommitted = vi.fn();
    renderWithCommit(onCommitted);
    const name = screen.getByTestId("new-worktree-branch-name");
    // Working tree source requires a name — blanking it makes the form invalid.
    fireEvent.change(name, { target: { value: "  " } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onCommitted).not.toHaveBeenCalled();
  });
});
