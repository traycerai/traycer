import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock, type LockMetadata } from "../cross-process-lock";
import { readProcessStartIdentity } from "../process-identity";

// These tests prove a contended acquisition, and a fresh
// process's own first acquisition, currently judge the holder / own identity
// through a SYNCHRONOUS `ps` spawn (`execFileSync`) rather than the async
// path the fix introduces (`verifyLockHolderLivenessAsync`,
// `ownProcessStartTimeMsAsync`). Spying (not stubbing) `execFileSync` keeps
// real behavior while letting each test count spawns precisely. `execFile`
// is spied too, for the shared-cache spec test below to prove the async read
// genuinely spawned `ps` through the async API rather than answering from
// nothing.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

const dirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cross-process-lock-async-holder-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("acquireLock - contended acquisition against a live holder", () => {
  let child: ChildProcess;
  let childIdentity: ProcessStartIdentity | null;

  beforeEach(async () => {
    child = spawn("sleep", ["30"]);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    if (child.pid === undefined) {
      throw new Error("real sleep child was spawned without a pid");
    }
    // Real, unmocked-behavior read (the mock above wraps, not replaces, the
    // real implementation) of the child's kernel creation stamp - taken
    // BEFORE the measured operation resets the call count, per the harness's
    // instructions.
    childIdentity = readProcessStartIdentity(child.pid);
  });

  afterEach(() => {
    child.kill("SIGKILL");
  });

  // A contended `acquireLock` against a genuinely
  // alive, positively-identified holder must not spawn `ps` synchronously on
  // any poll iteration. The poll loop's holder-liveness judgment (async
  // `verifyLockHolderLivenessAsync`) must never fall back to the
  // synchronous `verifyProcessIdentity` path, which would spawn `ps` on
  // every iteration even though `process.kill` liveness alone already says
  // the holder is alive.
  it("a contended acquisition never judges its holder synchronously", async () => {
    if (child.pid === undefined) {
      throw new Error("real sleep child was spawned without a pid");
    }
    const dir = await freshDir();
    const lockPath = join(dir, "host.lock");
    const holder: LockMetadata = {
      pid: child.pid,
      reason: "holder",
      startedAt: new Date().toISOString(),
      hostname: null,
      token: "holder-token",
      processStartedAtMs: null,
      processStartIdentity: childIdentity,
    };
    await writeFile(lockPath, JSON.stringify(holder, null, 2));

    // Reset right before the measured operation - the identity read in
    // `beforeEach` above must not count against this assertion.
    vi.mocked(execFileSync).mockClear();

    const outcome = await acquireLock({
      lockPath,
      reason: "contender",
      waitMs: 300,
      pollIntervalMs: 50,
    });

    // The holder is genuinely alive for the whole wait, so acquisition
    // never succeeds.
    expect(outcome.kind).toBe("busy");
    // Pins: 0 calls during acquire - the poll loop's async
    // `verifyLockHolderLivenessAsync` must never fall back to a
    // synchronous spawn.
    expect(execFileSync).toHaveBeenCalledTimes(0);
  });
});

describe("acquireLock - first uncontended acquisition's own metadata", () => {
  // The very first acquisition in a process (a freshly
  // reset own-identity cache) must not spawn `ps` synchronously either.
  // `newAcquisitionMetadata` must build its own metadata over the async
  // `ownProcessStartTimeMsAsync()` / `ownProcessStartIdentityAsync()`, never
  // the synchronous `ownProcessStartTimeMs()` / `ownProcessStartIdentity()`
  // pair, which would spawn `ps` synchronously against a freshly reset
  // cache.
  it("the first acquisition's own metadata never spawns synchronously", async () => {
    // Fresh module registry so the own-identity cache starts empty, and both
    // modules resolve from the SAME fresh registry so `cross-process-lock`'s
    // internal import of `process-identity` is the exact instance we reset
    // below.
    vi.resetModules();
    const freshProcessIdentity = await import("../process-identity");
    const freshCrossProcessLock = await import("../cross-process-lock");
    freshProcessIdentity.__resetOwnStartIdentityForTest();

    const dir = await freshDir();
    const lockPath = join(dir, "host.lock");

    vi.mocked(execFileSync).mockClear();

    const outcome = await freshCrossProcessLock.acquireLock({
      lockPath,
      reason: "first",
      waitMs: 0,
      pollIntervalMs: 50,
    });

    expect(outcome.kind).toBe("acquired");
    if (outcome.kind === "acquired") {
      await outcome.handle.release();
    }

    // Pins: 0 calls for the first, uncontended acquisition -
    // `newAcquisitionMetadata` is built over `ownProcessStartTimeMsAsync` /
    // `ownProcessStartIdentityAsync`.
    expect(execFileSync).toHaveBeenCalledTimes(0);
  });
});

describe("ownProcessStartTimeMsAsync - shares the sync twin's cache (spec)", () => {
  // Row 3 (spec): `ownProcessStartTimeMsAsync()` and the sync
  // `ownProcessStartTimeMs()` must agree, the async read must genuinely have
  // spawned `ps` through `execFile` (never `execFileSync`), and the sync
  // read that follows must be served entirely from the shared cache - zero
  // additional `execFileSync` spawns.
  it("ownProcessStartTimeMsAsync and ownProcessStartTimeMs agree and share one cache", async () => {
    vi.resetModules();
    const freshProcessIdentity = await import("../process-identity");

    vi.mocked(execFileSync).mockClear();
    vi.mocked(execFile).mockClear();

    const asyncValue = await freshProcessIdentity.ownProcessStartTimeMsAsync();
    const syncValue = freshProcessIdentity.ownProcessStartTimeMs();

    expect(syncValue).toBe(asyncValue);
    // This machine is macOS/darwin: a genuine start-time read always
    // produces a value.
    expect(asyncValue).not.toBeNull();
    // The async read spawns `ps` through `execFile`, never `execFileSync` -
    // proves the value came from a real async read, not from nothing.
    expect(
      vi
        .mocked(execFile)
        .mock.calls.some(
          (call) => Array.isArray(call[1]) && call[1].includes("etime="),
        ),
    ).toBe(true);
    // The sync read must be served entirely from the cache the async read
    // just filled - no synchronous spawn at all.
    expect(execFileSync).toHaveBeenCalledTimes(0);
  });
});
