import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCredentialsFile,
  writeCredentialsFile,
  type StoredCredentials,
} from "../credentials";
import {
  createCredentialsMutationStore,
  CredentialsStoreUnavailableError,
  spentBaseMarkerPath,
  type CredentialsMutationStore,
  type RefreshFn,
  type RefreshResult,
} from "../credentials-mutation";
import { queryPidStartFingerprint } from "../credentials-lock";
import { writeSidecarState } from "../credentials-wal";

const CREDS: StoredCredentials = {
  token: "tok-0",
  refreshToken: "rt-0",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
};

const isWindows = process.platform === "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// A read-only parent dir blocks temp creation, forcing every WAL write to fail
// -> commit-failed, while reads still succeed. Root and Windows ignore the bits.
const canForceCommitFailure = !isWindows && !isRoot;

describe("credentials mutation store", () => {
  let workDir: string;
  let credentialsPath: string;
  let metaPath: string;
  let lockPath: string;
  const stores: CredentialsMutationStore[] = [];

  function makeStore(refresh: RefreshFn): CredentialsMutationStore {
    const store = createCredentialsMutationStore({
      paths: { credentialsPath, metaPath, lockPath },
      refresh,
      lockWaitMs: 500,
      lockPollIntervalMs: 25,
      continuationRetryMs: 15,
    });
    stores.push(store);
    return store;
  }

  // Refresh stub: records call count, mints a deterministic distinct pair.
  function refreshStub(behavior: (token: string) => RefreshResult): {
    fn: RefreshFn;
    calls: () => number;
  } {
    let count = 0;
    return {
      fn: async ({ token }) => {
        count += 1;
        return behavior(token);
      },
      calls: () => count,
    };
  }

  const rotateOk = (token: string): RefreshResult => ({
    kind: "refreshed",
    token: `${token}::r`,
    refreshToken: `rt::${token}`,
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "traycer-cred-mut-test-"));
    credentialsPath = join(workDir, "credentials");
    metaPath = join(workDir, "credentials.meta.json");
    // The lock lives in its own subdir so the commit-failure tests can freeze
    // only the credentials+meta dir (blocking their writes) while lock
    // acquisition and reads still work (0o500 keeps search+read).
    mkdirSync(join(workDir, "lock"), { recursive: true, mode: 0o700 });
    lockPath = join(workDir, "lock", "credentials.lock");
  });

  afterEach(() => {
    for (const store of stores) store.dispose();
    stores.length = 0;
    chmodSync(workDir, 0o700);
    rmSync(workDir, { recursive: true, force: true });
  });

  async function seedSignedIn(store: CredentialsMutationStore): Promise<void> {
    const result = await store.signIn(CREDS, false, null);
    expect(result.outcome).toBe("applied");
  }

  describe("rotate", () => {
    it("refreshes and commits when the token matches (applied)", async () => {
      const refresh = refreshStub(rotateOk);
      const store = makeStore(refresh.fn);
      await seedSignedIn(store);
      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });
      expect(result.outcome).toBe("applied");
      expect(result.credentials?.token).toBe("tok-0::r");
      expect((await readCredentialsFile(credentialsPath))?.token).toBe(
        "tok-0::r",
      );
      expect(refresh.calls()).toBe(1);
    });

    it("adopts the file pair without spending when a sibling already rotated (superseded)", async () => {
      const refresh = refreshStub(rotateOk);
      const store = makeStore(refresh.fn);
      await seedSignedIn(store);
      // Simulate a sibling having rotated the file out from under us.
      await writeCredentialsFile(
        credentialsPath,
        { ...CREDS, token: "sibling-tok" },
        0,
      );
      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });
      expect(result.outcome).toBe("superseded");
      expect(result.credentials?.token).toBe("sibling-tok");
      expect(refresh.calls()).toBe(0); // no spend
    });

    it("returns deleted without spending when the file is gone", async () => {
      const refresh = refreshStub(rotateOk);
      const store = makeStore(refresh.fn);
      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });
      expect(result.outcome).toBe("deleted");
      expect(refresh.calls()).toBe(0);
    });

    it("returns user-mismatch without spending for a foreign file", async () => {
      const refresh = refreshStub(rotateOk);
      const store = makeStore(refresh.fn);
      await writeCredentialsFile(
        credentialsPath,
        { ...CREDS, user: { ...CREDS.user, id: "other" } },
        0,
      );
      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });
      expect(result.outcome).toBe("user-mismatch");
      expect(result.credentials?.user.id).toBe("other");
      expect(refresh.calls()).toBe(0);
    });

    it("keeps the file on an authn-confirmed rejection (refresh-rejected)", async () => {
      const refresh = refreshStub(() => ({ kind: "rejected" }));
      const store = makeStore(refresh.fn);
      await seedSignedIn(store);
      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });
      expect(result.outcome).toBe("refresh-rejected");
      // File kept (settled decision: only explicit intent destroys shared state).
      expect((await readCredentialsFile(credentialsPath))?.token).toBe(
        CREDS.token,
      );
    });

    it("writes nothing on a transient refresh failure (refresh-network)", async () => {
      const refresh = refreshStub(() => ({ kind: "network-error" }));
      const store = makeStore(refresh.fn);
      await seedSignedIn(store);
      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });
      expect(result.outcome).toBe("refresh-network");
      expect((await readCredentialsFile(credentialsPath))?.token).toBe(
        CREDS.token,
      );
    });

    it("reports lock-busy without spending when a live holder keeps the lock", async () => {
      const refresh = refreshStub(rotateOk);
      const store = makeStore(refresh.fn);
      await seedSignedIn(store);
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, acquisitionNonce: "held" }),
      );
      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });
      expect(result.outcome).toBe("lock-busy");
      expect(refresh.calls()).toBe(0);
    });

    it("two racing rotations serialize under the lock: exactly one spend, the other adopts", async () => {
      const shared = refreshStub(rotateOk);
      const a = makeStore(shared.fn);
      const b = makeStore(shared.fn);
      await seedSignedIn(a);
      const [ra, rb] = await Promise.all([
        a.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        }),
        b.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        }),
      ]);
      expect(shared.calls()).toBe(1); // exactly one spend
      const outcomes = [ra.outcome, rb.outcome].sort();
      expect(outcomes).toEqual(["applied", "superseded"]);
    });
  });

  describe("signIn / signOut", () => {
    it("signIn creates the file; a later signIn supersedes a sign-out tombstone", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await seedSignedIn(store);
      expect(await readCredentialsFile(credentialsPath)).toEqual(CREDS);
      const out = await store.signOut(null);
      expect(out.outcome).toBe("deleted");
      expect(await readCredentialsFile(credentialsPath)).toBeNull();
      const back = await store.signIn(
        { ...CREDS, token: "tok-2" },
        false,
        null,
      );
      expect(back.outcome).toBe("applied");
      expect((await readCredentialsFile(credentialsPath))?.token).toBe("tok-2");
    });

    it("preserveRefreshTokenIfBlank carries over the on-disk refresh token read fresh under the lock", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await seedSignedIn(store);
      const result = await store.signIn(
        { ...CREDS, token: "tok-2", refreshToken: "" },
        true,
        null,
      );
      expect(result.outcome).toBe("applied");
      expect(result.credentials?.refreshToken).toBe(CREDS.refreshToken);
      expect((await readCredentialsFile(credentialsPath))?.refreshToken).toBe(
        CREDS.refreshToken,
      );
    });

    it("preserveRefreshTokenIfBlank does not resurrect a refresh token when there is no file yet", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      const result = await store.signIn(
        { ...CREDS, refreshToken: "" },
        true,
        null,
      );
      expect(result.outcome).toBe("applied");
      expect(result.credentials?.refreshToken).toBe("");
    });

    it("a blank refreshToken is written as-is when preserveRefreshTokenIfBlank is false", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await seedSignedIn(store);
      const result = await store.signIn(
        { ...CREDS, token: "tok-2", refreshToken: "" },
        false,
        null,
      );
      expect(result.outcome).toBe("applied");
      expect(result.credentials?.refreshToken).toBe("");
    });

    it("preserveRefreshTokenIfBlank never pairs a foreign refresh token with a different account", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await seedSignedIn(store);
      const result = await store.signIn(
        {
          ...CREDS,
          token: "tok-2",
          refreshToken: "",
          user: { id: "u2", email: "bo@traycer.ai", name: "Bo" },
        },
        true,
        null,
      );
      expect(result.outcome).toBe("applied");
      expect(result.credentials?.refreshToken).toBe("");
      expect(result.credentials?.user.id).toBe("u2");
      expect((await readCredentialsFile(credentialsPath))?.refreshToken).toBe(
        "",
      );
    });
  });

  describe("updateProfile", () => {
    it("merges the user block when the token matches, leaving tokens untouched", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await seedSignedIn(store);
      const result = await store.updateProfile({
        expectedToken: CREDS.token,
        user: { ...CREDS.user, name: "Ada Lovelace" },
        signal: null,
      });
      expect(result.outcome).toBe("applied");
      const file = await readCredentialsFile(credentialsPath);
      expect(file?.token).toBe(CREDS.token); // unchanged
      expect(file?.user.name).toBe("Ada Lovelace");
    });

    it("skips (superseded) when a sibling rotated under it", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await seedSignedIn(store);
      const result = await store.updateProfile({
        expectedToken: "stale",
        user: { ...CREDS.user, name: "X" },
        signal: null,
      });
      expect(result.outcome).toBe("superseded");
      expect((await readCredentialsFile(credentialsPath))?.user.name).toBe(
        "Ada",
      );
    });
  });

  describe("guardedSignIn (migration first-write)", () => {
    it("refuses to resurrect a signed-out session (tombstoned)", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await seedSignedIn(store);
      await store.signOut(null);
      const result = await store.guardedSignIn({
        credentials: CREDS,
        expectedFile: null,
        signal: null,
      });
      expect(result.outcome).toBe("tombstoned");
      expect(await readCredentialsFile(credentialsPath)).toBeNull();
    });

    it("writes when the file is absent and no tombstone stands (applied)", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      const result = await store.guardedSignIn({
        credentials: CREDS,
        expectedFile: null,
        signal: null,
      });
      expect(result.outcome).toBe("applied");
      expect((await readCredentialsFile(credentialsPath))?.token).toBe(
        CREDS.token,
      );
    });

    it("supersedes when the file snapshot no longer matches", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await seedSignedIn(store); // file now holds CREDS.token
      const result = await store.guardedSignIn({
        credentials: { ...CREDS, token: "migrated" },
        expectedFile: { ...CREDS, token: "some-old-token" },
        signal: null,
      });
      expect(result.outcome).toBe("superseded");
    });

    it("supersedes a same-token content change instead of clobbering it (full-file guard)", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await writeCredentialsFile(credentialsPath, CREDS, 0);
      const snapshot = await readCredentialsFile(credentialsPath);
      // A sibling rewrites the user block but keeps the token (and epoch).
      await writeCredentialsFile(
        credentialsPath,
        { ...CREDS, user: { ...CREDS.user, name: "Newer" } },
        0,
      );
      const result = await store.guardedSignIn({
        credentials: { ...CREDS, token: "migrated" },
        expectedFile: snapshot,
        signal: null,
      });
      // A token-only guard would have matched and clobbered; the full-file
      // digest rejects the stale snapshot.
      expect(result.outcome).toBe("superseded");
      expect((await readCredentialsFile(credentialsPath))?.user.name).toBe(
        "Newer",
      );
    });
  });

  describe("migrateFirstWrite (spend + guarded first-write)", () => {
    const MIGRATED_IDENTITY = {
      id: "u2",
      email: "grace@traycer.ai",
      name: "Grace",
    };
    const CANDIDATE = {
      token: "cand-tok",
      refreshToken: "cand-rt",
    };

    it("spends the candidate and first-writes the refreshed pair stamped with the probed identity (applied)", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      const result = await store.migrateFirstWrite({
        candidate: CANDIDATE,
        identity: MIGRATED_IDENTITY,
        expectedFile: null,
        signal: null,
      });
      expect(result.outcome).toBe("applied");
      expect(stub.calls()).toBe(1);
      const onDisk = await readCredentialsFile(credentialsPath);
      expect(onDisk).toEqual({
        token: "cand-tok::r",
        refreshToken: "rt::cand-tok",
        savedAt: expect.any(String),
        user: MIGRATED_IDENTITY,
      });
    });

    it("refuses a signed-out tombstone BEFORE spending (tombstoned, no refresh)", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      await seedSignedIn(store);
      await store.signOut(null);
      const result = await store.migrateFirstWrite({
        candidate: CANDIDATE,
        identity: MIGRATED_IDENTITY,
        expectedFile: null,
        signal: null,
      });
      expect(result.outcome).toBe("tombstoned");
      expect(stub.calls()).toBe(0);
      expect(await readCredentialsFile(credentialsPath)).toBeNull();
    });

    it("supersedes a changed snapshot BEFORE spending (superseded, no refresh)", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      await seedSignedIn(store); // file now holds CREDS
      const result = await store.migrateFirstWrite({
        candidate: CANDIDATE,
        identity: MIGRATED_IDENTITY,
        expectedFile: null, // expected absent, but the file is present
        signal: null,
      });
      expect(result.outcome).toBe("superseded");
      expect(stub.calls()).toBe(0);
    });

    it("returns refresh-rejected without writing when the candidate is dead", async () => {
      const store = makeStore(refreshStub(() => ({ kind: "rejected" })).fn);
      const result = await store.migrateFirstWrite({
        candidate: CANDIDATE,
        identity: MIGRATED_IDENTITY,
        expectedFile: null,
        signal: null,
      });
      expect(result.outcome).toBe("refresh-rejected");
      expect(await readCredentialsFile(credentialsPath)).toBeNull();
    });

    it("returns refresh-network without writing on a transient refresh failure", async () => {
      const store = makeStore(
        refreshStub(() => ({ kind: "network-error" })).fn,
      );
      const result = await store.migrateFirstWrite({
        candidate: CANDIDATE,
        identity: MIGRATED_IDENTITY,
        expectedFile: null,
        signal: null,
      });
      expect(result.outcome).toBe("refresh-network");
      expect(await readCredentialsFile(credentialsPath)).toBeNull();
    });

    it.skipIf(!canForceCommitFailure)(
      "arms the firstWrite continuation with the minted pair on commit failure (commit-failed)",
      async () => {
        // Freeze INSIDE the refresh stub - after the fail-closed marker arm
        // and the spend - so only the post-spend commit fails.
        const store = makeStore(
          refreshStub((token) => {
            chmodSync(workDir, 0o500);
            return rotateOk(token);
          }).fn,
        );
        const failed = await store.migrateFirstWrite({
          candidate: CANDIDATE,
          identity: MIGRATED_IDENTITY,
          expectedFile: null,
          signal: null,
        });
        expect(failed.outcome).toBe("commit-failed");
        expect(failed.credentials?.token).toBe("cand-tok::r");
        expect(store.hasPendingContinuation()).toBe(true);
        chmodSync(workDir, 0o700); // unfreeze so cleanup + the retry can proceed
      },
    );
  });

  describe("tombstone guards", () => {
    it("rotate refuses to resurrect a signed-out session when F is recreated (tombstoned)", async () => {
      const refresh = refreshStub(rotateOk);
      const store = makeStore(refresh.fn);
      await seedSignedIn(store);
      await store.signOut(null); // sidecar tombstone stands
      // A raw/legacy writer recreates a matching file out-of-band.
      await writeCredentialsFile(credentialsPath, CREDS, 0);
      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });
      expect(result.outcome).toBe("tombstoned");
      expect(refresh.calls()).toBe(0); // never spent
    });

    it("updateProfile refuses to clear a sign-out tombstone (tombstoned)", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await seedSignedIn(store);
      await store.signOut(null);
      await writeCredentialsFile(credentialsPath, CREDS, 0);
      const result = await store.updateProfile({
        expectedToken: CREDS.token,
        user: { ...CREDS.user, name: "X" },
        signal: null,
      });
      expect(result.outcome).toBe("tombstoned");
      expect((await readCredentialsFile(credentialsPath))?.user.name).toBe(
        "Ada",
      );
    });
  });

  describe("firstWrite read overlay (sidecar-gated)", () => {
    it.skipIf(!canForceCommitFailure)(
      "does not ghost a sibling sign-out that landed while a first-write is pending",
      async () => {
        const store = makeStore(refreshStub(rotateOk).fn);
        chmodSync(workDir, 0o500); // freeze so the first-write commit fails
        const failed = await store.guardedSignIn({
          credentials: CREDS,
          expectedFile: null,
          signal: null,
        });
        expect(failed.outcome).toBe("commit-failed");
        expect(store.hasPendingContinuation()).toBe(true);
        store.dispose(); // stop the retry timer so we observe read()'s own gate
        chmodSync(workDir, 0o700);
        // A sibling committed a sign-out tombstone (epoch advanced), F absent.
        await writeSidecarState(metaPath, {
          epoch: 1,
          lastMutation: "signOut",
          mtimeFloorMs: 0,
          pending: null,
        });
        expect(await store.read()).toBeNull(); // gated, not resurrected
      },
    );

    it.skipIf(!canForceCommitFailure)(
      "overlays the minted pair over a matching legacy file until the first-write lands",
      async () => {
        const store = makeStore(refreshStub(rotateOk).fn);
        await writeCredentialsFile(credentialsPath, CREDS, 0); // legacy snapshot
        const migrated = {
          ...CREDS,
          token: "migrated",
          refreshToken: "rt-mig",
        };
        chmodSync(workDir, 0o500);
        const failed = await store.guardedSignIn({
          credentials: migrated,
          expectedFile: CREDS,
          signal: null,
        });
        expect(failed.outcome).toBe("commit-failed");
        store.dispose();
        // Disk still holds the legacy pair, but read() surfaces the minted one.
        expect((await readCredentialsFile(credentialsPath))?.token).toBe(
          CREDS.token,
        );
        expect((await store.read())?.token).toBe("migrated");
      },
    );
  });

  describe("malformed sidecar", () => {
    it("fails closed for an automatic rotate but lets an interactive signIn rebuild", async () => {
      const store = makeStore(refreshStub(rotateOk).fn);
      await seedSignedIn(store);
      writeFileSync(metaPath, "not json at all");
      await expect(
        store.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        }),
      ).rejects.toThrow();
      // Interactive signIn rebuilds the sidecar and proceeds.
      const back = await store.signIn(
        { ...CREDS, token: "rebuilt" },
        false,
        null,
      );
      expect(back.outcome).toBe("applied");
    });
  });

  describe("commit-failed continuation (read-only parent dir)", () => {
    it.skipIf(!canForceCommitFailure)(
      "overlays the minted pair on read, then lands it on retry",
      async () => {
        // Freeze INSIDE the refresh (after the fail-closed marker arm and the
        // spend) so only the post-spend WAL write cannot land.
        const refresh = refreshStub((token) => {
          chmodSync(workDir, 0o500);
          return rotateOk(token);
        });
        const store = makeStore(refresh.fn);
        await seedSignedIn(store);
        const result = await store.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        });
        expect(result.outcome).toBe("commit-failed");
        expect(result.credentials?.token).toBe("tok-0::r");
        expect(store.hasPendingContinuation()).toBe(true);
        // Disk still holds the spent base, but read() overlays the minted pair.
        expect((await readCredentialsFile(credentialsPath))?.token).toBe(
          "tok-0",
        );
        expect((await store.read())?.token).toBe("tok-0::r");
        // Unfreeze and let the continuation land the pair.
        chmodSync(workDir, 0o700);
        const rerun = await store.signIn(CREDS, false, null);
        // (the interactive signIn's preamble drives the continuation first)
        expect(store.hasPendingContinuation()).toBe(false);
        expect(rerun.outcome).toBe("applied");
      },
    );

    it.skipIf(!canForceCommitFailure)(
      "R9: a rotate entered while a continuation is pending drives it first and never re-adopts the spent base",
      async () => {
        // Freeze once, inside the FIRST refresh only: the arm and spend land,
        // the commit fails, and the later rotate's refresh works unfrozen.
        let frozen = false;
        const refresh = refreshStub((token) => {
          if (!frozen) {
            frozen = true;
            chmodSync(workDir, 0o500);
          }
          return rotateOk(token);
        });
        const store = makeStore(refresh.fn);
        await seedSignedIn(store);
        const failed = await store.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        });
        expect(failed.outcome).toBe("commit-failed");
        const mintedToken = failed.credentials?.token ?? "";
        expect(mintedToken).toBe("tok-0::r");
        chmodSync(workDir, 0o700);
        // The scheduler now holds the minted token in memory and rotates again
        // with it as the expected base. The disk still has the spent base until
        // the continuation lands, so a naive raw CAS would read `superseded` and
        // adopt the spent base back. The first-gate rule must prevent that.
        const next = await store.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: mintedToken,
          refreshTokenOverride: null,
          signal: null,
        });
        expect(next.outcome).toBe("applied");
        expect(next.credentials?.token).toBe("tok-0::r::r");
        expect(store.hasPendingContinuation()).toBe(false);
      },
    );

    it.skipIf(!canForceCommitFailure)(
      "R9: a re-entered rotate is refused (commit-failed) while the continuation stays unresolved, never re-spending the base",
      async () => {
        // Freeze inside the refresh: the post-spend commit cannot land, and
        // the dir STAYS frozen so the continuation cannot resolve either.
        const refresh = refreshStub((token) => {
          chmodSync(workDir, 0o500);
          return rotateOk(token);
        });
        const store = makeStore(refresh.fn);
        await seedSignedIn(store);
        const first = await store.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        });
        expect(first.outcome).toBe("commit-failed");
        expect(refresh.calls()).toBe(1);
        // Dir stays frozen -> the continuation cannot resolve. A second rotate
        // must NOT run its body against the spent base on disk (which would
        // return `superseded` with the base, or re-spend it): it is refused as
        // commit-failed carrying the still-pending minted pair.
        const second = await store.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: "tok-0::r",
          refreshTokenOverride: null,
          signal: null,
        });
        expect(second.outcome).toBe("commit-failed");
        expect(second.credentials?.token).toBe("tok-0::r");
        expect(refresh.calls()).toBe(1); // no second spend
        expect(store.hasPendingContinuation()).toBe(true);
        chmodSync(workDir, 0o700); // afterEach also restores
      },
    );
  });

  describe("spent-base marker (cross-process double-spend gate)", () => {
    // The production path, not a local rebuild of the suffix: if this drifted,
    // every `existsSync(markerPath())` assertion below would hold against a
    // file nothing writes and the "marker is cleared" cases would go vacuous.
    function markerPath(): string {
      return spentBaseMarkerPath(credentialsPath);
    }

    function sha256(token: string): string {
      return createHash("sha256").update(token, "utf8").digest("hex");
    }

    // A marker as another LIVE process would have armed it: the vitest
    // parent's pid + real fingerprint, so the provably-dead probe sees a
    // living foreign owner.
    function writeForeignMarker(over: {
      readonly token: string;
      readonly ageMs: number;
    }): void {
      // Every deferral case below turns on this owner being a DIFFERENT live
      // process. If the runner ever gives a worker no distinguishable parent,
      // the marker would read as OUR OWN and the `spend-pending` assertions
      // would silently invert into "reclaimed and spent" - fail loudly instead.
      expect(process.ppid).not.toBe(process.pid);
      writeFileSync(
        markerPath(),
        JSON.stringify({
          spentTokenDigest: sha256(over.token),
          at: new Date(Date.now() - over.ageMs).toISOString(),
          ownerPid: process.ppid,
          ownerFingerprint: queryPidStartFingerprint(process.ppid),
        }),
        { mode: 0o600 },
      );
    }

    async function waitUntil(check: () => boolean): Promise<void> {
      const deadline = Date.now() + 3_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error("waitUntil timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    it("defers with spend-pending on a live foreign owner's fresh marker, spending nothing", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      await seedSignedIn(store);
      writeForeignMarker({ token: CREDS.token, ageMs: 0 });

      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });

      expect(result.outcome).toBe("spend-pending");
      expect(stub.calls()).toBe(0);
      // The marker survives - the owner still needs it.
      expect(existsSync(markerPath())).toBe(true);
    });

    it("reclaims a foreign marker past the TTL and spends", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      await seedSignedIn(store);
      writeForeignMarker({ token: CREDS.token, ageMs: 61_000 });

      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });

      expect(result.outcome).toBe("applied");
      expect(stub.calls()).toBe(1);
      expect(existsSync(markerPath())).toBe(false);
    });

    it("reclaims a provably-dead owner's marker immediately", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      await seedSignedIn(store);
      // A pid that cannot be a live process paired with a real-shaped record.
      writeFileSync(
        markerPath(),
        JSON.stringify({
          spentTokenDigest: sha256(CREDS.token),
          at: new Date().toISOString(),
          ownerPid: 2 ** 22 - 7,
          ownerFingerprint: "long-gone",
        }),
        { mode: 0o600 },
      );

      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });

      expect(result.outcome).toBe("applied");
      expect(stub.calls()).toBe(1);
    });

    it("ignores an orphaned marker for a superseded base", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      await seedSignedIn(store);
      writeForeignMarker({ token: "some-older-token", ageMs: 0 });

      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });

      expect(result.outcome).toBe("applied");
      expect(stub.calls()).toBe(1);
      expect(existsSync(markerPath())).toBe(false);
    });

    it("keeps its own marker armed across a network-ambiguous refresh, without self-blocking the retry", async () => {
      let mode: "network" | "ok" = "network";
      const stub = refreshStub((token) =>
        mode === "network" ? { kind: "network-error" } : rotateOk(token),
      );
      const store = makeStore(stub.fn);
      await seedSignedIn(store);

      const first = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });
      expect(first.outcome).toBe("refresh-network");
      // The ambiguous spend leaves the marker guarding the base for siblings.
      expect(existsSync(markerPath())).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath(), "utf8")) as {
        spentTokenDigest: string;
        ownerPid: number;
      };
      expect(marker.spentTokenDigest).toBe(sha256(CREDS.token));
      expect(marker.ownerPid).toBe(process.pid);

      // The owner's own retry is not blocked by its own marker.
      mode = "ok";
      const second = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });
      expect(second.outcome).toBe("applied");
      expect(stub.calls()).toBe(2);
      expect(existsSync(markerPath())).toBe(false);
    });

    it("clears the marker on an explicit refresh rejection", async () => {
      const stub = refreshStub(() => ({ kind: "rejected" }));
      const store = makeStore(stub.fn);
      await seedSignedIn(store);

      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });

      expect(result.outcome).toBe("refresh-rejected");
      expect(existsSync(markerPath())).toBe(false);
    });

    it("a landed interactive sign-in clears any marker", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      await seedSignedIn(store);
      writeForeignMarker({ token: CREDS.token, ageMs: 0 });

      await seedSignedIn(store);

      expect(existsSync(markerPath())).toBe(false);
    });

    it("a future-dated foreign marker still defers (liveness dominates a clock step)", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      await seedSignedIn(store);
      // `at` 30s in the future: a backward clock step between the owner's
      // write and this read. The owner is live, so the spend must still defer.
      writeForeignMarker({ token: CREDS.token, ageMs: -30_000 });

      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });

      expect(result.outcome).toBe("spend-pending");
      expect(stub.calls()).toBe(0);
    });

    it("treats a torn marker as no marker (a crash mid-write precedes any spend)", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      await seedSignedIn(store);
      writeFileSync(markerPath(), '{"spentTokenDigest": "tru', { mode: 0o600 });

      const result = await store.rotate({
        expectedUserId: CREDS.user.id,
        expectedToken: CREDS.token,
        refreshTokenOverride: null,
        signal: null,
      });

      expect(result.outcome).toBe("applied");
      expect(stub.calls()).toBe(1);
    });

    it("fails closed when a marker exists but cannot be read", async () => {
      const stub = refreshStub(rotateOk);
      const store = makeStore(stub.fn);
      await seedSignedIn(store);
      // A directory at the marker path: readFile faults (EISDIR), proving
      // nothing about a sibling's in-flight spend - so no spend may proceed.
      mkdirSync(markerPath());

      await expect(
        store.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        }),
      ).rejects.toBeInstanceOf(CredentialsStoreUnavailableError);
      expect(stub.calls()).toBe(0);
      expect((await readCredentialsFile(credentialsPath))?.token).toBe(
        CREDS.token,
      );
    });

    it.runIf(canForceCommitFailure)(
      "refuses to spend when the marker cannot be armed (fail-closed canary)",
      async () => {
        const stub = refreshStub(rotateOk);
        const store = makeStore(stub.fn);
        await seedSignedIn(store);
        // Freeze the credentials+meta dir BEFORE the rotate: the arm write is
        // the first mutation to hit it, and must refuse the spend outright -
        // a store that cannot record the spend would also fail the commit.
        chmodSync(workDir, 0o500);

        await expect(
          store.rotate({
            expectedUserId: CREDS.user.id,
            expectedToken: CREDS.token,
            refreshTokenOverride: null,
            signal: null,
          }),
        ).rejects.toBeInstanceOf(CredentialsStoreUnavailableError);
        expect(stub.calls()).toBe(0);

        chmodSync(workDir, 0o700);
        expect((await readCredentialsFile(credentialsPath))?.token).toBe(
          CREDS.token,
        );
      },
    );

    describe("migration spends under the same marker protocol", () => {
      const MIGRATED_IDENTITY = {
        id: "u2",
        email: "grace@traycer.ai",
        name: "Grace",
      };
      const CANDIDATE = {
        token: "cand-tok",
        refreshToken: "cand-rt",
      };

      it("defers with spend-pending on a live foreign migrator's candidate marker, spending nothing", async () => {
        const stub = refreshStub(rotateOk);
        const store = makeStore(stub.fn);
        writeForeignMarker({ token: CANDIDATE.token, ageMs: 0 });

        const result = await store.migrateFirstWrite({
          candidate: CANDIDATE,
          identity: MIGRATED_IDENTITY,
          expectedFile: null,
          signal: null,
        });

        expect(result.outcome).toBe("spend-pending");
        expect(stub.calls()).toBe(0);
        expect(existsSync(markerPath())).toBe(true);
      });

      it("defers on a live foreign marker for the FILE's base pair (an in-flight rotate)", async () => {
        const stub = refreshStub(rotateOk);
        const store = makeStore(stub.fn);
        await seedSignedIn(store);
        writeForeignMarker({ token: CREDS.token, ageMs: 0 });

        const result = await store.migrateFirstWrite({
          candidate: CANDIDATE,
          identity: MIGRATED_IDENTITY,
          expectedFile: CREDS,
          signal: null,
        });

        expect(result.outcome).toBe("spend-pending");
        expect(stub.calls()).toBe(0);
      });

      it("keeps its marker armed across a network-ambiguous spend; a sibling migrator defers", async () => {
        const storeA = makeStore(
          refreshStub(() => ({ kind: "network-error" })).fn,
        );
        const ambiguous = await storeA.migrateFirstWrite({
          candidate: CANDIDATE,
          identity: MIGRATED_IDENTITY,
          expectedFile: null,
          signal: null,
        });
        expect(ambiguous.outcome).toBe("refresh-network");
        // The candidate may have been consumed server-side: the marker stays.
        const marker = JSON.parse(readFileSync(markerPath(), "utf8")) as {
          spentTokenDigest: string;
          ownerPid: number;
        };
        expect(marker.spentTokenDigest).toBe(sha256(CANDIDATE.token));
        expect(marker.ownerPid).toBe(process.pid);

        // Sibling-process view (in-process stores share our pid, so re-stamp
        // the owner as the live parent), then a competing migration.
        writeForeignMarker({ token: CANDIDATE.token, ageMs: 0 });
        const stubB = refreshStub(rotateOk);
        const storeB = makeStore(stubB.fn);
        const deferred = await storeB.migrateFirstWrite({
          candidate: CANDIDATE,
          identity: MIGRATED_IDENTITY,
          expectedFile: null,
          signal: null,
        });
        expect(deferred.outcome).toBe("spend-pending");
        expect(stubB.calls()).toBe(0);
      });

      it.runIf(canForceCommitFailure)(
        "holds the marker through a commit failure and releases it when the continuation lands",
        async () => {
          const store = makeStore(
            refreshStub((token) => {
              chmodSync(workDir, 0o500);
              return rotateOk(token);
            }).fn,
          );
          const failed = await store.migrateFirstWrite({
            candidate: CANDIDATE,
            identity: MIGRATED_IDENTITY,
            expectedFile: null,
            signal: null,
          });
          expect(failed.outcome).toBe("commit-failed");
          expect(store.hasPendingContinuation()).toBe(true);
          // Armed before the freeze; guards the spent candidate for siblings.
          expect(existsSync(markerPath())).toBe(true);

          chmodSync(workDir, 0o700);
          // Wait on the marker too, not just the flag: the continuation clears
          // `pending` BEFORE it awaits the marker unlink (both still under the
          // lock, so no other process can observe the gap - but this in-process
          // reader can, and did, flakily).
          await waitUntil(
            () => !store.hasPendingContinuation() && !existsSync(markerPath()),
          );
          expect((await readCredentialsFile(credentialsPath))?.token).toBe(
            "cand-tok::r",
          );
        },
      );
    });

    it.runIf(canForceCommitFailure)(
      "arms the marker through a post-spend commit failure; a foreign owner defers; the landed continuation releases it",
      async () => {
        const stubA = refreshStub((token) => {
          // Freeze the credentials+meta dir AFTER the marker is armed and the
          // spend has happened, so only the WAL commit fails.
          chmodSync(workDir, 0o500);
          return rotateOk(token);
        });
        // Park the automatic retry. `driveContinuation()` takes the same lock B's
        // observe needs; under parallel load that hold outlives B's 500ms
        // wait and the pin reads `lock-busy` instead of the marker gate.
        // `continuationRetryMs` is the injected test hook; we drive the
        // parked continuation explicitly after the sibling observe.
        const storeA = createCredentialsMutationStore({
          paths: { credentialsPath, metaPath, lockPath },
          refresh: stubA.fn,
          lockWaitMs: 500,
          lockPollIntervalMs: 25,
          continuationRetryMs: 60_000,
        });
        stores.push(storeA);
        await seedSignedIn(storeA);

        const failed = await storeA.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        });
        expect(failed.outcome).toBe("commit-failed");
        expect(storeA.hasPendingContinuation()).toBe(true);
        // The marker landed BEFORE the freeze and guards the spent base.
        expect(existsSync(markerPath())).toBe(true);

        // Simulate the sibling-PROCESS view: in-process, store B shares our
        // pid, so re-stamp the marker's owner as the (live) parent process.
        chmodSync(workDir, 0o700);
        writeForeignMarker({ token: CREDS.token, ageMs: 0 });
        chmodSync(workDir, 0o500);

        const stubB = refreshStub(rotateOk);
        const storeB = makeStore(stubB.fn);
        const deferred = await storeB.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        });
        expect(deferred.outcome).toBe("spend-pending");
        expect(stubB.calls()).toBe(0);

        // Unfreeze and land A's parked continuation under the lock preamble.
        // Rotate against the spent base: land first, then the body sees the
        // successor and returns superseded - no second spend. After this
        // returns, `pending` and the marker are both gone (no timer race).
        chmodSync(workDir, 0o700);
        const landed = await storeA.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        });
        expect(storeA.hasPendingContinuation()).toBe(false);
        expect(existsSync(markerPath())).toBe(false);
        expect(landed.outcome).toBe("superseded");
        expect(landed.credentials?.token).toBe(`${CREDS.token}::r`);
        expect(stubA.calls()).toBe(1);

        const adopted = await storeB.rotate({
          expectedUserId: CREDS.user.id,
          expectedToken: CREDS.token,
          refreshTokenOverride: null,
          signal: null,
        });
        expect(adopted.outcome).toBe("superseded");
        expect(stubB.calls()).toBe(0);
        expect(adopted.credentials?.token).toBe(`${CREDS.token}::r`);
      },
    );
  });
});
