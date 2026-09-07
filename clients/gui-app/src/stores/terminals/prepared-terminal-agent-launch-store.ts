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

/** Non-destructive read. */
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
