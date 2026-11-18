// Injectable command runner for the *read-only* probe. Deliberately
// narrower than the CLI's ProcessRunner so this module never depends on
// traycer-cli (and cannot import install/uninstall actuators).

export type ProbeCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the runner killed the child for exceeding timeoutMs. */
  readonly timedOut: boolean;
  /** True when the binary could not be spawned (ENOENT, EACCES on exec, …). */
  readonly spawnFailed: boolean;
  readonly signal: string | null;
};

export type ProbeCommandOptions = {
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly cwd: string | undefined;
};

export type ProbeCommandRunner = (
  command: string,
  args: readonly string[],
  options: ProbeCommandOptions,
) => Promise<ProbeCommandResult>;

export function combinedOutput(result: ProbeCommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}
