import type {
  WorktreeEntryScripts,
  WorktreeIntent,
  WorktreeFolderIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { createWorktreeRetryIdentity } from "@/lib/worktree/worktree-retry-identity";

/** The Environment chip uses this so an environment edit rides the worktree intent (and reaches the new
 * worktree at create) without touching the source checkout. */
export function setWorktreeIntentEntryScripts(
  intent: WorktreeIntent | null,
  workspacePath: string,
  scripts: WorktreeEntryScripts | null,
): WorktreeIntent | null {
  if (intent === null) return null;
  const hasTarget = intent.entries.some(
    (entry) =>
      entry.workspacePath === workspacePath && entry.kind === "worktree",
  );
  if (!hasTarget) return intent;
  return {
    entries: intent.entries.map((entry) =>
      entry.workspacePath === workspacePath && entry.kind === "worktree"
        ? { ...entry, scripts }
        : entry,
    ),
  };
}

/** Used by the Environment dialog's repository-defaults section to offer regenerating this picker's proposed
 * branch name after a repo prefix save, without touching any other staged intent. */
export function setWorktreeIntentEntryBranchName(
  intent: WorktreeIntent | null,
  workspacePath: string,
  name: string,
): WorktreeIntent | null {
  if (intent === null) return null;
  const hasTarget = intent.entries.some(
    (entry) =>
      entry.workspacePath === workspacePath &&
      entry.kind === "worktree" &&
      entry.branch.type === "new",
  );
  if (!hasTarget) return intent;
  return {
    entries: intent.entries.map((entry) =>
      entry.workspacePath === workspacePath &&
      entry.kind === "worktree" &&
      entry.branch.type === "new"
        ? {
            ...entry,
            branch: {
              ...entry.branch,
              name,
              collision: "random",
              retryIdentity: createWorktreeRetryIdentity(),
            },
          }
        : entry,
    ),
  };
}

export function removeWorktreeIntentEntry(
  intent: WorktreeIntent | null,
  workspacePath: string,
): WorktreeIntent | null {
  if (intent === null) return null;
  const entries = intent.entries.filter(
    (entry) => entry.workspacePath !== workspacePath,
  );
  return entries.length === 0 ? null : { entries };
}

export function mergeWorktreeIntent(
  existing: WorktreeIntent | null,
  next: WorktreeIntent,
): WorktreeIntent | null {
  if (next.entries.length === 0) return existing;
  return next.entries.reduce<WorktreeIntent | null>(
    (merged, entry) => mergeWorktreeIntentEntry(merged, entry),
    existing,
  );
}

export function mergeWorktreeIntentEntry(
  existing: WorktreeIntent | null,
  next: WorktreeFolderIntent,
): WorktreeIntent {
  const otherEntries =
    existing?.entries.filter(
      (entry) => entry.workspacePath !== next.workspacePath,
    ) ?? [];
  const normalizedOthers = next.isPrimary
    ? otherEntries.map((entry) =>
        entry.isPrimary ? { ...entry, isPrimary: false } : entry,
      )
    : otherEntries;
  return { entries: [...normalizedOthers, next] };
}

/** This is a staging-time fixup, not the launch boundary. */
export function restampWorktreeIntentPrimary(
  intent: WorktreeIntent | null,
  primaryPath: string,
): WorktreeIntent | null {
  if (intent === null) return null;
  const entries = intent.entries.map((entry) => {
    const shouldBePrimary = entry.workspacePath === primaryPath;
    return entry.isPrimary === shouldBePrimary
      ? entry
      : { ...entry, isPrimary: shouldBePrimary };
  });
  const changed = entries.some(
    (entry, index) => entry !== intent.entries[index],
  );
  return changed ? { entries } : intent;
}
