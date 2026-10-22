import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiskWorktreeEntry,
  WorktreeBranch,
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import {
  applySeedIntentOverride,
  defaultFolderIntent,
  mainCheckoutHasCommit,
  rememberedNeedsBranchValidation,
  resolveRememberedFolderIntent,
  seedEntryForFolder,
  type SeedFolderContext,
} from "@/lib/worktree/worktree-intent-seeding";

const UNBORN_HEAD = "0000000000000000000000000000000000000000";

function worktreeEntry(
  worktreePath: string,
  branch: string | null,
  isMain: boolean,
  head: string | null,
): DiskWorktreeEntry {
  return { worktreePath, branch, head, isMain, isLocked: false };
}

function summary(input: {
  workspacePath?: string;
  isGitRepo?: boolean;
  mainBranch?: string | null;
  worktrees?: DiskWorktreeEntry[];
}): WorktreeWorkspaceSummary {
  return {
    workspacePath: input.workspacePath ?? "/a",
    isGitRepo: input.isGitRepo ?? true,
    repoIdentifier: null,
    mainBranch: input.mainBranch ?? "main",
    worktrees: input.worktrees ?? [worktreeEntry("/a", "main", true, null)],
    scripts: null,
  };
}

function folderContext(
  overrides: Partial<SeedFolderContext>,
): SeedFolderContext {
  return {
    workspacePath: "/a",
    repoIdentifier: null,
    isPrimary: true,
    isGitRepo: true,
    hasCommit: true,
    currentBranch: "main",
    defaultNewBranchName: "traycer/swift-otter",
    summary: summary({}),
    ...overrides,
  };
}

function branch(name: string): WorktreeBranch {
  return { name, isCurrent: false, isRemoteOnly: false };
}

const rememberedLocal: WorktreeFolderIntent = {
  kind: "local",
  workspacePath: "/a",
  repoIdentifier: null,
  isPrimary: true,
};

function rememberedNew(source: string): WorktreeFolderIntent {
  return {
    kind: "worktree",
    scripts: null,
    workspacePath: "/a",
    repoIdentifier: null,
    isPrimary: true,
    branch: {
      type: "new",
      name: "feat/x",
      source,
      carryUncommittedChanges: false,
    },
  };
}

function rememberedExisting(name: string): WorktreeFolderIntent {
  return {
    kind: "worktree",
    scripts: null,
    workspacePath: "/a",
    repoIdentifier: null,
    isPrimary: true,
    branch: { type: "existing", name },
  };
}

function rememberedImport(worktreePath: string): WorktreeFolderIntent {
  return {
    kind: "import",
    workspacePath: "/a",
    repoIdentifier: null,
    isPrimary: true,
    worktreePath,
  };
}

beforeEach(() => {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000000",
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("defaultFolderIntent", () => {
  it("forks a new branch off the working tree for a git repo", () => {
    expect(
      defaultFolderIntent({
        workspacePath: "/a",
        repoIdentifier: null,
        isPrimary: true,
        isGitRepo: true,
        hasCommit: true,
        currentBranch: "main",
        defaultNewBranchName: "traycer/swift-otter",
      }),
    ).toEqual({
      kind: "worktree",
      scripts: null,
      workspacePath: "/a",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "traycer/swift-otter",
        source: "main",
        carryUncommittedChanges: false,
        collision: "random",
        retryIdentity: "00000000-0000-4000-8000-000000000000",
      },
    });
  });

  it("degrades to local for a non-git folder", () => {
    expect(
      defaultFolderIntent({
        workspacePath: "/a",
        repoIdentifier: null,
        isPrimary: true,
        isGitRepo: false,
        hasCommit: true,
        currentBranch: null,
        defaultNewBranchName: "x",
      }).kind,
    ).toBe("local");
  });

  it("degrades a detached-HEAD git repo to local instead of an empty source", () => {
    expect(
      defaultFolderIntent({
        workspacePath: "/a",
        repoIdentifier: null,
        isPrimary: true,
        isGitRepo: true,
        hasCommit: true,
        currentBranch: null,
        defaultNewBranchName: "x",
      }).kind,
    ).toBe("local");
  });

  it("degrades a repo whose branch has no commit to local instead of forking from a branch git cannot resolve", () => {
    expect(
      defaultFolderIntent({
        workspacePath: "/a",
        repoIdentifier: null,
        isPrimary: true,
        isGitRepo: true,
        hasCommit: false,
        currentBranch: "dev",
        defaultNewBranchName: "traycer/civic-quiet-raccoon",
      }),
    ).toEqual({
      kind: "local",
      workspacePath: "/a",
      repoIdentifier: null,
      isPrimary: true,
    });
  });
});

describe("mainCheckoutHasCommit", () => {
  it("is false only when the main checkout's head is the all-zero id", () => {
    expect(
      mainCheckoutHasCommit(
        summary({
          mainBranch: "dev",
          worktrees: [worktreeEntry("/a", "dev", true, UNBORN_HEAD)],
        }),
      ),
    ).toBe(false);
    expect(
      mainCheckoutHasCommit(
        summary({
          worktrees: [worktreeEntry("/a", "main", true, "d9ad5de7f5e7")],
        }),
      ),
    ).toBe(true);
    expect(
      mainCheckoutHasCommit(
        summary({ worktrees: [worktreeEntry("/a", "main", true, null)] }),
      ),
    ).toBe(true);
  });

  it("ignores a linked worktree's head", () => {
    expect(
      mainCheckoutHasCommit(
        summary({
          worktrees: [
            worktreeEntry("/a", "main", true, "d9ad5de7f5e7"),
            worktreeEntry("/b", "x", false, UNBORN_HEAD),
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("applySeedIntentOverride", () => {
  it("keeps the seed entry for a repo with no commit instead of forking a worktree off it", () => {
    const seedEntry = rememberedLocal;
    expect(
      applySeedIntentOverride({
        override: "worktree-carry",
        seedEntry,
        folder: folderContext({ hasCommit: false, currentBranch: "dev" }),
      }),
    ).toBe(seedEntry);
  });

  it("forks a worktree carrying the working tree when the repo has a commit", () => {
    const entry = applySeedIntentOverride({
      override: "worktree-carry",
      seedEntry: rememberedLocal,
      folder: folderContext({}),
    });
    expect(entry?.kind).toBe("worktree");
  });
});

describe("rememberedNeedsBranchValidation", () => {
  it("is false for null / local / import / new-off-working-tree", () => {
    expect(rememberedNeedsBranchValidation(null, "main")).toBe(false);
    expect(rememberedNeedsBranchValidation(rememberedLocal, "main")).toBe(
      false,
    );
    expect(
      rememberedNeedsBranchValidation(rememberedImport("/wt"), "main"),
    ).toBe(false);
    expect(rememberedNeedsBranchValidation(rememberedNew("main"), "main")).toBe(
      false,
    );
  });

  it("is true for an existing-branch checkout or a non-working-tree fork source", () => {
    expect(
      rememberedNeedsBranchValidation(rememberedExisting("feat/y"), "main"),
    ).toBe(true);
    expect(
      rememberedNeedsBranchValidation(rememberedNew("develop"), "main"),
    ).toBe(true);
  });
});

describe("resolveRememberedFolderIntent", () => {
  it("returns null when nothing is remembered", () => {
    expect(
      resolveRememberedFolderIntent({
        remembered: null,
        branches: [],
        folder: folderContext({}),
      }),
    ).toBeNull();
  });

  it("replays a remembered local choice", () => {
    expect(
      resolveRememberedFolderIntent({
        remembered: rememberedLocal,
        branches: [],
        folder: folderContext({ isPrimary: false }),
      }),
    ).toEqual({
      kind: "local",
      workspacePath: "/a",
      repoIdentifier: null,
      isPrimary: false,
    });
  });

  it("keeps an adopted worktree that still exists and drops one that is gone", () => {
    const live = summary({
      worktrees: [
        worktreeEntry("/a", "main", true, null),
        worktreeEntry("/wt/x", "feat/x", false, null),
      ],
    });
    expect(
      resolveRememberedFolderIntent({
        remembered: rememberedImport("/wt/x"),
        branches: null,
        folder: folderContext({ summary: live }),
      }),
    ).toEqual(rememberedImport("/wt/x"));
    expect(
      resolveRememberedFolderIntent({
        remembered: rememberedImport("/wt/gone"),
        branches: null,
        folder: folderContext({ summary: live }),
      }),
    ).toBeNull();
  });

  it("regenerates the branch name for a new-off-working-tree replay", () => {
    expect(
      resolveRememberedFolderIntent({
        remembered: rememberedNew("main"),
        branches: null,
        folder: folderContext({ defaultNewBranchName: "traycer/fresh-name" }),
      }),
    ).toEqual({
      kind: "worktree",
      scripts: null,
      workspacePath: "/a",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "traycer/fresh-name",
        source: "main",
        carryUncommittedChanges: false,
        collision: "random",
        retryIdentity: "00000000-0000-4000-8000-000000000000",
      },
    });
  });

  it("keeps a non-working-tree fork source only when the branch still exists", () => {
    expect(
      resolveRememberedFolderIntent({
        remembered: rememberedNew("develop"),
        branches: [branch("main"), branch("develop")],
        folder: folderContext({}),
      }),
    ).not.toBeNull();
    expect(
      resolveRememberedFolderIntent({
        remembered: rememberedNew("develop"),
        branches: [branch("main")],
        folder: folderContext({}),
      }),
    ).toBeNull();
  });

  it("keeps an existing-branch checkout only when present and checked out nowhere", () => {
    // Present and free -> valid.
    expect(
      resolveRememberedFolderIntent({
        remembered: rememberedExisting("feat/y"),
        branches: [branch("main"), branch("feat/y")],
        folder: folderContext({}),
      }),
    ).toEqual(rememberedExisting("feat/y"));
    // Branch gone -> null.
    expect(
      resolveRememberedFolderIntent({
        remembered: rememberedExisting("feat/y"),
        branches: [branch("main")],
        folder: folderContext({}),
      }),
    ).toBeNull();
    // Checked out in a worktree already -> null (no double checkout).
    const checkedOut = summary({
      worktrees: [
        worktreeEntry("/a", "main", true, null),
        worktreeEntry("/wt/y", "feat/y", false, null),
      ],
    });
    expect(
      resolveRememberedFolderIntent({
        remembered: rememberedExisting("feat/y"),
        branches: [branch("main"), branch("feat/y")],
        folder: folderContext({ summary: checkedOut }),
      }),
    ).toBeNull();
  });

  it("cannot validate an existing-branch checkout without the branch list", () => {
    expect(
      resolveRememberedFolderIntent({
        remembered: rememberedExisting("feat/y"),
        branches: null,
        folder: folderContext({}),
      }),
    ).toBeNull();
  });
});

describe("seedEntryForFolder", () => {
  it("stages the seed verbatim, beating per-epic memory, per-folder memory, and the default", () => {
    // The source conversation runs on an adopted worktree; that seed is the top
    // tier and must win over any remembered pick or the generic new-worktree
    // default - and it needs no branch list (staged verbatim, not disk-validated).
    const seed = rememberedImport("/a/.worktrees/feature");
    expect(
      seedEntryForFolder({
        seedFolderIntent: seed,
        epicIntentEntry: rememberedExisting("from-epic"),
        rememberedFolderIntent: rememberedLocal,
        branches: null,
        folder: folderContext({}),
        alreadyStaged: false,
      }),
    ).toEqual(seed);
  });

  it("never overwrites a folder the user already staged", () => {
    expect(
      seedEntryForFolder({
        seedFolderIntent: null,
        epicIntentEntry: null,
        rememberedFolderIntent: rememberedLocal,
        branches: [],
        folder: folderContext({}),
        alreadyStaged: true,
      }),
    ).toBeNull();
  });

  it("replays a valid per-epic entry, beating per-folder memory and the default", () => {
    const epicEntry = rememberedExisting("from-epic");
    const result = seedEntryForFolder({
      seedFolderIntent: null,
      epicIntentEntry: epicEntry,
      rememberedFolderIntent: rememberedLocal,
      // The existing branch still exists on disk, so the epic pick is valid.
      branches: [branch("from-epic")],
      folder: folderContext({}),
      alreadyStaged: false,
    });
    expect(result?.kind).toBe("worktree");
    if (result?.kind === "worktree" && result.branch.type === "existing") {
      expect(result.branch.name).toBe("from-epic");
    }
  });

  it("self-heals a stale per-epic entry to the default instead of replaying a doomed pick", () => {
    // The epic remembered an existing-branch checkout that no longer exists; it
    // must fall back to a fresh worktree rather than stage a pick that fails at
    // worktree.create (the per-epic tier is validated like the per-folder tier).
    const entry = seedEntryForFolder({
      seedFolderIntent: null,
      epicIntentEntry: rememberedExisting("gone-from-epic"),
      rememberedFolderIntent: null,
      branches: [branch("main")],
      folder: folderContext({ defaultNewBranchName: "traycer/fallback" }),
      alreadyStaged: false,
    });
    expect(entry?.kind).toBe("worktree");
    if (entry?.kind === "worktree" && entry.branch.type === "new") {
      expect(entry.branch.name).toBe("traycer/fallback");
    }
  });

  it("replays a valid per-folder memory over the default", () => {
    expect(
      seedEntryForFolder({
        seedFolderIntent: null,
        epicIntentEntry: null,
        rememberedFolderIntent: rememberedLocal,
        branches: [],
        folder: folderContext({}),
        alreadyStaged: false,
      })?.kind,
    ).toBe("local");
  });

  it("falls back to a new worktree off the working tree when the memory is invalid", () => {
    // Remembered an existing-branch checkout that no longer exists.
    const entry = seedEntryForFolder({
      seedFolderIntent: null,
      epicIntentEntry: null,
      rememberedFolderIntent: rememberedExisting("gone"),
      branches: [branch("main")],
      folder: folderContext({ defaultNewBranchName: "traycer/fallback" }),
      alreadyStaged: false,
    });
    expect(entry?.kind).toBe("worktree");
    if (entry?.kind === "worktree" && entry.branch.type === "new") {
      expect(entry.branch.source).toBe("main");
      expect(entry.branch.name).toBe("traycer/fallback");
    }
  });

  it("defaults to a new worktree off the working tree when nothing is remembered", () => {
    const entry = seedEntryForFolder({
      seedFolderIntent: null,
      epicIntentEntry: null,
      rememberedFolderIntent: null,
      branches: [],
      folder: folderContext({}),
      alreadyStaged: false,
    });
    expect(entry?.kind).toBe("worktree");
  });

  it("defaults a repo with no commit to local, never a fork off its unborn branch", () => {
    const unborn = summary({
      mainBranch: "dev",
      worktrees: [worktreeEntry("/a", "dev", true, UNBORN_HEAD)],
    });
    expect(
      seedEntryForFolder({
        seedFolderIntent: null,
        epicIntentEntry: null,
        rememberedFolderIntent: null,
        branches: [],
        folder: folderContext({
          currentBranch: "dev",
          hasCommit: mainCheckoutHasCommit(unborn),
          summary: unborn,
        }),
        alreadyStaged: false,
      })?.kind,
    ).toBe("local");
  });

  it("defaults a non-git folder to local", () => {
    expect(
      seedEntryForFolder({
        seedFolderIntent: null,
        epicIntentEntry: null,
        rememberedFolderIntent: null,
        branches: [],
        folder: folderContext({
          isGitRepo: false,
          currentBranch: null,
          summary: summary({ isGitRepo: false, worktrees: [] }),
        }),
        alreadyStaged: false,
      })?.kind,
    ).toBe("local");
  });
});
