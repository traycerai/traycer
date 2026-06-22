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
    execFile(
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
        const summary =
          killed && signal !== null
            ? `timed out after ${options.timeoutMs}ms (killed via ${signal})`
            : `exited with code ${exitCode}`;
        reject(
          new ProcessRunError(
            `${command} ${args.join(" ")} ${summary}: ${stderrStr.trim() || stdoutStr.trim()}`,
            command,
            args,
            exitCode,
            stdoutStr,
            stderrStr,
          ),
        );
      },
    );
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
