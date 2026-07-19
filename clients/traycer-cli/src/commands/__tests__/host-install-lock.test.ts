import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";

// Genuine two-process regression coverage for `host install`'s `cli-lock`
// wiring (Host Update Layer Redesign Tech Plan, "Lock-scope restructure",
// Verification: "Pin gate: `host install <v> --if-idle` busy ->
// `E_HOST_BUSY` before any service stop, temp scrubbed, install intact;
// plain install stays unconditional; probe runs after lock acquisition
// (agent starting during the lock wait is caught - two-process test)").
// An in-process `Promise.allSettled`-style test can't reproduce a real
// cross-process TOCTOU window - only actual OS-level file contention (via
// `store/__tests__/fixtures/cli-lock-worker.ts`, the same worker
// `cli-lock.test.ts`/`host-restart-lock.test.ts` use) can be trusted to
// exercise:
//
//   1. `stageHostInstallSource` runs to completion WITHOUT waiting on the
//      lock at all (the extract happens outside `cli-lock`), while
//      `commitHostInstallSource` genuinely BLOCKS behind a foreign holder
//      (e.g. an in-progress `host apply`) and only proceeds once it
//      releases;
//   2. `--if-idle`'s busy probe runs strictly AFTER lock acquisition, so
//      an agent that starts busy WHILE install is still waiting behind a
//      foreign holder is still caught, discarding the staged temp and
//      never reaching commit.
//
// The installer's own extract/download machinery is mocked out (as in
// host-install.test.ts) so this suite stays focused on lock-gating, not
// re-testing installer/__tests__/install.test.ts's commit-phase coverage.

const mocks = vi.hoisted(() => ({
  stageCalls: [] as string[],
  commitCalls: [] as string[],
  discardCalls: [] as string[],
  busyOverride: null as "busy" | null,
}));

vi.mock("../../installer", () => ({
  stageHostInstallSource: async () => {
    mocks.stageCalls.push("stage");
    return {
      stagingDir: "/tmp/staging-dir",
      archivePath: "/tmp/staging-dir/archive.tar.gz",
      archiveIsTemporary: true,
      executablePath: "/tmp/staging-dir/traycer-host",
      version: "2.0.0",
      runtimeVersion: null,
      source: { kind: "registry", value: "2.0.0" },
      archiveSha256: "b".repeat(64),
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      signatureKeyId: "test-key",
      sizeBytes: 1,
    };
  },
  commitHostInstallSource: async () => {
    mocks.commitCalls.push("commit");
    return {
      record: {
        installId: "install-2.0.0",
        version: "2.0.0",
        runtimeVersion: null,
        platform: "darwin",
        arch: "arm64",
        installedAt: "2026-01-01T00:00:00.000Z",
        source: { kind: "registry", value: "2.0.0" },
        archiveSha256: "b".repeat(64),
        signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
        signatureKeyId: "test-key",
        sizeBytes: 1,
        executablePath: "/tmp/traycer-host",
      },
      previous: null,
      installGeneration: "id:install-2.0.0",
    };
  },
  discardStagedHostInstallSource: async () => {
    mocks.discardCalls.push("discard");
  },
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: () => ({
    state: {
      priorState: "not-installed" as const,
      stoppedBeforeSwap: false,
      postSwapAction: "none" as const,
      postSwapError: null,
    },
    lifecycle: {
      beforeSwap: async () => {},
      afterSwap: async () => {},
    },
  }),
}));

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async () => {
    if (mocks.busyOverride === "busy") {
      throw Object.assign(new Error("host is busy"), { code: "E_HOST_BUSY" });
    }
  },
}));

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
  "host install - genuine cli-lock contention",
  () => {
    beforeEach(() => {
      workHome = mkdtempSync(join(tmpdir(), "traycer-host-install-lock-test-"));
      osHome.current = workHome;
      process.env.HOME = workHome;
      process.env.USERPROFILE = workHome;
      // `store/paths` captures `homedir()` once at module load - drop the
      // module cache so the dynamic imports below see this test's own
      // tmp HOME (the mocked `node:os.homedir()` above, not the real one).
      vi.resetModules();
      mocks.stageCalls = [];
      mocks.commitCalls = [];
      mocks.discardCalls = [];
      mocks.busyOverride = null;
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

    it("stages without waiting on the lock, then blocks behind a foreign lock holder and commits only after it releases", async () => {
      const { cliLockPath, ensureCliInstallHomeDir } =
        await import("../../store/paths");
      await ensureCliInstallHomeDir("production");
      const lockPath = cliLockPath("production");

      const holdBarrierDir = mkdtempSync(
        join(tmpdir(), "traycer-install-lock-barrier-"),
      );
      const { exited } = spawnLockWorker(WORKER_SCRIPT, {
        WORKER_LOCK_PATH: lockPath,
        WORKER_MARKER_DIR: holdBarrierDir,
        WORKER_LABEL: "foreign-holder",
        WORKER_HOLD_BARRIER_DIR: holdBarrierDir,
      });

      try {
        await waitForFile(join(holdBarrierDir, "held"));

        const { buildHostInstallCommand } = await import("../host-install");
        const command = buildHostInstallCommand({
          versionRequest: "2.0.0",
          fromPath: null,
          enableLinger: true,
          allowSelfInvocation: false,
          noServiceRegister: false,
          ifIdle: false,
        });
        const pending = command(fakeCtx());

        // Staging happens outside the lock - it must complete even while
        // the foreign holder still owns the lock on disk.
        await waitForCallCount(() => mocks.stageCalls.length, 1);

        // Give the command every chance to (wrongly) proceed to commit
        // while the worker still genuinely holds the lock on disk.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(mocks.commitCalls).toEqual([]);

        writeFileSync(join(holdBarrierDir, "release"), "");
        const result = await pending;
        expect(mocks.commitCalls).toEqual(["commit"]);
        expect(result.data).toMatchObject({
          version: "2.0.0",
          installGeneration: "id:install-2.0.0",
        });
      } finally {
        expect(await exited).toBe(0);
        rmSync(holdBarrierDir, { recursive: true, force: true });
      }
    }, 20_000);

    it("--if-idle probes AFTER lock acquisition: an agent that starts busy while install is still waiting behind a foreign holder is still caught, and the staged temp is discarded", async () => {
      const { cliLockPath, ensureCliInstallHomeDir } =
        await import("../../store/paths");
      await ensureCliInstallHomeDir("production");
      const lockPath = cliLockPath("production");

      const holdBarrierDir = mkdtempSync(
        join(tmpdir(), "traycer-install-lock-barrier-idle-"),
      );
      const { exited } = spawnLockWorker(WORKER_SCRIPT, {
        WORKER_LOCK_PATH: lockPath,
        WORKER_MARKER_DIR: holdBarrierDir,
        WORKER_LABEL: "foreign-holder",
        WORKER_HOLD_BARRIER_DIR: holdBarrierDir,
      });

      try {
        await waitForFile(join(holdBarrierDir, "held"));

        const { buildHostInstallCommand } = await import("../host-install");
        const command = buildHostInstallCommand({
          versionRequest: "2.0.0",
          fromPath: null,
          enableLinger: true,
          allowSelfInvocation: false,
          noServiceRegister: false,
          ifIdle: true,
        });
        const pending = command(fakeCtx());

        await waitForCallCount(() => mocks.stageCalls.length, 1);

        // The host was idle when this install was requested, but an agent
        // starts (host goes busy) WHILE install is still genuinely blocked
        // waiting for the foreign holder to release - a pre-wait probe
        // would have missed this.
        await new Promise((resolve) => setTimeout(resolve, 100));
        mocks.busyOverride = "busy";

        writeFileSync(join(holdBarrierDir, "release"), "");
        await expect(pending).rejects.toMatchObject({ code: "E_HOST_BUSY" });
        expect(mocks.commitCalls).toEqual([]);
        expect(mocks.discardCalls).toEqual(["discard"]);
      } finally {
        expect(await exited).toBe(0);
        rmSync(holdBarrierDir, { recursive: true, force: true });
      }
    }, 20_000);
  },
);

function waitForCallCount(read: () => number, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (read() >= expected) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for call count ${expected}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

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
