import { spawn, type ChildProcess } from "node:child_process";
import { errnoCode } from "../errno-code";

/**
 * The one process-spawning seam the secret providers share. Injected into
 * every provider so the suites drive a fake and never the real `security`,
 * `secret-tool`, or `powershell`.
 *
 * `stdin` exists because a DPAPI blob must never travel on argv, where every
 * process on the machine can read it from the process table.
 */
export interface CommandRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly stdin: string | null;
  readonly timeoutMs: number;
}

export type CommandResult =
  | {
      readonly kind: "exited";
      readonly exitCode: number | null;
      readonly stdout: string;
    }
  | { readonly kind: "spawn-failed"; readonly code: string | null }
  | { readonly kind: "timed-out" };

export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

const MAX_OUTPUT_BYTES = 64 * 1024;

export const runCommand: CommandRunner = (request) =>
  new Promise<CommandResult>((resolve) => {
    let settled = false;
    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = spawn(request.file, [...request.args], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      settle({ kind: "spawn-failed", code: errnoCode(error) });
      return;
    }
    const chunks: Buffer[] = [];
    let collected = 0;
    const timer = setTimeout(() => {
      settle({ kind: "timed-out" });
      child.kill();
    }, request.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({ kind: "spawn-failed", code: errnoCode(error) });
    });
    // The pipe is its own emitter: an error on it (the far end gone before
    // the read drained) is not the child's `error`, and unhandled it would
    // throw out of this process's event loop.
    child.stdout?.on("error", (error) => {
      clearTimeout(timer);
      settle({ kind: "spawn-failed", code: errnoCode(error) });
      child.kill();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (collected >= MAX_OUTPUT_BYTES) return;
      collected += chunk.length;
      chunks.push(chunk);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      settle({
        kind: "exited",
        exitCode,
        stdout: Buffer.concat(chunks).toString("utf8"),
      });
    });
    if (request.stdin !== null) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(request.stdin);
    } else {
      child.stdin?.end();
    }
  });
