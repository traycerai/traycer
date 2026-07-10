import type {
  WorktreeBranch,
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";

type RepoIdentifier = WorktreeFolderIntent["repoIdentifier"];

export interface DefaultFolderInput {
  readonly workspacePath: string;
  readonly repoIdentifier: RepoIdentifier;
  readonly isPrimary: boolean;
  readonly isGitRepo: boolean;
  readonly currentBranch: string | null;
  readonly defaultNewBranchName: string;
}

export interface SeedFolderContext extends DefaultFolderInput {
  readonly summary: WorktreeWorkspaceSummary;
}

/**
 * The default a freshly-added folder seeds to: a new worktree forking a fresh
 * branch off the working tree (the folder's current branch). A non-git folder or
 * a git repo with no resolvable current branch (detached HEAD) has no valid fork
 * source, so it degrades to `local` rather than emitting a structurally invalid
 * `{ source: "" }` worktree entry that would only fail at send/setup.
 */
export function defaultFolderIntent(
  folder: DefaultFolderInput,
): WorktreeFolderIntent {
  if (!folder.isGitRepo || folder.currentBranch === null) {
    return {
      kind: "local",
      workspacePath: folder.workspacePath,
      repoIdentifier: folder.repoIdentifier,
      isPrimary: folder.isPrimary,
    };
  }
  return {
    kind: "worktree",
    scripts: null,
    workspacePath: folder.workspacePath,
    repoIdentifier: folder.repoIdentifier,
    isPrimary: folder.isPrimary,
    branch: {
      type: "new",
      name: folder.defaultNewBranchName,
      source: folder.currentBranch,
      carryUncommittedChanges: false,
    },
  };
}

/**
 * A per-folder transform applied on top of a seed intent (the source
 * conversation's live binding) when a fork surface wants a specific workspace
 * disposition instead of the binding verbatim.
 *
 * `worktree-carry` ("A/B Fork"): fork a fresh branch off each folder's
 * current branch into a new worktree, carrying uncommitted + staged work
 * (the "Working Tree" option), so the fork can proceed with different
 * answers in parallel without touching the original checkout.
 *
 * (A Cross Question fork wants the SAME working copy as the source chat -
 * local for a local binding, the existing worktree for a worktree binding -
 * which is the verbatim seed, so it passes no override.)
 */
export type SeedIntentOverride = "worktree-carry";

/**
 * Applies a {@link SeedIntentOverride} to one folder's seed entry using the
 * folder's disk truth. `null` override (or no seed entry for this folder)
 * passes the seed through untouched.
 *
 * `worktree-carry` forks a new worktree off THIS FOLDER'S working tree (its
 * current branch, carrying uncommitted + staged work). The A/B fork seed has
 * already rebased each folder to the source chat's actual working-copy
 * directory (`buildAbForkWorkspaceSeed`) — for a worktree-bound chat the
 * folder IS the origin worktree — so the current branch here is the origin
 * working copy's branch. When no valid fork source exists (non-git folder or
 * detached HEAD) the seed entry passes through untouched: staying on the
 * origin working copy beats silently forking the wrong one.
 */
export function applySeedIntentOverride(input: {
  readonly override: SeedIntentOverride | null;
  readonly seedEntry: WorktreeFolderIntent | null;
  readonly folder: DefaultFolderInput;
}): WorktreeFolderIntent | null {
  const { override, seedEntry, folder } = input;
  if (override === null || seedEntry === null) return seedEntry;
  if (!folder.isGitRepo || folder.currentBranch === null) return seedEntry;
  return {
    kind: "worktree",
    scripts: null,
    workspacePath: folder.workspacePath,
    repoIdentifier: folder.repoIdentifier,
    isPrimary: seedEntry.isPrimary,
    branch: {
      type: "new",
      name: folder.defaultNewBranchName,
      source: folder.currentBranch,
      carryUncommittedChanges: true,
    },
  };
}

/**
 * Whether validating `remembered` against disk truth needs the full branch list
 * (from `worktree.listBranches`), which the seeder fetches lazily. Only an
 * existing-branch checkout, or a new-branch fork from a source other than the
 * working tree, can't be confirmed from the cheap workspace summary alone.
 */
export function rememberedNeedsBranchValidation(
  remembered: WorktreeFolderIntent | null,
  currentBranch: string | null,
): boolean {
  if (remembered === null || remembered.kind !== "worktree") return false;
  if (remembered.branch.type === "existing") return true;
  return remembered.branch.source !== currentBranch;
}

/**
 * Replay a remembered per-folder choice, validated against the latest disk
 * truth, or `null` when it no longer matches (so the caller falls back to the
 * default new worktree). `branches` is `null` when the list hasn't loaded yet -
 * callers gate on {@link rememberedNeedsBranchValidation} so a branch-dependent
 * case is never resolved against a missing list.
 *
 *  - `local`    - always valid (the checkout always exists).
 *  - `import`   - valid iff the adopted worktree path still exists on disk.
 *  - `worktree` `new`      - valid iff the fork source branch still exists; the
 *    branch name is regenerated fresh (a remembered name is one-shot and would
 *    collide), keeping the remembered source.
 *  - `worktree` `existing` - valid iff the branch still exists AND isn't checked
 *    out in any worktree (i.e. is still a one-click checkout candidate).
 *
 * `isPrimary` / `repoIdentifier` are re-stamped from the live folder context;
 * the remembered copy's are not authoritative across surfaces.
 */
export function resolveRememberedFolderIntent(input: {
  readonly remembered: WorktreeFolderIntent | null;
  readonly branches: ReadonlyArray<WorktreeBranch> | null;
  readonly folder: SeedFolderContext;
}): WorktreeFolderIntent | null {
  const { remembered, branches, folder } = input;
  if (remembered === null) return null;
  const base = {
    workspacePath: folder.workspacePath,
    repoIdentifier: folder.repoIdentifier,
    isPrimary: folder.isPrimary,
  } as const;

  if (remembered.kind === "local") {
    return { kind: "local", ...base };
  }

  if (remembered.kind === "import") {
    const exists = folder.summary.worktrees.some(
      (w) => !w.isMain && w.worktreePath === remembered.worktreePath,
    );
    return exists
      ? { kind: "import", ...base, worktreePath: remembered.worktreePath }
      : null;
  }

  if (remembered.branch.type === "new") {
    if (!isSourceValid(remembered.branch.source, folder, branches)) return null;
    return {
      kind: "worktree",
      scripts: null,
      ...base,
      branch: {
        type: "new",
        name: folder.defaultNewBranchName,
        source: remembered.branch.source,
        carryUncommittedChanges: false,
      },
    };
  }

  // existing-branch checkout: must still exist and be checked out nowhere.
  if (branches === null) return null;
  const name = remembered.branch.name;
  const checkedOut = new Set(
    folder.summary.worktrees.flatMap((w) =>
      w.branch === null ? [] : [w.branch],
    ),
  );
  const exists = branches.some((b) => b.name === name);
  if (!exists || checkedOut.has(name)) return null;
  return {
    kind: "worktree",
    scripts: null,
    ...base,
    branch: { type: "existing", name },
  };
}

function isSourceValid(
  source: string,
  folder: SeedFolderContext,
  branches: ReadonlyArray<WorktreeBranch> | null,
): boolean {
  if (source === folder.currentBranch) return true;
  if (source === folder.summary.mainBranch) return true;
  if (folder.summary.worktrees.some((w) => w.branch === source)) return true;
  return branches !== null && branches.some((b) => b.name === source);
}

/**
 * What to pre-stage for a single resolved git folder when a surface opens. Pure
 * so the precedence is unit-testable without rendering the picker. Precedence:
 *
 *  - already staged: never overwrite a folder the user has touched this session.
 *  - seed: an explicit intent projected from a source conversation's live
 *    binding (the fork dialog, and creating a new GUI/terminal agent from the
 *    latest conversation). It is the single source of truth and is staged
 *    directly - it already reflects a binding running on this host, so the
 *    generic memory/default tiers below never compete. This is what keeps a new
 *    terminal agent on the SAME workspace as the chat it was created from.
 *  - per-epic intent: replay the remembered entry for this folder, validated
 *    against disk (its own `isPrimary` carries over) - reopening an epic
 *    restores it, but a stale branch/worktree self-heals to the default rather
 *    than staging a doomed pick that only fails at `worktree.create`.
 *  - per-folder memory: the last choice for this folder, validated against disk.
 *  - default: a new worktree off the working tree.
 */
export function seedEntryForFolder(input: {
  readonly seedFolderIntent: WorktreeFolderIntent | null;
  readonly epicIntentEntry: WorktreeFolderIntent | null;
  readonly rememberedFolderIntent: WorktreeFolderIntent | null;
  readonly branches: ReadonlyArray<WorktreeBranch> | null;
  readonly folder: SeedFolderContext;
  readonly alreadyStaged: boolean;
}): WorktreeFolderIntent | null {
  if (input.alreadyStaged) return null;
  // Top precedence: the source conversation's live binding. Staged verbatim (no
  // disk re-validation) because it mirrors a binding the source owner is already
  // running on this host - the same intent the source would itself send.
  if (input.seedFolderIntent !== null) {
    return input.seedFolderIntent;
  }
  // The per-epic tier is validated like the per-folder tier (a vanished
  // branch/worktree must not stage a pick that fails at the host), but it
  // preserves the remembered entry's own `isPrimary` instead of re-stamping from
  // the live folder context - reopening an epic restores which folder was primary.
  if (input.epicIntentEntry !== null) {
    const replayedEpic = resolveRememberedFolderIntent({
      remembered: input.epicIntentEntry,
      branches: input.branches,
      folder: { ...input.folder, isPrimary: input.epicIntentEntry.isPrimary },
    });
    return replayedEpic ?? defaultFolderIntent(input.folder);
  }
  const replayed = resolveRememberedFolderIntent({
    remembered: input.rememberedFolderIntent,
    branches: input.branches,
    folder: input.folder,
  });
  return replayed ?? defaultFolderIntent(input.folder);
}
