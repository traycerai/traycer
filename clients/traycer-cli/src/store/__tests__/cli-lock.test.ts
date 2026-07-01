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

const mocks = vi.hoisted(() => ({ lockPath: "" }));

vi.mock("../paths", () => ({
  cliLockPath: () => mocks.lockPath,
  ensureCliHomeDir: async () => {},
}));

import {
  acquireCliLock,
  isProcessAlive,
  withCliLock,
  type CliLockMetadata,
} from "../cli-lock";
import { CLI_ERROR_CODES } from "../../runner/errors";

// Ten minutes - kept in sync with MAX_LOCK_AGE_MS in cli-lock.ts (not
// exported; the regression test below re-derives it from behavior, not
// from importing the private constant).
const MAX_LOCK_AGE_MS = 10 * 60 * 1000;
const EMPTY_LOCK_GRACE_MS = 5000;

function writeLock(overrides: Partial<CliLockMetadata>): void {
  const meta: CliLockMetadata = {
    pid: 999999,
    reason: "old-holder",
    startedAt: new Date().toISOString(),
    hostname: null,
    token: "original-token",
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

  it("regression: breaks a lock past the age ceiling even though the pid is alive", async () => {
    // Same live pid as the previous test (guaranteed alive via the
    // pid === process.pid shortcut - no ESRCH/EPERM involved), but old
    // enough to exceed MAX_LOCK_AGE_MS. Before the fix this hung until
    // waitMs regardless of age; this is the exact bug from the report.
    writeLock({
      pid: process.pid,
      reason: "host-update",
      startedAt: new Date(Date.now() - MAX_LOCK_AGE_MS - 1000).toISOString(),
    });
    const handle = await acquireCliLock({
      environment: "production",
      reason: "contender",
      waitMs: 1000,
      pollIntervalMs: 50,
    });
    expect(handle.metadata.reason).toBe("contender");
    await handle.release();
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

  it("falls back to the lock file's mtime when startedAt is unparseable, and still breaks past the ceiling", async () => {
    writeLock({
      pid: process.pid,
      reason: "host-update",
      startedAt: "not-a-real-timestamp",
    });
    const old = new Date(Date.now() - MAX_LOCK_AGE_MS - 1000);
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

  it("falls back to the lock file's mtime when startedAt is in the future, and still breaks past the ceiling", async () => {
    writeLock({
      pid: process.pid,
      reason: "host-update",
      startedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const old = new Date(Date.now() - MAX_LOCK_AGE_MS - 1000);
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
