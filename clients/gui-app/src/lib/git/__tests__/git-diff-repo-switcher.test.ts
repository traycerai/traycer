import { describe, expect, it } from "vitest";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import type { GitSubmoduleSummary } from "@/lib/git/git-repo-tree";
import {
  buildGitDiffRepoSwitcherModel,
  type GitDiffRepoSelection,
  type GitDiffRepoSwitcherRootInput,
} from "../git-diff-repo-switcher";

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
  overrides: Partial<GitSubmoduleSummary>,
): GitSubmoduleSummary {
  return {
    repoRoot: "/repo/vendor/traycer",
    parentPath: "vendor/traycer",
    label: "vendor/traycer",
    headLabel: "feature/submodule-ui",
    changeCount: 2,
    hasChanges: true,
    unavailable: false,
    ...overrides,
  };
}

function selection(
  overrides: Partial<GitDiffRepoSelection>,
): GitDiffRepoSelection {
  return {
    hostId: "host-1",
    rootRunningDir: "/repo",
    repoRoot: "/repo",
    ...overrides,
  };
}

function rootInput(args: {
  readonly row: WorktreeBindingSelectorRow;
  readonly fileChangeCount: number | null;
  readonly moduleChangeCount: number | null;
}): GitDiffRepoSwitcherRootInput {
  return args;
}

describe("buildGitDiffRepoSwitcherModel", () => {
  it("constructs workspace-only rows with stable parent-status counts and paths", () => {
    const model = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 5, moduleChangeCount: 1 }),
        rootInput({
          row: row({
            runningDir: "/notes",
            workspacePath: "/notes",
            repoIdentifier: null,
            branch: null,
            isGitRepo: false,
          }),
          fileChangeCount: null,
          moduleChangeCount: null,
        }),
      ],
      activeRootSubmodules: [
        submoduleNode({}),
        submoduleNode({
          repoRoot: "/repo/clean-lib",
          parentPath: "clean-lib",
          label: "clean-lib",
          headLabel: "main",
          changeCount: 0,
          hasChanges: false,
        }),
      ],
      selected: selection({}),
      searchQuery: "",
    });

    expect(model.rows.map((item) => item.kind)).toEqual(["root", "root"]);
    expect(model.rows[0]).toMatchObject({
      label: "traycer-internal",
      selected: true,
      fileChangeCount: 7,
      moduleChangeCount: 1,
      secondaryLabel: "/repo",
      disabledLabel: null,
    });
    expect(model.rows[1]).toMatchObject({
      label: "notes",
      disabledLabel: "not git",
      fileChangeCount: null,
      moduleChangeCount: null,
    });
    expect(model.trigger).toMatchObject({
      label: "traycer-internal",
      secondaryLabel: "/repo",
      fileChangeCount: 7,
      moduleChangeCount: 1,
      openTarget: { workspacePath: "/repo", hostId: "host-1" },
    });
  });

  it("keeps row path stable and aggregates selected workspace file counts", () => {
    const beforeSelection = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 0, moduleChangeCount: 1 }),
        rootInput({
          row: row({
            runningDir: "/other/repo",
            workspacePath: "/other/repo",
            repoIdentifier: { owner: "acme", repo: "other-repo" },
            branch: "main",
          }),
          fileChangeCount: 0,
          moduleChangeCount: 0,
        }),
      ],
      activeRootSubmodules: [],
      selected: selection({
        rootRunningDir: "/other/repo",
        repoRoot: "/other/repo",
      }),
      searchQuery: "",
    });
    const afterSelection = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 0, moduleChangeCount: 1 }),
        rootInput({
          row: row({
            runningDir: "/other/repo",
            workspacePath: "/other/repo",
            repoIdentifier: { owner: "acme", repo: "other-repo" },
            branch: "main",
          }),
          fileChangeCount: 0,
          moduleChangeCount: 0,
        }),
      ],
      activeRootSubmodules: [submoduleNode({ changeCount: 133 })],
      selected: selection({}),
      searchQuery: "",
    });

    expect(beforeSelection.rows[0]).toMatchObject({
      selected: false,
      secondaryLabel: "/repo",
      fileChangeCount: 0,
      moduleChangeCount: 1,
    });
    expect(afterSelection.rows[0]).toMatchObject({
      selected: true,
      secondaryLabel: "/repo",
      fileChangeCount: 133,
      moduleChangeCount: 1,
    });
    expect(afterSelection.trigger).toMatchObject({
      fileChangeCount: 133,
      moduleChangeCount: 1,
    });
  });

  it("treats a persisted submodule repoRoot as the parent workspace selection", () => {
    const model = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 4, moduleChangeCount: 1 }),
      ],
      activeRootSubmodules: [submoduleNode({ changeCount: 2 })],
      selected: selection({ repoRoot: "/repo/vendor/traycer" }),
      searchQuery: "",
    });

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      label: "traycer-internal",
      selected: true,
      fileChangeCount: 6,
      moduleChangeCount: 1,
    });
    expect(model.trigger).toMatchObject({
      label: "traycer-internal",
      secondaryLabel: "/repo",
      fileChangeCount: 6,
      moduleChangeCount: 1,
      openTarget: { workspacePath: "/repo", hostId: "host-1" },
    });
  });

  it("keeps submodule state out of the visible picker row while preserving row state", () => {
    const cleanModel = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 0, moduleChangeCount: 0 }),
      ],
      activeRootSubmodules: [
        submoduleNode({
          repoRoot: "/repo/clean-lib",
          parentPath: "clean-lib",
          label: "clean-lib",
          headLabel: "main",
          changeCount: 0,
          hasChanges: false,
        }),
      ],
      selected: selection({}),
      searchQuery: "",
    });
    expect(cleanModel.rows[0]).toMatchObject({
      secondaryLabel: "/repo",
      fileChangeCount: 0,
      moduleChangeCount: 0,
      clean: true,
    });

    const unavailableModel = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 0, moduleChangeCount: 1 }),
      ],
      activeRootSubmodules: [
        submoduleNode({
          repoRoot: "/repo/broken",
          parentPath: "broken",
          label: "broken",
          headLabel: "detached",
          changeCount: 0,
          hasChanges: false,
          unavailable: true,
        }),
      ],
      selected: selection({}),
      searchQuery: "",
    });
    expect(unavailableModel.rows[0]).toMatchObject({
      secondaryLabel: "/repo",
      fileChangeCount: 0,
      moduleChangeCount: 1,
    });
  });

  it("does not turn unavailable-only submodule summaries into changed module badges", () => {
    const model = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 0, moduleChangeCount: 0 }),
      ],
      activeRootSubmodules: [
        submoduleNode({
          repoRoot: "/repo/broken",
          parentPath: "broken",
          label: "broken",
          headLabel: "detached",
          changeCount: 0,
          hasChanges: false,
          unavailable: true,
        }),
      ],
      selected: selection({}),
      searchQuery: "",
    });

    expect(model.rows[0]).toMatchObject({
      secondaryLabel: "/repo",
      fileChangeCount: 0,
      moduleChangeCount: 0,
      clean: false,
    });
    expect(model.trigger).toMatchObject({
      fileChangeCount: 0,
      moduleChangeCount: 0,
    });
  });

  it("summarizes a parent-reference-only submodule as a changed module without adding files", () => {
    const model = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 0, moduleChangeCount: 1 }),
      ],
      activeRootSubmodules: [
        submoduleNode({
          changeCount: 0,
          hasChanges: true,
        }),
      ],
      selected: selection({}),
      searchQuery: "",
    });

    expect(model.rows[0]).toMatchObject({
      secondaryLabel: "/repo",
      fileChangeCount: 0,
      moduleChangeCount: 1,
      clean: false,
    });
    expect(model.trigger).toMatchObject({
      label: "traycer-internal",
      fileChangeCount: 0,
      moduleChangeCount: 1,
    });
  });

  it("keeps the trigger transiently unavailable when a selected workspace disappears", () => {
    const model = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({
          row: row({ runningDir: "/other" }),
          fileChangeCount: 1,
          moduleChangeCount: 0,
        }),
      ],
      activeRootSubmodules: [],
      selected: selection({ rootRunningDir: "/missing", repoRoot: "/missing" }),
      searchQuery: "",
    });

    expect(model.trigger).toMatchObject({
      label: "Workspace unavailable",
      secondaryLabel: "/missing",
      fileChangeCount: null,
      moduleChangeCount: null,
      unavailable: true,
      openTarget: { workspacePath: "/missing", hostId: "host-1" },
    });
  });

  it("matches submodule names, paths, heads, and status while returning only the parent workspace row", () => {
    const modelByHead = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 0, moduleChangeCount: 1 }),
        rootInput({
          row: row({
            runningDir: "/other/repo",
            workspacePath: "/other/repo",
            repoIdentifier: { owner: "acme", repo: "other-repo" },
            branch: "main",
          }),
          fileChangeCount: 0,
          moduleChangeCount: 0,
        }),
      ],
      activeRootSubmodules: [submoduleNode({})],
      selected: selection({}),
      searchQuery: "feature/submodule",
    });
    expect(modelByHead.visibleRows.map((item) => item.label)).toEqual([
      "traycer-internal",
    ]);

    const modelByPath = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 0, moduleChangeCount: 1 }),
      ],
      activeRootSubmodules: [submoduleNode({})],
      selected: selection({}),
      searchQuery: "vendor/traycer",
    });
    expect(modelByPath.visibleRows.map((item) => item.label)).toEqual([
      "traycer-internal",
    ]);

    const modelByStatus = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({ row: row({}), fileChangeCount: 0, moduleChangeCount: 1 }),
      ],
      activeRootSubmodules: [
        submoduleNode({
          repoRoot: "/repo/broken",
          parentPath: "broken",
          label: "broken",
          headLabel: "detached",
          changeCount: 0,
          hasChanges: false,
          unavailable: true,
        }),
      ],
      selected: selection({}),
      searchQuery: "unavailable",
    });
    expect(modelByStatus.visibleRows.map((item) => item.label)).toEqual([
      "traycer-internal",
    ]);
  });

  it("keeps disabled Git roots and non-Git roots visible with disabled reasons", () => {
    const model = buildGitDiffRepoSwitcherModel({
      roots: [
        rootInput({
          row: row({
            runningDir: "/setup-failed",
            repoIdentifier: { owner: "acme", repo: "setup-failed" },
            disabledReason: "setup_failed",
          }),
          fileChangeCount: null,
          moduleChangeCount: null,
        }),
        rootInput({
          row: row({
            runningDir: "/notes",
            workspacePath: "/notes",
            repoIdentifier: null,
            branch: null,
            isGitRepo: false,
          }),
          fileChangeCount: null,
          moduleChangeCount: null,
        }),
      ],
      activeRootSubmodules: [],
      selected: null,
      searchQuery: "",
    });

    expect(model.rows.map((item) => item.disabledLabel)).toEqual([
      "failed",
      "not git",
    ]);
  });
});
