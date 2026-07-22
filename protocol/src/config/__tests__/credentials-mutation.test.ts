import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  type CredentialsMutationStore,
  type RefreshFn,
  type RefreshResult,
} from "../credentials-mutation";
import { writeSidecarState } from "../credentials-wal";

const CREDS: StoredCredentials = {
  token: "tok-0",
  refreshToken: "rt-0",
  authnBaseUrl: "http://localhost:21001",
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
      const back = await store.signIn({ ...CREDS, token: "tok-2" }, false, null);
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
      expect(
        (await readCredentialsFile(credentialsPath))?.refreshToken,
      ).toBe("");
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
      authnBaseUrl: "http://localhost:21001",
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
        authnBaseUrl: CANDIDATE.authnBaseUrl,
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
        const store = makeStore(refreshStub(rotateOk).fn);
        chmodSync(workDir, 0o500); // freeze: the post-spend commit cannot land
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
      const back = await store.signIn({ ...CREDS, token: "rebuilt" }, false, null);
      expect(back.outcome).toBe("applied");
    });
  });

  describe("commit-failed continuation (read-only parent dir)", () => {
    it.skipIf(!canForceCommitFailure)(
      "overlays the minted pair on read, then lands it on retry",
      async () => {
        const refresh = refreshStub(rotateOk);
        const store = makeStore(refresh.fn);
        await seedSignedIn(store);
        // Freeze the directory so the post-spend WAL write cannot land.
        chmodSync(workDir, 0o500);
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
        const refresh = refreshStub(rotateOk);
        const store = makeStore(refresh.fn);
        await seedSignedIn(store);
        chmodSync(workDir, 0o500);
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
        const refresh = refreshStub(rotateOk);
        const store = makeStore(refresh.fn);
        await seedSignedIn(store);
        chmodSync(workDir, 0o500); // freeze: the post-spend commit cannot land
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
});
