import type {
  WorktreeEntryScripts,
  WorktreeIntent,
  WorktreeFolderIntent,
} from "@traycer/protocol/host/worktree-schemas";

/**
 * Updates the setup/teardown `scripts` override on the staged `worktree` entry
 * for `workspacePath`, preserving its branch selection. The Environment chip
 * uses this so an environment edit rides the worktree intent (and reaches the
 * new worktree at create) without touching the source checkout. A no-op (same
 * reference returned) when the folder has no staged `worktree` entry - a
 * `local` / `import` folder has no worktree to attach scripts to.
 */
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

/**
 * Re-marks every staged entry's `isPrimary` bit to match `primaryPath` -
 * the target entry (if staged) flips true, every other staged entry flips
 * false. Entries are otherwise untouched (never removed, reordered, or
 * recreated - scripts and branch selections survive intact), and a call that
 * changes nothing returns the SAME reference so callers can skip a write.
 * Used when the explicit primary switches, so a staged intent set from
 * BEFORE the switch never sends a stale `isPrimary` to another consumer.
 *
 * This is a STAGING-time fixup, not the launch boundary: it can only restamp
 * entries that already exist, so promoting a folder with no staged entry (a
 * non-git folder is never auto-staged) leaves the intent with zero primaries
 * until `effectiveWorktreeIntent` canonicalizes it at launch.
 */
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
