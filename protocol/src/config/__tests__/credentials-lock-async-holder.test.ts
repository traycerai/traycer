import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCredentialsFile, type StoredCredentials } from "../credentials";
import {
  spentBaseMarkerPath,
  type RefreshFn,
  type RefreshResult,
} from "../credentials-mutation";

// Row 5: these tests pin a contended `acquireCredentialsLock` against a
// live holder (5a), a stale spent-base marker owned by a live process driven
// through the mutation store's public `rotate` (5b), and a first,
// uncontended lock acquisition with a cold own-fingerprint cache (5c) to
// judging liveness WITHOUT a SYNCHRONOUS `ps -o lstart=` spawn
// (`execFileSync`, via `queryPidStartFingerprint`). Spying (not stubbing)
// `execFileSync` keeps real behavior while letting each test count spawns
// precisely.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

const isWindows = process.platform === "win32";

const CREDS: StoredCredentials = {
  token: "tok-0",
  refreshToken: "rt-0",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
};

function sha256(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Row 5a/5b: platform is macOS-shaped (non-Linux, non-win32) production
// code, which is why the fingerprint probe below is `ps -o lstart=` via
// `execFileSync` rather than `/proc/<pid>/stat` or `tasklist`.
describe.skipIf(isWindows)("credentials-lock async holder (row 5)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "traycer-cred-lock-async-holder-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  describe("acquireCredentialsLock - contended against a live holder (5a)", () => {
    let child: ChildProcess;
    let childFingerprint: string | null;

    beforeEach(async () => {
      child = spawn("sleep", ["30"], { stdio: "ignore" });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      if (child.pid === undefined) {
        throw new Error("real sleep child was spawned without a pid");
      }
      // Real, unmocked-behavior read (the mock above wraps, not replaces,
      // the real implementation) of the child's fingerprint, taken BEFORE
      // the measured operation resets the call count.
      const { queryPidStartFingerprint, ownPidStartFingerprint } =
        await import("../credentials-lock");
      childFingerprint = queryPidStartFingerprint(child.pid);
      // Pre-warm this process's own fingerprint cache too: `acquireCredentialsLock`
      // unconditionally stamps `ownPidStartFingerprint()` before it ever inspects
      // the holder, and that spawn is not the mechanism this test targets.
      ownPidStartFingerprint();
    });

    afterEach(() => {
      child.kill("SIGKILL");
    });

    // Pins 5a: a contended `acquireCredentialsLock` against a genuinely
    // alive, positively-identified holder must not spawn `ps` synchronously
    // on any poll iteration. Today, each contended iteration's
    // `holderProvablyDead` -> `queryPidStartFingerprint` reads the holder's
    // fingerprint via a synchronous `ps` spawn, even though `isProcessAlive`
    // (POSIX `process.kill`, no spawn) already proves the holder alive and
    // the recorded fingerprint still matches.
    it("never judges its live holder synchronously on any poll iteration", async () => {
      if (child.pid === undefined) {
        throw new Error("real sleep child was spawned without a pid");
      }
      const { acquireCredentialsLock } = await import("../credentials-lock");
      const lockPath = join(workDir, "credentials.lock");
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: child.pid,
          pidStartTime: childFingerprint,
          acquisitionNonce: "holder-nonce",
          acquiredAt: Date.now(),
          reason: "holder",
        }),
      );

      // Reset right before the measured operation - the fingerprint reads in
      // `beforeEach` above must not count against this assertion.
      vi.mocked(execFileSync).mockClear();

      const result = await acquireCredentialsLock({
        lockPath,
        reason: "contender",
        waitMs: 250,
        pollIntervalMs: 25,
        signal: null,
      });

      // The holder is genuinely alive (matching fingerprint) for the whole
      // wait, so acquisition never succeeds.
      expect(result.acquired).toBe(false);
      // 0 calls during the contended wait: an async holder-liveness check
      // is what keeps this pinned.
      expect(execFileSync).toHaveBeenCalledTimes(0);
    });
  });

  describe("credentials mutation store - stale spent-base marker owned by a live process (5b)", () => {
    let child: ChildProcess;
    let childFingerprint: string | null;
    let credentialsPath: string;
    let metaPath: string;
    let lockPath: string;

    beforeEach(async () => {
      child = spawn("sleep", ["30"], { stdio: "ignore" });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      if (child.pid === undefined) {
        throw new Error("real sleep child was spawned without a pid");
      }
      const { queryPidStartFingerprint, ownPidStartFingerprint } =
        await import("../credentials-lock");
      // Real, unmocked-behavior fingerprint read, taken before the mock's
      // call count is reset below.
      childFingerprint = queryPidStartFingerprint(child.pid);
      // Pre-warm this process's own fingerprint cache: `rotate`'s own,
      // uncontended lock acquisition stamps `ownPidStartFingerprint()` too,
      // and that spawn is not the mechanism this test targets (5c covers it).
      ownPidStartFingerprint();

      credentialsPath = join(workDir, "credentials");
      metaPath = join(workDir, "credentials.meta.json");
      lockPath = join(workDir, "credentials.lock");
    });

    afterEach(() => {
      child.kill("SIGKILL");
    });

    function refreshStub(): { fn: RefreshFn; calls: () => number } {
      let count = 0;
      const rotateOk = (token: string): RefreshResult => ({
        kind: "refreshed",
        token: `${token}::r`,
        refreshToken: `rt::${token}`,
      });
      return {
        fn: async ({ token }) => {
          count += 1;
          return rotateOk(token);
        },
        calls: () => count,
      };
    }

    // Pins 5b: a fresh spent-base marker naming a genuinely alive,
    // positively identified process as owner must be judged without a
    // synchronous `ps` spawn. Driven through `rotate` (the store's public
    // entry point that reaches `markerOwnerProvablyDead` at
    // credentials-mutation.ts:882), mirroring the "defers with spend-pending
    // on a live foreign owner's fresh marker" case in
    // credentials-mutation.test.ts, but asserting the liveness mechanism
    // instead of the outcome. Today, `markerOwnerProvablyDead` ->
    // `queryPidStartFingerprint` spawns `ps` synchronously for the marker's
    // owner.
    it("never judges a live marker owner synchronously when rotate defers to spend-pending", async () => {
      if (child.pid === undefined) {
        throw new Error("real sleep child was spawned without a pid");
      }
      await writeCredentialsFile(credentialsPath, CREDS, 0);
      writeFileSync(
        spentBaseMarkerPath(credentialsPath),
        JSON.stringify({
          spentTokenDigest: sha256(CREDS.token),
          at: new Date().toISOString(),
          ownerPid: child.pid,
          ownerFingerprint: childFingerprint,
        }),
        { mode: 0o600 },
      );

      const { createCredentialsMutationStore } =
        await import("../credentials-mutation");
      const stub = refreshStub();
      const store = createCredentialsMutationStore({
        paths: { credentialsPath, metaPath, lockPath },
        refresh: stub.fn,
        lockWaitMs: 500,
        lockPollIntervalMs: 25,
        continuationRetryMs: 15,
      });

      // Reset right before the measured operation.
      vi.mocked(execFileSync).mockClear();

      try {
        const result = await store.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        });

        // The marker owner is genuinely alive with a matching fingerprint,
        // so rotate defers rather than spending.
        expect(result.outcome).toBe("spend-pending");
        expect(stub.calls()).toBe(0);
        // 0 calls: an async marker-owner liveness check is what keeps this
        // pinned.
        expect(execFileSync).toHaveBeenCalledTimes(0);
      } finally {
        store.dispose();
      }
    });
  });

  describe("acquireCredentialsLock - first acquisition's own fingerprint (5c)", () => {
    // Pins 5c: the very first acquisition in a fresh module instance (a
    // cold `cachedOwnFingerprint`) must not spawn `ps` synchronously either.
    // Today, `acquireCredentialsLock` stamps `ownPidStartFingerprint()` at
    // write time (credentials-lock.ts:101), and with a freshly reset
    // module-level cache that spawns `ps` synchronously via `execFileSync`.
    it("never spawns synchronously for its own uncontended, cold-cache first acquisition", async () => {
      // Fresh module registry so `cachedOwnFingerprint` starts as `undefined`.
      vi.resetModules();
      const freshCredentialsLock = await import("../credentials-lock");

      const lockPath = join(workDir, "credentials-fresh.lock");

      // Reset right before the measured operation.
      vi.mocked(execFileSync).mockClear();

      const result = await freshCredentialsLock.acquireCredentialsLock({
        lockPath,
        reason: "first",
        waitMs: 0,
        pollIntervalMs: 25,
        signal: null,
      });

      expect(result.acquired).toBe(true);
      if (result.acquired) {
        await result.handle.release();
      }

      // 0 calls for the first, uncontended acquisition: an async
      // own-fingerprint read is what keeps this pinned.
      expect(execFileSync).toHaveBeenCalledTimes(0);
    });
  });
});
