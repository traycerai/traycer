/**
 * Resolves the running directory from a WorktreeBindingEntry.
 * Per Q4 lock: for "worktree" mode, returns worktreePath (may be null);
 * for "local" mode, returns workspacePath.
 */

import type { WorktreeBindingEntry } from "@traycer/protocol/host";

export function resolveBindingRunningDir(
  entry: WorktreeBindingEntry,
): string | null {
  if (entry.mode === "worktree") {
    return entry.worktreePath;
  }
  return entry.workspacePath;
}
