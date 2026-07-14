import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lockPath: "", forceIndeterminate: false }));

vi.mock("../paths", () => ({
  cliLockPath: () => mocks.lockPath,
  ensureCliInstallHomeDir: async () => {},
}));

// Lets one test force `verifyProcessIdentity` to report "indeterminate"
// (simulating a probe failure) without needing a flaky real-world
// reproduction. Every other test proxies straight through to the real
// implementation, so the two-process tests below still exercise the
// genuine `ps`/liveness probing.
vi.mock("../process-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process-identity")>();
  return {
    ...actual,
    verifyProcessIdentity: (
      token: Parameters<typeof actual.verifyProcessIdentity>[0],
    ) =>
      mocks.forceIndeterminate
        ? ("indeterminate" as const)
        : actual.verifyProcessIdentity(token),
  };
});

import {
  acquireCliLock,
  isProcessAlive,
  withCliLock,
  type CliLockMetadata,
} from "../cli-lock";
import { readProcessStartTimeMs } from "../process-identity";
import { CLI_ERROR_CODES } from "../../runner/errors";

// Spawns a real, separate OS process so the "two-process" lock tests probe
// genuine cross-process liveness/identity instead of the `pid ===
// process.pid` self shortcut. Not available on win32 (no `sleep`) - those
// tests are skipped there, matching this file's existing platform-specific
// skip convention.
function spawnSleeper(seconds: number): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<number>;
} {
  const child = spawn("sleep", [String(seconds)]);
  const ready = new Promise<number>((resolve, reject) => {
    child.once("spawn", () => {
      if (child.pid === undefined) {
        reject(new Error("spawned sleep process has no pid"));
        return;
      }
      resolve(child.pid);
    });
    child.once("error", reject);
  });
  return { child, ready };
}

// Retained only as an "old enough that the removed age ceiling would have
// broken this lock under the pre-hardening rule" marker for the regression
// tests below - the cli-lock breaking decision no longer consults age at
// all once a holder record parses (see cli-lock.ts's "only positive
// evidence" comment).
const VERY_OLD_MS = 10 * 60 * 1000 + 1000;
const EMPTY_LOCK_GRACE_MS = 5000;

function writeLock(overrides: Partial<CliLockMetadata>): void {
  const meta: CliLockMetadata = {
    pid: 999999,
    reason: "old-holder",
    startedAt: new Date().toISOString(),
    hostname: null,
    token: "original-token",
    processStartedAtMs: null,
    ...overrides,
  };
  writeFileSync(mocks.lockPath, JSON.stringify(meta, null, 2));
}

function readLockRaw(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(mocks.lockPath, "utf8"));
  } catch {
    return null;
  }
}

describe("isProcessAlive", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true for a real, currently-running pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for an invalid pid without probing", () => {
    const spy = vi.spyOn(process, "kill");
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  // On win32, isProcessAlive never calls process.kill (it shells out to
  // tasklist instead), so mocking kill here would test nothing there.
  it.skipIf(process.platform === "win32")(
    "returns false when kill(pid, 0) throws ESRCH (process is gone)",
    () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      });
      expect(isProcessAlive(999999)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "returns true (conservative) when kill(pid, 0) throws EPERM",
    () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      });
      expect(isProcessAlive(1)).toBe(true);
    },
  );
});

describe("acquireCliLock", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "traycer-cli-lock-test-"));
    mocks.lockPath = join(workDir, ".lock");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("breaks a lock whose holder pid is dead and acquires immediately", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    writeLock({ pid: 999999, startedAt: new Date().toISOString() });
    const handle = await acquireCliLock({
      environment: "production",
      reason: "new-holder",
      waitMs: 1000,
      pollIntervalMs: 50,
    });
    expect(handle.metadata.reason).toBe("new-holder");
    await handle.release();
  });

  it("throws CLI_LOCK_BUSY when a live holder never frees the lock in time", async () => {
    // pid === process.pid short-circuits holderAlive() to true without
    // probing, so this holder reads as genuinely alive throughout.
    writeLock({
      pid: process.pid,
      reason: "host-update",
      startedAt: new Date().toISOString(),
    });
    await expect(
      acquireCliLock({
        environment: "production",
        reason: "contender",
        waitMs: 200,
        pollIntervalMs: 50,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.CLI_LOCK_BUSY,
      message: expect.stringContaining("holder.pid=" + process.pid),
    });
  });

  // Superseded regression: the pre-hardening rule force-broke any lock
  // past MAX_LOCK_AGE_MS regardless of liveness. The hardened rule removes
  // that ceiling entirely - only positive identity evidence (dead /
  // mismatched) breaks a lock now, so a genuinely live, identity-verified
  // holder survives no matter its age.
  it("new-format live holder survives past the old age ceiling (only positive evidence breaks a lock)", async () => {
    writeLock({
      pid: process.pid,
      reason: "host-update",
      startedAt: new Date(Date.now() - VERY_OLD_MS).toISOString(),
      processStartedAtMs: readProcessStartTimeMs(process.pid),
    });
    await expect(
      acquireCliLock({
        environment: "production",
        reason: "contender",
        waitMs: 200,
        pollIntervalMs: 50,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.CLI_LOCK_BUSY });
  });

  it("startedAt corruption/future values no longer affect the breaking decision", async () => {
    writeLock({
      pid: process.pid,
      reason: "host-update",
      startedAt: "not-a-real-timestamp",
      processStartedAtMs: readProcessStartTimeMs(process.pid),
    });
    const old = new Date(Date.now() - VERY_OLD_MS);
    utimesSync(mocks.lockPath, old, old);
    await expect(
      acquireCliLock({
        environment: "production",
        reason: "contender",
        waitMs: 200,
        pollIntervalMs: 50,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.CLI_LOCK_BUSY });
  });

  it("liveness/start-identity-indeterminate holder survives past the ceiling (probe forced to fail -> contender gets E_CLI_LOCK_BUSY, no break)", async () => {
    mocks.forceIndeterminate = true;
    try {
      writeLock({
        pid: process.pid,
        reason: "host-update",
        startedAt: new Date(Date.now() - VERY_OLD_MS).toISOString(),
        processStartedAtMs: readProcessStartTimeMs(process.pid),
      });
      await expect(
        acquireCliLock({
          environment: "production",
          reason: "contender",
          waitMs: 200,
          pollIntervalMs: 50,
        }),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.CLI_LOCK_BUSY });
    } finally {
      mocks.forceIndeterminate = false;
    }
  });

  // Two-process tests: a genuinely separate OS process (not the
  // `pid === process.pid` shortcut) proves the identity check works
  // against real cross-process liveness/start-time probing.
  describe.skipIf(process.platform === "win32")("two-process holders", () => {
    it("identity-less (legacy-format) live holder survives past the ceiling", async () => {
      const { child, ready } = spawnSleeper(5);
      try {
        const pid = await ready;
        writeLock({
          pid,
          reason: "host-update",
          startedAt: new Date(Date.now() - VERY_OLD_MS).toISOString(),
          // No recorded process-start-time at all - the shape a
          // pre-hardening CLI would have written.
          processStartedAtMs: null,
        });
        await expect(
          acquireCliLock({
            environment: "production",
            reason: "contender",
            waitMs: 200,
            pollIntervalMs: 50,
          }),
        ).rejects.toMatchObject({ code: CLI_ERROR_CODES.CLI_LOCK_BUSY });
      } finally {
        child.kill();
      }
    });

    it("positively-mismatched start identity (recycled pid) still breaks", async () => {
      const { child, ready } = spawnSleeper(5);
      try {
        const pid = await ready;
        writeLock({
          pid,
          reason: "old-holder",
          startedAt: new Date().toISOString(),
          // Deliberately wrong - far enough from the real process's
          // actual start time to exceed the identity-match tolerance,
          // simulating the OS having recycled this pid onto an unrelated
          // process since the lock was written.
          processStartedAtMs: Date.now() - 10 * 60 * 1000,
        });
        const handle = await acquireCliLock({
          environment: "production",
          reason: "contender",
          waitMs: 1000,
          pollIntervalMs: 50,
        });
        expect(handle.metadata.reason).toBe("contender");
        await handle.release();
      } finally {
        child.kill();
      }
    });
  });

  it("does not break an empty/corrupt lock file younger than the grace window", async () => {
    writeFileSync(mocks.lockPath, "");
    await expect(
      acquireCliLock({
        environment: "production",
        reason: "contender",
        waitMs: 200,
        pollIntervalMs: 50,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.CLI_LOCK_BUSY });
  });

  it("breaks an empty/corrupt lock file older than the grace window", async () => {
    writeFileSync(mocks.lockPath, "");
    const old = new Date(Date.now() - EMPTY_LOCK_GRACE_MS - 1000);
    utimesSync(mocks.lockPath, old, old);
    const handle = await acquireCliLock({
      environment: "production",
      reason: "contender",
      waitMs: 1000,
      pollIntervalMs: 50,
    });
    expect(handle.metadata.reason).toBe("contender");
    await handle.release();
  });

  it("still recognizes a pre-token lock as a live holder, not as corrupt", async () => {
    const meta = {
      pid: process.pid,
      reason: "host-update",
      startedAt: new Date().toISOString(),
      hostname: null,
      // no `token` field at all - a lock written by a pre-fix CLI.
    };
    writeFileSync(mocks.lockPath, JSON.stringify(meta));
    await expect(
      acquireCliLock({
        environment: "production",
        reason: "contender",
        waitMs: 200,
        pollIntervalMs: 50,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.CLI_LOCK_BUSY,
      message: expect.stringContaining("holder.pid=" + process.pid),
    });
  });

  it("a future startedAt (lock-acquisition time, not process identity) no longer affects the breaking decision", async () => {
    writeLock({
      pid: process.pid,
      reason: "host-update",
      startedAt: new Date(Date.now() + 60_000).toISOString(),
      processStartedAtMs: readProcessStartTimeMs(process.pid),
    });
    const old = new Date(Date.now() - VERY_OLD_MS);
    utimesSync(mocks.lockPath, old, old);
    await expect(
      acquireCliLock({
        environment: "production",
        reason: "contender",
        waitMs: 200,
        pollIntervalMs: 50,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.CLI_LOCK_BUSY });
  });
});

describe("release() compare-and-delete", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "traycer-cli-lock-release-test-"));
    mocks.lockPath = join(workDir, ".lock");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("unlinks the lock file when the token still matches", async () => {
    await withCliLock(
      {
        environment: "production",
        reason: "r",
        waitMs: 1000,
        pollIntervalMs: 50,
      },
      async () => {
        expect(readLockRaw()).not.toBeNull();
      },
    );
    expect(readLockRaw()).toBeNull();
  });

  it("does not delete another holder's lock file if the token no longer matches", async () => {
    const handle = await acquireCliLock({
      environment: "production",
      reason: "r",
      waitMs: 1000,
      pollIntervalMs: 50,
    });
    // Simulate a steal: someone else broke the (falsely-stale) lock and
    // wrote their own metadata while this handle still believes it holds it.
    const impostor: CliLockMetadata = {
      pid: 424242,
      reason: "impostor",
      startedAt: new Date().toISOString(),
      hostname: null,
      token: "impostor-token",
      processStartedAtMs: null,
    };
    writeFileSync(mocks.lockPath, JSON.stringify(impostor));
    await handle.release();
    expect(readLockRaw()).toEqual(impostor);
  });

  it("falls back to unconditional unlink for a legacy no-token file", async () => {
    const handle = await acquireCliLock({
      environment: "production",
      reason: "r",
      waitMs: 1000,
      pollIntervalMs: 50,
    });
    // Simulate the file having been rewritten by pre-token-version code.
    writeFileSync(
      mocks.lockPath,
      JSON.stringify({
        pid: process.pid,
        reason: "r",
        startedAt: new Date().toISOString(),
      }),
    );
    await handle.release();
    expect(readLockRaw()).toBeNull();
  });
});
