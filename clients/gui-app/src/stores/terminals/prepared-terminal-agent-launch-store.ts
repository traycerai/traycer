export interface PreparedTerminalAgentLaunch {
  readonly cwd: string;
  readonly shellCommand: string;
  readonly shellArgs: readonly string[];
  readonly worktreeBusyPaths: readonly string[];
}

const preparedLaunches = new Map<string, PreparedTerminalAgentLaunch>();

export function stashPreparedTerminalAgentLaunch(
  terminalAgentId: string,
  launch: PreparedTerminalAgentLaunch,
): void {
  preparedLaunches.set(terminalAgentId, {
    cwd: launch.cwd,
    shellCommand: launch.shellCommand,
    shellArgs: [...launch.shellArgs],
    worktreeBusyPaths: [...launch.worktreeBusyPaths],
  });
}

/**
 * Non-destructive read. The first tile mount uses this so a FAILED
 * `terminal.create` (the PTY never started, so the fork command never ran) can
 * be retried against the SAME fork-prepared args - a destructive read would lose
 * them on retry and silently fall back to a fresh, non-forked launch. The entry
 * is cleared via {@link clearPreparedTerminalAgentLaunch} once `terminal.create`
 * succeeds (the PTY is live; later reopens resume the now-persisted session).
 */
export function peekPreparedTerminalAgentLaunch(
  terminalAgentId: string,
): PreparedTerminalAgentLaunch | null {
  const launch = preparedLaunches.get(terminalAgentId);
  if (launch === undefined) return null;
  return {
    cwd: launch.cwd,
    shellCommand: launch.shellCommand,
    shellArgs: [...launch.shellArgs],
    worktreeBusyPaths: [...launch.worktreeBusyPaths],
  };
}

export function clearPreparedTerminalAgentLaunch(
  terminalAgentId: string,
): void {
  preparedLaunches.delete(terminalAgentId);
}
