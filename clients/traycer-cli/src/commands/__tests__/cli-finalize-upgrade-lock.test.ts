import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";

// Genuine two-process regression coverage for `cli finalize-upgrade`'s
// `cli-lock` wiring (Host Update Layer Redesign Tech Plan, "Windows
// CLI-finalize helper", Verification: "Windows finalize-helper waits
// behind a live apply and never starts the service between apply's
// renames"). The detached helper script invokes this hidden command
// (via the staged binary) to complete a pending self-upgrade; it must
// not be able to swap the binary / start the service while another
// actor (e.g. an in-progress `host apply`) owns the apply/install/
// activation critical section - only real OS-level file contention
// (the same worker `cli-lock.test.ts`/`host-restart-lock.test.ts` use)
// can be trusted to prove this.

const mocks = vi.hoisted(() => ({
  finalizeCalls: [] as string[],
  controllerCalls: [] as string[],
}));

vi.mock("../cli-upgrade", () => ({
  finalizePendingCliUpgrade: async () => {
    mocks.finalizeCalls.push("finalize");
    return { status: "no-pending" };
  },
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      install: async () => undefined,
      uninstall: async () => undefined,
      status: async () => ({
        state: "stopped" as const,
        version: null,
        listenUrl: null,
        pid: null,
      }),
      stop: async () => {
        mocks.controllerCalls.push("stop");
      },
      start: async () => {
        mocks.controllerCalls.push("start");
      },
      restart: async () => {
        mocks.controllerCalls.push("restart");
      },
    }),
  };
});

// `process.env.HOME`/`USERPROFILE` mutation alone is not trustworthy under
// `bun --bun`, which can honor its own startup home independently of a
// runtime env mutation - the exact root cause of a prior incident where a
// test's real `os.homedir()` resolved to the operator's actual home,
// pointing `cliLockPath` at the REAL `~/.traycer/cli/.lock` and sending
// genuine lock contention/break traffic at a live production CLI/host
// (see commit 96fc9f47). Mocking `node:os.homedir()` directly makes the
// sandbox authoritative regardless of Bun's own caching behavior; the env
// mutation below is kept too since some code path may still read it.
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

// See host-restart-lock.test.ts's identical helper: the "exit" listener
// must be registered immediately, not lazily - the worker can legitimately
// exit within milliseconds of the release barrier.
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
  "cli finalize-upgrade - genuine cli-lock contention",
  () => {
    beforeEach(() => {
      workHome = mkdtempSync(
        join(tmpdir(), "traycer-cli-finalize-upgrade-lock-test-"),
      );
      osHome.current = workHome;
      process.env.HOME = workHome;
      process.env.USERPROFILE = workHome;
      // `store/paths` captures `homedir()` once at module load - drop the
      // module cache so the dynamic imports below see this test's own
      // tmp HOME (the mocked `node:os.homedir()` above, not the real one).
      vi.resetModules();
      mocks.finalizeCalls = [];
      mocks.controllerCalls = [];
    });

    afterEach(() => {
      if (ORIGINAL_HOME === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = ORIGINAL_HOME;
      }
      if (ORIGINAL_USERPROFILE === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = ORIGINAL_USERPROFILE;
      }
      rmSync(workHome, { recursive: true, force: true });
    });

    it("blocks behind a foreign lock holder (e.g. an in-progress apply) - never swaps or starts the service inside its critical section - and proceeds only after it releases", async () => {
      const { cliLockPath, ensureCliInstallHomeDir } =
        await import("../../store/paths");
      await ensureCliInstallHomeDir("production");
      const lockPath = cliLockPath("production");

      const holdBarrierDir = mkdtempSync(
        join(tmpdir(), "traycer-finalize-upgrade-lock-barrier-"),
      );
      const { exited } = spawnLockWorker(WORKER_SCRIPT, {
        WORKER_LOCK_PATH: lockPath,
        WORKER_MARKER_DIR: holdBarrierDir,
        WORKER_LABEL: "foreign-holder",
        WORKER_HOLD_BARRIER_DIR: holdBarrierDir,
      });

      try {
        await waitForFile(join(holdBarrierDir, "held"));

        const { cliFinalizeUpgradeCommand } =
          await import("../cli-finalize-upgrade");
        const pending = cliFinalizeUpgradeCommand(fakeCtx());

        // Give the command every chance to (wrongly) proceed while the
        // worker still genuinely holds the lock on disk.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(mocks.finalizeCalls).toEqual([]);
        expect(mocks.controllerCalls).toEqual([]);

        writeFileSync(join(holdBarrierDir, "release"), "");
        const result = await pending;
        expect(mocks.finalizeCalls).toEqual(["finalize"]);
        expect(result.data).toEqual({ status: "no-pending" });
      } finally {
        expect(await exited).toBe(0);
        rmSync(holdBarrierDir, { recursive: true, force: true });
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
