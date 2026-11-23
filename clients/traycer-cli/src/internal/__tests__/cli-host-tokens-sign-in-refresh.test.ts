import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutableBearerLease } from "../../../../shared/auth/bearer-source";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import type {
  HostTokenMintOutcome,
  HostTokenSource,
} from "../../../../shared/auth/host-token-source";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { Environment } from "../../runner/environment";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../../store/credentials-store";
import { createCliHostTokens } from "../cli-host-tokens";
import type { SignInRotationResult } from "../../store/credentials-store";

// The real token path (`createCliHostTokens`: its single-flight mints, its
// recovery and its sign-in judge) against a fake authn, whose first mint is held
// and answered by the test, and a fake credentials refresh that counts its
// rotations and rotates the lease as the credentials store does.

const USER_ID = "user-1";
const SIGN_IN_A = "sign-in-a";
const SIBLING_SIGN_IN = "sign-in-sibling";
const ROTATED_SIGN_IN = "sign-in-rotated";
const REFRESHED_SIGN_IN = "sign-in-refreshed";

const harness = vi.hoisted(() => ({
  /** Every mint request authn was sent, the first held until the test answers it. */
  mints: [] as Array<{
    readonly hostId: string;
    readonly signIn: string;
    readonly signal: AbortSignal;
    readonly answer: (outcome: HostTokenMintOutcome) => void;
  }>,
  table: new Map() as HostTokenTable,
  /** How many of the first mint requests are held; every later one is answered ok. */
  hold: 1,
}));

const credentialsFile = vi.hoisted(() => ({
  /** The credentials file under test; empty until a test points the store at its own directory. */
  path: "",
  /** The sign-ins authn's refresh hands out, in the order asked. */
  refreshed: [] as string[],
}));

const createdSources = vi.hoisted(() => [] as HostTokenSource[]);

vi.mock("../../../../shared/auth/host-token-source", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/host-token-source")
    >();
  return {
    ...actual,
    createHostTokenSource: (
      options: Parameters<typeof actual.createHostTokenSource>[0],
    ): HostTokenSource => {
      const source = actual.createHostTokenSource(options);
      createdSources.push(source);
      return source;
    },
  };
});

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    cliCredentialsPath: (environment: Environment): string => {
      if (credentialsFile.path === "")
        throw new Error("no credentials file under test");
      return credentialsFile.path;
    },
  };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return {
    ...actual,
    refreshOnceAbortable: async (): Promise<{
      readonly kind: "refreshed";
      readonly token: string;
      readonly refreshToken: string;
    }> => {
      const token = credentialsFile.refreshed.shift();
      if (token === undefined)
        throw new Error("authn was asked for a refresh no test expected");
      return { kind: "refreshed", token, refreshToken: `rt-${token}` };
    },
  };
});

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => harness.table,
    update: async (change: (table: HostTokenTable) => HostTokenTable) => {
      harness.table = change(harness.table);
      return harness.table;
    },
  }),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/remote/grant-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/grant-client")
      >();
    return {
      ...actual,
      mintHostTokenViaHttp: (
        _authnBaseUrl: string,
        hostId: string,
        signIn: string,
        signal: AbortSignal,
      ): Promise<HostTokenMintOutcome> =>
        new Promise<HostTokenMintOutcome>((resolve) => {
          const held = harness.mints.length < harness.hold;
          harness.mints.push({ hostId, signIn, signal, answer: resolve });
          if (!held)
            resolve({
              kind: "ok",
              token: {
                token: `host-token-${harness.mints.length}`,
                expiresAtMs: Date.now() + 3_600_000,
              },
            });
        }),
    };
  },
);

let hostCount = 0;
let hostId = "";

beforeEach(() => {
  harness.mints.splice(0);
  harness.hold = 1;
  createdSources.splice(0);
  harness.table = new Map();
  hostCount += 1;
  // A host process's flights and memory are kept per host id.
  hostId = `55555555-5555-4555-8555-${String(hostCount).padStart(12, "0")}`;
  processReleasedHosts.forgetAll();
});

afterEach(() => {
  processReleasedHosts.forgetAll();
});

/** The credentials refresh: each call is one rotation, and rotates the lease to the next sign-in. */
function countingRefresh(lease: MutableBearerLease): {
  readonly refresh: () => Promise<SignInRotationResult>;
  readonly rotations: () => number;
  readonly rotatedTo: (rotation: number) => string;
} {
  let rotations = 0;
  const rotatedTo = (rotation: number): string => `sign-in-rotated-${rotation}`;
  return {
    refresh: async () => {
      rotations += 1;
      lease.rotate(rotatedTo(rotations));
      return { outcome: "rotated", installed: rotatedTo(rotations) };
    },
    rotations: () => rotations,
    rotatedTo,
  };
}

describe("a mint refusal's recovery refreshes only the sign-in it was refused for", () => {
  it("ends holding the sign-in a foreground recovery saved, with exactly one rotation, when the background mint's refusal of the earlier sign-in arrives late", async () => {
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const credentials = countingRefresh(lease);
    const tokens = createCliHostTokens({
      lease,
      refresh: credentials.refresh,
      adoptStored: async () => undefined,
      signal: null,
    });
    await tokens.whenLoaded();
    // A background mint is sent on sign-in A.
    const background = tokens.hostBearerFor(hostId, true);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));
    expect(harness.mints[0]?.signIn).toBe(SIGN_IN_A);

    // A foreground recovery then refreshes and saves B.
    await expect(tokens.refreshSignIn()).resolves.toBe("rotated");
    expect(lease.getBearerToken()).toBe(credentials.rotatedTo(1));

    // The background mint's refusal of A arrives late.
    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    await background;

    expect(credentials.rotations()).toBe(1);
    expect(lease.getBearerToken()).toBe(credentials.rotatedTo(1));
    for (const mint of harness.mints)
      expect([SIGN_IN_A, credentials.rotatedTo(1)]).toContain(mint.signIn);
  });

  it("retries on the sign-in now stored, spending no rotation and judging nothing, when a sibling rotated it while the mint was held", async () => {
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const credentials = countingRefresh(lease);
    const tokens = createCliHostTokens({
      lease,
      refresh: credentials.refresh,
      adoptStored: async () => undefined,
      signal: null,
    });
    await tokens.whenLoaded();
    const minting = tokens.hostBearerFor(hostId, true);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));
    // Another session or the desktop rotated the stored sign-in meanwhile.
    lease.rotate(SIBLING_SIGN_IN);

    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    const bearer = await minting;

    expect(credentials.rotations()).toBe(0);
    expect(harness.mints.map((mint) => mint.signIn)).toEqual([
      SIGN_IN_A,
      SIBLING_SIGN_IN,
    ]);
    expect(bearer).not.toBeNull();
    expect(tokens.signInRejected()).toBe(false);
  });
});

describe("a mint refusal's recovery belongs to the session that started it", () => {
  it("starts no rotation and no second mint when the refusal arrives after the session ended, though the session's signal is live", async () => {
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const credentials = countingRefresh(lease);
    // A command whose signal outlives the call, as a give's budget does.
    const commandSignal = new AbortController();
    const tokens = createCliHostTokens({
      lease,
      refresh: credentials.refresh,
      adoptStored: async () => undefined,
      signal: commandSignal.signal,
    });
    await tokens.whenLoaded();
    // The call asks without waiting; its mint is sent and held.
    await tokens.hostBearerFor(hostId, false);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));
    // The session ends. The mint's own signal is the command's, so it stays in flight.
    tokens.dispose();
    // The mint still running, joined, is the point at which its recovery has finished.
    const finished = tokens.hostBearerFor(hostId, true);

    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    await finished;

    expect(credentials.rotations()).toBe(0);
    expect(harness.mints).toHaveLength(1);
  });
});

describe("a refusal of a sign-in that is no longer the stored one judges nothing", () => {
  it("records no rejection, reports nothing and retries on the stored sign-in when a late 401 for the earlier sign-in follows an accepted refresh", async () => {
    // The retry is held too, so what the late 401 recorded is read while it is pending.
    harness.hold = 2;
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const credentials = countingRefresh(lease);
    const tokens = createCliHostTokens({
      lease,
      refresh: credentials.refresh,
      adoptStored: async () => undefined,
      signal: null,
    });
    await tokens.whenLoaded();
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });
    // A refresh is accepted: the next 401 would normally judge the sign-in.
    await expect(tokens.refreshSignIn()).resolves.toBe("rotated");
    // A mint is sent on the sign-in held now, and held; a sibling then moves the lease on.
    const sentOn = lease.getBearerToken();
    const minting = tokens.hostBearerFor(hostId, true);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));
    expect(harness.mints[0]?.signIn).toBe(sentOn);
    lease.rotate(SIBLING_SIGN_IN);

    // The late 401 for the sign-in no longer stored arrives.
    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    await vi.waitFor(() => expect(harness.mints).toHaveLength(2));

    // It judged nothing: no rejection is recorded against the stored sign-in,
    // nothing is reported, and nothing was refreshed beyond the accepted refresh.
    expect(tokens.signInRejected()).toBe(false);
    expect(reports).toEqual([]);
    expect(credentials.rotations()).toBe(1);
    // The one retry went out on the stored sign-in.
    expect(harness.mints[1]?.signIn).toBe(SIBLING_SIGN_IN);

    // Its success leaves nothing judged.
    harness.mints[1]?.answer({
      kind: "ok",
      token: { token: "host-token-b", expiresAtMs: Date.now() + 3_600_000 },
    });
    const bearer = await minting;
    expect(bearer).not.toBeNull();
    expect(tokens.signInRejected()).toBe(false);
    expect(reports).toEqual([]);
  });

  it("reports nothing final and asks once more on the stored sign-in when the retry after a rotation is refused for a sign-in a sibling has since replaced", async () => {
    harness.hold = 2;
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const credentials = countingRefresh(lease);
    const tokens = createCliHostTokens({
      lease,
      refresh: credentials.refresh,
      adoptStored: async () => undefined,
      signal: null,
    });
    await tokens.whenLoaded();
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });
    const minting = tokens.hostBearerFor(hostId, true);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));

    // The first mint is refused on A; the recovery refreshes to B and retries on B, held.
    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    await vi.waitFor(() => expect(harness.mints).toHaveLength(2));
    expect(harness.mints[1]?.signIn).toBe(credentials.rotatedTo(1));
    // While it is pending a sibling replaces the lease with C.
    lease.rotate(SIBLING_SIGN_IN);

    // The retry's 401 for B arrives.
    harness.mints[1]?.answer({ kind: "sign-in-rejected" });
    await minting;

    expect(reports).toEqual([]);
    expect(tokens.signInRejected()).toBe(false);
    // Once more, on C, with no further refresh.
    expect(harness.mints.map((mint) => mint.signIn)).toEqual([
      SIGN_IN_A,
      credentials.rotatedTo(1),
      SIBLING_SIGN_IN,
    ]);
    expect(credentials.rotations()).toBe(1);
  });

  it("judges nothing and refreshes the stored sign-in once when its own refusal follows a stale refusal of the sign-in our rotation produced", async () => {
    // The mints on A, on B (the retry) and on C are held; the one after C's refresh is answered.
    harness.hold = 3;
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const credentials = countingRefresh(lease);
    // The refresh of C is held where it starts, so what C's refusal recorded is read while it is pending.
    const refreshesStarted: number[] = [];
    const releaseRefreshOfC: { release: () => void } = {
      release: () => undefined,
    };
    const refreshOfCHeld = new Promise<void>((resolve) => {
      releaseRefreshOfC.release = resolve;
    });
    const tokens = createCliHostTokens({
      lease,
      refresh: async () => {
        refreshesStarted.push(refreshesStarted.length + 1);
        if (refreshesStarted.length === 2) await refreshOfCHeld;
        return credentials.refresh();
      },
      adoptStored: async () => undefined,
      signal: null,
    });
    await tokens.whenLoaded();
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });
    const minting = tokens.hostBearerFor(hostId, true);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));

    // A is refused; our rotation produces B and the retry goes out on it, held.
    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    await vi.waitFor(() => expect(harness.mints).toHaveLength(2));
    expect(harness.mints[1]?.signIn).toBe(credentials.rotatedTo(1));
    // While it is pending a sibling replaces B with C.
    lease.rotate(SIBLING_SIGN_IN);

    // B's stale 401 arrives: the one retry goes out on C, and nothing is judged.
    harness.mints[1]?.answer({ kind: "sign-in-rejected" });
    await vi.waitFor(() => expect(harness.mints).toHaveLength(3));
    expect(harness.mints[2]?.signIn).toBe(SIBLING_SIGN_IN);
    expect(tokens.signInRejected()).toBe(false);
    expect(refreshesStarted).toHaveLength(1);

    // C's own 401 arrives: the first refusal of C, so C is refreshed, once. While
    // that refresh is pending the refusal has judged nothing.
    harness.mints[2]?.answer({ kind: "sign-in-rejected" });
    await vi.waitFor(() => expect(refreshesStarted).toHaveLength(2));
    expect(tokens.signInRejected()).toBe(false);
    expect(reports).toEqual([]);
    releaseRefreshOfC.release();
    const bearer = await minting;

    expect(bearer).not.toBeNull();
    expect(tokens.signInRejected()).toBe(false);
    expect(reports).toEqual([]);
    expect(refreshesStarted).toHaveLength(2);
    expect(harness.mints.map((mint) => mint.signIn)).toEqual([
      SIGN_IN_A,
      credentials.rotatedTo(1),
      SIBLING_SIGN_IN,
      credentials.rotatedTo(2),
    ]);
  });

  it("judges nothing and refreshes once when a sibling installs another sign-in before our rotation's continuation runs and that one is refused", async () => {
    // The mint on A and the retry after our rotation are held; the one after C's refresh is answered.
    harness.hold = 2;
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const refreshesStarted: number[] = [];
    const releaseRefreshOfC: { release: () => void } = {
      release: () => undefined,
    };
    const refreshOfCHeld = new Promise<void>((resolve) => {
      releaseRefreshOfC.release = resolve;
    });
    const tokens = createCliHostTokens({
      lease,
      refresh: async () => {
        refreshesStarted.push(refreshesStarted.length + 1);
        if (refreshesStarted.length === 1) {
          // Our rotation installs B; a sibling's write installs C before the
          // continuation of the rotation runs.
          lease.rotate(ROTATED_SIGN_IN);
          lease.rotate(SIBLING_SIGN_IN);
          return { outcome: "rotated", installed: ROTATED_SIGN_IN };
        }
        await refreshOfCHeld;
        lease.rotate(REFRESHED_SIGN_IN);
        return { outcome: "rotated", installed: REFRESHED_SIGN_IN };
      },
      adoptStored: async () => undefined,
      signal: null,
    });
    await tokens.whenLoaded();
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });
    const minting = tokens.hostBearerFor(hostId, true);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));

    // A is refused: our rotation installs B, a sibling then installs C, and the retry goes out on C.
    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    await vi.waitFor(() => expect(harness.mints).toHaveLength(2));
    expect(harness.mints[1]?.signIn).toBe(SIBLING_SIGN_IN);

    // C's 401 arrives. C is not the sign-in our rotation installed, so this is
    // its first refusal: C is refreshed once, and while that refresh is pending
    // nothing is judged and nothing is reported.
    harness.mints[1]?.answer({ kind: "sign-in-rejected" });
    await vi.waitFor(() => expect(refreshesStarted).toHaveLength(2));
    expect(tokens.signInRejected()).toBe(false);
    expect(reports).toEqual([]);
    releaseRefreshOfC.release();
    const bearer = await minting;

    expect(bearer).not.toBeNull();
    expect(tokens.signInRejected()).toBe(false);
    expect(reports).toEqual([]);
    expect(refreshesStarted).toHaveLength(2);
    expect(harness.mints.map((mint) => mint.signIn)).toEqual([
      SIGN_IN_A,
      SIBLING_SIGN_IN,
      REFRESHED_SIGN_IN,
    ]);
  });
});

describe("a refusal of a sign-in a sibling process has since replaced on disk", () => {
  let workDir = "";

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "traycer-sign-in-sibling-"));
    credentialsFile.path = join(workDir, "credentials");
    credentialsFile.refreshed.splice(0);
  });

  afterEach(async () => {
    credentialsFile.path = "";
    await rm(workDir, { recursive: true, force: true });
  });

  const credentialsOf = (token: string): StoredCredentials => ({
    token,
    refreshToken: `rt-${token}`,
    savedAt: "2026-01-01T00:00:00.000Z",
    user: { id: USER_ID, email: "user@example.test", name: "User" },
  });

  it("reports nothing and asks once on the sign-in on disk when the retry after our rotation is refused after another process saved a newer one", async () => {
    // The mints on A and the retry on B are held; the one after is answered.
    harness.hold = 2;
    const store = createCliCredentialsStore();
    // A second handle on the same file: another process's save, outside this lease.
    const otherProcess = createCliCredentialsStore();
    await store.signIn(credentialsOf(SIGN_IN_A), false, null);
    credentialsFile.refreshed.push(ROTATED_SIGN_IN);
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const revalidator = createStoreBackedRevalidator({
      store,
      lease,
      signal: null,
    });
    const tokens = createCliHostTokens({
      lease,
      refresh: () => revalidator.rotateSignIn(),
      adoptStored: () => revalidator.adoptStoredSignIn(),
      signal: null,
    });
    await tokens.whenLoaded();
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });
    const minting = tokens.hostBearerFor(hostId, true);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));

    // A is refused; the recovery rotates to B under the lock and retries on B, held.
    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    await vi.waitFor(() => expect(harness.mints).toHaveLength(2));
    expect(harness.mints[1]?.signIn).toBe(ROTATED_SIGN_IN);

    // Another process rotates B to C and saves it to the credentials file; this lease still holds B.
    await otherProcess.signIn(credentialsOf(SIBLING_SIGN_IN), false, null);
    expect(lease.getBearerToken()).toBe(ROTATED_SIGN_IN);

    // B's 401 arrives: B is no longer the sign-in stored, so nothing is judged.
    harness.mints[1]?.answer({ kind: "sign-in-rejected" });
    await vi.waitFor(() => expect(harness.mints).toHaveLength(3));
    expect(harness.mints[2]?.signIn).toBe(SIBLING_SIGN_IN);
    expect(lease.getBearerToken()).toBe(SIBLING_SIGN_IN);
    expect(tokens.signInRejected()).toBe(false);
    expect(reports).toEqual([]);

    harness.mints[2]?.answer({
      kind: "ok",
      token: { token: "host-token-c", expiresAtMs: Date.now() + 3_600_000 },
    });
    expect(await minting).not.toBeNull();
    expect(tokens.signInRejected()).toBe(false);
    expect(reports).toEqual([]);
    expect(harness.mints.map((mint) => mint.signIn)).toEqual([
      SIGN_IN_A,
      ROTATED_SIGN_IN,
      SIBLING_SIGN_IN,
    ]);
    tokens.dispose();
    store.dispose();
    otherProcess.dispose();
  });

  it("leaves the lease on the sign-in a rotation installed while the adopting read was held", async () => {
    const store = createCliCredentialsStore();
    const otherProcess = createCliCredentialsStore();
    // The file holds B and this lease holds A: the read snapshots B.
    await store.signIn(credentialsOf(ROTATED_SIGN_IN), false, null);
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const snapshotTaken: { resolve: () => void } = { resolve: () => undefined };
    const snapshotWasTaken = new Promise<void>((resolve) => {
      snapshotTaken.resolve = resolve;
    });
    const releaseRead: { resolve: () => void } = { resolve: () => undefined };
    const readHeld = new Promise<void>((resolve) => {
      releaseRead.resolve = resolve;
    });
    const heldRead: CredentialsMutationStore = {
      ...store,
      read: async () => {
        const snapshot = await store.read();
        snapshotTaken.resolve();
        await readHeld;
        return snapshot;
      },
    };
    const adopting = createStoreBackedRevalidator({
      store: heldRead,
      lease,
      signal: null,
    }).adoptStoredSignIn();
    await snapshotWasTaken;

    // Meanwhile a rotation installs C in the lease: another process saved C and the rotation adopts it.
    await otherProcess.signIn(credentialsOf(SIBLING_SIGN_IN), false, null);
    await expect(
      createStoreBackedRevalidator({
        store,
        lease,
        signal: null,
      }).rotateSignIn(),
    ).resolves.toEqual({ outcome: "adopted", installed: null });
    expect(lease.getBearerToken()).toBe(SIBLING_SIGN_IN);

    // The read, begun before, is released: its snapshot is older than the lease.
    releaseRead.resolve();
    await adopting;
    expect(lease.getBearerToken()).toBe(SIBLING_SIGN_IN);
    store.dispose();
    otherProcess.dispose();
  });

  it("takes the sign-in on disk before the source records a refusal of the sign-in the mint was sent with", async () => {
    const signInA = unsignedJwtExpiring(Date.now() + 60 * 60 * 1000);
    const signInB = unsignedJwtExpiring(Date.now() + 2 * 60 * 60 * 1000);
    const store = createCliCredentialsStore();
    const otherProcess = createCliCredentialsStore();
    await store.signIn(credentialsOf(signInA), false, null);
    const lease = new MutableBearerLease(signInA, USER_ID);
    const revalidator = createStoreBackedRevalidator({
      store,
      lease,
      signal: null,
    });
    // How the refused mint stands in the source when the lease is about to be synced with the file.
    const recordedWhenSyncing: Array<string | null> = [];
    const tokens = createCliHostTokens({
      lease,
      refresh: () => revalidator.rotateSignIn(),
      adoptStored: async () => {
        recordedWhenSyncing.push(
          createdSources[0]?.lastFailureOf(
            USER_ID,
            processReleasedHosts.currentInstance(hostId),
          ) ?? null,
        );
        await revalidator.adoptStoredSignIn();
      },
      signal: null,
    });
    await tokens.whenLoaded();
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });
    const minting = tokens.hostBearerFor(hostId, true);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));
    expect(harness.mints[0]?.signIn).toBe(signInA);

    // Another process saves B while the mint on A is out; the lease still holds A when A's 401 arrives.
    await otherProcess.signIn(credentialsOf(signInB), false, null);
    expect(lease.getBearerToken()).toBe(signInA);
    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    expect(await minting).not.toBeNull();

    // No refusal of A was on record when the lease was synced; the lease holds B and the next mint presented B.
    expect(recordedWhenSyncing.length).toBeGreaterThan(0);
    expect(recordedWhenSyncing.every((failure) => failure === null)).toBe(true);
    expect(lease.getBearerToken()).toBe(signInB);
    expect(harness.mints.map((mint) => mint.signIn)).toEqual([
      signInA,
      signInB,
    ]);
    expect(tokens.signInRejected()).toBe(false);
    expect(reports).toEqual([]);
    tokens.dispose();
    store.dispose();
    otherProcess.dispose();
  });

  it("goes on with the sign-in on disk, rejecting nothing, when the stream recovery's retry after our rotation is refused after another process saved a newer one", async () => {
    // The mints on A and the retry on B are held; the one on C is answered.
    harness.hold = 2;
    const store = createCliCredentialsStore();
    const otherProcess = createCliCredentialsStore();
    await store.signIn(credentialsOf(SIGN_IN_A), false, null);
    credentialsFile.refreshed.push(ROTATED_SIGN_IN);
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const revalidator = createStoreBackedRevalidator({
      store,
      lease,
      signal: null,
    });
    const tokens = createCliHostTokens({
      lease,
      refresh: () => revalidator.rotateSignIn(),
      adoptStored: () => revalidator.adoptStoredSignIn(),
      signal: null,
    });
    await tokens.whenLoaded();
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });
    // The host refused the held token as expired: the stream's recovery, bounded by its own sequence, mints a fresh one.
    const refusal: FatalErrorDetails = {
      code: "UNAUTHORIZED",
      reason: "host token expired",
      doorReason: "token_expired",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    };
    const recovering = tokens.streamRecovery(hostId).revalidateRefused(refusal);
    await vi.waitFor(() => expect(harness.mints).toHaveLength(1));
    expect(harness.mints[0]?.signIn).toBe(SIGN_IN_A);

    // A is refused; the recovery rotates to B under the lock and retries on B, held.
    harness.mints[0]?.answer({ kind: "sign-in-rejected" });
    await vi.waitFor(() => expect(harness.mints).toHaveLength(2));
    expect(harness.mints[1]?.signIn).toBe(ROTATED_SIGN_IN);

    // Another process saves C while the retry is out; B's 401 arrives.
    await otherProcess.signIn(credentialsOf(SIBLING_SIGN_IN), false, null);
    harness.mints[1]?.answer({ kind: "sign-in-rejected" });

    // The recovery is not answered "rejected" for a sign-in that is no longer the stored one: it mints on C.
    await expect(recovering).resolves.toBe("rotated");
    expect(lease.getBearerToken()).toBe(SIBLING_SIGN_IN);
    expect(harness.mints.map((mint) => mint.signIn)).toEqual([
      SIGN_IN_A,
      ROTATED_SIGN_IN,
      SIBLING_SIGN_IN,
    ]);
    expect(credentialsFile.refreshed).toEqual([]);
    expect(tokens.signInRejected()).toBe(false);
    expect(reports).toEqual([]);
    tokens.dispose();
    store.dispose();
    otherProcess.dispose();
  });
});

/** A sign-in with a readable end and no signature: its key is the end, as authn's sign-ins carry. */
function unsignedJwtExpiring(endMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(endMs / 1000) }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}
