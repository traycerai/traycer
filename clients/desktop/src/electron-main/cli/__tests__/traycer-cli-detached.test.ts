import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: (): string => "/tmp/traycer-test/desktop",
  },
}));

Object.defineProperty(process, "resourcesPath", {
  value: "/tmp/traycer-test/resources",
  configurable: true,
});

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../cli-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli-discovery")>();
  return {
    ...actual,
    discoverCli: async () => ({
      kind: "bundled" as const,
      binaryPath: "/tmp/traycer-test/discovered-cli/traycer",
    }),
    resolveBundledCliPath: async () => "/tmp/traycer-test/bundled-cli/traycer",
  };
});

class FakeDetachedChild extends EventEmitter {
  readonly pid = 4242;
  readonly unref = vi.fn();
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

const spawnCalls: SpawnCall[] = [];
let spawnedChild: FakeDetachedChild | null = null;

vi.mock("node:child_process", () => {
  const spawn = (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): FakeDetachedChild => {
    spawnCalls.push({ command, args, options });
    const child = new FakeDetachedChild();
    spawnedChild = child;
    return child;
  };
  const execFile = (): void => {
    throw new Error("execFile is not used by the detached spawner");
  };
  return { spawn, execFile, default: { spawn, execFile } };
});

let outputDir = "";

beforeEach(async () => {
  vi.resetModules();
  spawnCalls.length = 0;
  spawnedChild = null;
  outputDir = await mkdtemp(join(tmpdir(), "traycer-cli-detached-"));
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

function requireChild(): FakeDetachedChild {
  if (spawnedChild === null) {
    throw new Error("expected the spawner to have created a child");
  }
  return spawnedChild;
}

async function loadModule() {
  return import("../traycer-cli");
}

describe("spawnDetachedBundledTraycerCliJson", () => {
  it("spawns detached with file stdio, hidden window, and unrefs the child", async () => {
    const mod = await loadModule();
    const run = await mod.spawnDetachedBundledTraycerCliJson<unknown>({
      args: ["host", "stop", "--if-idle"],
      outputDir,
      outputStem: "stop",
    });

    expect(spawnCalls).toHaveLength(1);
    const [call] = spawnCalls;
    if (call === undefined) throw new Error("expected one spawn call");
    expect(call.command).toBe("/tmp/traycer-test/bundled-cli/traycer");
    expect(call.args).toContain("--json");
    expect(call.args.slice(0, 3)).toEqual(["host", "stop", "--if-idle"]);
    expect(call.options.detached).toBe(true);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.stdio).toEqual([
      "ignore",
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(requireChild().unref).toHaveBeenCalledTimes(1);
    expect(run.pid).toBe(4242);
    expect(run.stdoutPath.startsWith(outputDir)).toBe(true);
    expect(run.stderrPath.startsWith(outputDir)).toBe(true);
  });

  it("resolves the ok envelope's data from the stdout file once the child exits", async () => {
    const mod = await loadModule();
    const run = await mod.spawnDetachedBundledTraycerCliJson<{
      readonly forced: boolean;
    }>({ args: ["host", "stop"], outputDir, outputStem: "stop" });

    await writeFile(
      run.stdoutPath,
      [
        JSON.stringify({ type: "progress", stage: "stopping" }),
        JSON.stringify({
          type: "result",
          status: "ok",
          data: { forced: true },
        }),
      ].join("\n") + "\n",
    );
    requireChild().emit("exit", 0, null);

    await expect(run.completion).resolves.toEqual({ forced: true });
  });

  it("rejects with the CLI's own error code for an error envelope", async () => {
    const mod = await loadModule();
    const run = await mod.spawnDetachedBundledTraycerCliJson<unknown>({
      args: ["host", "stop"],
      outputDir,
      outputStem: "stop",
    });

    await writeFile(
      run.stdoutPath,
      JSON.stringify({
        type: "result",
        status: "error",
        error: { code: "E_HOST_BUSY", message: "host is busy", details: null },
      }) + "\n",
    );
    requireChild().emit("exit", 1, null);

    const failure: unknown = await run.completion.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(mod.TraycerCliError);
    if (!(failure instanceof mod.TraycerCliError)) {
      throw new Error("expected a TraycerCliError");
    }
    expect(failure.code).toBe("E_HOST_BUSY");
    expect(failure.exitCode).toBe(1);
  });

  it("rejects with a code-less TraycerCliError when the child exits with no envelope", async () => {
    const mod = await loadModule();
    const run = await mod.spawnDetachedBundledTraycerCliJson<unknown>({
      args: ["host", "stop"],
      outputDir,
      outputStem: "stop",
    });
    requireChild().emit("exit", 3, null);

    const failure: unknown = await run.completion.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(mod.TraycerCliError);
    if (!(failure instanceof mod.TraycerCliError)) {
      throw new Error("expected a TraycerCliError");
    }
    expect(failure.code).toBeNull();
    expect(failure.exitCode).toBe(3);
  });

  it("surfaces a spawn error event through completion, not synchronously", async () => {
    const mod = await loadModule();
    const run = await mod.spawnDetachedBundledTraycerCliJson<unknown>({
      args: ["host", "stop"],
      outputDir,
      outputStem: "stop",
    });

    const settled = run.completion.then(
      () => null,
      (error: unknown) => error,
    );
    // An emitter `error` with no listener would throw here; the production
    // code attached one before its first await.
    expect(() =>
      requireChild().emit("error", new Error("spawn ENOENT")),
    ).not.toThrow();

    const failure = await settled;
    expect(failure).toBeInstanceOf(mod.TraycerCliError);
    if (!(failure instanceof mod.TraycerCliError)) {
      throw new Error("expected a TraycerCliError");
    }
    expect(failure.message).toContain("spawn ENOENT");
    expect(failure.code).toBeNull();
  });

  it("prunes to at most ten runs per stem and keeps the newest", async () => {
    const mod = await loadModule();
    const runIds: string[] = [];
    for (let index = 1; index <= 12; index += 1) {
      const runId = `stop-${1_000_000_000_000 + index}-aaaaaaaa`;
      runIds.push(runId);
      await writeFile(join(outputDir, `${runId}.ndjson`), "{}\n");
      await writeFile(join(outputDir, `${runId}.log`), "");
    }
    // A different stem is never touched.
    await writeFile(join(outputDir, "start-1000000000001-bbbbbbbb.ndjson"), "");

    await mod.spawnDetachedBundledTraycerCliJson<unknown>({
      args: ["host", "stop"],
      outputDir,
      outputStem: "stop",
    });

    const names = await readdir(outputDir);
    const stopRuns = new Set(
      names
        .filter((name) => name.startsWith("stop-"))
        .map((name) => name.replace(/\.(ndjson|log)$/, "")),
    );
    expect(stopRuns.size).toBeLessThanOrEqual(10);
    // The newest nine pre-existing runs survive alongside the new one.
    for (const survivor of runIds.slice(3)) {
      expect(stopRuns.has(survivor)).toBe(true);
    }
    for (const pruned of runIds.slice(0, 3)) {
      expect(stopRuns.has(pruned)).toBe(false);
      expect(names).not.toContain(`${pruned}.ndjson`);
      expect(names).not.toContain(`${pruned}.log`);
    }
    expect(names).toContain("start-1000000000001-bbbbbbbb.ndjson");
  });

  it("does not prune when the directory holds fewer runs than the cap", async () => {
    const mod = await loadModule();
    for (let index = 1; index <= 3; index += 1) {
      await writeFile(
        join(outputDir, `stop-${1_000_000_000_000 + index}-aaaaaaaa.ndjson`),
        "{}\n",
      );
    }
    await mod.spawnDetachedBundledTraycerCliJson<unknown>({
      args: ["host", "stop"],
      outputDir,
      outputStem: "stop",
    });
    const names = await readdir(outputDir);
    expect(
      names.filter((name) => /^stop-100000000000[123]-/.test(name)),
    ).toHaveLength(3);
  });
});
