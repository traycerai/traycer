import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import {
  CLIENT_REAUTH_INTERVAL_MS,
  CLIENT_REAUTH_JITTER_MS,
} from "@traycer/protocol/host-transport/remote/config";
import {
  countWebCrypto,
  settleNoise,
} from "@traycer/protocol/host-transport/remote/__tests__/web-crypto-completion-fixture";
import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import type { OpenFrameBearerSource } from "@traycer-clients/shared/auth/bearer-source";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
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

  /** A sign-in refresh that always rotates, counted. */
  const recovery: StreamAuthRevalidator = {
    revalidateForReconnect: () => {
      revalidations += 1;
      return Promise.resolve("rotated");
    },
  };

  function openTransport(): RemoteHostTransport<
    VersionedRpcRegistry,
    VersionedStreamRpcRegistry
  > {
    const bearerSource: OpenFrameBearerSource = {
      getBearerToken: () => SIGN_IN,
      identity: { userId: USER_ID },
    };
    let nextRequestId = 0;
    const transport = createRemoteHostTransport<
      VersionedRpcRegistry,
      VersionedStreamRpcRegistry
    >({
      clientIdentity: TEST_CLIENT_IDENTITY,
      opensReleasedWay: () => false,
      confirmRowBeforeSignIn: null,
      hostId: HOST_ID,
      userId: USER_ID,
      relayAttachUrl: "wss://relay.invalid/attach",
      authnBaseUrl: "https://authn.invalid",
      hostPublicKey: Buffer.from(relay.hostStaticPublicKey).toString("hex"),
      bearer: () => bearerSource,
      hostTokens: tokens,
      door: null,
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
    const { session } = openTransport();
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
    const { session } = openTransport();
    session.start();
    await advanceUntil(() => session.isReady(), 10_000);
    await advanceFeedingHost(() => authn.calls() === 3);
    // The re-auth's own refresh, then its mint again.
    expect(revalidations).toBe(1);

    relay.dropCurrentConnection();
    await advanceUntil(() => authn.calls() >= 5 && session.isReady(), 30_000);

    expect(revalidations).toBe(2);
  });
});
