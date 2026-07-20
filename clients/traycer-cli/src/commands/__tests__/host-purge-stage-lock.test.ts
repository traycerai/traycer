import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";

// `host purge-stage` is a destructive yanked-release handoff. This uses a
// real foreign process holding the actual lock file: a passthrough lock mock
// would still pass if the command stopped acquiring the lock entirely.
const mocks = vi.hoisted(() => ({ purgeCalls: 0 }));

vi.mock("../../installer/stage-reconcile", () => ({
  purgeHostStage: async () => {
    mocks.purgeCalls += 1;
    return { outcome: "purged" as const, purged: true as const };
  },
}));

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function spawnLockWorker(
  workerScript: string,
  env: Record<string, string>,
): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
} {
  const child = spawn("bun", ["run", workerScript], {
    env: { ...process.env, ...env },
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  return { child, exited };
}

const WORKER_SCRIPT = join(
  __dirname,
  "..",
  "..",
  "store",
  "__tests__",
  "fixtures",
  "cli-lock-worker.ts",
);

describe.skipIf(process.platform === "win32")(
  "host purge-stage - genuine cli-lock contention",
  () => {
    beforeEach(() => {
      workHome = mkdtempSync(join(tmpdir(), "traycer-host-purge-lock-test-"));
      osHome.current = workHome;
      process.env.HOME = workHome;
      process.env.USERPROFILE = workHome;
      vi.resetModules();
      mocks.purgeCalls = 0;
    });

    afterEach(() => {
      if (ORIGINAL_HOME === undefined) delete process.env.HOME;
      else process.env.HOME = ORIGINAL_HOME;
      if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
      rmSync(workHome, { recursive: true, force: true });
    });

    it("cannot purge a staged host while another CLI actor owns the mutation lock", async () => {
      const { cliLockPath, ensureCliInstallHomeDir } =
        await import("../../store/paths");
      await ensureCliInstallHomeDir("production");
      const lockPath = cliLockPath("production");
      const barrierDir = mkdtempSync(join(tmpdir(), "traycer-purge-lock-"));
      const { exited } = spawnLockWorker(WORKER_SCRIPT, {
        WORKER_LOCK_PATH: lockPath,
        WORKER_MARKER_DIR: barrierDir,
        WORKER_LABEL: "foreign-holder",
        WORKER_HOLD_BARRIER_DIR: barrierDir,
      });

      try {
        await waitForFile(join(barrierDir, "held"));
        const { buildHostPurgeStageCommand } =
          await import("../host-purge-stage");
        const pending = buildHostPurgeStageCommand({
          expectedStageFingerprint: "stage-a",
        })(fakeCtx());

        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(mocks.purgeCalls).toBe(0);

        writeFileSync(join(barrierDir, "release"), "");
        await expect(pending).resolves.toMatchObject({
          data: { outcome: "purged", purged: true },
        });
        expect(mocks.purgeCalls).toBe(1);
      } finally {
        writeFileSync(join(barrierDir, "release"), "");
        expect(await exited).toBe(0);
        rmSync(barrierDir, { recursive: true, force: true });
      }
    }, 20_000);
  },
);

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}
