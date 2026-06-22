import { describe, expect, it } from "vitest";
import type {
  WorktreeBranch,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import {
  buildUnifiedPickerModel,
  newWorktreeIntent,
  WORKING_TREE_SOURCE_ID,
  worktreeImportRows,
} from "@/components/home/worktree/worktree-unified-picker-model";

const WORKSPACE = "/repo";

function summary(
  overrides: Partial<WorktreeWorkspaceSummary>,
): WorktreeWorkspaceSummary {
  return {
    workspacePath: WORKSPACE,
    isGitRepo: true,
    repoIdentifier: { owner: "acme", repo: "app" },
    mainBranch: "development",
    worktrees: [
      {
        worktreePath: WORKSPACE,
        branch: "development",
        head: null,
        isMain: true,
        isLocked: false,
      },
    ],
    scripts: null,
    ...overrides,
  };
}

function branch(name: string): WorktreeBranch {
  return { name, isCurrent: false, isRemoteOnly: false };
}

function currentBranch(name: string): WorktreeBranch {
  return { name, isCurrent: true, isRemoteOnly: false };
}

function remoteBranch(name: string): WorktreeBranch {
  return { name, isCurrent: false, isRemoteOnly: true };
}

function build(input: {
  readonly summary: WorktreeWorkspaceSummary;
  readonly branches: ReadonlyArray<WorktreeBranch>;
  readonly currentIntent?: Parameters<
    typeof buildUnifiedPickerModel
  >[0]["currentIntent"];
  readonly uncommittedFileCount?: number;
}) {
  return buildUnifiedPickerModel({
    summary: input.summary,
    branches: input.branches,
    currentIntent: input.currentIntent ?? null,
    defaultNewBranchName: "traycer/swift-otter",
    uncommittedFileCount: input.uncommittedFileCount ?? 0,
  });
}

describe("buildUnifiedPickerModel — partition invariant", () => {
  it("keeps a branch checked out in a sibling worktree in the source list", () => {
    const model = build({
      summary: summary({
        worktrees: [
          {
            worktreePath: WORKSPACE,
            branch: "development",
            head: null,
            isMain: true,
            isLocked: false,
          },
          {
            worktreePath: "/wt/feat-login",
            branch: "feat/login",
            sourceBranch: "development",
            head: null,
            isMain: false,
            isLocked: false,
          },
        ],
      }),
      branches: [
        currentBranch("development"),
        branch("feat/login"),
        branch("hotfix/bug"),
      ],
    });

    // feat/login is checked out in a worktree, but New worktree always creates a
    // new branch, so it remains a valid source.
    expect(model.sourceOptions.find((r) => r.name === "feat/login")).toEqual({
      id: "feat/login",
      name: "feat/login",
      label: "feat/login",
      carryUncommittedChanges: false,
      isRemote: false,
      defaultNewBranchName: "traycer/swift-otter",
    });
    expect(model.sourceOptions.map((r) => r.name)).toEqual([
      "development",
      "feat/login",
      "hotfix/bug",
    ]);
  });

  it("partitions sources into the current-branch fork and branch rows", () => {
    const model = build({
      summary: summary({
        worktrees: [
          {
            worktreePath: WORKSPACE,
            branch: "development",
            head: null,
            isMain: true,
            isLocked: false,
          },
          {
            worktreePath: "/wt/feat-login",
            branch: "feat/login",
            sourceBranch: "development",
            head: null,
            isMain: false,
            isLocked: false,
          },
        ],
      }),
      branches: [
        currentBranch("development"),
        branch("feat/login"),
        branch("hotfix/bug"),
      ],
    });
    // A clean tree → the current branch is a fork source (no carry row), followed
    // by the remaining branches from listBranches.
    expect(model.sourceOptions).toMatchObject([
      { name: "development", isRemote: false },
      { name: "feat/login", isRemote: false },
      { name: "hotfix/bug", isRemote: false },
    ]);
  });

  it("the current branch is a clean fork source when the tree is clean", () => {
    const model = build({
      summary: summary({}),
      branches: [currentBranch("development"), branch("feat/x")],
    });
    // No WIP to carry → just the plain current-branch fork, labelled as the branch
    // (not "Working tree · …"), so "start fresh on a new worktree" is reachable.
    expect(model.sourceOptions[0]).toMatchObject({
      id: "development",
      name: "development",
      label: "development",
      carryUncommittedChanges: false,
    });
    expect(model.currentBranch).toBe("development");
  });

  it("offers a carry source above the clean fork when the tree is dirty", () => {
    const model = build({
      summary: summary({}),
      branches: [currentBranch("development"), branch("feat/x")],
      uncommittedFileCount: 3,
    });
    // Dirty tree → "Working tree · development" (carry WIP) sits above the clean
    // "development" fork; both fork the same branch but differ by carry.
    expect(model.sourceOptions.slice(0, 2)).toMatchObject([
      {
        id: WORKING_TREE_SOURCE_ID,
        name: "development",
        label: "Working tree · development",
        carryUncommittedChanges: true,
      },
      {
        id: "development",
        name: "development",
        label: "development",
        carryUncommittedChanges: false,
      },
    ]);
  });

  it("a local branch source uses the generated new-branch default", () => {
    const model = build({
      summary: summary({}),
      branches: [currentBranch("development"), branch("feat/x")],
    });
    const source = model.sourceOptions.find((r) => r.name === "feat/x");
    expect(source).toMatchObject({
      name: "feat/x",
      defaultNewBranchName: "traycer/swift-otter",
    });
  });

  it("a remote-only ref is a new-branch source option", () => {
    const model = build({
      summary: summary({}),
      branches: [
        currentBranch("development"),
        remoteBranch("origin/release-9"),
      ],
    });
    const source = model.sourceOptions.find(
      (r) => r.name === "origin/release-9",
    );
    expect(source).toMatchObject({
      name: "origin/release-9",
      label: "Remote · origin/release-9",
      defaultNewBranchName: "release-9",
    });
  });

  it("omits the carry source when the tree is clean", () => {
    const model = build({
      summary: summary({}),
      branches: [currentBranch("development")],
      uncommittedFileCount: 0,
    });
    expect(
      model.sourceOptions.some((s) => s.id === WORKING_TREE_SOURCE_ID),
    ).toBe(false);
    expect(model.sourceOptions.map((s) => s.name)).toEqual(["development"]);
  });

  it("defaults to the clean current-branch fork, not the carry source, when dirty", () => {
    const model = build({
      summary: summary({}),
      branches: [currentBranch("development")],
      uncommittedFileCount: 5,
    });
    // A fresh worktree should not silently carry WIP — default selection is the
    // clean fork id even though the carry row is offered above it.
    expect(model.newBranchSourceId).toBe("development");
  });

  it("re-selects the staged source by id (clean fork)", () => {
    const model = build({
      summary: summary({}),
      branches: [
        currentBranch("development"),
        remoteBranch("origin/release-9"),
      ],
      currentIntent: {
        kind: "worktree",
        scripts: null,
        workspacePath: WORKSPACE,
        repoIdentifier: null,
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "development",
          carryUncommittedChanges: false,
        },
      },
    });
    expect(model.newBranchSourceId).toBe("development");
  });

  it("re-selects the carry source when the staged intent carries WIP", () => {
    const model = build({
      summary: summary({}),
      branches: [currentBranch("development")],
      uncommittedFileCount: 4,
      currentIntent: {
        kind: "worktree",
        scripts: null,
        workspacePath: WORKSPACE,
        repoIdentifier: null,
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "development",
          carryUncommittedChanges: true,
        },
      },
    });
    expect(model.newBranchSourceId).toBe(WORKING_TREE_SOURCE_ID);
  });
});

describe("worktreeImportRows", () => {
  it("builds import rows from the summary's sibling worktrees with branch + locked", () => {
    const rows = worktreeImportRows({
      workspacePath: WORKSPACE,
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      currentIntent: null,
      summary: summary({
        worktrees: [
          {
            worktreePath: WORKSPACE,
            branch: "development",
            head: null,
            isMain: true,
            isLocked: false,
          },
          {
            worktreePath: "/wt/feat-login",
            branch: "feat/login",
            sourceBranch: "development",
            head: null,
            isMain: false,
            isLocked: false,
          },
          {
            worktreePath: "/wt/release",
            branch: "release-x",
            head: null,
            isMain: false,
            isLocked: true,
          },
        ],
      }),
    });
    // The main worktree is never an import row.
    expect(rows.map((r) => r.worktreePath)).toEqual([
      "/wt/feat-login",
      "/wt/release",
    ]);
    expect(rows[0]).toMatchObject({
      branch: "feat/login",
      sourceBranch: "development",
      isLocked: false,
      intent: { kind: "import", worktreePath: "/wt/feat-login" },
    });
    expect(rows[1].isLocked).toBe(true);
  });

  it("marks the staged import row as selected", () => {
    const rows = worktreeImportRows({
      workspacePath: WORKSPACE,
      repoIdentifier: null,
      isPrimary: true,
      currentIntent: {
        kind: "import",
        workspacePath: WORKSPACE,
        repoIdentifier: null,
        isPrimary: true,
        worktreePath: "/wt/feat-login",
      },
      summary: summary({
        worktrees: [
          {
            worktreePath: WORKSPACE,
            branch: "development",
            head: null,
            isMain: true,
            isLocked: false,
          },
          {
            worktreePath: "/wt/feat-login",
            branch: "feat/login",
            head: null,
            isMain: false,
            isLocked: false,
          },
        ],
      }),
    });
    expect(rows[0].selected).toBe(true);
  });
});

describe("newWorktreeIntent", () => {
  it("builds a clean worktree/new intent when a branch name is provided", () => {
    expect(
      newWorktreeIntent({
        workspacePath: WORKSPACE,
        repoIdentifier: null,
        isPrimary: false,
        source: {
          id: "development",
          name: "development",
          label: "development",
          carryUncommittedChanges: false,
          isRemote: false,
          defaultNewBranchName: "traycer/swift-otter",
        },
        branchName: "feat/new",
      }),
    ).toEqual({
      kind: "worktree",
      scripts: null,
      workspacePath: WORKSPACE,
      repoIdentifier: null,
      isPrimary: false,
      branch: {
        type: "new",
        name: "feat/new",
        source: "development",
        carryUncommittedChanges: false,
      },
    });
  });

  it("carries WIP into the new branch when the working-tree carry source is selected", () => {
    expect(
      newWorktreeIntent({
        workspacePath: WORKSPACE,
        repoIdentifier: null,
        isPrimary: false,
        source: {
          id: WORKING_TREE_SOURCE_ID,
          name: "development",
          label: "Working tree · development",
          carryUncommittedChanges: true,
          isRemote: false,
          defaultNewBranchName: "traycer/swift-otter",
        },
        branchName: "feat/new",
      }),
    ).toMatchObject({
      kind: "worktree",
      branch: {
        type: "new",
        name: "feat/new",
        source: "development",
        carryUncommittedChanges: true,
      },
    });
  });

  it("returns null when no new branch name is provided", () => {
    expect(
      newWorktreeIntent({
        workspacePath: WORKSPACE,
        repoIdentifier: null,
        isPrimary: false,
        source: {
          id: "feat/existing",
          name: "feat/existing",
          label: "feat/existing",
          carryUncommittedChanges: false,
          isRemote: false,
          defaultNewBranchName: "traycer/swift-otter",
        },
        branchName: "",
      }),
    ).toBeNull();
  });

  it("forks from the selected source branch", () => {
    expect(
      newWorktreeIntent({
        workspacePath: WORKSPACE,
        repoIdentifier: null,
        isPrimary: false,
        source: {
          id: "development",
          name: "development",
          label: "development",
          carryUncommittedChanges: false,
          isRemote: false,
          defaultNewBranchName: "traycer/swift-otter",
        },
        branchName: "traycer/swift-otter",
      }),
    ).toMatchObject({
      kind: "worktree",
      scripts: null,
      branch: {
        type: "new",
        name: "traycer/swift-otter",
        source: "development",
        carryUncommittedChanges: false,
      },
    });
  });
});
