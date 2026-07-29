import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  commitMutation,
  defaultSidecarState,
  digestCredentials,
  hasTombstone,
  readSidecar,
  recoverPending,
  runInitGate,
  writeSidecarState,
  type CommitOutcome,
  type CommitPaths,
  type PendingRecord,
  type SidecarState,
} from "../credentials-wal";

const CREDS: StoredCredentials = {
  token: "access-token",
  refreshToken: "refresh-token",
  authnBaseUrl: "http://localhost:21001",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
};

function committed(out: CommitOutcome): {
  state: SidecarState;
  mtimeMs: number | null;
} {
  if (out.kind !== "committed") {
    throw new Error(`expected committed, got ${out.kind}`);
  }
  return { state: out.state, mtimeMs: out.mtimeMs };
}

describe("credentials WAL", () => {
  let workDir: string;
  let paths: CommitPaths;
  let lockPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "traycer-cred-wal-test-"));
    paths = {
      credentialsPath: join(workDir, "credentials"),
      metaPath: join(workDir, "credentials.meta.json"),
    };
    lockPath = join(workDir, "credentials.lock");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe("digestCredentials", () => {
    it("matches the exact bytes the write primitive lands", async () => {
      await writeCredentialsFile(paths.credentialsPath, CREDS, 0);
      const onDisk = readFileSync(paths.credentialsPath, "utf8");
      const { createHash } = await import("node:crypto");
      expect(digestCredentials(CREDS)).toBe(
        createHash("sha256").update(onDisk).digest("hex"),
      );
    });
  });

  describe("readSidecar", () => {
    it("reports missing when absent", async () => {
      expect(await readSidecar(paths.metaPath)).toEqual({ kind: "missing" });
    });

    it("reports malformed on unparseable content", async () => {
      writeFileSync(paths.metaPath, "not json");
      expect(await readSidecar(paths.metaPath)).toEqual({ kind: "malformed" });
    });

    it("reports malformed for valid JSON with an out-of-range mtime floor", async () => {
      // Correct field types, but a floor no Date can represent: it must fail
      // closed here, not parse `present` and later break at utimes post-spend.
      writeFileSync(
        paths.metaPath,
        JSON.stringify({
          epoch: 0,
          lastMutation: null,
          mtimeFloorMs: 1e300,
          pending: null,
        }),
      );
      expect(await readSidecar(paths.metaPath)).toEqual({ kind: "malformed" });
    });

    it("reports malformed for an mtime floor inside the max-Date bump headroom", async () => {
      // The top 16s below max-Date must be rejected: a validated floor plus the
      // largest post-parse bump (bumpMtimeAbove escalates up to 16s) would
      // otherwise overflow Date and fault at utimes AFTER a spend.
      writeFileSync(
        paths.metaPath,
        JSON.stringify({
          epoch: 0,
          lastMutation: null,
          mtimeFloorMs: 8_640_000_000_000_000,
          pending: null,
        }),
      );
      expect(await readSidecar(paths.metaPath)).toEqual({ kind: "malformed" });
    });

    it("reports malformed for a non-integer epoch", async () => {
      writeFileSync(
        paths.metaPath,
        JSON.stringify({
          epoch: 1.5,
          lastMutation: null,
          mtimeFloorMs: 0,
          pending: null,
        }),
      );
      expect(await readSidecar(paths.metaPath)).toEqual({ kind: "malformed" });
    });

    it("reports malformed for a write pending missing its target digest", async () => {
      writeFileSync(
        paths.metaPath,
        JSON.stringify({
          epoch: 0,
          lastMutation: null,
          mtimeFloorMs: 0,
          pending: {
            op: "signIn",
            nextEpoch: 1,
            targetDigest: null,
            floorCandidate: 0,
          },
        }),
      );
      expect(await readSidecar(paths.metaPath)).toEqual({ kind: "malformed" });
    });

    it("reports malformed for a sign-out pending carrying a spurious digest", async () => {
      writeFileSync(
        paths.metaPath,
        JSON.stringify({
          epoch: 0,
          lastMutation: null,
          mtimeFloorMs: 0,
          pending: {
            op: "signOut",
            nextEpoch: 1,
            targetDigest: "deadbeef",
            floorCandidate: 0,
          },
        }),
      );
      expect(await readSidecar(paths.metaPath)).toEqual({ kind: "malformed" });
    });

    it("round-trips a written state", async () => {
      const state = defaultSidecarState(0);
      await writeSidecarState(paths.metaPath, state);
      expect(await readSidecar(paths.metaPath)).toEqual({
        kind: "present",
        state,
      });
    });
  });

  describe("hasTombstone", () => {
    it("is true for a committed sign-out and a pending sign-out", () => {
      expect(
        hasTombstone({
          epoch: 1,
          lastMutation: "signOut",
          mtimeFloorMs: 0,
          pending: null,
        }),
      ).toBe(true);
      expect(
        hasTombstone({
          epoch: 0,
          lastMutation: "signIn",
          mtimeFloorMs: 0,
          pending: {
            op: "signOut",
            nextEpoch: 1,
            targetDigest: null,
            floorCandidate: 0,
          },
        }),
      ).toBe(true);
    });

    it("is false for a live session and a fresh sidecar", () => {
      expect(
        hasTombstone({
          epoch: 1,
          lastMutation: "signIn",
          mtimeFloorMs: 0,
          pending: null,
        }),
      ).toBe(false);
      expect(hasTombstone(defaultSidecarState(0))).toBe(false);
    });
  });

  describe("commitMutation", () => {
    it("signIn writes F and finalizes with a fresh epoch", async () => {
      const out = committed(
        await commitMutation({
          paths,
          op: "signIn",
          target: { kind: "write", credentials: CREDS },
          currentState: defaultSidecarState(0),
        }),
      );
      expect(out.state).toMatchObject({
        epoch: 1,
        lastMutation: "signIn",
        pending: null,
      });
      expect(out.mtimeMs).not.toBeNull();
      expect(await readCredentialsFile(paths.credentialsPath)).toEqual(CREDS);
      expect(await readSidecar(paths.metaPath)).toEqual({
        kind: "present",
        state: out.state,
      });
    });

    it("rotate keeps the epoch and preserves the session", async () => {
      const signedIn = committed(
        await commitMutation({
          paths,
          op: "signIn",
          target: { kind: "write", credentials: CREDS },
          currentState: defaultSidecarState(0),
        }),
      );
      const rotated = committed(
        await commitMutation({
          paths,
          op: "rotate",
          target: { kind: "write", credentials: { ...CREDS, token: "rot" } },
          currentState: signedIn.state,
        }),
      );
      expect(rotated.state.epoch).toBe(signedIn.state.epoch);
      expect(rotated.state.lastMutation).toBe("rotate");
    });

    it("signOut deletes F and lands a tombstone at a fresh epoch", async () => {
      const signedIn = committed(
        await commitMutation({
          paths,
          op: "signIn",
          target: { kind: "write", credentials: CREDS },
          currentState: defaultSidecarState(0),
        }),
      );
      const out = committed(
        await commitMutation({
          paths,
          op: "signOut",
          target: { kind: "delete" },
          currentState: signedIn.state,
        }),
      );
      expect(out.state.epoch).toBe(signedIn.state.epoch + 1);
      expect(out.state.lastMutation).toBe("signOut");
      expect(out.mtimeMs).toBeNull();
      expect(hasTombstone(out.state)).toBe(true);
      expect(await readCredentialsFile(paths.credentialsPath)).toBeNull();
    });

    it("keeps the mtime floor strictly increasing across signIn -> signOut -> signIn", async () => {
      const first = committed(
        await commitMutation({
          paths,
          op: "signIn",
          target: { kind: "write", credentials: CREDS },
          currentState: defaultSidecarState(0),
        }),
      );
      const out = committed(
        await commitMutation({
          paths,
          op: "signOut",
          target: { kind: "delete" },
          currentState: first.state,
        }),
      );
      const recreated = committed(
        await commitMutation({
          paths,
          op: "signIn",
          target: { kind: "write", credentials: CREDS },
          currentState: out.state,
        }),
      );
      expect(first.mtimeMs).not.toBeNull();
      expect(recreated.mtimeMs).not.toBeNull();
      // The recreated file outranks the deleted one, so the host owner cache
      // cannot serve a stale owner after a sign-out/sign-in.
      expect(recreated.mtimeMs ?? 0).toBeGreaterThan(first.mtimeMs ?? 0);
    });
  });

  describe("recoverPending", () => {
    it("completes a pending sign-out with F present, carrying the floor", async () => {
      await writeCredentialsFile(paths.credentialsPath, CREDS, 0);
      const state: SidecarState = {
        epoch: 3,
        lastMutation: "signIn",
        mtimeFloorMs: 100,
        pending: {
          op: "signOut",
          nextEpoch: 4,
          targetDigest: null,
          floorCandidate: 12345,
        },
      };
      const recovered = await recoverPending({ paths, state });
      expect(recovered).toEqual({
        epoch: 4,
        lastMutation: "signOut",
        mtimeFloorMs: 12345,
        pending: null,
      });
      expect(await readCredentialsFile(paths.credentialsPath)).toBeNull();
    });

    it("completes a pending sign-out with F already absent (no throw)", async () => {
      const state: SidecarState = {
        epoch: 3,
        lastMutation: null,
        mtimeFloorMs: 0,
        pending: {
          op: "signOut",
          nextEpoch: 4,
          targetDigest: null,
          floorCandidate: 999,
        },
      };
      const recovered = await recoverPending({ paths, state });
      expect(recovered.lastMutation).toBe("signOut");
      expect(recovered.mtimeFloorMs).toBe(999);
      expect(recovered.pending).toBeNull();
    });

    it("finalizes a pending write whose apply landed (F matches the digest)", async () => {
      await writeCredentialsFile(paths.credentialsPath, CREDS, 0);
      const state: SidecarState = {
        epoch: 0,
        lastMutation: null,
        mtimeFloorMs: 0,
        pending: {
          op: "signIn",
          nextEpoch: 1,
          targetDigest: digestCredentials(CREDS),
          floorCandidate: 0,
        },
      };
      const recovered = await recoverPending({ paths, state });
      expect(recovered.epoch).toBe(1);
      expect(recovered.lastMutation).toBe("signIn");
      expect(recovered.pending).toBeNull();
      expect(await readCredentialsFile(paths.credentialsPath)).toEqual(CREDS);
    });

    it("rolls back a pending write whose apply never landed (F absent)", async () => {
      const state: SidecarState = {
        epoch: 2,
        lastMutation: "signOut",
        mtimeFloorMs: 0,
        pending: {
          op: "signIn",
          nextEpoch: 3,
          targetDigest: digestCredentials(CREDS),
          floorCandidate: 0,
        },
      };
      const recovered = await recoverPending({ paths, state });
      // Rollback preserves the committed base (the tombstone stands), not
      // nextEpoch, and does not resurrect a session.
      expect(recovered.epoch).toBe(2);
      expect(recovered.lastMutation).toBe("signOut");
      expect(recovered.pending).toBeNull();
    });

    it("rolls back a pending write whose F holds different bytes (digest mismatch)", async () => {
      await writeCredentialsFile(
        paths.credentialsPath,
        { ...CREDS, token: "other" },
        0,
      );
      const state: SidecarState = {
        epoch: 2,
        lastMutation: null,
        mtimeFloorMs: 0,
        pending: {
          op: "signIn",
          nextEpoch: 3,
          targetDigest: digestCredentials(CREDS),
          floorCandidate: 0,
        },
      };
      const recovered = await recoverPending({ paths, state });
      expect(recovered.epoch).toBe(2);
      expect(recovered.pending).toBeNull();
    });

    it("restores absence on a digest mismatch under a committed sign-out (no resurrection)", async () => {
      // Committed base is a sign-out (F must be absent), but a stale/foreign
      // writer left a *different* valid file mid sign-in. Recovery must delete F
      // so the sidecar-blind host cannot adopt it and undo the logout.
      await writeCredentialsFile(
        paths.credentialsPath,
        { ...CREDS, token: "stray" },
        0,
      );
      const strayMtime = statSync(paths.credentialsPath).mtimeMs;
      const state: SidecarState = {
        epoch: 5,
        lastMutation: "signOut",
        mtimeFloorMs: 0,
        pending: {
          op: "signIn",
          nextEpoch: 6,
          targetDigest: digestCredentials(CREDS),
          floorCandidate: 0,
        },
      };
      const recovered = await recoverPending({ paths, state });
      expect(recovered.lastMutation).toBe("signOut");
      expect(recovered.epoch).toBe(5); // committed base kept, not nextEpoch
      expect(recovered.pending).toBeNull();
      expect(await readCredentialsFile(paths.credentialsPath)).toBeNull();
      // The floor is carried above the stray file's mtime so a later sign-in
      // still outranks it for the host owner cache.
      expect(recovered.mtimeFloorMs).toBeGreaterThanOrEqual(strayMtime);
    });
  });

  describe("runInitGate", () => {
    const gate = (waitMs: number) =>
      runInitGate({ paths, lockPath, waitMs, pollIntervalMs: 25 });

    it("is ready and completes recovery when the lock is free", async () => {
      await writeCredentialsFile(paths.credentialsPath, CREDS, 0);
      const pending: PendingRecord = {
        op: "signIn",
        nextEpoch: 1,
        targetDigest: digestCredentials(CREDS),
        floorCandidate: 0,
      };
      await writeSidecarState(paths.metaPath, {
        epoch: 0,
        lastMutation: null,
        mtimeFloorMs: 0,
        pending,
      });
      expect(await gate(200)).toBe("ready");
      const read = await readSidecar(paths.metaPath);
      expect(read).toMatchObject({
        kind: "present",
        state: { pending: null, epoch: 1 },
      });
    });

    it("defers recovery when a live holder keeps the lock", async () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, acquisitionNonce: "held" }),
      );
      expect(await gate(100)).toBe("recovery-deferred");
    });

    it("reports unavailable on an I/O failure under the lock", async () => {
      // A directory at the sidecar path makes readSidecar throw (EISDIR).
      mkdirSync(paths.metaPath, { recursive: true });
      expect(await gate(200)).toBe("unavailable");
    });
  });
});
