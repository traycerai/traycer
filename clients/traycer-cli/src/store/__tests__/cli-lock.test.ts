import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Lets one test force the raw `readFile` release() performs to fail with a
// transient, non-ENOENT error (EIO-shaped) for the exact lock path, while
// every other read proxies straight through to the real implementation -
// see the "aborts release ... transient error" test below.
const mocks = vi.hoisted(() => ({
  lockPath: "",
  forceReadFileErrorForPath: null as string | null,
}));

vi.mock("../paths", () => ({
  cliLockPath: () => mocks.lockPath,
  ensureCliInstallHomeDir: async () => {},
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: PathLike, encoding: "utf8") => {
      if (path === mocks.forceReadFileErrorForPath) {
        throw Object.assign(new Error("simulated read failure"), {
          code: "EIO",
        });
      }
      return actual.readFile(path, encoding);
    },
  };
});

import {
  acquireCliLock,
  isProcessAlive,
  withCliLock,
  type CliLockMetadata,
} from "../cli-lock";
import {
  __setProcessStartTimeReaderForTest,
  readProcessStartTimeMs,
} from "../process-identity";
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
  // holder survives no matter its age. Spawns a real, separate OS process
  // (not the `pid === process.pid` self shortcut) so this exercises the
  // genuine cross-process liveness/start-time probing, not the own-pid
  // identity path.
  it.skipIf(process.platform === "win32")(
    "new-format live holder (genuine two-process) survives past the old age ceiling",
    async () => {
      const { child, ready } = spawnSleeper(5);
      try {
        const pid = await ready;
        writeLock({
          pid,
          reason: "host-update",
          startedAt: new Date(Date.now() - VERY_OLD_MS).toISOString(),
          processStartedAtMs: readProcessStartTimeMs(pid),
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
    },
  );

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

  // Forces the failure at the underlying `readProcessStartTimeMs` probe
  // boundary via the real test-only injection seam
  // (`__setProcessStartTimeReaderForTest`), not by mocking the
  // `../process-identity` module wholesale: a `vi.mock` replacing the
  // module's EXPORTED `readProcessStartTimeMs` does not rebind
  // `verifyProcessIdentity`'s own same-module call to it (ES module
  // same-file references aren't routed through the mocked export object),
  // so that approach silently passed via ordinary alive-same instead of
  // genuinely exercising the probe-failure path - see the Fixup round-2
  // ticket's item F. Against a genuinely live, separate spawned process:
  // liveness itself succeeds (the child really is running), only the
  // start-time read fails, so the real verdict logic must independently
  // derive "indeterminate" from that combination rather than have the
  // verdict handed to it.
  it.skipIf(process.platform === "win32")(
    "liveness-alive/start-time-probe-failure holder (genuine two-process) survives past the ceiling",
    async () => {
      const { child, ready } = spawnSleeper(5);
      try {
        const pid = await ready;
        const genuineStartedAtMs = readProcessStartTimeMs(pid);
        __setProcessStartTimeReaderForTest((probePid) =>
          probePid === pid ? null : readProcessStartTimeMs(probePid),
        );
        writeLock({
          pid,
          reason: "host-update",
          startedAt: new Date(Date.now() - VERY_OLD_MS).toISOString(),
          processStartedAtMs: genuineStartedAtMs,
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
        __setProcessStartTimeReaderForTest(null);
        child.kill();
      }
    },
  );

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

  // Regression for the break-race: a plain `unlink` let a second
  // contender delete a FIRST contender's freshly-acquired, genuinely
  // live lock, because the break decision was based on a stale read with
  // no re-check against what was actually still on disk at unlink time.
  // The reviewer reproduced 3 simultaneous holders out of 40 racing
  // contenders against a single dead lock. This drives the same shape:
  // many concurrent contenders, one initially-dead holder, and a
  // held-marker counter asserting no two contenders are ever inside
  // their acquired section at the same time.
  it("many concurrent contenders racing a dead lock never see more than one holder at a time", async () => {
    const DEAD_PID = 555555;
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number) => {
        if (pid === DEAD_PID) {
          throw Object.assign(new Error("no such process"), {
            code: "ESRCH",
          });
        }
        return true;
      });
    writeLock({
      pid: DEAD_PID,
      reason: "dead-holder",
      startedAt: new Date().toISOString(),
      processStartedAtMs: null,
    });

    const CONTENDER_COUNT = 40;
    let concurrentHolders = 0;
    let maxConcurrentHolders = 0;

    const tasks = Array.from({ length: CONTENDER_COUNT }, (_, i) =>
      acquireCliLock({
        environment: "production",
        reason: `contender-${i}`,
        waitMs: 10_000,
        pollIntervalMs: 25,
      }).then(async (handle) => {
        concurrentHolders += 1;
        maxConcurrentHolders = Math.max(
          maxConcurrentHolders,
          concurrentHolders,
        );
        // Hold briefly so two overlapping holders would actually
        // overlap in wall-clock time if mutual exclusion were broken.
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrentHolders -= 1;
        await handle.release();
      }),
    );
    const results = await Promise.allSettled(tasks);
    killSpy.mockRestore();

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(maxConcurrentHolders).toBe(1);
  }, 20_000);

  // TRUE multiprocess regression for the residual break-race the reviewer
  // found in the round-1 rename-to-claim protocol: a contender delayed
  // between its stale read and its break attempt could rename away a
  // DIFFERENT, genuinely fresh holder's lock. Reproducing that shape needs
  // two genuinely separate OS processes and a deterministic way to pause
  // one of them mid-decision - an in-process `Promise.allSettled` (as the
  // stress test above uses) can't reproduce a cross-process TOCTOU window,
  // only the arbitration-lock serialization itself can be trusted to close
  // it. `cli-lock-worker.ts` is spawned as a real `bun run` child process
  // so this exercises actual OS-level file contention, not a simulation.
  it.skipIf(process.platform === "win32")(
    "a contender paused between its stale read and its break attempt aborts even while a different process is still actively holding the lock it broke",
    async () => {
      const markerDir = join(workDir, "markers");
      const hookDir = join(workDir, "hook");
      const holdBarrierDir = join(workDir, "hold-barrier");
      mkdirSync(markerDir);
      mkdirSync(hookDir);
      mkdirSync(holdBarrierDir);

      // A genuinely dead pid, established the same way the rest of this
      // file's real-process tests do: spawn, wait for exit, then use that
      // now-dead pid - never a magic number that might collide with an
      // unrelated live process on the test machine.
      const shortLived = spawn("sleep", ["0.1"]);
      const deadPid = await new Promise<number>((resolve, reject) => {
        shortLived.once("spawn", () => {
          if (shortLived.pid === undefined) {
            reject(new Error("spawned short-lived process has no pid"));
            return;
          }
          resolve(shortLived.pid);
        });
        shortLived.once("error", reject);
      });
      await new Promise<void>((resolve) =>
        shortLived.once("exit", () => resolve()),
      );

      const workerLockPath = join(workDir, "worker.lock");
      writeFileSync(
        workerLockPath,
        JSON.stringify({
          pid: deadPid,
          reason: "dead-holder",
          startedAt: new Date().toISOString(),
          hostname: null,
          token: "original-token",
          processStartedAtMs: null,
        }),
      );

      const workerScript = join(__dirname, "fixtures", "cli-lock-worker.ts");
      const spawnWorker = (
        label: string,
        extraEnv: Record<string, string>,
      ): ChildProcessWithoutNullStreams =>
        spawn("bun", ["run", workerScript], {
          env: {
            ...process.env,
            WORKER_LOCK_PATH: workerLockPath,
            WORKER_MARKER_DIR: markerDir,
            WORKER_LABEL: label,
            ...extraEnv,
          },
        });
      const waitForExit = (child: ChildProcessWithoutNullStreams) =>
        new Promise<number | null>((resolve) => {
          child.once("exit", (code) => resolve(code));
        });
      const waitForFile = async (path: string): Promise<void> => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if (existsSync(path)) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`timed out waiting for ${path}`);
      };

      // Contender A: paused (via the env-gated break-hook seam) right
      // after it decides to break the stale lock, but before it attempts
      // the break.
      const childA = spawnWorker("A", {
        TRAYCER_CLI_LOCK_TEST_BREAK_HOOK_DIR: hookDir,
      });
      await waitForFile(join(hookDir, "ready"));

      // Contender B: unpaused. Reads the SAME stale lock, breaks it,
      // acquires, writes its held-marker - then blocks behind an explicit
      // release barrier instead of releasing immediately. Resuming A only
      // after B has fully exited (and released) would make A's abort
      // vacuous - it would just find the path absent, which even the old,
      // unsafe direct-unlink protocol would also no-op on. Resuming A
      // while B's fresh lock is still genuinely on disk, mid-critical-
      // section, is what actually exercises the byte-equality re-read.
      const childB = spawnWorker("B", {
        WORKER_HOLD_BARRIER_DIR: holdBarrierDir,
      });
      await waitForFile(join(holdBarrierDir, "held"));

      // B is confirmed actively holding. Only now let A resume its paused
      // break attempt against that live, changed content.
      writeFileSync(join(hookDir, "go"), "");

      // A's own process won't exit until it eventually acquires the lock
      // itself (which can't happen until B releases below) - so wait for
      // the break OUTCOME it records via the hook seam, not for A's exit.
      await waitForFile(join(hookDir, "outcome"));
      const outcome = readFileSync(join(hookDir, "outcome"), "utf8");
      expect(outcome).toBe("aborted");

      // Held-marker protocol: neither worker ever observed the other's
      // marker still present when it wrote its own - i.e. at no point did
      // both processes believe they held the lock simultaneously. Checked
      // while B is still holding, before its marker is removed.
      const markerEntries = readdirSync(markerDir);
      const violations = markerEntries.filter((name) =>
        name.startsWith("violation-"),
      );
      expect(violations).toEqual([]);

      // Release B, then confirm both processes exit cleanly - A must have
      // gone on to retry and legitimately acquire the now-free lock.
      writeFileSync(join(holdBarrierDir, "release"), "");
      const codeB = await waitForExit(childB);
      expect(codeB).toBe(0);
      const codeA = await waitForExit(childA);
      expect(codeA).toBe(0);
    },
    30_000,
  );

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
    mocks.forceReadFileErrorForPath = null;
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

  it("does not unlink a legacy no-token file - it can never prove ownership of it", async () => {
    const handle = await acquireCliLock({
      environment: "production",
      reason: "r",
      waitMs: 1000,
      pollIntervalMs: 50,
    });
    // Simulate the file having been rewritten by pre-token-version code.
    // Every lock THIS code writes always carries a `randomUUID()` token,
    // so a tokenless record at this path can never be the one this handle
    // itself wrote - unlinking it would risk deleting a different,
    // legitimate holder's lock on nothing but "there was nothing to
    // compare against."
    const legacy = {
      pid: process.pid,
      reason: "r",
      startedAt: new Date().toISOString(),
    };
    writeFileSync(mocks.lockPath, JSON.stringify(legacy));
    await handle.release();
    expect(readLockRaw()).toEqual(legacy);
  });

  it("does not unlink present content that fails to parse (empty/corrupt bytes, or a holder mid-write)", async () => {
    const handle = await acquireCliLock({
      environment: "production",
      reason: "r",
      waitMs: 1000,
      pollIntervalMs: 50,
    });
    // Same positive-evidence rule as the read-error and legacy-file cases
    // above: a successful read of content that doesn't even parse as
    // lock metadata is not evidence of ownership either - it could be a
    // fresh holder that has `open()`ed but not yet finished
    // `writeFile()`ing its own metadata.
    writeFileSync(mocks.lockPath, "not valid json");
    await handle.release();
    expect(readFileSync(mocks.lockPath, "utf8")).toBe("not valid json");
  });

  it("aborts release without unlinking when the raw read hits a transient error", async () => {
    const handle = await acquireCliLock({
      environment: "production",
      reason: "r",
      waitMs: 1000,
      pollIntervalMs: 50,
    });
    // Simulate a transient I/O error (not ENOENT) on the exact read
    // release() performs to confirm it still owns the file. A prior
    // version of this code folded any read failure into "nothing to
    // compare against, unlink anyway" - which would delete a live
    // holder's lock (e.g. a fresh holder's under the accepted
    // break-arbitration double-recovery residual) on nothing but a flaky
    // read. Only a successful read that confirms ownership may unlink.
    mocks.forceReadFileErrorForPath = mocks.lockPath;
    await handle.release();
    mocks.forceReadFileErrorForPath = null;
    expect(existsSync(mocks.lockPath)).toBe(true);
    expect(readLockRaw()).toMatchObject({ token: handle.metadata.token });
  });
});
