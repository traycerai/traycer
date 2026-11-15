import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVitest, type Vitest } from "vitest/node";
import type { RunRootObservations } from "./fixtures/credentials-run-root/observe-run-root.global-setup";
import {
  createRunRoot,
  recordWorker,
  removeRunRootOnceWorkersGone,
} from "./credentials-run-root";

const FIXTURE_ROOT = join(
  import.meta.dirname,
  "fixtures",
  "credentials-run-root",
);
const GLOBAL_SETUP = join(
  import.meta.dirname,
  "credentials-run-root.global-setup.ts",
);
const OBSERVE_SETUP = join(FIXTURE_ROOT, "observe-run-root.global-setup.ts");
const EXTRA_WORKER_ENV = "CREDENTIALS_RUN_ROOT_EXTRA_WORKER";

type LongLivedChild = {
  readonly pid: number;
  /** Ends the child and resolves once it has exited; safe to call again. */
  readonly stop: () => Promise<void>;
};

async function spawnLongLivedChild(): Promise<LongLivedChild> {
  const child = spawn(process.execPath, [
    "-e",
    "setInterval(() => undefined, 1 << 30)",
  ]);
  const spawned = Promise.withResolvers<void>();
  child.once("spawn", () => spawned.resolve());
  child.once("error", spawned.reject);
  const exited = Promise.withResolvers<void>();
  child.once("exit", () => exited.resolve());
  await spawned.promise;
  const pid = child.pid;
  if (pid === undefined) throw new Error("child spawned without a pid");
  return {
    pid,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited.promise;
    },
  };
}

/** Runs every step, even after one throws, and reports all failures. */
async function runAll(steps: readonly (() => unknown)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "cleanup failed");
}

function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

describe("credentials test run root", () => {
  it("is kept while a recorded process runs and removed once it has exited", async () => {
    const root = createRunRoot();
    let child: LongLivedChild | null = null;
    try {
      child = await spawnLongLivedChild();
      recordWorker(root, child.pid);

      expect(removeRunRootOnceWorkersGone(root)).toEqual({
        removed: false,
        reason: `worker ${child.pid} may still be running`,
      });
      expect(existsSync(root)).toBe(true);

      await child.stop();

      expect(removeRunRootOnceWorkersGone(root)).toEqual({ removed: true });
      expect(existsSync(root)).toBe(false);
    } finally {
      await runAll([() => child?.stop(), () => removeTree(root)]);
    }
  });

  it("is kept when a worker record names no process", async () => {
    const root = createRunRoot();
    try {
      mkdirSync(join(root, ".workers"));
      writeFileSync(join(root, ".workers", "not-a-pid"), "");

      expect(removeRunRootOnceWorkersGone(root)).toEqual({
        removed: false,
        reason: "unrecognised worker record not-a-pid",
      });
    } finally {
      removeTree(root);
    }
  });

  /**
   * Runs the fixture case in a nested vitest whose fork worker records its pid
   * in the run root, then closes it. `extraWorkerPid` is a process the case
   * records as a second worker.
   */
  async function runNestedFixture(
    extraWorkerPid: number | null,
    check: (observed: {
      root: string;
      observations: RunRootObservations;
    }) => void | Promise<void>,
  ): Promise<void> {
    const previousExtraWorker = process.env[EXTRA_WORKER_ENV];
    let vitest: Vitest | null = null;
    let root: string | null = null;
    try {
      if (extraWorkerPid !== null) {
        process.env[EXTRA_WORKER_ENV] = String(extraWorkerPid);
      }
      vitest = await createVitest("test", {
        root: FIXTURE_ROOT,
        config: false,
        watch: false,
        reporters: [],
        include: ["case.fixture.ts"],
        globalSetup: [OBSERVE_SETUP, GLOBAL_SETUP],
        pool: "forks",
        isolate: false,
        maxWorkers: 1,
      });
      const { testModules, unhandledErrors } = await vitest.start();
      expect(unhandledErrors).toEqual([]);
      expect(testModules.map((module) => module.state())).toEqual(["passed"]);
      const provided = vitest.getRootProject().getProvidedContext();
      root = provided.credentialsTestRoot;

      await vitest.close();

      await check({ root, observations: provided.runRootObservations });
    } finally {
      await runAll([
        // A run that failed before `start()` returned has not yet recorded its
        // root; `close()` clears the provided context, so read it first.
        () => {
          if (root !== null || vitest === null) return;
          const provided = vitest.getRootProject().getProvidedContext();
          if (typeof provided.credentialsTestRoot === "string") {
            root = provided.credentialsTestRoot;
          }
        },
        // `close()` returns the cached closing promise, so a second call after
        // the one above settles the same close.
        () => vitest?.close(),
        () => {
          if (root !== null) removeTree(root);
        },
        () => {
          if (previousExtraWorker === undefined) {
            delete process.env[EXTRA_WORKER_ENV];
          } else {
            process.env[EXTRA_WORKER_ENV] = previousExtraWorker;
          }
        },
      ]);
    }
  }

  it("stays through global teardown and goes after vitest has awaited its workers", async () => {
    await runNestedFixture(null, ({ root, observations }) => {
      expect(observations.rootAtGlobalTeardown).toBe(true);
      expect(observations.atClose).toEqual({ alive: [], rootExists: true });
      expect(existsSync(root)).toBe(false);
    });
  });

  it("stays through the real close while a recorded process runs, then goes once it has exited", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let child: LongLivedChild | null = null;
    try {
      child = await spawnLongLivedChild();
      const running = child;
      await runNestedFixture(running.pid, async ({ root, observations }) => {
        expect(observations.atClose).toEqual({
          alive: [running.pid],
          rootExists: true,
        });
        expect(existsSync(root)).toBe(true);
        expect(warn).toHaveBeenCalledWith(
          `credentials test root ${root} kept: worker ${running.pid} may still be running`,
        );

        await running.stop();

        expect(removeRunRootOnceWorkersGone(root)).toEqual({ removed: true });
        expect(existsSync(root)).toBe(false);
      });
    } finally {
      await runAll([() => child?.stop(), () => warn.mockRestore()]);
    }
  });
});
