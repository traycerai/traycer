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
import {
  acquireCredentialsLock,
  breakStaleLock,
  isHolderProvablyDead,
  queryPidStartFingerprint,
  withCredentialsLock,
  type AcquireCredentialsLockOptions,
} from "../credentials-lock";

const isWindows = process.platform === "win32";
const ORPHAN_LOCK_GRACE_MS = 60_000;

function writeRawLock(lockPath: string, value: unknown): void {
  writeFileSync(
    lockPath,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

describe("isHolderProvablyDead", () => {
  it("is dead when the pid is gone regardless of fingerprints", () => {
    expect(
      isHolderProvablyDead({
        alive: false,
        recordedFingerprint: "a",
        currentFingerprint: "a",
      }),
    ).toBe(true);
  });

  it("is dead when alive but the fingerprint no longer matches (pid recycled)", () => {
    expect(
      isHolderProvablyDead({
        alive: true,
        recordedFingerprint: "old",
        currentFingerprint: "new",
      }),
    ).toBe(true);
  });

  it("is live when alive and the fingerprint matches", () => {
    expect(
      isHolderProvablyDead({
        alive: true,
        recordedFingerprint: "same",
        currentFingerprint: "same",
      }),
    ).toBe(false);
  });

  it("assumes live when the current fingerprint cannot be queried", () => {
    expect(
      isHolderProvablyDead({
        alive: true,
        recordedFingerprint: "old",
        currentFingerprint: null,
      }),
    ).toBe(false);
  });

  it("assumes live when the record predates fingerprints", () => {
    expect(
      isHolderProvablyDead({
        alive: true,
        recordedFingerprint: null,
        currentFingerprint: "new",
      }),
    ).toBe(false);
  });
});

describe("acquireCredentialsLock", () => {
  let workDir: string;
  let lockPath: string;

  const opts = (
    over: Partial<AcquireCredentialsLockOptions>,
  ): AcquireCredentialsLockOptions => ({
    lockPath,
    reason: "test",
    waitMs: 200,
    pollIntervalMs: 25,
    signal: null,
    ...over,
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "traycer-cred-lock-test-"));
    lockPath = join(workDir, "credentials.lock");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("acquires a free lock and writes a fully-populated record", async () => {
    const result = await acquireCredentialsLock(opts({ waitMs: 0 }));
    expect(result.acquired).toBe(true);
    // Populated acquisition: the file always parses (no empty-lock window).
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(typeof parsed.pid).toBe("number");
    expect(typeof parsed.acquisitionNonce).toBe("string");
    if (result.acquired) await result.handle.release();
  });

  it("release() removes the lock file", async () => {
    const result = await acquireCredentialsLock(opts({ waitMs: 0 }));
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;
    await result.handle.release();
    expect(() => readFileSync(lockPath, "utf8")).toThrow();
  });

  it("reports busy for a live holder that never frees it in time", async () => {
    // pid === process.pid is genuinely alive; a null fingerprint means "cannot
    // prove dead" -> assumed live -> never broken.
    writeRawLock(lockPath, { pid: process.pid, acquisitionNonce: "held" });
    const result = await acquireCredentialsLock(opts({ waitMs: 150 }));
    expect(result.acquired).toBe(false);
    // The live holder's lock is left intact.
    expect(JSON.parse(readFileSync(lockPath, "utf8")).acquisitionNonce).toBe(
      "held",
    );
  });

  it.skipIf(isWindows)(
    "takes over a lock whose holder pid is gone",
    async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      });
      writeRawLock(lockPath, {
        pid: 999999,
        pidStartTime: "whatever",
        acquisitionNonce: "dead-holder",
      });
      const result = await acquireCredentialsLock(opts({ waitMs: 1000 }));
      expect(result.acquired).toBe(true);
      if (result.acquired) await result.handle.release();
    },
  );

  it.skipIf(isWindows)(
    "takes over a live pid whose start-time fingerprint no longer matches (recycled pid)",
    async () => {
      // process.pid is alive, but the recorded fingerprint is bogus, so the
      // current (real) fingerprint won't match -> provably a recycled pid.
      writeRawLock(lockPath, {
        pid: process.pid,
        pidStartTime: "stale-bogus-fingerprint",
        acquisitionNonce: "recycled",
      });
      const result = await acquireCredentialsLock(opts({ waitMs: 1000 }));
      expect(result.acquired).toBe(true);
      if (result.acquired) await result.handle.release();
    },
  );

  it("takes over an unparseable lock older than the orphan grace window", async () => {
    writeRawLock(lockPath, "this is not valid json");
    const old = new Date(Date.now() - ORPHAN_LOCK_GRACE_MS - 1000);
    utimesSync(lockPath, old, old);
    const result = await acquireCredentialsLock(opts({ waitMs: 1000 }));
    expect(result.acquired).toBe(true);
    if (result.acquired) await result.handle.release();
  });

  it("reports busy for an unparseable lock younger than the orphan grace window", async () => {
    writeRawLock(lockPath, "corrupt");
    const result = await acquireCredentialsLock(opts({ waitMs: 150 }));
    expect(result.acquired).toBe(false);
  });

  it("release() does not delete a lock re-acquired by someone else after a false takeover", async () => {
    const result = await acquireCredentialsLock(opts({ waitMs: 0 }));
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;
    // Simulate a steal: another holder replaced our record while we still
    // believe we hold it. Owner-checked release must not remove theirs.
    const impostor = {
      pid: 424242,
      pidStartTime: null,
      acquisitionNonce: "impostor",
      acquiredAt: 0,
      reason: "impostor",
    };
    writeRawLock(lockPath, impostor);
    await result.handle.release();
    expect(JSON.parse(readFileSync(lockPath, "utf8")).acquisitionNonce).toBe(
      "impostor",
    );
  });

  it("returns busy immediately when the signal is already aborted", async () => {
    writeRawLock(lockPath, { pid: process.pid, acquisitionNonce: "held" });
    const controller = new AbortController();
    controller.abort();
    const result = await acquireCredentialsLock(
      opts({ waitMs: 5000, signal: controller.signal }),
    );
    expect(result.acquired).toBe(false);
  });

  it("aborting mid-wait cuts the wait short instead of blocking for waitMs", async () => {
    writeRawLock(lockPath, { pid: process.pid, acquisitionNonce: "held" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const started = Date.now();
    const result = await acquireCredentialsLock(
      opts({ waitMs: 10_000, signal: controller.signal }),
    );
    expect(result.acquired).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.skipIf(isWindows)(
    "serializes concurrent contenders racing to break the same dead-holder lock",
    async () => {
      vi.spyOn(process, "kill").mockImplementation((pid: number) => {
        // Only the recorded dead holder is gone; this real test process (which
        // every contender's own lock records) stays alive, so contenders must
        // wait for each other rather than all breaking through at once.
        if (pid === 999999) {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        }
        return true;
      });
      writeRawLock(lockPath, {
        pid: 999999,
        pidStartTime: "x",
        acquisitionNonce: "dead",
      });
      const acquired = await Promise.all(
        Array.from({ length: 4 }, () =>
          (async () => {
            const r = await acquireCredentialsLock(opts({ waitMs: 3000 }));
            if (r.acquired) await r.handle.release();
            return r.acquired;
          })(),
        ),
      );
      // Every contender eventually acquires (serialized), and no lock is leaked.
      expect(acquired.every(Boolean)).toBe(true);
      expect(() => readFileSync(lockPath, "utf8")).toThrow();
    },
  );
});

describe("withCredentialsLock", () => {
  let workDir: string;
  let lockPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "traycer-cred-withlock-test-"));
    lockPath = join(workDir, "credentials.lock");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("runs the body under the lock and releases afterward", async () => {
    let ranWithLock = false;
    const result = await withCredentialsLock(
      { lockPath, reason: "t", waitMs: 0, pollIntervalMs: 25, signal: null },
      async () => {
        ranWithLock = readFileSync(lockPath, "utf8").length > 0;
        return "value";
      },
    );
    expect(result).toEqual({ acquired: true, value: "value" });
    expect(ranWithLock).toBe(true);
    expect(() => readFileSync(lockPath, "utf8")).toThrow();
  });

  it("skips the body and reports not-acquired when the lock is busy", async () => {
    writeRawLock(lockPath, { pid: process.pid, acquisitionNonce: "held" });
    let ran = false;
    const result = await withCredentialsLock(
      { lockPath, reason: "t", waitMs: 100, pollIntervalMs: 25, signal: null },
      async () => {
        ran = true;
      },
    );
    expect(result).toEqual({ acquired: false });
    expect(ran).toBe(false);
  });
});

describe("breakStaleLock", () => {
  let workDir: string;
  let lockPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "traycer-cred-break-test-"));
    lockPath = join(workDir, "credentials.lock");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("removes the lock when it still holds the exact bytes we inspected", async () => {
    writeFileSync(lockPath, "STALE");
    expect(await breakStaleLock(lockPath, "STALE")).toBe("removed");
    expect(() => readFileSync(lockPath, "utf8")).toThrow();
  });

  it("leaves a lock that changed under us untouched and reports contended (re-read guard)", async () => {
    // A competitor already broke the stale lock and linked its own live one in
    // the gap. The re-read guard sees the bytes no longer match the stale entry
    // and bails without moving it - the live lock is left intact.
    writeFileSync(lockPath, "FRESH");
    expect(await breakStaleLock(lockPath, "STALE")).toBe("contended");
    expect(readFileSync(lockPath, "utf8")).toBe("FRESH");
  });

  it("reports contended without throwing when the lock is already gone", async () => {
    expect(await breakStaleLock(lockPath, "STALE")).toBe("contended");
  });
});

describe("queryPidStartFingerprint", () => {
  it("is timezone-invariant for the same live pid", () => {
    // A desktop holder in local time and a differently-zoned CLI contender must
    // fingerprint a live pid identically, or one steals the other's live lock.
    const saved = process.env.TZ;
    process.env.TZ = "UTC";
    const utc = queryPidStartFingerprint(process.pid);
    process.env.TZ = "Asia/Kolkata";
    const kolkata = queryPidStartFingerprint(process.pid);
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
    expect(utc).toBe(kolkata);
  });
});
