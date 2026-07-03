import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import type { RepoTreeSubmoduleNode } from "@/lib/git/git-repo-tree";
import type { GitPanelSelectedRepo } from "@/stores/epics/git-panel-store";
import { RepoTree, type RepoTreeRootRow } from "../repo-tree";

function row(
  overrides: Partial<WorktreeBindingSelectorRow>,
): WorktreeBindingSelectorRow {
  return {
    hostId: "host-1",
    runningDir: "/repo",
    workspacePath: "/repo",
    worktreePath: null,
    mode: "local",
    isGitRepo: true,
    repoIdentifier: { owner: "acme", repo: "traycer-internal" },
    branch: "development",
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
    ...overrides,
  };
}

function submoduleNode(
  overrides: Partial<RepoTreeSubmoduleNode>,
): RepoTreeSubmoduleNode {
  return {
    repoRoot: "/repo/traycer",
    parentPath: "traycer",
    label: "traycer",
    headLabel: "main",
    changeCount: 2,
    hasChanges: true,
    unavailable: false,
    ...overrides,
  };
}

const rootSelection: GitPanelSelectedRepo = {
  hostId: "host-1",
  rootRunningDir: "/repo",
  repoRoot: "/repo",
};

function renderTree(props: {
  roots: ReadonlyArray<RepoTreeRootRow>;
  selected: GitPanelSelectedRepo;
  activeRootSubmodules: ReadonlyArray<RepoTreeSubmoduleNode>;
  onSelectRoot?: (row: WorktreeBindingSelectorRow) => void;
  onSelectSubmodule?: (node: RepoTreeSubmoduleNode) => void;
}) {
  return render(
    <RepoTree
      roots={props.roots}
      selected={props.selected}
      activeRootSubmodules={props.activeRootSubmodules}
      onSelectRoot={props.onSelectRoot ?? vi.fn()}
      onSelectSubmodule={props.onSelectSubmodule ?? vi.fn()}
    />,
  );
}

describe("<RepoTree />", () => {
  beforeEach(() => cleanup());

  it("renders roots as level-1 treeitems and the active root's submodules as level-2", () => {
    renderTree({
      roots: [{ row: row({}), changeCount: 3 }],
      selected: rootSelection,
      activeRootSubmodules: [submoduleNode({})],
    });
    expect(screen.getByRole("tree")).toBeDefined();
    const root = screen.getByRole("treeitem", { name: /traycer-internal/ });
    expect(root.getAttribute("aria-level")).toBe("1");
    expect(root.getAttribute("aria-selected")).toBe("true");
    expect(root.getAttribute("aria-expanded")).toBe("true");

    const sub = screen.getByTestId("git-repo-tree-submodule-traycer");
    expect(sub.getAttribute("aria-level")).toBe("2");
    expect(sub.getAttribute("aria-selected")).toBe("false");
  });

  it("does not render submodules of a non-active root", () => {
    renderTree({
      roots: [
        { row: row({ runningDir: "/repo" }), changeCount: 1 },
        {
          row: row({ runningDir: "/other", repoIdentifier: null }),
          changeCount: 0,
        },
      ],
      selected: {
        hostId: "host-1",
        rootRunningDir: "/other",
        repoRoot: "/other",
      },
      // Submodules belong to the /other root; the /repo root shows none.
      activeRootSubmodules: [],
    });
    expect(screen.queryByTestId("git-repo-tree-submodule-traycer")).toBeNull();
  });

  it("selects a root on click", () => {
    const onSelectRoot = vi.fn();
    renderTree({
      roots: [{ row: row({}), changeCount: 1 }],
      selected: rootSelection,
      activeRootSubmodules: [],
      onSelectRoot,
    });
    fireEvent.click(screen.getByRole("treeitem", { name: /traycer-internal/ }));
    expect(onSelectRoot).toHaveBeenCalledTimes(1);
  });

  it("selects a submodule on click", () => {
    const onSelectSubmodule = vi.fn();
    renderTree({
      roots: [{ row: row({}), changeCount: 1 }],
      selected: rootSelection,
      activeRootSubmodules: [submoduleNode({})],
      onSelectSubmodule,
    });
    fireEvent.click(screen.getByTestId("git-repo-tree-submodule-traycer"));
    expect(onSelectSubmodule).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo/traycer" }),
    );
  });

  it("shows a warning affordance for an unavailable submodule", () => {
    renderTree({
      roots: [{ row: row({}), changeCount: 1 }],
      selected: rootSelection,
      activeRootSubmodules: [
        submoduleNode({ unavailable: true, hasChanges: false, changeCount: 0 }),
      ],
    });
    const sub = screen.getByTestId("git-repo-tree-submodule-traycer");
    expect(sub.textContent).toContain("unavailable");
  });

  it("moves focus with ArrowDown across visible rows", () => {
    renderTree({
      roots: [{ row: row({}), changeCount: 1 }],
      selected: rootSelection,
      activeRootSubmodules: [submoduleNode({})],
    });
    const root = screen.getByRole("treeitem", { name: /traycer-internal/ });
    root.focus();
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByTestId("git-repo-tree-submodule-traycer"),
    );
  });

  it("ArrowRight on an expanded root moves focus to its first child", () => {
    renderTree({
      roots: [{ row: row({}), changeCount: 1 }],
      selected: rootSelection,
      activeRootSubmodules: [submoduleNode({})],
    });
    const root = screen.getByRole("treeitem", { name: /traycer-internal/ });
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByTestId("git-repo-tree-submodule-traycer"),
    );
  });

  it("ArrowRight on a collapsed (non-active) root expands it by selecting it", () => {
    const onSelectRoot = vi.fn();
    renderTree({
      roots: [
        { row: row({ runningDir: "/repo" }), changeCount: 1 },
        {
          row: row({
            runningDir: "/other",
            repoIdentifier: { owner: "acme", repo: "other-repo" },
          }),
          changeCount: 0,
        },
      ],
      selected: rootSelection, // active root is /repo
      activeRootSubmodules: [],
      onSelectRoot,
    });
    const otherRoot = screen.getByTestId("git-repo-tree-root-other-repo");
    otherRoot.focus();
    fireEvent.keyDown(otherRoot, { key: "ArrowRight" });
    expect(onSelectRoot).toHaveBeenCalledWith(
      expect.objectContaining({ runningDir: "/other" }),
    );
  });

  it("ArrowLeft from a submodule moves focus to its parent root", () => {
    renderTree({
      roots: [{ row: row({}), changeCount: 1 }],
      selected: rootSelection,
      activeRootSubmodules: [submoduleNode({})],
    });
    const sub = screen.getByTestId("git-repo-tree-submodule-traycer");
    sub.focus();
    fireEvent.keyDown(sub, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(
      screen.getByRole("treeitem", { name: /traycer-internal/ }),
    );
  });

  it("ArrowLeft on a root is a no-op (keeps focus)", () => {
    renderTree({
      roots: [{ row: row({}), changeCount: 1 }],
      selected: rootSelection,
      activeRootSubmodules: [submoduleNode({})],
    });
    const root = screen.getByRole("treeitem", { name: /traycer-internal/ });
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(root);
  });

  it("activates the focused row with Enter", () => {
    const onSelectSubmodule = vi.fn();
    renderTree({
      roots: [{ row: row({}), changeCount: 1 }],
      selected: rootSelection,
      activeRootSubmodules: [submoduleNode({})],
      onSelectSubmodule,
    });
    const sub = screen.getByTestId("git-repo-tree-submodule-traycer");
    fireEvent.keyDown(sub, { key: "Enter" });
    expect(onSelectSubmodule).toHaveBeenCalledTimes(1);
  });
});
