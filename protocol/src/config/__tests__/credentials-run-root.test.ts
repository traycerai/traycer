import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";
import {
  createRunRoot,
  processExists,
  recordWorker,
  removeRunRootOnceWorkersGone,
  workerRecords,
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
const RELEASE_WORKER_SETUP = join(
  FIXTURE_ROOT,
  "release-worker.global-setup.ts",
);

describe("credentials test run root", () => {
  it("is kept while a recorded worker runs and removed once it has exited", async () => {
    const root = createRunRoot();
    const worker = spawn(process.execPath, [
      "-e",
      "setInterval(() => undefined, 1 << 30)",
    ]);
    const spawned = Promise.withResolvers<void>();
    worker.once("spawn", () => spawned.resolve());
    await spawned.promise;
    const pid = worker.pid;
    if (pid === undefined) throw new Error("worker spawned without a pid");
    recordWorker(root, pid);

    expect(removeRunRootOnceWorkersGone(root)).toEqual({
      removed: false,
      reason: `worker ${pid} may still be running`,
    });
    expect(existsSync(root)).toBe(true);

    const exited = Promise.withResolvers<void>();
    worker.once("exit", () => exited.resolve());
    worker.kill();
    await exited.promise;

    expect(removeRunRootOnceWorkersGone(root)).toEqual({ removed: true });
    expect(existsSync(root)).toBe(false);
  });

  it("is kept when a worker record names no process", () => {
    const root = createRunRoot();
    mkdirSync(join(root, ".workers"));
    writeFileSync(join(root, ".workers", "not-a-pid"), "");
    try {
      expect(removeRunRootOnceWorkersGone(root)).toEqual({
        removed: false,
        reason: "unrecognised worker record not-a-pid",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The fixture worker parks in a SIGTERM handler, which win32 does not deliver.
  it.skipIf(process.platform === "win32")(
    "stays until vitest has stopped its workers, then goes",
    async () => {
      const stopLogDirectory = mkdtempSync(join(tmpdir(), "traycer-run-root-"));
      const stopLog = join(stopLogDirectory, "stop.log");
      process.env.CREDENTIALS_RUN_ROOT_STOP_LOG = stopLog;
      process.env.CREDENTIALS_RUN_ROOT_RELEASE_FILE = join(
        stopLogDirectory,
        "release",
      );
      const vitest = await createVitest("test", {
        root: FIXTURE_ROOT,
        config: false,
        watch: false,
        reporters: [],
        include: ["case.fixture.ts"],
        globalSetup: [RELEASE_WORKER_SETUP, GLOBAL_SETUP],
        pool: "forks",
        isolate: false,
        maxWorkers: 1,
      });
      try {
        const { testModules, unhandledErrors } = await vitest.start();
        expect(unhandledErrors).toEqual([]);
        expect(testModules.map((module) => module.state())).toEqual(["passed"]);

        const root = vitest
          .getRootProject()
          .getProvidedContext().credentialsTestRoot;
        const [workerRecord] = workerRecords(root);
        const worker = Number(workerRecord);
        expect(workerRecords(root)).toHaveLength(1);
        expect(processExists(worker)).toBe(true);
        expect(
          readdirSync(root).filter((name) => name.startsWith("fixture-case-")),
        ).toHaveLength(1);

        await vitest.close();

        expect(readFileSync(stopLog, "utf8")).toBe("present");
        expect(processExists(worker)).toBe(false);
        expect(existsSync(root)).toBe(false);
      } finally {
        await vitest.close();
        delete process.env.CREDENTIALS_RUN_ROOT_STOP_LOG;
        delete process.env.CREDENTIALS_RUN_ROOT_RELEASE_FILE;
        rmSync(stopLogDirectory, { recursive: true, force: true });
      }
    },
  );
});
