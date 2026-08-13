import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const MAIN_PATH = fileURLToPath(new URL("../main.ts", import.meta.url));
const ADVERTISE_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5_000;

type PidMetadata = {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
};

let child: ChildProcess | null = null;
let tempDirs: string[] = [];

afterEach(async () => {
  const running = child;
  child = null;
  if (running !== null && isChildAlive(running)) {
    running.kill("SIGTERM");
    await waitForExit(running, EXIT_TIMEOUT_MS).catch(() => {
      running.kill("SIGKILL");
    });
  }
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("thanos-host start CLI", () => {
  it("writes pid.json after bind and prints the /rpc URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "thanos-host-"));
    tempDirs.push(root);
    const hostDataDir = join(root, "nested", "host-data");

    const started = spawnCli(["--host-data-dir", hostDataDir]);
    child = started;
    const advertisedUrl = await waitForStdoutLine(started, ADVERTISE_TIMEOUT_MS);
    const raw = await readFile(join(hostDataDir, "pid.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    expect(isPidMetadata(parsed)).toBe(true);
    if (!isPidMetadata(parsed)) {
      return;
    }

    expect(parsed.hostId).toBe("thanos-local");
    expect(parsed.version).toBe("0.0.0-thanos");
    expect(parsed.pid).toBe(started.pid);
    expect(parsed.websocketUrl).toBe(advertisedUrl);
    expect(isLoopbackRpcUrl(parsed.websocketUrl)).toBe(true);
    expect(parsed.startedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(Math.abs(Date.now() - Date.parse(parsed.startedAt))).toBeLessThan(
      10_000,
    );
  });

  it("exits non-zero without listening when --host-data-dir is missing", async () => {
    const started = spawnCli([]);
    child = started;
    const finished = await waitForExitOrListen(started, EXIT_TIMEOUT_MS);
    expect(finished.kind).toBe("exited");
    if (finished.kind !== "exited") {
      return;
    }
    expect(finished.code).not.toBe(0);
    expect(finished.stdout).not.toMatch(/ws:\/\//);
  });
});

function spawnCli(args: string[]): ChildProcess {
  return spawn("bun", [MAIN_PATH, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function isChildAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

function isPidMetadata(value: unknown): value is PidMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (
    !("pid" in value) ||
    !("hostId" in value) ||
    !("version" in value) ||
    !("websocketUrl" in value) ||
    !("startedAt" in value)
  ) {
    return false;
  }
  return (
    typeof value.pid === "number" &&
    typeof value.hostId === "string" &&
    typeof value.version === "string" &&
    typeof value.websocketUrl === "string" &&
    typeof value.startedAt === "string"
  );
}

function isLoopbackRpcUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "ws:" &&
    parsed.hostname === "127.0.0.1" &&
    parsed.port !== "" &&
    parsed.pathname === "/rpc"
  );
}

function waitForStdoutLine(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (stdout === null || stderr === null) {
      reject(new Error("thanos-host CLI is missing stdio pipes"));
      return;
    }

    let stdoutText = "";
    let stderrText = "";
    let settled = false;

    const settle = (next: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onStdout);
      stderr.off("data", onStderr);
      proc.off("error", onError);
      proc.off("exit", onExit);
      next();
    };

    const timer = setTimeout(() => {
      settle(() => {
        reject(
          new Error(
            `Timed out waiting for thanos-host stdout: ${stderrText.trim()}`,
          ),
        );
      });
    }, timeoutMs);

    const onStdout = (chunk: Buffer | string): void => {
      stdoutText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = stdoutText.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = stdoutText.slice(0, newline).trim();
      settle(() => {
        resolve(line);
      });
    };

    const onStderr = (chunk: Buffer | string): void => {
      stderrText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };

    const onError = (cause: Error): void => {
      settle(() => {
        reject(new Error("Failed to spawn thanos-host CLI", { cause }));
      });
    };

    const onExit = (code: number | null, signal: string | null): void => {
      settle(() => {
        reject(
          new Error(
            `thanos-host exited before advertising (code=${String(code)}, signal=${String(signal)}): ${stderrText.trim()}`,
          ),
        );
      });
    };

    stdout.on("data", onStdout);
    stderr.on("data", onStderr);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
}

function waitForExit(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    if (!isChildAlive(proc)) {
      resolve({ code: proc.exitCode, signal: proc.signalCode });
      return;
    }

    let settled = false;
    const settle = (next: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      proc.off("exit", onExit);
      next();
    };

    const timer = setTimeout(() => {
      settle(() => {
        reject(new Error("Timed out waiting for thanos-host to exit"));
      });
    }, timeoutMs);

    const onExit = (code: number | null, signal: string | null): void => {
      settle(() => {
        resolve({ code, signal });
      });
    };

    proc.on("exit", onExit);
  });
}

type ExitOrListen =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly stdout: string;
    }
  | { readonly kind: "listened"; readonly url: string };

function waitForExitOrListen(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<ExitOrListen> {
  return new Promise((resolve, reject) => {
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    if (stdout === null || stderr === null) {
      reject(new Error("thanos-host CLI is missing stdio pipes"));
      return;
    }

    let stdoutText = "";
    let stderrText = "";
    let settled = false;

    const settle = (next: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onStdout);
      stderr.off("data", onStderr);
      proc.off("error", onError);
      proc.off("exit", onExit);
      next();
    };

    const timer = setTimeout(() => {
      settle(() => {
        reject(
          new Error(
            `Timed out waiting for thanos-host exit or listen: ${stderrText.trim()}`,
          ),
        );
      });
    }, timeoutMs);

    const onStdout = (chunk: Buffer | string): void => {
      stdoutText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = stdoutText.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = stdoutText.slice(0, newline).trim();
      if (line.startsWith("ws://")) {
        settle(() => {
          resolve({ kind: "listened", url: line });
        });
      }
    };

    const onStderr = (chunk: Buffer | string): void => {
      stderrText += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    };

    const onError = (cause: Error): void => {
      settle(() => {
        reject(new Error("Failed to spawn thanos-host CLI", { cause }));
      });
    };

    const onExit = (code: number | null, _signal: string | null): void => {
      settle(() => {
        resolve({ kind: "exited", code, stdout: stdoutText });
      });
    };

    stdout.on("data", onStdout);
    stderr.on("data", onStderr);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
}
