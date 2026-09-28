import { execFile, type ChildProcess } from "node:child_process";

/**
 * How long a child that `execFile`'s timeout signalled has to exit before it
 * is SIGKILLed.
 *
 * `execFile`'s timeout sends SIGTERM and destroys the child's stdio, but its
 * callback fires only on the child's `close`, and that needs the child to
 * EXIT. A child that ignores SIGTERM therefore held the promise open for as
 * long as it ran - a timeout that did not time out
 * (`process-runner-timeout-escalation.test.ts`). The stdio destroy already
 * frees a call whose grandchild holds the pipes; this escalation frees one
 * whose child outlives the signal.
 */
export const PROCESS_TIMEOUT_KILL_GRACE_MS = 2_000;

/**
 * Arm the SIGKILL that follows `execFile`'s own timeout signal, and return the
 * disarm the completion callback calls first. A call with no timeout
 * (`timeoutMs <= 0`, which `execFile` reads as "none") arms nothing.
 */
function armTimeoutKillEscalation(
  child: ChildProcess,
  timeoutMs: number,
): () => void {
  if (timeoutMs <= 0) return () => undefined;
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone: its `close` settles the call.
    }
  }, timeoutMs + PROCESS_TIMEOUT_KILL_GRACE_MS);
  return () => clearTimeout(timer);
}

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

/**
 * {@link RunOptions} for a command that must never wait on its stdin:
 * `runCommand` ends the child's stdin as soon as it is spawned, so a prompt
 * the command may print reads EOF and returns at once instead of holding the
 * call until its timeout. `schtasks /Create` without `/F` is the one user: on
 * a task that already exists it refuses, and a build that asked "overwrite?
 * (Y/N)" first would otherwise wait on the open pipe `execFile` leaves.
 */
export interface EndedStdinRunOptions extends RunOptions {
  readonly endStdin: true;
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
    // Assigned once `execFile` returns; the callback always runs later.
    let disarmEscalation: () => void = () => undefined;
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
        disarmEscalation();
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
        const timedOut = !spawnFailed && killed && signal !== null;
        const summary = spawnFailed
          ? `could not be spawned (${err.code})`
          : timedOut
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
            : timedOut
              ? new ProcessTimeoutError(
                  message,
                  command,
                  args,
                  exitCode,
                  stdoutStr,
                  stderrStr,
                  options.timeoutMs,
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
    if ("endStdin" in options && options.endStdin === true) {
      child.stdin?.end();
    }
    disarmEscalation = armTimeoutKillEscalation(child, options.timeoutMs);
  });
}

export interface RunBytesResult {
  readonly stdout: Buffer;
  /**
   * The child's stderr, decoded as UTF-8 (lossy): diagnostic text for the
   * caller that must tell one failure from another, never parsed as data.
   */
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * {@link runCommand} for a READ whose stdout is not UTF-8 - `schtasks /Query
 * /XML` writes UTF-16LE, which a `utf8` decode turns into garbage. Resolves
 * with the raw bytes and the exit code whatever that code is (the caller
 * decides what a non-zero exit means); rejects only when the child could not
 * be run at all, ran past `timeoutMs`, or overflowed the output cap.
 */
export function runCommandForBytes(
  command: string,
  args: readonly string[],
  options: Omit<RunOptions, "tolerateNonZeroExit">,
): Promise<RunBytesResult> {
  return new Promise((resolve, reject) => {
    // Assigned once `execFile` returns; the callback always runs later.
    let disarmEscalation: () => void = () => undefined;
    const child = execFile(
      command,
      [...args],
      {
        env: options.env ?? process.env,
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "buffer",
      },
      (err, stdout, stderr) => {
        disarmEscalation();
        const stderrText = stderr.toString("utf8");
        if (err === null) {
          resolve({ stdout, stderr: stderrText, exitCode: 0 });
          return;
        }
        if (typeof err.code === "number") {
          resolve({ stdout, stderr: stderrText, exitCode: err.code });
          return;
        }
        reject(err);
      },
    );
    disarmEscalation = armTimeoutKillEscalation(child, options.timeoutMs);
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

/**
 * The child ran past `timeoutMs` and this runner killed it. Still a
 * {@link ProcessRunError} for every caller that only asks "did it fail", and a
 * distinct class for the callers whose command outlives the process that
 * issued it: killing `launchctl kickstart -k` or `systemctl restart` does not
 * withdraw a request the service manager has already accepted - it finishes
 * the job regardless - so such a caller must report a timeout as unconfirmed,
 * never as the operation having failed.
 *
 * The discriminator is that the child died BY the runner's timeout signal
 * (`killed` with a `signal`). A child that traps SIGTERM and exits with a code
 * of its own reads as an ordinary {@link ProcessRunError}, a genuine failure.
 * That is right for `launchctl` and `systemctl`, which do not trap it, and is
 * why this is not a general-purpose timeout class for any binary. One that
 * ignores SIGTERM past {@link PROCESS_TIMEOUT_KILL_GRACE_MS} is SIGKILLed and
 * reads as a timeout (`killed via SIGKILL`).
 */
export class ProcessTimeoutError extends ProcessRunError {
  public readonly timeoutMs: number;
  constructor(
    message: string,
    command: string,
    args: readonly string[],
    exitCode: number,
    stdout: string,
    stderr: string,
    timeoutMs: number,
  ) {
    super(message, command, args, exitCode, stdout, stderr);
    this.name = "ProcessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
