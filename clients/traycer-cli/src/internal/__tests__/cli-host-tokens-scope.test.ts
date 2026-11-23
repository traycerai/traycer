import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { AuthTokenRefreshResult } from "../../../../shared/auth/auth-validation";
import { MutableBearerLease } from "../../../../shared/auth/bearer-source";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import type { HostTokenMintOutcome } from "../../../../shared/auth/host-token-source";
import type { Environment } from "../../runner/environment";
import {
  createCliCredentialsStore,
  createStoreBackedRevalidator,
} from "../../store/credentials-store";
import { createCliHostTokens } from "../cli-host-tokens";
import { nameReason } from "./released-memory-test-support";
import { SIGN_OUT_ARMS, standSignOutArm } from "./sign-out-arms-test-support";

// Model P, J, L and N through the CLI's real token path: a token session that
// has ended starts no authn request; a terminal effect is re-checked against the
// credentials file; an "adopted" answer with nothing changed ends its loop.
// Every interleaving is gated on an event (a held load, rotation or read), with
// real timers: no sleeps, no turn counts.

const USER_ID = "user-1";
const SIGN_IN_A = "sign-in-a";
const SIGN_IN_B = "sign-in-b";

type MintAnswer = "hold" | "refused" | "ok" | "not-admitted";

const harness = vi.hoisted(() => ({
  /** Every authn request, in the order sent. */
  mints: [] as Array<{ readonly hostId: string; readonly signIn: string }>,
  /** How the request at an index is answered when it is sent. */
  answerFor: ((_index: number): MintAnswer => "ok") as (
    index: number,
  ) => MintAnswer,
  table: new Map() as HostTokenTable,
  /** Called as each authn request is sent, before it is answered. */
  onSend: null as ((index: number) => void) | null,
  /** While set, the stored host tokens are not yet read. */
  loadGate: null as Promise<void> | null,
}));

const credentialsFile = vi.hoisted(() => ({
  path: "",
  refreshes: [] as Array<"rejected">,
}));

vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    cliCredentialsPath: (_environment: Environment): string => {
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
    refreshOnceAbortable: async (): Promise<AuthTokenRefreshResult> => {
      if (credentialsFile.refreshes.shift() === undefined)
        throw new Error("authn was asked for a refresh no test expected");
      return {
        kind: "rejected",
        rejection: { kind: "credential", revocation: null },
      };
    },
  };
});

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => {
      await harness.loadGate;
      return harness.table;
    },
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
      ): Promise<HostTokenMintOutcome> =>
        new Promise<HostTokenMintOutcome>((resolve) => {
          const index = harness.mints.length;
          harness.mints.push({ hostId, signIn });
          harness.onSend?.(index);
          const answer = harness.answerFor(index);
          if (answer === "refused") resolve({ kind: "sign-in-rejected" });
          if (answer === "not-admitted") resolve({ kind: "not-admitted" });
          if (answer === "ok")
            resolve({
              kind: "ok",
              token: {
                token: `host-token-${index + 1}`,
                expiresAtMs: Date.now() + 3_600_000,
              },
            });
        }),
    };
  },
);

interface Gate {
  readonly reached: Promise<void>;
  readonly release: Promise<void>;
  readonly markReached: () => void;
  readonly open: () => void;
}

/** One event the test waits for (`reached`) and one it later fires (`open`). */
function gate(): Gate {
  const marks: { markReached: () => void; open: () => void } = {
    markReached: () => undefined,
    open: () => undefined,
  };
  const reached = new Promise<void>((resolve) => {
    marks.markReached = resolve;
  });
  const release = new Promise<void>((resolve) => {
    marks.open = resolve;
  });
  return { reached, release, ...marks };
}

const credentialsOf = (token: string): StoredCredentials => ({
  token,
  refreshToken: `rt-${token}`,
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: USER_ID, email: "user@example.test", name: "User" },
});

const REFUSED_AS_EXPIRED: FatalErrorDetails = {
  code: "UNAUTHORIZED",
  reason: "host token expired",
  doorReason: "token_expired",
  retryable: false,
  incompatibleMethods: null,
  upgradeGuidance: null,
};

let hostCount = 0;
let hostId = "";
let workDir = "";

beforeEach(async () => {
  harness.mints.splice(0);
  harness.answerFor = () => "ok";
  harness.table = new Map();
  harness.loadGate = null;
  harness.onSend = null;
  credentialsFile.refreshes.splice(0);
  hostCount += 1;
  // A host process's flights and memory are kept per host id.
  hostId = `66666666-6666-4666-8666-${String(hostCount).padStart(12, "0")}`;
  processReleasedHosts.forgetAll();
  workDir = await mkdtemp(join(tmpdir(), "traycer-scope-"));
  credentialsFile.path = join(workDir, "credentials");
});

afterEach(async () => {
  processReleasedHosts.forgetAll();
  credentialsFile.path = "";
  await rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

describe("a token session that has ended starts no authn request (J)", () => {
  // The mints carry the command's own signal, which outlives the token session.
  const command = new AbortController();

  it("starts none when it ends while the stored host tokens are still being read", async () => {
    const loading = gate();
    harness.loadGate = loading.release;
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const tokens = createCliHostTokens({
      lease,
      refresh: async () => ({
        outcome: "network-error",
        installed: null,
        refused: null,
        accepted: null,
      }),
      adoptStored: async () => undefined,
      signal: null,
    });
    const asking = tokens.mintFresh(hostId, command.signal);

    tokens.dispose();
    loading.open();
    await asking;

    expect(harness.mints).toEqual([]);
  });

  it("starts none for the new process when it ends while a replaced process's ask is being answered", async () => {
    const loading = gate();
    harness.loadGate = loading.release;
    processReleasedHosts.observeInstance(hostId, "boot-1");
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const tokens = createCliHostTokens({
      lease,
      refresh: async () => ({
        outcome: "network-error",
        installed: null,
        refused: null,
        accepted: null,
      }),
      adoptStored: async () => undefined,
      signal: null,
    });
    // The ask is for the process observed now; it is replaced before the ask is answered.
    const asking = tokens.mintFresh(hostId, command.signal);
    processReleasedHosts.observeInstance(hostId, "boot-2");

    tokens.dispose();
    loading.open();
    await asking;

    expect(harness.mints).toEqual([]);
  });

  it("starts no retry when it ends while the rotation after a refusal is running", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    const rotation = gate();
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const tokens = createCliHostTokens({
      lease,
      refresh: async () => {
        rotation.markReached();
        await rotation.release;
        lease.rotate(SIGN_IN_B);
        return {
          outcome: "rotated",
          installed: SIGN_IN_B,
          refused: null,
          accepted: SIGN_IN_B,
        };
      },
      adoptStored: async () => undefined,
      signal: null,
    });
    const asking = tokens.mintFresh(hostId, command.signal);
    await rotation.reached;

    tokens.dispose();
    rotation.open();
    await asking;

    expect(harness.mints).toHaveLength(1);
  });
});

describe("a terminal effect re-checks the credentials file first (L)", () => {
  /** A real store, its rotation answered "rejected" for A and then held before it hands the result back. */
  function rotationRejectedThenHeld(): {
    readonly store: CredentialsMutationStore;
    readonly otherProcess: CredentialsMutationStore;
    readonly rejected: Gate;
  } {
    const store = createCliCredentialsStore();
    const rejected = gate();
    return {
      store: {
        ...store,
        rotate: async (args) => {
          const result = await store.rotate(args);
          rejected.markReached();
          await rejected.release;
          return result;
        },
      },
      otherProcess: createCliCredentialsStore(),
      rejected,
    };
  }

  it("reports nothing and asks again on the saved sign-in when a sibling saves one before a rejected rotation's caller reports", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    credentialsFile.refreshes.push("rejected");
    const { store, otherProcess, rejected } = rotationRejectedThenHeld();
    await store.signIn(credentialsOf(SIGN_IN_A), false, null);
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
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });
    const asking = tokens.mintFresh(hostId, null);
    // The locked rotation has answered "rejected" for A; a sibling then saves B before the caller reports.
    await rejected.reached;
    await otherProcess.signIn(credentialsOf(SIGN_IN_B), false, null);
    rejected.open();
    const answered = await asking;

    expect(reports).toEqual([]);
    expect(harness.mints.map((mint) => mint.signIn)).toEqual([
      SIGN_IN_A,
      SIGN_IN_B,
    ]);
    expect(answered.kind).toBe("ok");
    expect(await tokens.signInRejectedNow(null)).toBe(false);
    tokens.dispose();
    store.dispose();
    otherProcess.dispose();
  });

  it("does the same through the proactive renewal after a sign-in refresh", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    credentialsFile.refreshes.push("rejected");
    const { store, otherProcess, rejected } = rotationRejectedThenHeld();
    await store.signIn(credentialsOf(SIGN_IN_A), false, null);
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
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });
    const renewing = tokens.renewAfterSignInRefresh(hostId);
    await rejected.reached;
    await otherProcess.signIn(credentialsOf(SIGN_IN_B), false, null);
    rejected.open();

    expect(await renewing).toBe(true);
    expect(reports).toEqual([]);
    expect(harness.mints.map((mint) => mint.signIn)).toEqual([
      SIGN_IN_A,
      SIGN_IN_B,
    ]);
    expect(await tokens.signInRejectedNow(null)).toBe(false);
    tokens.dispose();
    store.dispose();
    otherProcess.dispose();
  });
});

describe("a refused rotation of the sign-in the command started with (v5)", () => {
  it("makes the terminal report after an adopting read, once, and reads signed out", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    credentialsFile.refreshes.push("rejected");
    const store = createCliCredentialsStore();
    await store.signIn(credentialsOf(SIGN_IN_A), false, null);
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const events: string[] = [];
    const rotatingStore: CredentialsMutationStore = {
      ...store,
      rotate: async (args) => {
        const result = await store.rotate(args);
        events.push("rotated");
        return result;
      },
    };
    const revalidator = createStoreBackedRevalidator({
      store: rotatingStore,
      lease,
      signal: null,
    });
    const tokens = createCliHostTokens({
      lease,
      refresh: () => revalidator.rotateSignIn(),
      adoptStored: async () => {
        events.push("adopt");
        await revalidator.adoptStoredSignIn();
      },
      signal: null,
    });
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
      events.push("report");
    });

    await tokens.mintFresh(hostId, null);

    // Authn refused the refresh of A: one report, made after an adopting read that followed the rotation.
    expect(reports).toEqual([hostId]);
    expect(await tokens.signInRejectedNow(null)).toBe(true);
    const rotated = events.lastIndexOf("rotated");
    expect(rotated).toBeGreaterThan(-1);
    expect(events.slice(rotated + 1, events.indexOf("report"))).toContain(
      "adopt",
    );
    tokens.dispose();
    store.dispose();
  });
});

describe("a rotation no refresh can follow reads signed out (v5)", () => {
  it.each(SIGN_OUT_ARMS)(
    "reads signed out when the file is in the %s arm",
    async (arm) => {
      harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
      const store = createCliCredentialsStore();
      const otherProcess = createCliCredentialsStore();
      await store.signIn(credentialsOf(SIGN_IN_A), false, null);
      await standSignOutArm(arm, {
        credentialsPath: credentialsFile.path,
        otherProcess,
        credentials: credentialsOf(SIGN_IN_A),
      });
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

      await tokens.mintFresh(hostId, null);

      expect(await tokens.signInRejectedNow(null)).toBe(true);
      tokens.dispose();
      store.dispose();
      otherProcess.dispose();
    },
  );
});

describe("an adopted answer with nothing changed ends its loop (N)", () => {
  it("asks no more than once more when the sign-in refresh is adopted and the sign-in presented is unchanged", async () => {
    // Every request is refused until the sixth, so a loop that repeats is seen as asks, not hung.
    harness.answerFor = (index) => (index < 5 ? "refused" : "ok");
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const tokens = createCliHostTokens({
      lease,
      refresh: async () => ({
        outcome: "adopted",
        installed: null,
        refused: null,
        accepted: null,
      }),
      adoptStored: async () => undefined,
      signal: null,
    });

    await tokens
      .streamRecovery(hostId)
      .revalidateRefused(REFUSED_AS_EXPIRED, () => true);

    expect(harness.mints.length).toBeLessThanOrEqual(2);
    tokens.dispose();
  });
});

describe("an admission resets only the host process that admitted", () => {
  it("leaves the replacement's recovery spent when a late admission of the replaced process arrives", async () => {
    processReleasedHosts.observeInstance(hostId, "boot-p");
    const processP = processReleasedHosts.currentInstance(hostId);
    const tokens = createCliHostTokens({
      lease: new MutableBearerLease(SIGN_IN_A, USER_ID),
      refresh: async () => ({
        outcome: "network-error",
        installed: null,
        refused: null,
        accepted: null,
      }),
      adoptStored: async () => undefined,
      signal: null,
    });
    // P is replaced by Q; Q's recovery spends its one replacement of an expired token.
    processReleasedHosts.observeInstance(hostId, "boot-q");
    const recoveryOfQ = tokens.streamRecovery(hostId);
    expect(
      await recoveryOfQ.revalidateRefused(REFUSED_AS_EXPIRED, () => true),
    ).toBe("rotated");

    // P's admission arrives late: it is not Q's, so Q's recovery stays spent.
    tokens.admitted(processP)();

    expect(
      await recoveryOfQ.revalidateRefused(REFUSED_AS_EXPIRED, () => true),
    ).toBe("rejected");
    expect(harness.mints).toHaveLength(1);
    tokens.dispose();
  });

  it("gives the recovery of the process that admitted its allowance again", async () => {
    processReleasedHosts.observeInstance(hostId, "boot-p");
    const processP = processReleasedHosts.currentInstance(hostId);
    const tokens = createCliHostTokens({
      lease: new MutableBearerLease(SIGN_IN_A, USER_ID),
      refresh: async () => ({
        outcome: "network-error",
        installed: null,
        refused: null,
        accepted: null,
      }),
      adoptStored: async () => undefined,
      signal: null,
    });
    const recoveryOfP = tokens.streamRecovery(hostId);
    expect(
      await recoveryOfP.revalidateRefused(REFUSED_AS_EXPIRED, () => true),
    ).toBe("rotated");

    // P is still current and admits: its next refusal is recovered afresh.
    tokens.admitted(processP)();

    expect(
      await recoveryOfP.revalidateRefused(REFUSED_AS_EXPIRED, () => true),
    ).toBe("rotated");
    expect(harness.mints).toHaveLength(2);
    tokens.dispose();
  });
});

describe("a refusal a later purchase outlived hands its caller the held token (P4)", () => {
  /** A store over the real file whose `read` number `heldRead` is held after its snapshot until released. */
  function holdingRead(
    store: CredentialsMutationStore,
    heldRead: number,
  ): { readonly store: CredentialsMutationStore; readonly held: Gate } {
    const held = gate();
    let reads = 0;
    return {
      held,
      store: {
        ...store,
        read: async () => {
          reads += 1;
          const snapshot = await store.read();
          if (reads === heldRead) {
            held.markReached();
            await held.release;
          }
          return snapshot;
        },
      },
    };
  }

  it("answers the held token of the later purchase when the refusal to report was outlived during the final adopting read", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    credentialsFile.refreshes.push("rejected");
    const real = createCliCredentialsStore();
    const rejected = gate();
    const store: CredentialsMutationStore = {
      ...real,
      rotate: async (args) => {
        const result = await real.rotate(args);
        rejected.markReached();
        await rejected.release;
        return result;
      },
    };
    await store.signIn(credentialsOf(SIGN_IN_A), false, null);
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
    const asking = tokens.mintFresh(hostId, null);
    // authn has refused the refresh of A; a later request for the same host process buys a token while the caller waits to report.
    await rejected.reached;
    expect((await tokens.mintFresh(hostId, null)).kind).toBe("ok");
    rejected.open();

    expect(await asking).toMatchObject({ kind: "ok" });
    tokens.dispose();
    real.dispose();
  });

  it("answers the held token of the later purchase when the recovery's own re-check finds its refusal outlived", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    const real = createCliCredentialsStore();
    await real.signIn(credentialsOf(SIGN_IN_A), false, null);
    // Reads 1 and 2 are the tracker's, before the refusal counts; read 3 is the recovery's own.
    const { store, held } = holdingRead(real, 3);
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
    const asking = tokens.mintFresh(hostId, null);
    await held.reached;
    expect((await tokens.mintFresh(hostId, null)).kind).toBe("ok");
    held.open();

    expect(await asking).toMatchObject({ kind: "ok" });
    tokens.dispose();
    real.dispose();
  });
});

describe("a direct recovery sends no retry on a sign-in that did not change (P8)", () => {
  it("sends none after a rotation answered rotated while the presented sign-in is still the refused one", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    const tokens = createCliHostTokens({
      lease: new MutableBearerLease(SIGN_IN_A, USER_ID),
      // authn accepted a refresh, but nothing installed it: the lease still holds A.
      refresh: async () => ({
        outcome: "rotated",
        installed: SIGN_IN_A,
        refused: null,
        accepted: SIGN_IN_B,
      }),
      adoptStored: async () => undefined,
      signal: null,
    });

    const answered = await tokens.mintFresh(hostId, null);

    expect(harness.mints.map((mint) => mint.signIn)).toEqual([SIGN_IN_A]);
    expect(answered.kind).toBe("failed");
    tokens.dispose();
  });
});

describe("two token instances of one process share one order of purchases for a host process (P3)", () => {
  it("lets a purchase through the second instance outlive a refusal through the first, by order", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    const real = createCliCredentialsStore();
    await real.signIn(credentialsOf(SIGN_IN_A), false, null);
    // Instance 1's mint on A is refused; it waits in its adopting read.
    const holding = ((): { store: CredentialsMutationStore; held: Gate } => {
      const held = gate();
      let reads = 0;
      return {
        held,
        store: {
          ...real,
          read: async () => {
            reads += 1;
            const snapshot = await real.read();
            if (reads === 1) {
              held.markReached();
              await held.release;
            }
            return snapshot;
          },
        },
      };
    })();
    const lease1 = new MutableBearerLease(SIGN_IN_A, USER_ID);
    const revalidator1 = createStoreBackedRevalidator({
      store: holding.store,
      lease: lease1,
      signal: null,
    });
    let refreshes = 0;
    const first = createCliHostTokens({
      lease: lease1,
      refresh: async () => {
        refreshes += 1;
        return revalidator1.rotateSignIn();
      },
      adoptStored: () => revalidator1.adoptStoredSignIn(),
      signal: null,
    });
    const second = createCliHostTokens({
      lease: new MutableBearerLease(SIGN_IN_A, USER_ID),
      refresh: async () => ({
        outcome: "network-error",
        installed: null,
        refused: null,
        accepted: null,
      }),
      adoptStored: async () => undefined,
      signal: null,
    });
    const asking = first.mintFresh(hostId, null);
    await holding.held.reached;

    // A later request for the same host process, through the other instance, buys and keeps a token.
    expect((await second.mintFresh(hostId, null)).kind).toBe("ok");
    holding.held.open();
    await asking;

    // The older refusal is outlived for every instance of the process: it earns no recovery.
    expect(refreshes).toBe(0);
    first.dispose();
    second.dispose();
    real.dispose();
  });
});

describe("a host-specific failure is reported by the order its own request was sent in (P9)", () => {
  // A guard: with no purchase for the host process, the same refusal is reported.
  it("reports a not-admitted when no purchase for the host process outlives it", async () => {
    harness.answerFor = () => "not-admitted";
    // The host has named a reason for its refusals, so a refused mint can end the command.
    nameReason(hostId);
    const tokens = createCliHostTokens({
      lease: new MutableBearerLease(SIGN_IN_A, USER_ID),
      refresh: async () => ({
        outcome: "network-error",
        installed: null,
        refused: null,
        accepted: null,
      }),
      adoptStored: async () => undefined,
      signal: null,
    });
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });

    await tokens.mintFresh(hostId, null);

    expect(reports).toEqual([hostId]);
    tokens.dispose();
  });

  it("reports a not-admitted whose request was sent after a kept purchase, though it was asked before it", async () => {
    // Two asks wait on the stored host tokens. Y's continuation sends first, on A; a sibling's B is
    // published; X's continuation then sends a distinct request, on B, which is refused not-admitted.
    const loading = gate();
    harness.loadGate = loading.release;
    harness.answerFor = (index) => (index === 0 ? "ok" : "not-admitted");
    nameReason(hostId);
    const lease = new MutableBearerLease(SIGN_IN_A, USER_ID);
    harness.onSend = (index) => {
      if (index === 0) lease.rotate(SIGN_IN_B);
    };
    const tokens = createCliHostTokens({
      lease,
      refresh: async () => ({
        outcome: "network-error",
        installed: null,
        refused: null,
        accepted: null,
      }),
      adoptStored: async () => undefined,
      signal: null,
    });
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((reportedHostId) => {
      reports.push(reportedHostId);
    });
    const purchaser = tokens.mintFresh(hostId, null);
    const refused = tokens.mintFresh(hostId, null);

    loading.open();
    await Promise.all([purchaser, refused]);

    expect(harness.mints.map((mint) => mint.signIn)).toEqual([
      SIGN_IN_A,
      SIGN_IN_B,
    ]);
    // The refused request was sent after the purchase: the later request, not an outlived one.
    expect(reports).toEqual([hostId]);
    tokens.dispose();
  });
});
