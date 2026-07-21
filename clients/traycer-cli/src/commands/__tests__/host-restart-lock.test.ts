import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";

// Genuine two-process regression coverage for `host restart`'s `cli-lock`
// wiring (Host Update Layer Redesign Tech Plan, "Lifecycle lock
// coverage" + "host restart --if-idle"). An in-process
// `Promise.allSettled`-style test can't reproduce a real cross-process
// TOCTOU window - only actual OS-level file contention (via
// `store/__tests__/fixtures/cli-lock-worker.ts`, the same worker
// `cli-lock.test.ts` uses) can be trusted to exercise:
//
//   1. a terminal `host restart` genuinely BLOCKS while another actor
//      (e.g. an in-progress `host apply`) holds the lock, then proceeds
//      once it releases - never entering that actor's critical section;
//   2. `--if-idle`'s busy probe runs strictly AFTER lock acquisition, so
//      an agent that starts busy WHILE restart is still waiting behind
//      a foreign holder is still caught (a pre-wait probe would have
//      missed it).

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  busyOverride: null as "busy" | null,
  attestationBarrier: null as {
    readonly signalStarted: () => void;
    readonly release: Promise<void>;
  } | null,
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

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async () => {
    if (mocks.busyOverride === "busy") {
      throw Object.assign(new Error("host is busy"), { code: "E_HOST_BUSY" });
    }
  },
}));

// The barrier intentionally wraps the real attestation read. Pausing it
// while a real foreign process waits on cli-lock proves the read has not
// slipped to after lock release (a passthrough withCliLock mock cannot).
vi.mock("../../host/attested-install-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../host/attested-install-runtime")
    >();
  return {
    ...actual,
    attestInstallRuntime: async (environment: "dev" | "production") => {
      const barrier = mocks.attestationBarrier;
      if (barrier !== null) {
        barrier.signalStarted();
        await barrier.release;
      }
      return actual.attestInstallRuntime(environment);
    },
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

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// Registers the "exit" listener immediately (returning a promise, not a
// function to call later) - `child.once("exit", ...)` never replays an
// event that already fired, and this worker can legitimately exit within
// milliseconds of the release barrier, well before a caller further down
// an async chain would get around to attaching a listener.
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
  "host restart - genuine cli-lock contention",
  () => {
    beforeEach(() => {
      workHome = mkdtempSync(join(tmpdir(), "traycer-host-restart-lock-test-"));
      osHome.current = workHome;
      process.env.HOME = workHome;
      process.env.USERPROFILE = workHome;
      // `store/paths` captures `homedir()` once at module load - drop the
      // module cache so the dynamic imports below see this test's own
      // tmp HOME (the mocked `node:os.homedir()` above, not the real one).
      vi.resetModules();
      mocks.controllerCalls = [];
      mocks.busyOverride = null;
      mocks.attestationBarrier = null;
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

    it("blocks behind a foreign lock holder and proceeds only after it releases", async () => {
      const { cliLockPath, ensureCliInstallHomeDir } =
        await import("../../store/paths");
      await ensureCliInstallHomeDir("production");
      const lockPath = cliLockPath("production");

      const holdBarrierDir = mkdtempSync(
        join(tmpdir(), "traycer-restart-lock-barrier-"),
      );
      const { exited } = spawnLockWorker(WORKER_SCRIPT, {
        WORKER_LOCK_PATH: lockPath,
        WORKER_MARKER_DIR: holdBarrierDir,
        WORKER_LABEL: "foreign-holder",
        WORKER_HOLD_BARRIER_DIR: holdBarrierDir,
      });

      try {
        await waitForFile(join(holdBarrierDir, "held"));

        const { buildHostRestartCommand } = await import("../host-restart");
        const command = buildHostRestartCommand({ ifIdle: false });
        const pending = command(fakeCtx());

        // Give the command every chance to (wrongly) proceed while the
        // worker still genuinely holds the lock on disk.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(mocks.controllerCalls).toEqual([]);

        writeFileSync(join(holdBarrierDir, "release"), "");
        const result = await pending;
        expect(mocks.controllerCalls).toEqual(["stop", "start"]);
        expect(result.data).toMatchObject({ restarted: true });
      } finally {
        // Re-written unconditionally (idempotent): if an assertion above
        // threw before the in-try release, the worker would otherwise hold
        // the lock until the test timeout.
        writeFileSync(join(holdBarrierDir, "release"), "");
        expect(await exited).toBe(0);
        rmSync(holdBarrierDir, { recursive: true, force: true });
      }
    }, 20_000);

    it("--if-idle probes AFTER lock acquisition: an agent that starts busy while restart is still waiting behind a foreign holder is still caught", async () => {
      const { cliLockPath, ensureCliInstallHomeDir } =
        await import("../../store/paths");
      await ensureCliInstallHomeDir("production");
      const lockPath = cliLockPath("production");

      const holdBarrierDir = mkdtempSync(
        join(tmpdir(), "traycer-restart-lock-barrier-idle-"),
      );
      const { exited } = spawnLockWorker(WORKER_SCRIPT, {
        WORKER_LOCK_PATH: lockPath,
        WORKER_MARKER_DIR: holdBarrierDir,
        WORKER_LABEL: "foreign-holder",
        WORKER_HOLD_BARRIER_DIR: holdBarrierDir,
      });

      try {
        await waitForFile(join(holdBarrierDir, "held"));

        const { buildHostRestartCommand } = await import("../host-restart");
        const command = buildHostRestartCommand({ ifIdle: true });
        const pending = command(fakeCtx());

        // The host was idle when this restart was requested, but an
        // agent starts (host goes busy) WHILE restart is still
        // genuinely blocked waiting for the foreign holder to
        // release - a pre-wait probe would have missed this.
        await new Promise((resolve) => setTimeout(resolve, 100));
        mocks.busyOverride = "busy";

        writeFileSync(join(holdBarrierDir, "release"), "");
        await expect(pending).rejects.toMatchObject({ code: "E_HOST_BUSY" });
        expect(mocks.controllerCalls).toEqual([]);
      } finally {
        // Re-written unconditionally (idempotent): if an assertion above
        // threw before the in-try release, the worker would otherwise hold
        // the lock until the test timeout.
        writeFileSync(join(holdBarrierDir, "release"), "");
        expect(await exited).toBe(0);
        rmSync(holdBarrierDir, { recursive: true, force: true });
      }
    }, 20_000);

    it("keeps the install-runtime attestation inside cli-lock until its read has completed", async () => {
      const { cliLockPath, ensureCliInstallHomeDir } =
        await import("../../store/paths");
      await ensureCliInstallHomeDir("production");
      const lockPath = cliLockPath("production");
      const attestationStarted = deferred();
      const releaseAttestation = deferred();
      const barrierDir = mkdtempSync(
        join(tmpdir(), "traycer-restart-attestation-lock-barrier-"),
      );
      mocks.attestationBarrier = {
        signalStarted: attestationStarted.resolve,
        release: releaseAttestation.promise,
      };

      const { buildHostRestartCommand } = await import("../host-restart");
      const pendingRestart = buildHostRestartCommand({ ifIdle: false })(
        fakeCtx(),
      );
      await attestationStarted.promise;
      const { exited } = spawnLockWorker(WORKER_SCRIPT, {
        WORKER_LOCK_PATH: lockPath,
        WORKER_MARKER_DIR: barrierDir,
        WORKER_LABEL: "attestation-contender",
        WORKER_HOLD_BARRIER_DIR: barrierDir,
      });

      try {
        // If attestation were called after `withCliLock` settled, this
        // contender would acquire now despite the paused read.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(existsSync(join(barrierDir, "held"))).toBe(false);

        releaseAttestation.resolve();
        await pendingRestart;
        await waitForFile(join(barrierDir, "held"));
        writeFileSync(join(barrierDir, "release"), "");
        expect(await exited).toBe(0);
      } finally {
        releaseAttestation.resolve();
        writeFileSync(join(barrierDir, "release"), "");
        await exited;
        mocks.attestationBarrier = null;
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
