import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename as nodeRename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetAttemptHolderCacheForTest,
  __resetHeldInProcessForTest,
  acquireAttemptMutationLease,
  acquireUpdateAttemptLock,
  isUpdateAttemptLockHeldInProcess,
  probeAttemptHolder,
  verifyAttemptLockOwnership,
  type UpdateAttemptLockHandle,
} from "../lock";
import { updateAttemptLockPath } from "../paths";
import {
  __setLockReadPlatformForTest,
  readLockHolder,
  rewriteLockLivenessIfToken,
} from "../../host-lock/cross-process-lock";

// F-round coverage (CodeRabbit): `rewriteLockLivenessIfToken`'s temp-file
// rename is the ONLY `rename()` call anywhere in `cross-process-lock.ts`, so
// wrapping it here is a surgical seam - the default implementation always
// delegates to the real `rename`, and only the one test below overrides it
// for a single call.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const execFileAsync = promisify(execFile);

const dirs: string[] = [];
const handles: UpdateAttemptLockHandle[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "host-update-lock-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  __setLockReadPlatformForTest(null);
  __resetAttemptHolderCacheForTest();
  __resetHeldInProcessForTest();
  await Promise.all(
    handles.splice(0).map((handle) => handle.release().catch(() => undefined)),
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function waitForFile(path: string, maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const exists = await stat(path)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${path}`));
        return;
      }
      setTimeout(poll, 20);
    };
    void poll();
  });
}

function spawnLockWorker(
  hostHomeDir: string,
  barrierDir: string,
  waitMs: number,
): ChildProcessWithoutNullStreams {
  const workerScript = join(__dirname, "fixtures", "lock-worker.ts");
  const child = spawn("bun", ["run", workerScript], {
    env: {
      ...process.env,
      WORKER_HOST_HOME_DIR: hostHomeDir,
      WORKER_BARRIER_DIR: barrierDir,
      WORKER_WAIT_MS: String(waitMs),
    },
  });
  child.stderr.on("data", (chunk) =>
    process.stderr.write(`[lock-worker] ${chunk}`),
  );
  return child;
}

type LockReadWorkerMode = "acquire" | "probe" | "holder";

async function runLockReadWorker(
  hostHomeDir: string,
  mode: LockReadWorkerMode,
  maxWaitMs: number,
): Promise<{ readonly timedOut: boolean; readonly output: string }> {
  const workerScript = join(__dirname, "fixtures", "lock-read-worker.ts");
  const child = spawn("bun", ["run", workerScript], {
    env: {
      ...process.env,
      LOCK_READ_WORKER_HOME: hostHomeDir,
      LOCK_READ_WORKER_PATH: updateAttemptLockPath(hostHomeDir),
      LOCK_READ_WORKER_MODE: mode,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ timedOut, output });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(true);
    }, maxWaitMs);
    child.once("close", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

// Confirms the worker process has actually terminated by polling kernel
// liveness (`kill(pid, 0)`) rather than the child's `"exit"` event. This
// sandbox's process tree reaps deeply-nested grandchildren (a `bun`
// subprocess spawned from inside a `vitest` pool worker) before Node's own
// `waitpid` gets to it, so `"exit"` never fires even though the process is
// confirmed gone - a sandbox artifact, not a lock-protocol behavior under
// test. The barrier files already prove the worker's critical section ran
// correctly; this only confirms cleanup, so it never gates a lock assertion.
async function waitForProcessDeath(
  pid: number,
  maxWaitMs: number,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`process ${pid} did not exit within ${maxWaitMs}ms`);
}

describe("acquireUpdateAttemptLock - genuine cross-process contention", () => {
  it("a second contender in a real, separate OS process gets busy with waitMs: 0", async () => {
    const dir = await freshDir();
    const barrierDir = join(dir, "barrier");
    await mkdir(barrierDir);

    const worker = spawnLockWorker(dir, barrierDir, 15_000);
    await waitForFile(join(barrierDir, "held"), 30_000);
    const held = JSON.parse(
      await readFile(join(barrierDir, "held"), "utf8"),
    ) as {
      pid: number;
      token: string;
    };

    // This test process is the SECOND contender - a genuine other process
    // (the worker) is holding the lock right now.
    const outcome = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "second-contender",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(outcome.kind).toBe("busy");
    if (outcome.kind === "busy") {
      expect(outcome.holder?.pid).toBe(held.pid);
      expect(outcome.holder?.token).toBe(held.token);
    }

    await writeFile(join(barrierDir, "release"), "");
    await waitForFile(join(barrierDir, "released"), 30_000);
    if (worker.pid !== undefined) await waitForProcessDeath(worker.pid, 30_000);
  }, 60_000);

  it("probeAttemptHolder reports holder-live for a lock held by a real, separate OS process", async () => {
    const dir = await freshDir();
    const barrierDir = join(dir, "barrier");
    await mkdir(barrierDir);

    const worker = spawnLockWorker(dir, barrierDir, 15_000);
    await waitForFile(join(barrierDir, "held"), 30_000);

    const evidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: Date.now(),
      cacheTtlMs: 0,
    });
    expect(evidence.kind).toBe("holder-live");

    await writeFile(join(barrierDir, "release"), "");
    await waitForFile(join(barrierDir, "released"), 30_000);
    if (worker.pid !== undefined) await waitForProcessDeath(worker.pid, 30_000);
  }, 60_000);
});

describe("lock-path special entries and missing-flag fallback", () => {
  it.skipIf(process.platform === "win32")(
    "bounds no-writer FIFO reads for acquire, holder reads, and holder probes without treating it as break evidence",
    async () => {
      const dir = await freshDir();
      const lockPath = updateAttemptLockPath(dir);
      try {
        await execFileAsync("mkfifo", [lockPath]);
      } catch {
        return;
      }

      const acquire = await runLockReadWorker(dir, "acquire", 2_000);
      expect(acquire.timedOut).toBe(false);
      expect(JSON.parse(acquire.output)).toMatchObject({
        kind: "busy",
        holder: null,
      });

      const holder = await runLockReadWorker(dir, "holder", 2_000);
      expect(holder.timedOut).toBe(false);
      expect(JSON.parse(holder.output)).toEqual({ kind: "read-error" });

      const probe = await runLockReadWorker(dir, "probe", 2_000);
      expect(probe.timedOut).toBe(false);
      expect(JSON.parse(probe.output)).toEqual({
        kind: "indeterminate",
        cause: "lock-read-error",
      });
      await expect(stat(lockPath)).resolves.toBeDefined();
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "exercises the missing-flag lock fallback with absent, fake regular, and special entries",
    async () => {
      __setLockReadPlatformForTest({ noFollow: 0, nonBlock: 0 });
      const dir = await freshDir();
      const lockPath = updateAttemptLockPath(dir);

      await expect(readLockHolder(lockPath)).resolves.toEqual({
        kind: "absent",
      });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          reason: "fake-holder",
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: null,
          token: "fake-token",
          processStartedAtMs: null,
          processStartIdentity: null,
        }),
      );
      const fake = await readLockHolder(lockPath);
      expect(fake.kind).toBe("held");
      if (fake.kind === "held") expect(fake.holder.token).toBe("fake-token");

      await rm(lockPath, { force: true });
      await mkdir(lockPath);
      await expect(readLockHolder(lockPath)).resolves.toEqual({
        kind: "read-error",
      });
    },
  );

  it.skipIf(process.platform !== "win32")(
    "forces the missing-flag lock fallback on Windows and keeps fake/special entries non-authoritative",
    async () => {
      __setLockReadPlatformForTest({ noFollow: 0, nonBlock: 0 });
      const dir = await freshDir();
      const lockPath = updateAttemptLockPath(dir);

      await expect(readLockHolder(lockPath)).resolves.toEqual({
        kind: "absent",
      });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          reason: "fake-holder",
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: null,
          token: "fake-token",
          processStartedAtMs: null,
          processStartIdentity: null,
        }),
      );
      await expect(readLockHolder(lockPath)).resolves.toMatchObject({
        kind: "held",
        holder: { token: "fake-token" },
      });

      await rm(lockPath, { force: true });
      await mkdir(lockPath);
      await expect(readLockHolder(lockPath)).resolves.toEqual({
        kind: "read-error",
      });
    },
  );
});

describe("cross-process-lock direct coverage - parseLockMetadata / rewriteLockLivenessIfToken", () => {
  afterEach(async () => {
    // `mockClear()` only drops call history - it RETAINS a queued
    // `mockRejectedValueOnce` implementation, and `rewriteLockLivenessIfToken`
    // can return before ever calling `rename()` (arbitration busy, lock
    // absent, token mismatch), so the queued rejection would leak into
    // whichever `rename()` call happens next, in a later, unrelated test.
    // `mockReset()` drops the queued implementation too, but it also wipes
    // this vi.fn's default (real-delegating) implementation, so it must be
    // restored explicitly for later tests in this file to still get genuine
    // renames.
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(nodeRename).mockReset();
    vi.mocked(nodeRename).mockImplementation(actual.rename);
  });

  it("drops a recorded supervisedProcessGroupId of 1 rather than treating group 1 (init's) as a live supervised actuator", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);
    // Hand-authored, mirroring exactly what a pre-hardening writer (or a
    // corrupt/adversarial value) could put on disk - `parseLockMetadata` is
    // private, so `readLockHolder` is the public surface this drop is
    // observable through.
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        reason: "group-id-one-fixture",
        startedAt: "2026-01-01T00:00:00.000Z",
        hostname: null,
        token: "group-one-token",
        processStartedAtMs: null,
        processStartIdentity: null,
        supervisedProcessGroupId: 1,
      }),
    );

    const holder = await readLockHolder(lockPath);
    expect(holder.kind).toBe("held");
    if (holder.kind !== "held") return;
    // `process.kill(-1, 0)` asks "can I signal ANY process", which is true
    // on every running machine - a recorded group of 1 would otherwise
    // classify any machine's holder as live forever. No supervised actuator
    // can legitimately lead process group 1 (init's), so the parser drops
    // the field entirely rather than passing it through to the liveness
    // probe.
    expect(holder.holder.supervisedProcessGroupId).toBeUndefined();
  });

  it("a rewriteLockLivenessIfToken whose rename fails returns false rather than throwing", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "rewrite-liveness-rename-failure",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    handles.push(acquired.handle);
    const token = acquired.handle.metadata.token;
    expect(token).not.toBeNull();
    if (token === null) return;

    // `rename()` is the ONLY `rename` call anywhere in
    // `cross-process-lock.ts` (see the module-scope `vi.mock` above), so
    // this fails exactly the rename this function performs after its
    // temp-file open/writeFile/sync succeed - not the break-lock
    // acquisition or the canonical-lock read that precede it.
    vi.mocked(nodeRename).mockRejectedValueOnce(
      Object.assign(new Error("simulated rename failure"), {
        code: "EACCES",
      }),
    );

    const rewritten = await rewriteLockLivenessIfToken(lockPath, token, {
      ...acquired.handle.metadata,
      supervisedProcessGroupId: process.pid,
    });
    expect(rewritten).toBe(false);

    // The canonical lock is untouched by the failed rewrite - still the
    // original token, still no supplemental liveness published.
    const holder = await readLockHolder(lockPath);
    expect(holder.kind).toBe("held");
    if (holder.kind === "held") {
      expect(holder.holder.token).toBe(token);
      expect(holder.holder.supervisedProcessGroupId).toBeUndefined();
    }
  });
});

describe("acquireUpdateAttemptLock - in-process re-entrancy", () => {
  it("a re-entrant acquire in the SAME process returns held-in-process, not busy", async () => {
    const dir = await freshDir();

    const first = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "first",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(first.kind).toBe("acquired");
    if (first.kind === "acquired") handles.push(first.handle);
    expect(isUpdateAttemptLockHeldInProcess(dir)).toBe(true);

    const second = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "second",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(second.kind).toBe("held-in-process");
    if (second.kind === "held-in-process" && first.kind === "acquired") {
      expect(second.holder).toEqual(first.handle.metadata);
    }
  });

  it("release clears the in-process claim so a later acquire in this process succeeds", async () => {
    const dir = await freshDir();

    const first = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "first",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;
    await first.handle.release();
    expect(isUpdateAttemptLockHeldInProcess(dir)).toBe(false);

    const second = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "second",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(second.kind).toBe("acquired");
    if (second.kind === "acquired") handles.push(second.handle);
  });
});

describe("probeAttemptHolder", () => {
  it("reports no-holder when no lock file exists", async () => {
    const dir = await freshDir();

    const evidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: Date.now(),
      cacheTtlMs: 0,
    });
    expect(evidence).toEqual({ kind: "no-holder" });
  });

  it("reports holder-live for a lock this same process genuinely holds", async () => {
    const dir = await freshDir();

    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "self",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    handles.push(acquired.handle);

    const evidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: Date.now(),
      cacheTtlMs: 0,
    });
    expect(evidence.kind).toBe("holder-live");
  });

  it("reports indeterminate for an empty lock file", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);
    await writeFile(lockPath, "");

    const evidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: Date.now(),
      cacheTtlMs: 0,
    });
    expect(evidence).toEqual({
      kind: "indeterminate",
      cause: "lock-unparseable",
    });
  });

  it("reports indeterminate for a corrupt lock file", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);
    await writeFile(lockPath, "{ not json");

    const evidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: Date.now(),
      cacheTtlMs: 0,
    });
    expect(evidence).toEqual({
      kind: "indeterminate",
      cause: "lock-unparseable",
    });
  });

  it("does not serve a stale cached verdict once the lock is released and re-taken by a different holder", async () => {
    const dir = await freshDir();

    const first = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "first-holder",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;

    const firstEvidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: 1_000,
      // A generous TTL - if the cache were keyed on path alone, the second
      // probe below (well inside this window) would wrongly reuse this
      // verdict's token.
      cacheTtlMs: 60_000,
    });
    expect(firstEvidence.kind).toBe("holder-live");
    if (firstEvidence.kind === "holder-live") {
      expect(firstEvidence.holder.token).toBe(first.handle.metadata.token);
    }

    await first.handle.release();

    const second = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "second-holder",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(second.kind).toBe("acquired");
    if (second.kind !== "acquired") return;
    handles.push(second.handle);
    expect(second.handle.metadata.token).not.toBe(first.handle.metadata.token);

    const secondEvidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: 1_001, // still well inside the 60s TTL window
      cacheTtlMs: 60_000,
    });
    expect(secondEvidence.kind).toBe("holder-live");
    if (secondEvidence.kind === "holder-live") {
      // The fingerprint must have expired on the token change, not been
      // served from the first holder's cached verdict.
      expect(secondEvidence.holder.token).toBe(second.handle.metadata.token);
    }
  });

  it("does not serve a stale cached holder-live verdict across a backward wall-clock step, even with a generous TTL", async () => {
    const dir = await freshDir();
    const barrierDir = join(dir, "barrier");
    await mkdir(barrierDir);

    // A genuine, separate OS process holds the lock, so the fingerprint
    // (pid | token | start identity) is real and stable - the lock file is
    // never rewritten below, so it never changes.
    const worker = spawnLockWorker(dir, barrierDir, 15_000);
    await waitForFile(join(barrierDir, "held"), 30_000);

    const liveEvidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: 10_000,
      cacheTtlMs: 60_000,
    });
    expect(liveEvidence.kind).toBe("holder-live");

    // Kill the worker directly (not the release handshake), so the lock
    // file - and therefore the fingerprint - is UNCHANGED: this isolates the
    // elapsed-time floor from the fingerprint-mismatch path already covered
    // above. The holder is now genuinely dead while the cached verdict still
    // says "holder-live".
    if (worker.pid !== undefined) {
      process.kill(worker.pid, "SIGKILL");
      await waitForProcessDeath(worker.pid, 30_000);
    }

    // A backward clock step: nowMs is EARLIER than the cached atMs (10_000),
    // even though the fingerprint still matches and cacheTtlMs is generous.
    // Pre-fix, `elapsedMs = -1` satisfied the strict `-1 < 60_000` and served
    // the stale "holder-live" verdict for a process that is now provably
    // dead. Fixed, a negative elapsed is a cache miss and the re-probe below
    // observes the real, dead state.
    const staleWindowEvidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: 9_999,
      cacheTtlMs: 60_000,
    });
    expect(staleWindowEvidence.kind).toBe("no-holder");
  }, 60_000);

  it("does not serve a stale cached holder-live verdict across a backward wall-clock step, with cacheTtlMs: 0", async () => {
    const dir = await freshDir();
    const barrierDir = join(dir, "barrier");
    await mkdir(barrierDir);

    const worker = spawnLockWorker(dir, barrierDir, 15_000);
    await waitForFile(join(barrierDir, "held"), 30_000);

    const liveEvidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: 10_000,
      cacheTtlMs: 0,
    });
    expect(liveEvidence.kind).toBe("holder-live");

    if (worker.pid !== undefined) {
      process.kill(worker.pid, "SIGKILL");
      await waitForProcessDeath(worker.pid, 30_000);
    }

    // `cacheTtlMs: 0` is the value `verifyAdoptedCapability` passes so every
    // mutation re-probes its parent - the exact case the fix's comment
    // calls out. Pre-fix, a backward step made `elapsedMs` negative, and a
    // negative number satisfies `elapsedMs < 0` even though `0` is meant to
    // disable caching outright; the stale "holder-live" verdict would have
    // been served for a dead holder under a `cacheTtlMs` that promises no
    // caching at all.
    const staleWindowEvidence = await probeAttemptHolder({
      hostHomeDir: dir,
      nowMs: 9_999,
      cacheTtlMs: 0,
    });
    expect(staleWindowEvidence.kind).toBe("no-holder");
  }, 60_000);
});

describe("verifyAttemptLockOwnership", () => {
  it("reports not-issued for a forged handle object that mimics an issued one", async () => {
    const dir = await freshDir();
    const real = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "real",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(real.kind).toBe("acquired");
    if (real.kind !== "acquired") return;
    handles.push(real.handle);

    const forged: UpdateAttemptLockHandle = {
      hostHomeDir: real.handle.hostHomeDir,
      path: real.handle.path,
      metadata: real.handle.metadata,
      release: () => Promise.resolve(),
    };

    expect(await verifyAttemptLockOwnership(forged)).toEqual({
      kind: "not-issued",
    });
  });

  it("reports owned for a genuine, unreleased handle that still owns the lock", async () => {
    const dir = await freshDir();
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "owner",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    handles.push(acquired.handle);

    expect(await verifyAttemptLockOwnership(acquired.handle)).toEqual({
      kind: "owned",
    });
  });

  it("reports released once the handle's release() has run", async () => {
    const dir = await freshDir();
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "owner",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    await acquired.handle.release();

    expect(await verifyAttemptLockOwnership(acquired.handle)).toEqual({
      kind: "released",
    });
  });

  it("reports lost when the lock has been broken and re-acquired by another holder while the old handle is unreleased", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);

    const first = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "first",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;

    // Simulate another contender breaking and re-taking the lock without
    // this handle ever being released.
    await rm(lockPath, { force: true });
    __resetHeldInProcessForTest();
    const second = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "second",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(second.kind).toBe("acquired");
    if (second.kind !== "acquired") return;
    handles.push(second.handle);

    const ownership = await verifyAttemptLockOwnership(first.handle);
    expect(ownership.kind).toBe("lost");
    if (ownership.kind === "lost") {
      expect(ownership.observed?.token).toBe(second.handle.metadata.token);
    }
  });

  it("reports lost when the lock file has been removed outright while the old handle is unreleased", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);

    const first = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "first",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;

    await rm(lockPath, { force: true });

    expect(await verifyAttemptLockOwnership(first.handle)).toEqual({
      kind: "lost",
      observed: null,
    });
  });

  it("reports indeterminate when the lock file is present but unparseable", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);

    const first = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "first",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;
    handles.push(first.handle);

    await writeFile(lockPath, "{ not json");

    expect(await verifyAttemptLockOwnership(first.handle)).toEqual({
      kind: "indeterminate",
      cause: "lock-unparseable",
    });
  });
});

describe("acquireAttemptMutationLease", () => {
  it("returns not-issued for a forged handle", async () => {
    const dir = await freshDir();
    const real = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "real",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(real.kind).toBe("acquired");
    if (real.kind !== "acquired") return;
    handles.push(real.handle);

    const forged: UpdateAttemptLockHandle = {
      hostHomeDir: real.handle.hostHomeDir,
      path: real.handle.path,
      metadata: real.handle.metadata,
      release: () => Promise.resolve(),
    };
    expect(acquireAttemptMutationLease(forged)).toEqual({
      kind: "not-issued",
    });
  });

  it("returns released once the handle has been released", async () => {
    const dir = await freshDir();
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "owner",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    await acquired.handle.release();

    expect(acquireAttemptMutationLease(acquired.handle)).toEqual({
      kind: "released",
    });
  });

  it("leases carry the derived hostHomeDir and recordPath, never a caller-supplied one", async () => {
    const dir = await freshDir();
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "owner",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    handles.push(acquired.handle);

    const outcome = acquireAttemptMutationLease(acquired.handle);
    expect(outcome.kind).toBe("leased");
    if (outcome.kind !== "leased") return;
    expect(outcome.lease.hostHomeDir).toBe(acquired.handle.hostHomeDir);
    outcome.lease.release();
  });

  // The release-overlap protection this lease exists to provide: `release()`
  // must not let the lock disappear while a lease is still outstanding, so a
  // fresh contender can never acquire while an old mutation is still able to
  // reach its rename/unlink.
  it("release() waits for an outstanding mutation lease before the lock disappears", async () => {
    const dir = await freshDir();
    const lockPath = updateAttemptLockPath(dir);
    const acquired = await acquireUpdateAttemptLock({
      hostHomeDir: dir,
      reason: "owner",
      waitMs: 0,
      pollIntervalMs: 25,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;

    const leaseOutcome = acquireAttemptMutationLease(acquired.handle);
    expect(leaseOutcome.kind).toBe("leased");
    if (leaseOutcome.kind !== "leased") return;

    let released = false;
    const releasePromise = acquired.handle.release().then(() => {
      released = true;
    });

    // Give the release() microtask/macrotask queue a chance to run. It must
    // NOT have completed - the lease is still outstanding.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(released).toBe(false);
    await expect(stat(lockPath)).resolves.toBeDefined();

    // A NEW lease request must also be refused while release is pending -
    // release() closes admission synchronously, before it awaits anything.
    expect(acquireAttemptMutationLease(acquired.handle)).toEqual({
      kind: "released",
    });

    leaseOutcome.lease.release();
    await releasePromise;
    expect(released).toBe(true);
    await expect(stat(lockPath)).rejects.toThrow();
  });
});
