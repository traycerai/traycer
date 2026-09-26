import {
  mkdtemp,
  open as nodeOpen,
  readFile,
  rename as nodeRename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireLock,
  rewriteLockLivenessIfToken,
  type LockMetadata,
} from "../cross-process-lock";

// Every lock this module writes carries a non-null `randomUUID()` token; the
// metadata type keeps `token` nullable for the tokenless legacy records the
// reader tolerates. The rebind wants the string, so narrow once here.
function ownedToken(metadata: LockMetadata): string {
  if (metadata.token === null) throw new Error("acquired lock has no token");
  return metadata.token;
}

// This file exercises the win32 rename-onto-an-open-handle regression fixed
// in `tryAcquireOnce`: `rewriteLockLivenessIfToken` publishes liveness via a
// same-directory temp file + `rename(temp, lockPath)`. On win32,
// `MoveFileExW` refuses to replace a file that still has an open handle -
// including the acquiring process's own handle on the canonical lock file -
// so every liveness rebind failed for as long as the write handle stayed
// open for the lock's whole life. The fix closes that handle right after
// the initial metadata write; `release()`, which used to close it, now only
// does its path-based compare-and-delete.
//
// `open` and `rename` are the only two `node:fs/promises` calls this file
// needs to intercept: `open` to track which paths currently have a handle
// live (so we know whether a simulated win32 rename should refuse), and
// `rename` to simulate `MoveFileExW`'s refusal. Every other function
// (`mkdtemp`, `readFile`, `rm`, `stat`, `writeFile`, and every call this
// module makes to `lstat`/`stat`/`unlink`/`writeFile` internally) passes
// straight through to the real implementation.
// An armed rename failure for `rewriteLockLivenessIfToken`'s retry-loop
// coverage below (A1-A4). Independent of `simulateWin32RenameEperm` above,
// which models the open-handle refusal; this models a THIRD PARTY (a reader
// holding the file open, antivirus, etc.) making the rename to `path` fail
// for reasons the acquiring process does not control.
type ArmedRenameFailure = {
  readonly path: string;
  readonly code: string;
  // Number of upcoming calls to `rename(_, path)` that still fail. Set to
  // `Number.POSITIVE_INFINITY` to fail every call (A3's persistent EPERM).
  remaining: number;
  // Run BEFORE the throw, so a test can simulate a third party mutating the
  // canonical file out from under the retry (A2). Uses the real `writeFile`,
  // never the wrapped one, so it is not itself subject to this same failure
  // injection.
  readonly onFailure: (() => Promise<void>) | null;
};

const fsPromisesMockState = vi.hoisted(() => {
  return {
    // Count of currently-open handles per resolved path. Incremented in the
    // wrapped `open()`, decremented once that handle's real `close()` has
    // run. A simulated close failure never reaches it, so that handle stays
    // counted as open - as it would be.
    openHandleCounts: new Map<string, number>(),
    // Gate for the win32 `MoveFileExW` simulation in the wrapped `rename()`.
    // Off by default so every other test in the suite - and any test in a
    // sibling file that happens to run in the same worker - sees ordinary
    // rename behavior.
    simulateWin32RenameEperm: false,
    // When set to a path, the NEXT `open()` of that exact path gets a
    // handle whose first `close()` call throws once instead of closing.
    // Consumed (reset to null) as soon as that `open()` call is observed,
    // so it never poisons a later, unrelated open of the same path.
    closeFailureOnceForPath: null as string | null,
    // See `ArmedRenameFailure` above. `null` means no injected failure.
    armedRenameFailure: null as ArmedRenameFailure | null,
    // Every `rename()` call, keyed by its destination path, regardless of
    // outcome - so a test can assert exactly how many attempts a retry loop
    // made against a given destination.
    renameCallCountByDestination: new Map<string, number>(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const state = fsPromisesMockState;

  const open = async (
    ...args: Parameters<typeof actual.open>
  ): Promise<FileHandle> => {
    const handle = await actual.open(...args);
    const path = String(args[0]);
    state.openHandleCounts.set(
      path,
      (state.openHandleCounts.get(path) ?? 0) + 1,
    );

    let decremented = false;
    const decrementOnce = (): void => {
      if (decremented) return;
      decremented = true;
      const current = state.openHandleCounts.get(path) ?? 0;
      state.openHandleCounts.set(path, Math.max(0, current - 1));
    };

    const shouldFailClose = state.closeFailureOnceForPath === path;
    if (shouldFailClose) {
      state.closeFailureOnceForPath = null;
    }

    const originalClose = handle.close.bind(handle);
    let closeAttempted = false;
    handle.close = async (): Promise<void> => {
      if (shouldFailClose && !closeAttempted) {
        closeAttempted = true;
        throw Object.assign(new Error("simulated close failure"), {
          code: "EIO",
        });
      }
      try {
        await originalClose();
      } finally {
        decrementOnce();
      }
    };

    return handle;
  };

  const rename = async (
    ...args: Parameters<typeof actual.rename>
  ): Promise<void> => {
    const destination = String(args[1]);
    state.renameCallCountByDestination.set(
      destination,
      (state.renameCallCountByDestination.get(destination) ?? 0) + 1,
    );

    if (state.simulateWin32RenameEperm) {
      const openCount = state.openHandleCounts.get(destination) ?? 0;
      if (openCount > 0) {
        throw Object.assign(
          new Error("EPERM: operation not permitted, rename"),
          { code: "EPERM" },
        );
      }
    }

    const armed = state.armedRenameFailure;
    if (armed !== null && armed.path === destination && armed.remaining > 0) {
      armed.remaining -= 1;
      if (armed.onFailure !== null) {
        await armed.onFailure();
      }
      throw Object.assign(new Error(`simulated ${armed.code}`), {
        code: armed.code,
      });
    }

    await actual.rename(...args);
  };

  return { ...actual, open: vi.fn(open), rename: vi.fn(rename) };
});

const dirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cross-process-lock-win32-rename-"));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  fsPromisesMockState.openHandleCounts.clear();
  fsPromisesMockState.simulateWin32RenameEperm = false;
  fsPromisesMockState.closeFailureOnceForPath = null;
  fsPromisesMockState.armedRenameFailure = null;
  fsPromisesMockState.renameCallCountByDestination.clear();
});

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// `process.platform` has an own, configurable property descriptor in every
// Node runtime this suite targets; captured once so every win32 simulation
// below restores the exact original rather than guessing a value.
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
if (ORIGINAL_PLATFORM_DESCRIPTOR === undefined) {
  throw new Error("process.platform has no own property descriptor");
}

function stubWin32Platform(): void {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
}

// Unconditional: a test that never stubbed the platform leaves it already
// equal to the original descriptor, so redefining it here is a no-op for
// that test and a genuine restore for one that did.
afterEach(() => {
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
  expect(process.platform).toBe(ORIGINAL_PLATFORM_DESCRIPTOR.value);
});

describe("tryAcquireOnce - write-handle lifecycle", () => {
  it("closes the canonical lock's write handle before acquireLock resolves, and release() still compare-and-deletes the file", async () => {
    const dir = await freshDir();
    const lockPath = join(dir, "host.lock");

    const outcome = await acquireLock({
      lockPath,
      reason: "test",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return;

    // Mechanism: by the time acquireLock() has resolved, the handle
    // tryAcquireOnce opened to write the lock record must already be
    // closed - zero handles open on the canonical path - not held open
    // until release() the way it used to be.
    expect(fsPromisesMockState.openHandleCounts.get(lockPath) ?? 0).toBe(0);

    await outcome.handle.release();

    // release() never closes a handle (there is none left to close by the
    // time it runs) but it still performs its path-based compare-and-delete
    // correctly.
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("rewriteLockLivenessIfToken - win32 rename onto the held lock path", () => {
  it("rebinds liveness metadata while the lock is held, because the write handle is already closed", async () => {
    const dir = await freshDir();
    const lockPath = join(dir, "host.lock");
    fsPromisesMockState.simulateWin32RenameEperm = true;

    const outcome = await acquireLock({
      lockPath,
      reason: "test",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return;
    const { handle } = outcome;

    // `rewriteLockLivenessIfToken` keeps token/reason/startedAt fixed (its
    // own immutability check) but does not itself verify the new pid is
    // live - it only publishes what it is given. `process.pid + 1` is
    // simply a value distinct from the pid already on disk, so the
    // round-trip below actually proves something changed.
    const newPid = process.pid + 1;
    const next: LockMetadata = {
      ...handle.metadata,
      pid: newPid,
    };

    const rewritten = await rewriteLockLivenessIfToken(
      lockPath,
      ownedToken(handle.metadata),
      next,
    );
    // This is the regression this file exists to catch: on the original
    // code the acquiring process's own write handle was still open on
    // `lockPath` at this point, the simulated `MoveFileExW` refused the
    // rename with EPERM, and this resolved to `false` instead.
    expect(rewritten).toBe(true);

    const persisted = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
    };
    expect(persisted.pid).toBe(newPid);

    // release()'s guard only refuses to unlink while
    // `supervisedProcessGroupId` or `retainOnPublisherDeath` is set on the
    // current on-disk record - see the comment above the guard in
    // `tryAcquireOnce`. `next` above spread `handle.metadata` and only
    // overrode `pid`, so neither flag is set; this is a plain pid change,
    // and release() unlinks it normally.
    await handle.release();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("EPERM simulation - control", () => {
  it("throws EPERM on rename when the destination genuinely has an open handle, proving the fake models the win32 rule rather than passing vacuously", async () => {
    const dir = await freshDir();
    const heldOpenPath = join(dir, "scratch-target");
    await writeFile(heldOpenPath, "");
    const sourcePath = join(dir, "scratch-source");
    await writeFile(sourcePath, "x");

    fsPromisesMockState.simulateWin32RenameEperm = true;

    const openHandle = await nodeOpen(heldOpenPath, "r");
    try {
      await expect(nodeRename(sourcePath, heldOpenPath)).rejects.toMatchObject({
        code: "EPERM",
      });
    } finally {
      await openHandle.close();
    }

    // With the handle released, the identical rename now succeeds - this
    // confirms the refusal above was keyed on the open handle, not on the
    // flag alone.
    await expect(nodeRename(sourcePath, heldOpenPath)).resolves.toBeUndefined();
  });
});

describe("tryAcquireOnce - close failure on the canonical lock handle", () => {
  it("rejects acquireLock and does not leave the lock file behind when the post-write close throws", async () => {
    const dir = await freshDir();
    const lockPath = join(dir, "host.lock");
    fsPromisesMockState.closeFailureOnceForPath = lockPath;

    // `tryAcquireOnce`'s post-write close failure mirrors its write-failure
    // path: unlink what was just created, then rethrow. `acquireLockAtPath`
    // has no try/catch around its call to `tryAcquireOnce`, so that
    // rejection propagates all the way out of `acquireLock()` - it rejects
    // the returned promise rather than resolving to a "busy" outcome.
    await expect(
      acquireLock({
        lockPath,
        reason: "test",
        waitMs: 0,
        pollIntervalMs: 10,
      }),
    ).rejects.toMatchObject({ code: "EIO" });

    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// A1-A4: `rewriteLockLivenessIfToken`'s win32 retry loop around its final
// `rename(temporaryPath, path)`. Each test acquires the lock UNSTUBBED (real
// platform), then stubs win32 ONLY around the `rewriteLockLivenessIfToken`
// call under test - other code paths in `cross-process-lock.ts` branch on
// `process.platform` too (`probeProcessGroupLiveness`), so the stub must not
// leak into them.
describe("rewriteLockLivenessIfToken - win32 retry against a transient reader (A1)", () => {
  it("retries past a transient EPERM and rebinds liveness metadata", async () => {
    const dir = await freshDir();
    const lockPath = join(dir, "host.lock");

    const outcome = await acquireLock({
      lockPath,
      reason: "test",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return;
    const { handle } = outcome;

    const newPid = process.pid + 1;
    const next: LockMetadata = { ...handle.metadata, pid: newPid };

    stubWin32Platform();
    fsPromisesMockState.armedRenameFailure = {
      path: lockPath,
      code: "EPERM",
      remaining: 2,
      onFailure: null,
    };

    const rewritten = await rewriteLockLivenessIfToken(
      lockPath,
      ownedToken(handle.metadata),
      next,
    );

    expect(rewritten).toBe(true);
    expect(fsPromisesMockState.renameCallCountByDestination.get(lockPath)).toBe(
      3,
    );

    const persisted = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
    };
    expect(persisted.pid).toBe(newPid);

    await handle.release();
  });
});

describe("rewriteLockLivenessIfToken - ownership change between retries (A2)", () => {
  it("returns false and never clobbers a fresh holder that appears mid-retry", async () => {
    const dir = await freshDir();
    const lockPath = join(dir, "host.lock");

    const outcome = await acquireLock({
      lockPath,
      reason: "test",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return;
    const { handle } = outcome;

    const otherToken = "other-holder-token";
    const otherHolder: LockMetadata = { ...handle.metadata, token: otherToken };

    stubWin32Platform();
    fsPromisesMockState.armedRenameFailure = {
      path: lockPath,
      code: "EPERM",
      remaining: 1,
      onFailure: async () => {
        // The real `writeFile`, simulating a DIFFERENT process becoming the
        // holder in between the failed rename and the retry's re-read.
        await writeFile(lockPath, JSON.stringify(otherHolder, null, 2));
      },
    };

    const next: LockMetadata = { ...handle.metadata, pid: process.pid + 1 };
    const rewritten = await rewriteLockLivenessIfToken(
      lockPath,
      ownedToken(handle.metadata),
      next,
    );

    expect(rewritten).toBe(false);
    expect(fsPromisesMockState.renameCallCountByDestination.get(lockPath)).toBe(
      1,
    );

    const persisted = JSON.parse(await readFile(lockPath, "utf8")) as {
      token: string;
    };
    expect(persisted.token).toBe(otherToken);
  });
});

describe("rewriteLockLivenessIfToken - persistent EPERM (A3)", () => {
  it("returns false after exhausting the retry schedule, leaving the canonical lock unchanged", async () => {
    const dir = await freshDir();
    const lockPath = join(dir, "host.lock");

    const outcome = await acquireLock({
      lockPath,
      reason: "test",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return;
    const { handle } = outcome;

    const originalRaw = await readFile(lockPath, "utf8");

    stubWin32Platform();
    fsPromisesMockState.armedRenameFailure = {
      path: lockPath,
      code: "EPERM",
      remaining: Number.POSITIVE_INFINITY,
      onFailure: null,
    };

    const next: LockMetadata = { ...handle.metadata, pid: process.pid + 1 };
    const rewritten = await rewriteLockLivenessIfToken(
      lockPath,
      ownedToken(handle.metadata),
      next,
    );

    expect(rewritten).toBe(false);
    // The schedule is [10, 25, 50, 100, 200]ms - one initial attempt plus
    // five scheduled retries, then `windowsRenameRetryDelayMs` returns null
    // at retryIndex 5 and the failure surfaces. Real timers; the schedule
    // totals 385ms.
    expect(fsPromisesMockState.renameCallCountByDestination.get(lockPath)).toBe(
      6,
    );

    const finalRaw = await readFile(lockPath, "utf8");
    expect(finalRaw).toBe(originalRaw);
    const persisted = JSON.parse(finalRaw) as { token: string };
    expect(persisted.token).toBe(handle.metadata.token);
  });
});

describe("rewriteLockLivenessIfToken - off win32 (A4, control)", () => {
  it("does not retry a transient rename failure off win32", async () => {
    const dir = await freshDir();
    const lockPath = join(dir, "host.lock");

    const outcome = await acquireLock({
      lockPath,
      reason: "test",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(outcome.kind).toBe("acquired");
    if (outcome.kind !== "acquired") return;
    const { handle } = outcome;

    // Deliberately NOT stubbed: this proves POSIX (this test runner's real
    // platform) behaviour is unchanged by the retry loop.
    expect(process.platform).not.toBe("win32");
    fsPromisesMockState.armedRenameFailure = {
      path: lockPath,
      code: "EPERM",
      remaining: Number.POSITIVE_INFINITY,
      onFailure: null,
    };

    const next: LockMetadata = { ...handle.metadata, pid: process.pid + 1 };
    const rewritten = await rewriteLockLivenessIfToken(
      lockPath,
      ownedToken(handle.metadata),
      next,
    );

    expect(rewritten).toBe(false);
    expect(fsPromisesMockState.renameCallCountByDestination.get(lockPath)).toBe(
      1,
    );
  });
});
