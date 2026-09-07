import { execFile } from "node:child_process";

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunOptions {
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly cwd: string | undefined;
  readonly timeoutMs: number;
  // When true, a non-zero exit code resolves rather than rejects. Use
  // for commands like `launchctl bootout` whose non-zero exit is an
  // expected "already gone" signal.
  readonly tolerateNonZeroExit: boolean;
}

// Promisified `child_process.execFile` with consistent error semantics
// across platforms. Lifted from the Desktop service-installer so the
// behaviour stays uniform after the move into the CLI.
export function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Affirmative "the child started" evidence, recorded from the process
    // handle itself rather than inferred from the shape of the error: a
    // spawned child has a pid the moment `execFile` returns (and emits
    // `spawn`), one that failed at fork/exec has neither. The error's `code`
    // TYPE is not that evidence - execFile also reports a string code for a
    // child that DID run and overflowed `maxBuffer`
    // (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), which must stay a run failure.
    let spawned = false;
    const child = execFile(
      command,
      [...args],
      {
        env: options.env ?? process.env,
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const stdoutStr = String(stdout);
        const stderrStr = String(stderr);
        if (err === null) {
          resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode: 0 });
          return;
        }
        const exitCode = typeof err.code === "number" ? err.code : -1;
        if (options.tolerateNonZeroExit) {
          resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode });
          return;
        }
        // Distinguish timeout/signal kills from genuine non-zero exits so
        // the resulting CLI error tells the operator which knob to turn
        // (raise `timeoutMs`) instead of pointing at a phantom "exit -1".
        // execFile sets `err.signal` (and `err.killed`) when its own
        // timer fires SIGTERM at the child.
        const errWithSignal = err as NodeJS.ErrnoException & {
          signal?: string | null;
          killed?: boolean;
        };
        const signal = errWithSignal.signal ?? null;
        const killed = errWithSignal.killed === true;
        // Never started: no pid and no `spawn` event, and execFile reported
        // the errno (`ENOENT`, `EACCES`, `EAGAIN`) instead of an exit status.
        // A child that ran and failed carries a numeric exit code, one this
        // runner killed carries a signal, and one that overflowed `maxBuffer`
        // carries a string code but DID start - the pid keeps it a run error.
        const spawnFailed = !spawned && typeof err.code === "string" && !killed;
        const summary = spawnFailed
          ? `could not be spawned (${err.code})`
          : killed && signal !== null
            ? `timed out after ${options.timeoutMs}ms (killed via ${signal})`
            : `exited with code ${exitCode}`;
        const message = `${command} ${args.join(" ")} ${summary}: ${stderrStr.trim() || stdoutStr.trim()}`;
        reject(
          spawnFailed
            ? new ProcessSpawnError(
                message,
                command,
                args,
                exitCode,
                stdoutStr,
                stderrStr,
              )
            : new ProcessRunError(
                message,
                command,
                args,
                exitCode,
                stdoutStr,
                stderrStr,
              ),
        );
      },
    );
    // Both signals, because they arrive at different times: the pid is set
    // synchronously when the fork succeeded, `spawn` fires once the child is
    // running. Either is proof the command reached the OS; the callback
    // above runs after both (execFile's error path defers to the next tick).
    if (typeof child.pid === "number") {
      spawned = true;
    }
    child.once("spawn", () => {
      spawned = true;
    });
  });
}

export class ProcessRunError extends Error {
  public readonly command: string;
  public readonly args: readonly string[];
  public readonly exitCode: number;
  public readonly stdout: string;
  public readonly stderr: string;
  constructor(
    message: string,
    command: string,
    args: readonly string[],
    exitCode: number,
    stdout: string,
    stderr: string,
  ) {
    super(message);
    this.name = "ProcessRunError";
    this.command = command;
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * The child never started - `execFile` reported a spawn errno (`ENOENT`,
 * `EACCES`) rather than an exit status. Still a {@link ProcessRunError} for
 * every caller that only asks "did it fail", and a distinct class for the
 * callers whose answer depends on whether the command REACHED its target: a
 * `launchctl bootout` that could not be spawned provably evicted nothing,
 * where one that ran and failed may have.
 */
export class ProcessSpawnError extends ProcessRunError {
  constructor(
    message: string,
    command: string,
    args: readonly string[],
    exitCode: number,
    stdout: string,
    stderr: string,
  ) {
    super(message, command, args, exitCode, stdout, stderr);
    this.name = "ProcessSpawnError";
  }
}
