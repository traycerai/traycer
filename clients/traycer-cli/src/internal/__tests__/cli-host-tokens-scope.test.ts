import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentials } from "@traycer/protocol/config/credentials";
import type { CredentialsMutationStore } from "@traycer/protocol/config/credentials-mutation";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { AuthTokenRefreshResult } from "../../../../shared/auth/auth-validation";
import {
  MutableBearerLease,
  type BearerLease,
} from "../../../../shared/auth/bearer-source";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import type { HostTokenMintOutcome } from "../../../../shared/auth/host-token-source";
import type { Environment } from "../../runner/environment";
import {
  createCliCredentialsStore,
  type SignInRotationResult,
} from "../../store/credentials-store";
import { acquireCliSignIn, type CliSignInHandle } from "../cli-host-tokens";
import { nameReason } from "./released-memory-test-support";
import { SIGN_OUT_ARMS, standSignOutArm } from "./sign-out-arms-test-support";
import { nextCasePerson } from "./case-person-test-support";

// Model P, J, L and N through the CLI's real token path: a token session that
// has ended starts no authn request; a terminal effect is re-checked against the
// credentials file; an "adopted" answer with nothing changed ends its loop.
// Every interleaving is gated on an event (a held load, rotation or read), with
// real timers: no sleeps, no turn counts.

// The person this case signs in as, one no earlier case used: the process-scope
// judge of a sign-in is kept per person.
let USER_ID = nextCasePerson().userId;
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
  /** How many times the stored host tokens were read. */
  loads: 0,
}));

const credentialsFile = vi.hoisted(() => ({
  path: "",
  refreshes: [] as Array<"rejected">,
}));

/** What a case injects into the store and revalidator the registry builds for its person. */
const injected = vi.hoisted(() => ({
  /** Wraps the store the registry builds for the next acquire. */
  wrapStore: null as
    | ((store: CredentialsMutationStore) => CredentialsMutationStore)
    | null,
  /** Replaces the sign-in refresh the registry's revalidator runs; null runs the real one. */
  rotate: null as
    | ((lease: BearerLease) => Promise<SignInRotationResult>)
    | null,
  /** Called as the revalidator's adopting read is asked, before it reads. */
  onAdopt: null as (() => void) | null,
  /** Called as a sign-in refresh is asked. */
  onRefresh: null as (() => void) | null,
}));

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: () => {
      const real = actual.createCliCredentialsStore();
      return injected.wrapStore === null ? real : injected.wrapStore(real);
    },
    createStoreBackedRevalidator: (
      args: Parameters<typeof actual.createStoreBackedRevalidator>[0],
    ) => {
      const real = actual.createStoreBackedRevalidator(args);
      return {
        ...real,
        rotateSignIn: () => {
          injected.onRefresh?.();
          return injected.rotate === null
            ? real.rotateSignIn()
            : injected.rotate(args.lease);
        },
        adoptStoredSignIn: () => {
          injected.onAdopt?.();
          return real.adoptStoredSignIn();
        },
      };
    },
  };
});

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
      harness.loads += 1;
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
  USER_ID = nextCasePerson().userId;
  harness.mints.splice(0);
  harness.answerFor = () => "ok";
  harness.table = new Map();
  harness.loadGate = null;
  harness.loads = 0;
  harness.onSend = null;
  credentialsFile.refreshes.splice(0);
  hostCount += 1;
  // A host process's flights and memory are kept per host id.
  hostId = `66666666-6666-4666-8666-${String(hostCount).padStart(12, "0")}`;
  processReleasedHosts.forgetAll();
  workDir = await mkdtemp(join(tmpdir(), "traycer-scope-"));
  credentialsFile.path = join(workDir, "credentials");
});

/** The handles a case took on its person; each is ended with the case. */
const handles: CliSignInHandle[] = [];

/** The person signed in as sign-in A, taking one more handle on the one instance of its tokens. */
async function acquire(signal: AbortSignal | null): Promise<CliSignInHandle> {
  const handle = await acquireCliSignIn(
    { token: SIGN_IN_A, authnBaseUrl: "https://authn.test", userId: USER_ID },
    signal,
  );
  handles.push(handle);
  return handle;
}

/** A refresh authn does not answer, as a lost connection does. */
const UNREACHABLE_AUTHN = async (): Promise<SignInRotationResult> => ({
  outcome: "network-error",
  installed: null,
  refused: null,
  accepted: null,
});

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.dispose();
  injected.wrapStore = null;
  injected.rotate = null;
  injected.onAdopt = null;
  injected.onRefresh = null;
  processReleasedHosts.forgetAll();
  credentialsFile.path = "";
  await rm(workDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

describe("a person's sign-in is acquired once their stored host tokens are read", () => {
  const HELD_TOKEN = "host-token-held-in-file";

  it("resolves a second acquire made during the first's read with the first's lease, after one read, and answers an ask from the file", async () => {
    harness.table = new Map([
      [
        USER_ID,
        new Map([
          [hostId, { token: HELD_TOKEN, expiresAtMs: Date.now() + 3_600_000 }],
        ]),
      ],
    ]);
    const reading = gate();
    harness.loadGate = reading.release;
    const settled: string[] = [];
    const first = acquire(null).then((handle) => {
      settled.push("first");
      return handle;
    });
    await vi.waitFor(() => expect(harness.loads).toBe(1));
    const second = acquire(null).then((handle) => {
      settled.push("second");
      return handle;
    });
    // Both are held by the read: observed over one turn of the loop, with the read still held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toEqual([]);
    expect(harness.loads).toBe(1);

    reading.open();
    const [a, b] = await Promise.all([first, second]);

    // One read and one lease: were a second instance built for the person, the
    // second acquire would read the file again and hold a lease of its own.
    expect(harness.loads).toBe(1);
    expect(b.lease).toBe(a.lease);
    expect(b.lease.getBearerToken()).toBe(a.lease.getBearerToken());
    for (const handle of [a, b]) {
      const answered = await handle.tokens.hostBearerFor(hostId, false);
      expect(answered?.getBearerToken()).toBe(HELD_TOKEN);
    }
    expect(harness.mints).toHaveLength(0);
  });
});

describe("a token session that has ended starts no authn request (J)", () => {
  // The mints carry the command's own signal, which outlives the token session.
  const command = new AbortController();

  it("starts no retry when it ends while the rotation after a refusal is running", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    const rotation = gate();
    injected.rotate = async (lease) => {
      rotation.markReached();
      await rotation.release;
      if (lease instanceof MutableBearerLease) lease.rotate(SIGN_IN_B);
      return {
        outcome: "rotated",
        installed: SIGN_IN_B,
        refused: null,
        accepted: SIGN_IN_B,
      };
    };
    const { tokens, dispose } = await acquire(null);
    const asking = tokens.mintFresh(hostId, command.signal);
    await rotation.reached;

    dispose();
    rotation.open();
    await asking;

    expect(harness.mints).toHaveLength(1);
  });
});

describe("a terminal effect re-checks the credentials file first (L)", () => {
  /** The registry's store: its rotation answers "rejected" for A and is then held before it hands the result back. */
  function rotationRejectedThenHeld(): {
    readonly store: CredentialsMutationStore;
    readonly otherProcess: CredentialsMutationStore;
    readonly rejected: Gate;
  } {
    const store = createCliCredentialsStore();
    const otherProcess = createCliCredentialsStore();
    const rejected = gate();
    injected.wrapStore = (registryStore) => ({
      ...registryStore,
      rotate: async (args) => {
        const result = await registryStore.rotate(args);
        rejected.markReached();
        await rejected.release;
        return result;
      },
    });
    return { store, otherProcess, rejected };
  }

  it("reports nothing and asks again on the saved sign-in when a sibling saves one before a rejected rotation's caller reports", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    credentialsFile.refreshes.push("rejected");
    const { store, otherProcess, rejected } = rotationRejectedThenHeld();
    await store.signIn(credentialsOf(SIGN_IN_A), false, null);
    const { tokens, dispose } = await acquire(null);
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((evidence) => {
      reports.push(evidence.hostId);
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
    expect((await tokens.signInRejectionNow(null)) !== null).toBe(false);
    dispose();
    store.dispose();
    otherProcess.dispose();
  });

  it("does the same through the proactive renewal after a sign-in refresh", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    credentialsFile.refreshes.push("rejected");
    const { store, otherProcess, rejected } = rotationRejectedThenHeld();
    await store.signIn(credentialsOf(SIGN_IN_A), false, null);
    const { tokens, dispose } = await acquire(null);
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((evidence) => {
      reports.push(evidence.hostId);
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
    expect((await tokens.signInRejectionNow(null)) !== null).toBe(false);
    dispose();
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
    const events: string[] = [];
    injected.wrapStore = (registryStore) => ({
      ...registryStore,
      rotate: async (args) => {
        const result = await registryStore.rotate(args);
        events.push("rotated");
        return result;
      },
    });
    injected.onAdopt = () => {
      events.push("adopt");
    };
    const { tokens, dispose } = await acquire(null);
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((evidence) => {
      reports.push(evidence.hostId);
      events.push("report");
    });

    await tokens.mintFresh(hostId, null);

    // Authn refused the refresh of A: one report, made after an adopting read that followed the rotation.
    expect(reports).toEqual([hostId]);
    expect((await tokens.signInRejectionNow(null)) !== null).toBe(true);
    const rotated = events.lastIndexOf("rotated");
    expect(rotated).toBeGreaterThan(-1);
    expect(events.slice(rotated + 1, events.indexOf("report"))).toContain(
      "adopt",
    );
    dispose();
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
      const { tokens, dispose } = await acquire(null);

      await tokens.mintFresh(hostId, null);

      expect((await tokens.signInRejectionNow(null)) !== null).toBe(true);
      dispose();
      store.dispose();
      otherProcess.dispose();
    },
  );
});

describe("an adopted answer with nothing changed ends its loop (N)", () => {
  it("asks no more than once more when the sign-in refresh is adopted and the sign-in presented is unchanged", async () => {
    // Every request is refused until the sixth, so a loop that repeats is seen as asks, not hung.
    harness.answerFor = (index) => (index < 5 ? "refused" : "ok");
    injected.rotate = async () => ({
      outcome: "adopted",
      installed: null,
      refused: null,
      accepted: null,
    });
    const { tokens, dispose } = await acquire(null);

    await tokens
      .streamRecovery(hostId)
      .revalidateRefused(REFUSED_AS_EXPIRED, () => true);

    expect(harness.mints.length).toBeLessThanOrEqual(2);
    dispose();
  });
});

describe("an admission resets only the host process that admitted", () => {
  it("leaves the replacement's recovery spent when a late admission of the replaced process arrives", async () => {
    processReleasedHosts.observeInstance(hostId, "boot-p");
    const processP = processReleasedHosts.currentInstance(hostId);
    injected.rotate = UNREACHABLE_AUTHN;
    const { tokens, dispose } = await acquire(null);
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
    dispose();
  });

  it("gives the recovery of the process that admitted its allowance again", async () => {
    processReleasedHosts.observeInstance(hostId, "boot-p");
    const processP = processReleasedHosts.currentInstance(hostId);
    injected.rotate = UNREACHABLE_AUTHN;
    const { tokens, dispose } = await acquire(null);
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
    dispose();
  });
});

describe("a refusal a later purchase outlived hands its caller the held token (P4)", () => {
  /** The registry's store, whose `read` number `heldRead` is held after its snapshot until released. */
  function holdingRead(heldRead: number): Gate {
    const held = gate();
    let reads = 0;
    injected.wrapStore = (registryStore) => ({
      ...registryStore,
      read: async () => {
        reads += 1;
        const snapshot = await registryStore.read();
        if (reads === heldRead) {
          held.markReached();
          await held.release;
        }
        return snapshot;
      },
    });
    return held;
  }

  it("answers the held token of the later purchase when the refusal to report was outlived during the final adopting read", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    credentialsFile.refreshes.push("rejected");
    const real = createCliCredentialsStore();
    const rejected = gate();
    injected.wrapStore = (registryStore) => ({
      ...registryStore,
      rotate: async (args) => {
        const result = await registryStore.rotate(args);
        rejected.markReached();
        await rejected.release;
        return result;
      },
    });
    await real.signIn(credentialsOf(SIGN_IN_A), false, null);
    const { tokens, dispose } = await acquire(null);
    const asking = tokens.mintFresh(hostId, null);
    // authn has refused the refresh of A; a later request for the same host process buys a token while the caller waits to report.
    await rejected.reached;
    expect((await tokens.mintFresh(hostId, null)).kind).toBe("ok");
    rejected.open();

    expect(await asking).toMatchObject({ kind: "ok" });
    dispose();
    real.dispose();
  });

  it("answers the held token of the later purchase when the recovery's own re-check finds its refusal outlived", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    const real = createCliCredentialsStore();
    await real.signIn(credentialsOf(SIGN_IN_A), false, null);
    // Reads 1 and 2 are the tracker's, before the refusal counts; read 3 is the recovery's own.
    const held = holdingRead(3);
    const { tokens, dispose } = await acquire(null);
    const asking = tokens.mintFresh(hostId, null);
    await held.reached;
    expect((await tokens.mintFresh(hostId, null)).kind).toBe("ok");
    held.open();

    expect(await asking).toMatchObject({ kind: "ok" });
    dispose();
    real.dispose();
  });
});

describe("a direct recovery sends no retry on a sign-in that did not change (P8)", () => {
  it("sends none after a rotation answered rotated while the presented sign-in is still the refused one", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    // authn accepted a refresh, but nothing installed it: the lease still holds A.
    injected.rotate = async () => ({
      outcome: "rotated",
      installed: SIGN_IN_A,
      refused: null,
      accepted: SIGN_IN_B,
    });
    const { tokens, dispose } = await acquire(null);

    const answered = await tokens.mintFresh(hostId, null);

    expect(harness.mints.map((mint) => mint.signIn)).toEqual([SIGN_IN_A]);
    expect(answered.kind).toBe("failed");
    dispose();
  });
});

describe("two token instances of one process share one order of purchases for a host process (P3)", () => {
  it("lets a purchase through the second instance outlive a refusal through the first, by order", async () => {
    harness.answerFor = (index) => (index === 0 ? "refused" : "ok");
    const real = createCliCredentialsStore();
    await real.signIn(credentialsOf(SIGN_IN_A), false, null);
    // Instance 1's mint on A is refused; it waits in its adopting read.
    const held = gate();
    let reads = 0;
    injected.wrapStore = (registryStore) => ({
      ...registryStore,
      read: async () => {
        reads += 1;
        const snapshot = await registryStore.read();
        if (reads === 1) {
          held.markReached();
          await held.release;
        }
        return snapshot;
      },
    });
    let refreshes = 0;
    injected.onRefresh = () => {
      refreshes += 1;
    };
    const first = await acquire(null);
    const second = await acquire(null);
    const asking = first.tokens.mintFresh(hostId, null);
    await held.reached;

    // A later request for the same host process, through the other instance, buys and keeps a token.
    expect((await second.tokens.mintFresh(hostId, null)).kind).toBe("ok");
    held.open();
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
    injected.rotate = UNREACHABLE_AUTHN;
    const { tokens, dispose } = await acquire(null);
    const reports: string[] = [];
    tokens.onRefusalEndingCommand((evidence) => {
      reports.push(evidence.hostId);
    });

    await tokens.mintFresh(hostId, null);

    expect(reports).toEqual([hostId]);
    dispose();
  });
});
