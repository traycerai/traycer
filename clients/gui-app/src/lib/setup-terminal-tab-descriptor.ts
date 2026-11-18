import type { WorktreeBindingEntry } from "@traycer/protocol/host/worktree-schemas";

/**
 * Canvas-tab descriptor fields for a worktree SETUP terminal, shared by the
 * chat and terminal-agent tab-register drivers so the auto-opened tab is named
 * and rooted identically on both surfaces (they converge on the same tab id).
 */

export function setupTerminalCwd(entry: WorktreeBindingEntry): string {
  if (entry.mode === "worktree" && entry.worktreePath !== null) {
    return entry.worktreePath;
  }
  return entry.workspacePath;
}

export function setupTerminalTitle(entry: WorktreeBindingEntry): string {
  return `Setup: ${labelForWorkspace(entry.workspacePath)} ${entry.branch}`;
}

function labelForWorkspace(workspacePath: string): string {
  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  const segments = trimmed.split(/[\\/]/u);
  const last = segments.at(-1);
  return last !== undefined && last.length > 0 ? last : workspacePath;
}
