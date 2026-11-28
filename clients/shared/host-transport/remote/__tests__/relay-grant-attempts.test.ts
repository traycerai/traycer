import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineVersionedRpcRegistry,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import {
  MuxFrameType,
  SESSION_CAPABILITY_CREDENTIAL_UPDATE,
} from "@traycer/protocol/host-transport/mux";
import {
  CLIENT_REAUTH_INTERVAL_MS,
  CLIENT_REAUTH_JITTER_MS,
} from "@traycer/protocol/host-transport/remote/config";
import {
  countWebCrypto,
  settleNoise,
} from "@traycer/protocol/host-transport/remote/__tests__/web-crypto-completion-fixture";
import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { NoiseChannel } from "@traycer/protocol/host-transport/remote/noise-channel";
import { retireAllRemoteSessions } from "../active-remote-sessions";
import {
  createRemoteHostTransport,
  type RemoteHostTransport,
} from "../create-remote-transport";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { VersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { emptyStreamRegistry, FakeRelayHost } from "./fake-relay-host";

const HOST_ID = "relay-grant-attempts-host";
const USER_ID = "user-relay-grant-attempts";
const SIGN_IN = "sign-in-token";
const ROTATED_SIGN_IN = "sign-in-token-rotated";
const SECOND_ROTATED_SIGN_IN = "sign-in-token-rotated-again";
const RELEASED_HOST_ID = "relay-grant-attempts-released-host";
/** What a released host says when its own check refuses a host-only token. */
const RELEASED_REFUSAL: FatalErrorDetails = {
  code: "UNAUTHORIZED",
  reason: "released-host-token-refusal",
  incompatibleMethods: null,
  upgradeGuidance: null,
};

/** How a test's transport is built: its host, whether the row opens released, and its sign-in. */
interface TransportSettings {
  readonly hostId: string;
  /** Read live, as the row is: whether the person's own computer may be handed the sign-in. */
  readonly releasedWay: () => boolean;
  readonly confirmRow: (() => Promise<void>) | null;
  readonly signIn: () => string;
}

const PLAIN_TRANSPORT: TransportSettings = {
  hostId: HOST_ID,
  releasedWay: () => false,
  confirmRow: null,
  signIn: () => SIGN_IN,
};
/** Short of the 15-minute standing bound, so the fake host's sign of life keeps the session. */
const FEED_STROKE_MS = 5 * 60 * 1000;
/** The re-auth cadence plus its jitter always covers the first fire. */
const REAUTH_COVERED_MS = CLIENT_REAUTH_INTERVAL_MS + CLIENT_REAUTH_JITTER_MS;
const emptyRpcRegistry: VersionedRpcRegistry = defineVersionedRpcRegistry({});

type MintAnswer = "ok" | "unauthorized" | "not-admitted";

/**
 * authn's attach-grant endpoint. Request `n` answers with relay pass
 * `relay-pass-n` and host-only token `host-token-n` unless it was scripted,
 * or held until the test answers it.
 */
interface ScriptedAuthn {
  readonly calls: () => number;
  /** Request `n` answers `answer` as soon as it arrives. */
  readonly script: (n: number, answer: MintAnswer) => void;
  /** Request `n` waits for the returned function, which answers it. */
  readonly hold: (n: number) => (answer: MintAnswer) => void;
}

function scriptedAuthn(): ScriptedAuthn {
  let calls = 0;
  const scripted = new Map<number, MintAnswer>();
  const held = new Map<number, Promise<MintAnswer>>();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => {
      calls += 1;
      const own = calls;
      const answer = await (held.get(own) ??
        Promise.resolve(scripted.get(own) ?? "ok"));
      if (answer === "unauthorized") return new Response("", { status: 401 });
      if (answer === "not-admitted") return new Response("", { status: 404 });
      return new Response(
        JSON.stringify({
          grant: `relay-pass-${own}`,
          role: "client",
          expires_in: 300,
          session_grant: `host-token-${own}`,
          session_grant_expires_in: 3_600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return {
    calls: () => calls,
    script: (n, answer) => {
      scripted.set(n, answer);
    },
    hold: (n) => {
      let answer: (value: MintAnswer) => void = () => undefined;
      held.set(
        n,
        new Promise<MintAnswer>((resolve) => {
          answer = resolve;
        }),
      );
      return (value) => answer(value);
    },
  };
}

describe("a relay session's grant mints, each for the attempt that asked", () => {
  let tokens: HostTokenSource;
  let relay: FakeRelayHost;
  let authn: ScriptedAuthn;
  let states: string[];
  let revalidations: number;
  let refreshGate: Promise<RevalidateOutcome> | null;
  let built: RemoteHostTransport<
    VersionedRpcRegistry,
    VersionedStreamRpcRegistry
  > | null;

  beforeEach(() => {
    vi.useFakeTimers();
    countWebCrypto();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tokens = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    relay = new FakeRelayHost();
    authn = scriptedAuthn();
    states = [];
    revalidations = 0;
    refreshGate = null;
    built = null;
  });

  afterEach(async () => {
    built?.session.close();
    retireAllRemoteSessions();
    await settleNoise();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A sign-in refresh that rotates at once, or when `refreshGate` answers; counted. */
  const recovery: StreamAuthRevalidator = {
    revalidateForReconnect: () => {
      revalidations += 1;
      return refreshGate ?? Promise.resolve("rotated");
    },
  };

  function openTransport(
    settings: TransportSettings,
  ): RemoteHostTransport<VersionedRpcRegistry, VersionedStreamRpcRegistry> {
    const bearerSource: OpenFrameBearerSource = {
      getBearerToken: settings.signIn,
      identity: { userId: USER_ID },
    };
    let nextRequestId = 0;
    const transport = createRemoteHostTransport<
      VersionedRpcRegistry,
      VersionedStreamRpcRegistry
    >({
      clientIdentity: TEST_CLIENT_IDENTITY,
      opensReleasedWay: settings.releasedWay,
      confirmRowBeforeSignIn: settings.confirmRow,
      hostId: settings.hostId,
      userId: USER_ID,
      relayAttachUrl: "wss://relay.invalid/attach",
      authnBaseUrl: "https://authn.invalid",
      hostPublicKey: Buffer.from(relay.hostStaticPublicKey).toString("hex"),
      bearer: () => bearerSource,
      hostTokens: tokens,
      door: null,
      showsNobodySignedIn: false,
      onState: (_hostId, state) => states.push(state),
      cloudAuthorized: () => true,
      auth: recovery,
      clock: null,
      rpcRegistry: emptyRpcRegistry,
      streamRegistry: emptyStreamRegistry,
      webSocketFactory: relay.factory,
      requestId: () => `req-${(nextRequestId += 1)}`,
      proactiveWakeEligible: true,
      evidence: NO_TRANSPORT_EVIDENCE,
    });
    if (transport === null) throw new Error("expected a built transport");
    built = transport;
    return transport;
  }

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await settleNoise();
  }

  async function advanceUntil(
    condition: () => boolean,
    maxMs: number,
  ): Promise<void> {
    for (let elapsed = 0; elapsed < maxMs; elapsed += 250) {
      if (condition()) return;
      await advance(250);
    }
    if (!condition()) throw new Error("condition was not reached in time");
  }

  /**
   * Moves the clock until `condition` holds, with the host speaking at least
   * every five minutes, which is inside the host-standing bound: a ready
   * session lives through the re-auth cadence the way it does against a host
   * that is there. The first stretch, which ends before the earliest re-auth
   * can fire, goes in five-minute strokes; the rest goes a second at a time,
   * so a mint the condition waits for is held for no more than a second past
   * its start, well inside the grant request's ten-second timeout.
   */
  async function advanceFeedingHost(condition: () => boolean): Promise<void> {
    const earliestReauthMs =
      CLIENT_REAUTH_INTERVAL_MS - CLIENT_REAUTH_JITTER_MS;
    let elapsed = 0;
    while (elapsed + FEED_STROKE_MS < earliestReauthMs) {
      await vi.advanceTimersByTimeAsync(FEED_STROKE_MS);
      elapsed += FEED_STROKE_MS;
      await relay.sendSignOfLife();
      await settleNoise();
    }
    let sinceHostSpoke = 0;
    while (elapsed < REAUTH_COVERED_MS) {
      if (condition()) return;
      await vi.advanceTimersByTimeAsync(1_000);
      elapsed += 1_000;
      sinceHostSpoke += 1_000;
      if (sinceHostSpoke >= FEED_STROKE_MS) {
        sinceHostSpoke = 0;
        await relay.sendSignOfLife();
      }
      await settleNoise();
    }
    if (!condition()) throw new Error("condition was not reached in time");
  }

  /** A ready session whose re-auth mint (request 2) has been asked and is held. */
  async function readyWithHeldReauthMint(): Promise<{
    readonly session: RemoteHostTransport<
      VersionedRpcRegistry,
      VersionedStreamRpcRegistry
    >["session"];
    readonly answerReauthMint: (answer: MintAnswer) => void;
  }> {
    const answerReauthMint = authn.hold(2);
    const { session } = openTransport(PLAIN_TRANSPORT);
    session.start();
    await advanceUntil(() => session.isReady(), 10_000);
    await advanceFeedingHost(() => authn.calls() === 2);
    return { session, answerReauthMint };
  }

  /** The leg drops, and the redial mints (request 3) and is admitted. */
  async function dropAndRedial(
    session: RemoteHostTransport<
      VersionedRpcRegistry,
      VersionedStreamRpcRegistry
    >["session"],
  ): Promise<void> {
    relay.dropCurrentConnection();
    await advanceUntil(() => authn.calls() === 3 && session.isReady(), 30_000);
    expect(tokens.current(USER_ID, HOST_ID)?.token).toBe("host-token-3");
  }

  /** Waits until the mint's answer has been taken: it re-reads the era once authn answers. */
  async function untilAnswerTaken(answer: () => void): Promise<void> {
    const eraReads = vi.spyOn(tokens, "era");
    const readsBeforeAnswer = eraReads.mock.calls.length;
    answer();
    await advanceUntil(
      () => eraReads.mock.calls.length > readsBeforeAnswer,
      5_000,
    );
    await advance(0);
  }

  it("reports nothing and leaves the session ready when a re-auth mint answers not-admitted after its leg dropped and the redial was admitted", async () => {
    const { session, answerReauthMint } = await readyWithHeldReauthMint();
    await dropAndRedial(session);

    await untilAnswerTaken(() => answerReauthMint("not-admitted"));

    expect(states).toEqual([]);
    expect(session.isReady()).toBe(true);
    expect(session.isClosed()).toBe(false);
  });

  it("spends no sign-in refresh and keeps the redial's host-only token when a re-auth mint answers 401 after its leg dropped", async () => {
    const { session, answerReauthMint } = await readyWithHeldReauthMint();
    await dropAndRedial(session);

    await untilAnswerTaken(() => answerReauthMint("unauthorized"));

    expect(revalidations).toBe(0);
    expect(authn.calls()).toBe(3);
    expect(tokens.current(USER_ID, HOST_ID)?.token).toBe("host-token-3");
    expect(states).toEqual([]);
  });

  it("gives the next dial's first 401 its own sign-in refresh after a ready leg's re-auth spent one", async () => {
    // Request 2 is the ready leg's re-auth; request 4 is the next dial's.
    authn.script(2, "unauthorized");
    authn.script(4, "unauthorized");
    const { session } = openTransport(PLAIN_TRANSPORT);
    session.start();
    await advanceUntil(() => session.isReady(), 10_000);
    await advanceFeedingHost(() => authn.calls() === 3);
    // The re-auth's own refresh, then its mint again.
    expect(revalidations).toBe(1);

    relay.dropCurrentConnection();
    await advanceUntil(() => authn.calls() >= 5 && session.isReady(), 30_000);

    expect(revalidations).toBe(2);
  });

  it("asks authn for no second mint when a sign-in refresh answers rotated after its attempt was retired", async () => {
    authn.script(1, "unauthorized");
    let answerRefresh: (outcome: RevalidateOutcome) => void = () => undefined;
    refreshGate = new Promise<RevalidateOutcome>((resolve) => {
      answerRefresh = resolve;
    });
    const { session } = openTransport(PLAIN_TRANSPORT);
    session.start();
    await advanceUntil(() => revalidations === 1, 10_000);

    session.close();
    retireAllRemoteSessions();
    answerRefresh("rotated");
    await advance(0);

    expect(authn.calls()).toBe(1);
  });

  it("keeps the held host-only token when an adopted token's write is released after its attempt was retired", async () => {
    const inner = createMemoryHostTokenPersistence();
    let writes = 0;
    let releaseWrite: () => void = () => undefined;
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    tokens = createHostTokenSource({
      persistence: {
        load: () => inner.load(),
        update: async (change) => {
          writes += 1;
          await writeHeld;
          return inner.update(change);
        },
      },
      mint: () => Promise.resolve({ kind: "no-sign-in" }),
      signIn: null,
      now: () => Date.now(),
    });
    const { session } = openTransport(PLAIN_TRANSPORT);
    session.start();
    await advanceUntil(() => writes === 1, 10_000);

    session.close();
    retireAllRemoteSessions();
    releaseWrite();
    await advance(0);

    expect(tokens.current(USER_ID, HOST_ID)?.token).not.toBe("host-token-1");
  });

  /** A sign-in refresh the test answers: asked by the next `revalidateForReconnect`. */
  function heldRefresh(): { readonly answer: (o: RevalidateOutcome) => void } {
    let answer: (outcome: RevalidateOutcome) => void = () => undefined;
    refreshGate = new Promise<RevalidateOutcome>((resolve) => {
      answer = resolve;
    });
    return { answer: (outcome) => answer(outcome) };
  }

  /** A released host that takes the sign-in the host-only token's refusal asks for, and the row confirmations a test scripts. */
  function releasedSession(
    hostId: string,
    releasedWay: () => boolean,
    confirmRow: () => Promise<void>,
    signIn: () => string,
  ): RemoteHostTransport<
    VersionedRpcRegistry,
    VersionedStreamRpcRegistry
  >["session"] {
    relay.openAckCapabilities = [SESSION_CAPABILITY_CREDENTIAL_UPDATE];
    relay.decideOpen = (_bearer, openIndex) =>
      relay.openAuthz[openIndex] === null
        ? { kind: "ack" }
        : { kind: "fatal", details: RELEASED_REFUSAL };
    const { session } = openTransport({
      hostId,
      releasedWay,
      confirmRow,
      signIn,
    });
    return session;
  }

  it("writes the rotated sign-in in a credential update while the row's read for the re-auth attach is pending", async () => {
    let signIn = SIGN_IN;
    let reads = 0;
    let finishRead: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    // The second read is the re-auth's: the redial's was the first, and settled at once.
    const confirmRow = (): Promise<void> => {
      reads += 1;
      return reads === 2 ? pending : Promise.resolve();
    };
    const session = releasedSession(
      RELEASED_HOST_ID,
      () => true,
      confirmRow,
      () => signIn,
    );
    session.start();
    await advanceUntil(() => session.isReady(), 15_000);
    expect(relay.openBearers).toEqual(["", SIGN_IN]);
    await advanceFeedingHost(() => reads === 2);

    signIn = ROTATED_SIGN_IN;
    session.notifyBearerRotated();
    await advance(0);

    expect(sentCredentialBearers()).toContain(ROTATED_SIGN_IN);
    finishRead();
  });

  it("keeps the host-only token in a credential update once a read has moved the row off the released way, and writes the sign-in when the row opens the released way again", async () => {
    let signIn = SIGN_IN;
    let released = true;
    let reads = 0;
    // The redial's read (1) leaves the row released; the re-auth's (2) commits
    // a row that no longer opens the released way.
    const confirmRow = (): Promise<void> => {
      reads += 1;
      if (reads === 2) released = false;
      return Promise.resolve();
    };
    const session = releasedSession(
      `${RELEASED_HOST_ID}-row-moved-off`,
      () => released,
      confirmRow,
      () => signIn,
    );
    session.start();
    await advanceUntil(() => session.isReady(), 15_000);
    expect(relay.openBearers).toEqual(["", SIGN_IN]);
    await advanceFeedingHost(() => reads === 2);
    expect(session.isReady()).toBe(true);

    signIn = ROTATED_SIGN_IN;
    const sentBefore = sentCredentialBearers().length;
    session.notifyBearerRotated();
    await advance(0);

    // The row the read committed no longer opens the released way: the sign-in
    // goes nowhere on this leg.
    expect(sentCredentialBearers()).not.toContain(ROTATED_SIGN_IN);
    expect(sentCredentialBearers().slice(sentBefore)).not.toContain(SIGN_IN);

    released = true;
    signIn = SECOND_ROTATED_SIGN_IN;
    session.notifyBearerRotated();
    await advance(0);

    expect(sentCredentialBearers()).toContain(SECOND_ROTATED_SIGN_IN);
  });

  it("gives the relink's attach its own one sign-in refresh after a re-auth's refresh answers rotated for an attach the drop retired, again after a second such answer", async () => {
    // Cycle one: the re-auth's mint (2) is refused, the leg drops, the relink's
    // mint (3) is held and then refused, and its re-mint (4) is admitted.
    // Cycle two: the next re-auth's mint (5) is refused, and the relink's (6)
    // is held and then refused.
    authn.script(2, "unauthorized");
    authn.script(5, "unauthorized");
    const answerFirstRelinkMint = authn.hold(3);
    const answerSecondRelinkMint = authn.hold(6);
    const { session } = openTransport(PLAIN_TRANSPORT);
    session.start();
    await advanceUntil(() => session.isReady(), 10_000);

    const retiredFirst = heldRefresh();
    await advanceFeedingHost(() => revalidations === 1);
    relay.dropCurrentConnection();
    await advanceUntil(() => authn.calls() === 3, 30_000);
    // The retired re-auth's answer spends nothing and asks for no mint.
    retiredFirst.answer("rotated");
    await advance(0);
    expect(authn.calls()).toBe(3);
    expect(revalidations).toBe(1);
    // The relink's own refusal makes its own one refresh.
    refreshGate = null;
    answerFirstRelinkMint("unauthorized");
    await advanceUntil(() => session.isReady() && authn.calls() === 4, 30_000);
    expect(revalidations).toBe(2);

    const retiredSecond = heldRefresh();
    await advanceFeedingHost(() => revalidations === 3);
    relay.dropCurrentConnection();
    await advanceUntil(() => authn.calls() === 6, 30_000);
    retiredSecond.answer("rotated");
    await advance(0);
    expect(authn.calls()).toBe(6);
    expect(revalidations).toBe(3);
    refreshGate = null;
    answerSecondRelinkMint("unauthorized");
    await advanceUntil(() => session.isReady() && authn.calls() === 7, 30_000);
    expect(revalidations).toBe(4);
  });

  /** Holds the seal of each credential update from `arm` until `release`; `held` counts the seals waiting. */
  function holdCredentialSeals(): {
    readonly arm: () => void;
    readonly held: () => number;
    readonly release: () => void;
  } {
    const original = NoiseChannel.prototype.encrypt;
    let gate: Promise<void> | null = null;
    let open: () => void = () => undefined;
    let held = 0;
    vi.spyOn(NoiseChannel.prototype, "encrypt").mockImplementation(
      async function (this: NoiseChannel, muxFrame: Uint8Array) {
        const waiting = gate;
        if (
          waiting !== null &&
          muxFrame[1] === MuxFrameType.CREDENTIAL_UPDATE
        ) {
          held += 1;
          await waiting;
        }
        return original.call(this, muxFrame);
      },
    );
    return {
      arm: () => {
        gate = new Promise<void>((resolve) => {
          open = resolve;
        });
      },
      held: () => held,
      release: () => {
        gate = null;
        open();
      },
    };
  }

  it("never lets a credential update sealed with the sign-in reach the host when the row stops allowing it during the seal, and ends the connection", async () => {
    let row = true;
    const seals = holdCredentialSeals();
    const session = releasedSession(
      `${RELEASED_HOST_ID}-row-flips-in-seal`,
      () => row,
      () => Promise.resolve(),
      () => SIGN_IN,
    );
    session.start();
    await advanceUntil(() => session.isReady(), 15_000);
    expect(relay.openBearers).toEqual(["", SIGN_IN]);

    seals.arm();
    session.notifyBearerRotated();
    await advanceUntil(() => seals.held() === 1, 5_000);
    row = false;
    seals.release();
    // The connection ends, and the next open reads the row afresh: no sign-in.
    await advanceUntil(() => relay.openBearers.length >= 3, 30_000);

    expect(sentCredentialBearers()).toEqual([]);
    expect(relay.openBearers).toEqual(["", SIGN_IN, ""]);
  });

  it("sends a credential update sealed with the sign-in as sealed when the sign-in rotates during the seal and the row still allows it, with the leg up", async () => {
    let signIn = SIGN_IN;
    const seals = holdCredentialSeals();
    const session = releasedSession(
      `${RELEASED_HOST_ID}-rotates-in-seal`,
      () => true,
      () => Promise.resolve(),
      () => signIn,
    );
    session.start();
    await advanceUntil(() => session.isReady(), 15_000);
    expect(relay.openBearers).toEqual(["", SIGN_IN]);

    seals.arm();
    session.notifyBearerRotated();
    await advanceUntil(() => seals.held() === 1, 5_000);
    signIn = ROTATED_SIGN_IN;
    seals.release();
    await advanceUntil(() => sentCredentialBearers().length === 1, 5_000);

    expect(sentCredentialBearers()).toEqual([SIGN_IN]);
    expect(session.isReady()).toBe(true);
    expect(relay.openBearers).toEqual(["", SIGN_IN]);
  });

  /** The bearer of every credential update the fake host has received. */
  function sentCredentialBearers(): string[] {
    const bearers: string[] = [];
    for (const update of relay.credentialUpdates) {
      if (typeof update !== "object" || update === null) continue;
      const bearer: unknown = Reflect.get(update, "bearer");
      if (typeof bearer === "string") bearers.push(bearer);
    }
    return bearers;
  }
});
