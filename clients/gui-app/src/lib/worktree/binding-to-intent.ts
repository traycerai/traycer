import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";

/**
 * Projects a live binding entry into the folder-intent shape the unified picker
 * stages: a worktree-bound entry maps to `import` (adopt the existing worktree),
 * a local entry to `local`. Used both to render an existing owner's rows and to
 * seed a new owner's picker from another chat's binding (the fork dialog
 * inheriting the source chat's workspace).
 */
export function bindingEntryToFolderIntent(
  entry: WorktreeBindingEntry | null,
  repoIdentifier: WorktreeFolderIntent["repoIdentifier"],
  isPrimary: boolean,
): WorktreeFolderIntent | null {
  if (entry === null) return null;
  if (entry.mode === "worktree" && entry.worktreePath !== null) {
    return {
      kind: "import",
      workspacePath: entry.workspacePath,
      repoIdentifier,
      isPrimary,
      worktreePath: entry.worktreePath,
    };
  }
  return {
    kind: "local",
    workspacePath: entry.workspacePath,
    repoIdentifier,
    isPrimary,
  };
}

/**
 * Projects a full binding into a stageable intent (each entry re-stamped from its
 * own `repoIdentifier` / `isPrimary`). `null` when the binding is absent or
 * empty - the caller then falls back to the default seeding.
 */
export function bindingToWorktreeIntent(
  binding: WorktreeBinding | null,
): WorktreeIntent | null {
  if (binding === null) return null;
  const entries = binding.entries.flatMap((entry) => {
    const intent = bindingEntryToFolderIntent(
      entry,
      entry.repoIdentifier,
      entry.isPrimary,
    );
    return intent === null ? [] : [intent];
  });
  return entries.length === 0 ? null : { entries };
}
