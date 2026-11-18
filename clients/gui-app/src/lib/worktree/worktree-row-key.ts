/**
 * Stable identity key for a worktree row: a host plus the directory the
 * worktree actually runs in. Shared by every surface that lists worktree
 * bindings (git diff panel, pickers) so selection state and label maps agree
 * on row identity.
 */
export function worktreeRowKey(worktree: {
  readonly hostId: string;
  readonly runningDir: string;
}): string {
  return `${worktree.hostId}\0${worktree.runningDir}`;
}
