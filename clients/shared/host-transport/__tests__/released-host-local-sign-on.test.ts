import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  MutableBearerLease,
  type BearerSourceProvider,
} from "@traycer-clients/shared/auth/bearer-source";
import {
  NO_TRANSPORT_EVIDENCE,
  type TransportEvidenceReporter,
} from "@traycer-clients/shared/host-selection/transport-evidence";
import { RecordingTransportEvidence } from "../../host-selection/__tests__/recording-transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  HOST_RESTARTING_FATAL_CODE,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "@traycer/protocol/host-transport/websocket";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";
import {
  RetryableTransportError,
  type HostTransportEndpoint,
} from "../host-messenger";
import type { IWebSocketFactory } from "../ws-factory";
import type { IStreamWebSocketFactory } from "../ws-stream-factory";
import { RECONNECT_MAX_BACKOFF_MS } from "@traycer/protocol/host-transport/remote/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import {
  hostDoorStateOfRefusal,
  type HostDoorObserver,
  type HostDoorStateKind,
  type StreamDoorObserver,
} from "../host-door-state";
import { signalsBackoff, type IStreamSession } from "../i-stream-session";
import {
  getNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "../negotiated-manifest-registry";
import type { HostCredentialMintOutcome } from "../host-credential-mint-flow";
import { resetNegotiatedStreamVersions } from "../negotiated-stream-version-registry";
import { resetStreamMethodSupportMemo } from "../stream-method-support-registry";
import {
  hostTokenBearer,
  hostTokenStreamAuth,
  trackHostTokenMints,
  type TrackedHostTokens,
} from "../../auth/host-token-lease";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
  hostSignInKey,
} from "../../auth/host-token-source";
import type { HostToken } from "../../auth/host-token-store";
import {
  createReleasedHostMemory,
  releasedSignOnForLocalRow,
  signInForLocalRow,
  type HostInstance,
  type ReleasedHostMemory,
  type ReleasedSignOn,
  type ReleasedSignOnRow,
  type SignInRecovery,
  type SignInRefusal,
} from "../released-sign-on";
import {
  makeStubSocketFactory,
  StubStreamWebSocket,
} from "../__testing__/stub-stream-socket";
import { WsRpcClient } from "../ws-rpc-client";
import {
  WsStreamClient,
  type HostBearerSourceProvider,
} from "../ws-stream-client";
import { echoRegistry } from "./__fixtures__/echo-registry";

const USER_ID = AUTHENTICATED_USER_FIXTURE_ID;
const HOST_TOKEN = "host-only-token";
const SIGN_IN = "person-sign-in";
const ROTATED_SIGN_IN = "person-sign-in-rotated";
const ROTATED_HOST_TOKEN = "host-only-token-rotated";
const WAIT = { timeout: 2_000, interval: 10 };

const PERSONAL_ROW: ReleasedSignOnRow = {
  owner: { kind: "user", id: USER_ID },
  sandbox: null,
};
const TEAM_ROW: ReleasedSignOnRow = {
  owner: { kind: "team", id: "team-1", name: "Team" },
  sandbox: null,
};

// Every case holds a host-only token, so no mint is ever asked for.
const NO_MINTS = trackHostTokenMints(
  {
    current: () => null,
    obtain: () => Promise.resolve({ kind: "no-sign-in" }),
    loaded: () => true,
    whenLoaded: () => Promise.resolve(),
    lastFailureOf: () => null,
  },
  createReleasedHostMemory(),
);

/** A local door whose mint authn has answered `not-admitted`: no host-only token can be had. */
function unobtainableTokens(): TrackedHostTokens {
  let failure: "not-admitted" | null = null;
  return trackHostTokenMints(
    {
      current: () => null,
      obtain: () => {
        failure = "not-admitted";
        return Promise.resolve({ kind: "not-admitted" });
      },
      loaded: () => true,
      whenLoaded: () => Promise.resolve(),
      lastFailureOf: () => failure,
    },
    createReleasedHostMemory(),
  );
}

const sessions: IStreamSession[] = [];
const clients: WsStreamClient<typeof hostStreamRpcRegistry>[] = [];

/** What a released host says when its own check refuses a credential. */
const RELEASED_HOST_REASONS = [
  "Authenticated user does not own this host",
  "Host is not provisioned - run `traycer login` on the host machine to authorize it",
  "Token has been revoked",
] as const;

function releasedRefusal(): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return releasedRefusalSaying("released-host-token-refusal");
}

function releasedRefusalSaying(reason: string): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function namedNotAdmitted(): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason: "not_admitted",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function namedRefusal(
  doorReason: NonNullable<FatalErrorDetails["doorReason"]>,
): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason,
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

/** The shape the host sends: its sign-in verifier cannot get keys, so a retry may admit. */
function retryableNamedRefusal(
  doorReason: NonNullable<FatalErrorDetails["doorReason"]>,
): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason,
      retryable: true,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function bareUnauthorized(): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "the sign-in was not accepted",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function hostRestarting(): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: HOST_RESTARTING_FATAL_CODE,
      reason: "The host is restarting and expects to be back shortly",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable: true,
      restartIntent: {
        tombstoneId: "tombstone-owner-sign-in",
        expiresAt: null,
      },
    },
  };
}

function readFrame(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("frame was not an object");
  }
  const frame: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    frame[key] = entry;
  }
  return frame;
}

function recordingDoor(): {
  readonly door: HostDoorObserver;
  readonly refusals: FatalErrorDetails[];
} {
  const refusals: FatalErrorDetails[] = [];
  return {
    refusals,
    door: {
      refused: (details) => {
        refusals.push(details);
      },
      admitted: () => () => undefined,
    },
  };
}

/** A stream's door, which hears the host id of the socket each answer came from. */
interface StreamRecordingDoor {
  readonly door: StreamDoorObserver;
  readonly admitted: string[];
  readonly refused: Array<{ readonly hostId: string; readonly reason: string }>;
}

function streamRecordingDoor(): StreamRecordingDoor {
  const admitted: string[] = [];
  const refused: Array<{ readonly hostId: string; readonly reason: string }> =
    [];
  return {
    admitted,
    refused,
    door: {
      admitted: (instance) => {
        admitted.push(instance.hostId);
        return () => undefined;
      },
      refused: (details, instance) => {
        refused.push({ hostId: instance.hostId, reason: details.reason });
      },
    },
  };
}

/**
 * The cover a host shows, kept as the app's door observer keeps it
 * (`host-door-observer.ts`): while a connection is admitted no refusal raises
 * a cover, and a connection that is admitted clears the one a refusal raised.
 * Tests read the state it ends in, never how often it was called.
 */
function coverDoor(): {
  readonly door: StreamDoorObserver;
  readonly cover: (hostId: string) => HostDoorStateKind | null;
} {
  const admittedNow = new Map<string, number>();
  const covers = new Map<string, HostDoorStateKind>();
  return {
    cover: (hostId) => covers.get(hostId) ?? null,
    door: {
      admitted: ({ hostId }) => {
        admittedNow.set(hostId, (admittedNow.get(hostId) ?? 0) + 1);
        covers.delete(hostId);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          const left = (admittedNow.get(hostId) ?? 0) - 1;
          if (left > 0) admittedNow.set(hostId, left);
          else admittedNow.delete(hostId);
        };
      },
      refused: (details, { hostId }) => {
        if ((admittedNow.get(hostId) ?? 0) > 0) return;
        const kind = hostDoorStateOfRefusal(details);
        if (kind !== null) covers.set(hostId, kind);
      },
    },
  };
}

function signOnFor(
  row: ReleasedSignOnRow,
  signIn: MutableBearerLease,
): ReleasedSignOn | null {
  return signOnWithMemory(row, signIn, createReleasedHostMemory());
}

function signOnWithMemory(
  row: ReleasedSignOnRow,
  signIn: MutableBearerLease,
  hosts: ReleasedHostMemory,
): ReleasedSignOn | null {
  return signOnReadingRow(() => row, signIn, hosts);
}

/** `readRow` is asked at every decision to present the sign-in, as the app's live directory is. */
function signOnReadingRow(
  readRow: () => ReleasedSignOnRow,
  signIn: MutableBearerLease,
  hosts: ReleasedHostMemory,
): ReleasedSignOn | null {
  return releasedSignOnForLocalRow(
    readRow,
    mockLocalHostEntry.hostId,
    USER_ID,
    () => signIn,
    null,
    NO_MINTS,
    hosts,
  );
}

function makeStreamClient(
  factory: IStreamWebSocketFactory,
  hostToken: MutableBearerLease,
  releasedSignOn: ReleasedSignOn | null,
  door: StreamDoorObserver,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  return makeStreamClientHolding(
    factory,
    () => hostToken,
    hostToken.identity.userId,
    releasedSignOn,
    door,
    NO_TRANSPORT_EVIDENCE,
  );
}

/** `bearer` returns null while no host-only token can be had for this host. */
function makeStreamClientHolding(
  factory: IStreamWebSocketFactory,
  bearer: () => MutableBearerLease | null,
  userId: string,
  releasedSignOn: ReleasedSignOn | null,
  door: StreamDoorObserver,
  evidence: TransportEvidenceReporter,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  return makeStreamClientAt({
    factory,
    endpoint: () => mockLocalHostEntry,
    hostId: mockLocalHostEntry.hostId,
    bearer,
    userId,
    releasedSignOn,
    auth: null,
    door,
    evidence,
  });
}

/** The stream client of {@link makeStreamClientHolding}, dialing a host the test moves. */
function makeStreamClientAt(input: {
  readonly factory: IStreamWebSocketFactory;
  readonly endpoint: () => HostTransportEndpoint;
  /** The host id the client is bound to; `null` follows whatever the endpoint names. */
  readonly hostId: string | null;
  readonly bearer: HostBearerSourceProvider;
  readonly userId: string;
  readonly releasedSignOn: ReleasedSignOn | null;
  readonly auth: StreamAuthRevalidator | null;
  readonly door: StreamDoorObserver;
  readonly evidence: TransportEvidenceReporter;
}): WsStreamClient<typeof hostStreamRpcRegistry> {
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: input.endpoint,
    hostId: input.hostId,
    bearer: input.bearer,
    userId: input.userId,
    releasedSignOn: input.releasedSignOn,
    auth: input.auth,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: input.evidence,
    webSocketFactory: input.factory,
    dialTimeoutMs: 1_000,
    openAckTimeoutMs: 1_000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
    door: input.door,
  });
  clients.push(client);
  return client;
}

function subscribe(client: WsStreamClient<typeof hostStreamRpcRegistry>): {
  readonly session: IStreamSession;
  readonly statuses: string[];
} {
  const session = client.subscribe("git.subscribeStatus", {
    hostId: mockLocalHostEntry.hostId,
    runningDir: "/repo",
    ignoreWhitespace: false,
    freshNonce: null,
  });
  const statuses: string[] = [];
  session.onStatusChange((status) => {
    statuses.push(status);
  });
  sessions.push(session);
  return { session, statuses };
}

async function openFrame(
  socket: StubStreamWebSocket,
): Promise<Record<string, unknown>> {
  socket.fireOpen();
  await vi.waitFor(
    () => expect(socket.textSent.length).toBeGreaterThan(0),
    WAIT,
  );
  return readFrame(socket.textSent[0]);
}

function ack(
  socket: StubStreamWebSocket,
  open: Record<string, unknown>,
  capabilities: readonly string[],
): void {
  socket.fireText({
    kind: "openAck",
    manifest: open.manifest,
    capabilities,
  });
}

function credentialUpdateTokens(socket: StubStreamWebSocket): unknown[] {
  return socket.textSent
    .map((raw) => readFrame(raw))
    .filter((frame) => frame.kind === "credentialUpdate")
    .map((frame) => frame.token);
}

function tokensOf(socket: StubStreamWebSocket): unknown[] {
  return socket.textSent.map((raw) => readFrame(raw).token);
}

async function untilStatus(
  statuses: readonly string[],
  status: "open" | "closed",
): Promise<void> {
  await vi.waitFor(() => expect(statuses).toContain(status), WAIT);
}

// The negotiated registries are module-global: no test starts from another's.
beforeEach(() => {
  resetNegotiatedStreamVersions();
  resetNegotiatedManifests();
  resetStreamMethodSupportMemo();
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  for (const client of clients.splice(0)) client.close("test-done");
  resetNegotiatedStreamVersions();
  resetNegotiatedManifests();
  resetStreamMethodSupportMemo();
  vi.useRealTimers();
});

describe("a late refusal of an earlier sign-in, on the real token source", () => {
  const HOST_ID = mockLocalHostEntry.hostId;
  const jwtExpiring = (exp: number): string =>
    `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
  const SIGN_IN_A = jwtExpiring(2_000_000);
  const SIGN_IN_B = jwtExpiring(2_100_000);

  /**
   * No usable host-only token (or an expired held one); a mint on sign-in A
   * is in flight and the stored sign-in moves to B; B's retry is pending when
   * A's late 401 arrives; then a stream dials.
   */
  async function dialAfterTheLate401(held: HostToken | null): Promise<{
    readonly sockets: StubStreamWebSocket[];
  }> {
    const hosts = createReleasedHostMemory();
    const owner = hosts.currentInstance(HOST_ID);
    let stored = SIGN_IN_A;
    const mints: Array<(outcome: HostTokenMintOutcome) => void> = [];
    const source = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () =>
        new Promise<HostTokenMintOutcome>((resolve) => {
          mints.push(resolve);
        }),
      signIn: (userId) => (userId === USER_ID ? stored : null),
      now: () => Date.now(),
    });
    if (held !== null)
      await source.adopt(
        USER_ID,
        HOST_ID,
        held,
        source.era(USER_ID),
        () => true,
      );
    await source.whenLoaded();
    const tracked = trackHostTokenMints(source, hosts);
    const ask = { signal: null, owner, observedNow: () => owner.observed };
    const onA = source.obtain(USER_ID, HOST_ID, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(1), WAIT);
    stored = SIGN_IN_B;
    void source.obtain(USER_ID, HOST_ID, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(2), WAIT);
    mints[0]({ kind: "sign-in-rejected" });
    await onA;

    const signInLease = new MutableBearerLease(SIGN_IN, USER_ID);
    const { factory, sockets } = makeStubSocketFactory();
    const { door } = recordingDoor();
    const client = makeStreamClientAt({
      factory,
      endpoint: () => mockLocalHostEntry,
      hostId: HOST_ID,
      bearer: hostTokenBearer(
        tracked,
        () => signInLease,
        HOST_ID,
        () => undefined,
      ),
      userId: USER_ID,
      releasedSignOn: releasedSignOnForLocalRow(
        () => PERSONAL_ROW,
        HOST_ID,
        USER_ID,
        () => signInLease,
        null,
        tracked,
        hosts,
      ),
      auth: null,
      door,
      evidence: NO_TRANSPORT_EVIDENCE,
    });
    subscribe(client);
    return { sockets };
  }

  it("probes the door, since authn has refused nothing of the sign-in now stored", async () => {
    const { sockets } = await dialAfterTheLate401(null);

    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
  });

  it("still presents an expired held host-only token during the wait", async () => {
    const held: HostToken = {
      token: "expired-held-host-token",
      expiresAtMs: Date.now() - 60_000,
    };
    const { sockets } = await dialAfterTheLate401(held);

    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    expect((await openFrame(sockets[0])).token).toBe(held.token);
  });
});

describe("released personal host, local stream", () => {
  it("opens with the sign-in after the refusal and pushes that sign-in", async () => {
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const refused = await openFrame(sockets[0]);
    expect(refused.token).toBe(HOST_TOKEN);
    sockets[0].fireText(releasedRefusal());
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const admitted = await openFrame(sockets[1]);
    expect(admitted.token).toBe(SIGN_IN);
    ack(sockets[1], admitted, ["credentialUpdate"]);
    await untilStatus(statuses, "open");
    signIn.rotate(ROTATED_SIGN_IN);
    client.notifyBearerRotated();
    await vi.waitFor(() => {
      const updates = sockets[1].textSent
        .map((raw) => readFrame(raw))
        .filter((frame) => frame.kind === "credentialUpdate");
      expect(updates.map((frame) => frame.token)).toEqual([ROTATED_SIGN_IN]);
    }, WAIT);
    expect(refusals).toEqual([]);
  });

  it("hands the host-only token to a host that names a reason while the sign-in's refresh runs", async () => {
    const hosts = createReleasedHostMemory();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const refreshes: Array<(outcome: RevalidateOutcome) => void> = [];
    const { factory, sockets } = makeStubSocketFactory();
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      releasedSignOnForLocalRow(
        () => PERSONAL_ROW,
        mockLocalHostEntry.hostId,
        USER_ID,
        () => signIn,
        {
          revalidateForReconnect: () =>
            new Promise<RevalidateOutcome>((resolve) => {
              refreshes.push(resolve);
            }),
        },
        NO_MINTS,
        hosts,
      ),
      door,
    );
    subscribe(client);
    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
    sockets[0].fireText(releasedRefusal());
    await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
    expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
    sockets[1].fireText(releasedRefusal());
    await vi.waitFor(() => expect(refreshes).toHaveLength(1), WAIT);
    // Another transport hears this host name a reason while the refresh runs.
    hosts.refusedNamingReason(
      hosts.currentInstance(mockLocalHostEntry.hostId),
      false,
    );
    refreshes[0]("rotated");
    await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
    expect((await openFrame(sockets[2])).token).toBe(HOST_TOKEN);
    expect(refusals).toEqual([]);
  });

  it("reports a restart of the stream opened with the invited owner sign-in, and probes again on the next dial", async () => {
    const hosts = createReleasedHostMemory();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { factory, sockets } = makeStubSocketFactory();
    const { door, refusals } = recordingDoor();
    const evidence = new RecordingTransportEvidence();
    const client = makeStreamClientHolding(
      factory,
      () => null,
      USER_ID,
      {
        signIn: () => signIn,
        recovery: null,
        hostTokenUnobtainable: () => true,
        ownerSignInEligible: () => true,
        heldTokenRefused: () => false,
        forgetHeldRefusal: () => undefined,
        mayPresentSignIn: () => true,
        hosts,
      },
      door,
      evidence,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
    sockets[0].fireText(namedRefusal("owner_sign_in"));
    await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
    const invited = await openFrame(sockets[1]);
    expect(invited.token).toBe(SIGN_IN);
    ack(sockets[1], invited, ["credentialUpdate"]);
    await untilStatus(statuses, "open");

    sockets[1].fireText(hostRestarting());
    await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
    expect((await openFrame(sockets[2])).token).toBe(NO_HOST_TOKEN_PROBE);
    expect(evidence.ofKind("restartIntent")).toEqual([
      {
        kind: "restartIntent",
        hostId: mockLocalHostEntry.hostId,
        tombstoneId: "tombstone-owner-sign-in",
        expiresAt: null,
      },
    ]);
    // The restart raises no door state, and it does not decline the probe.
    expect(refusals).toHaveLength(1);
    expect(hostDoorStateOfRefusal(refusals[0])).toBeNull();
    expect(hosts.probeDeclined(USER_ID, mockLocalHostEntry.hostId)).toBe(false);
  });

  it.each([
    { reason: "host_claimed", state: "host-claimed" },
    { reason: "membership_removed", state: "membership-removed" },
    { reason: "enrolment_broken", state: "enrolment-broken" },
    { reason: "clock_skew", state: "clock-skew" },
  ] as const)(
    "keeps reconnecting without a probe or a sign-in when the invited owner sign-in is refused with $reason, and dials the host-only token once it can be had",
    async ({ reason, state }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      let held: MutableBearerLease | null = null;
      const { factory, sockets } = makeStubSocketFactory();
      const { door, refusals } = recordingDoor();
      const client = makeStreamClientHolding(
        factory,
        () => held,
        USER_ID,
        {
          signIn: () => signIn,
          recovery: null,
          hostTokenUnobtainable: () => held === null,
          ownerSignInEligible: () => held === null,
          heldTokenRefused: () => false,
          forgetHeldRefusal: () => undefined,
          mayPresentSignIn: () => true,
          hosts,
        },
        door,
        NO_TRANSPORT_EVIDENCE,
      );
      const { statuses } = subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
      sockets[0].fireText(namedRefusal("owner_sign_in"));
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
      sockets[1].fireText(namedRefusal(reason));

      await vi.waitFor(
        () => expect(statuses.at(-1)).toBe("reconnecting"),
        WAIT,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sockets).toHaveLength(2);
      expect(statuses).not.toContain("closed");
      expect(hosts.probeDeclined(USER_ID, mockLocalHostEntry.hostId)).toBe(
        true,
      );
      expect(refusals).toHaveLength(1);
      expect(refusals[0].doorReason).toBe(reason);
      expect(hostDoorStateOfRefusal(refusals[0])).toBe(state);

      held = new MutableBearerLease(HOST_TOKEN, USER_ID);
      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      const back = await openFrame(sockets[2]);
      expect(back.token).toBe(HOST_TOKEN);
      ack(sockets[2], back, ["credentialUpdate"]);
      await untilStatus(statuses, "open");
      expect(refusals).toHaveLength(1);
    },
  );

  describe("a retryable keys_unavailable after the invited owner sign-in (guards: the sign-in goes once per invitation)", () => {
    function ownerSignInClient(
      hosts: ReleasedHostMemory,
      signIn: MutableBearerLease,
      factory: IStreamWebSocketFactory,
      door: StreamDoorObserver,
    ): WsStreamClient<typeof hostStreamRpcRegistry> {
      return makeStreamClientHolding(
        factory,
        () => null,
        USER_ID,
        {
          signIn: () => signIn,
          recovery: null,
          hostTokenUnobtainable: () => true,
          ownerSignInEligible: () => true,
          heldTokenRefused: () => false,
          forgetHeldRefusal: () => undefined,
          mayPresentSignIn: () => true,
          hosts,
        },
        door,
        NO_TRANSPORT_EVIDENCE,
      );
    }

    it("probes again after the backoff and sends the sign-in only when invited again", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { factory, sockets } = makeStubSocketFactory();
      const client = ownerSignInClient(
        hosts,
        signIn,
        factory,
        recordingDoor().door,
      );
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
      sockets[0].fireText(namedRefusal("owner_sign_in"));
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
      sockets[1].fireText(retryableNamedRefusal("keys_unavailable"));

      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      expect((await openFrame(sockets[2])).token).toBe(NO_HOST_TOKEN_PROBE);
      sockets[2].fireText(namedRefusal("owner_sign_in"));
      await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
      expect((await openFrame(sockets[3])).token).toBe(SIGN_IN);
      expect(sockets.map((socket) => tokensOf(socket))).toEqual([
        [NO_HOST_TOKEN_PROBE],
        [SIGN_IN],
        [NO_HOST_TOKEN_PROBE],
        [SIGN_IN],
      ]);
    });

    it("writes no sign-in when the next probe is answered with anything but the invitation", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { factory, sockets } = makeStubSocketFactory();
      const client = ownerSignInClient(
        hosts,
        signIn,
        factory,
        recordingDoor().door,
      );
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
      sockets[0].fireText(namedRefusal("owner_sign_in"));
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
      sockets[1].fireText(retryableNamedRefusal("keys_unavailable"));

      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      expect((await openFrame(sockets[2])).token).toBe(NO_HOST_TOKEN_PROBE);
      sockets[2].fireText(namedRefusal("not_provisioned"));
      // The host takes no sign-in from this probe: the next dial probes again.
      await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
      expect((await openFrame(sockets[3])).token).toBe(NO_HOST_TOKEN_PROBE);
      const written = sockets.flatMap((socket) => tokensOf(socket));
      expect(written.filter((token) => token === SIGN_IN)).toHaveLength(1);
      expect(written.slice(0, 3)).toEqual([
        NO_HOST_TOKEN_PROBE,
        SIGN_IN,
        NO_HOST_TOKEN_PROBE,
      ]);
    });
  });

  describe("a named-reason mark ends with the host's local process instance, never with a bare refusal", () => {
    async function dialAfterBareRefusal(forgetBefore: boolean): Promise<{
      readonly sockets: readonly StubStreamWebSocket[];
    }> {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      hosts.observeInstance(mockLocalHostEntry.hostId, "100");
      hosts.refusedNamingReason(
        hosts.currentInstance(mockLocalHostEntry.hostId),
        false,
      );
      // What the directory service reports when the same host id comes back under another pid.
      if (forgetBefore) hosts.observeInstance(mockLocalHostEntry.hostId, "200");
      const { factory, sockets } = makeStubSocketFactory();
      const client = makeStreamClient(
        factory,
        new MutableBearerLease(HOST_TOKEN, USER_ID),
        signOnWithMemory(
          PERSONAL_ROW,
          new MutableBearerLease(SIGN_IN, USER_ID),
          hosts,
        ),
        recordingDoor().door,
      );
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
      sockets[0].fireText(releasedRefusal());
      return { sockets };
    }

    it("sends the sign-in after a bare refusal once the host's named reason was forgotten", async () => {
      const { sockets } = await dialAfterBareRefusal(true);
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
    });

    it("sends no sign-in after the same bare refusal while the named reason stands (control)", async () => {
      const { sockets } = await dialAfterBareRefusal(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sockets.flatMap((socket) => tokensOf(socket))).not.toContain(
        SIGN_IN,
      );
    });
  });

  it("probes again on the next dial when the invited owner sign-in is refused without a door reason", async () => {
    const hosts = createReleasedHostMemory();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { factory, sockets } = makeStubSocketFactory();
    const { door } = recordingDoor();
    const client = makeStreamClientHolding(
      factory,
      () => null,
      USER_ID,
      {
        signIn: () => signIn,
        recovery: null,
        hostTokenUnobtainable: () => true,
        ownerSignInEligible: () => true,
        heldTokenRefused: () => false,
        forgetHeldRefusal: () => undefined,
        mayPresentSignIn: () => true,
        hosts,
      },
      door,
      NO_TRANSPORT_EVIDENCE,
    );
    subscribe(client);
    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
    sockets[0].fireText(namedRefusal("owner_sign_in"));
    await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
    expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
    sockets[1].fireText(bareUnauthorized());

    await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
    expect((await openFrame(sockets[2])).token).toBe(NO_HOST_TOKEN_PROBE);
    expect(hosts.probeDeclined(USER_ID, mockLocalHostEntry.hostId)).toBe(false);
  });

  it.each(["rejected", "local-plane-retained"] as const)(
    "tells the door nothing when the sign-in's refresh that ran past the budget answers %s after the redial was admitted",
    async (late) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
      const refreshes: Array<(outcome: RevalidateOutcome) => void> = [];
      const { factory, sockets } = makeStubSocketFactory();
      const { door, refusals } = recordingDoor();
      const client = makeStreamClient(
        factory,
        hostToken,
        releasedSignOnForLocalRow(
          () => PERSONAL_ROW,
          mockLocalHostEntry.hostId,
          USER_ID,
          () => signIn,
          {
            revalidateForReconnect: () =>
              new Promise<RevalidateOutcome>((resolve) => {
                refreshes.push(resolve);
              }),
          },
          NO_MINTS,
          hosts,
        ),
        door,
      );
      const { statuses } = subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
      sockets[0].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      const admitted = await openFrame(sockets[1]);
      expect(admitted.token).toBe(SIGN_IN);
      ack(sockets[1], admitted, ["credentialUpdate"]);
      await untilStatus(statuses, "open");
      sockets[1].fireText(releasedRefusal());
      await vi.waitFor(() => expect(refreshes).toHaveLength(1), WAIT);

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      const redialed = await openFrame(sockets[2]);
      expect(redialed.token).toBe(SIGN_IN);
      ack(sockets[2], redialed, ["credentialUpdate"]);
      await vi.waitFor(() => expect(statuses.at(-1)).toBe("open"), WAIT);

      refreshes[0](late);
      await vi.advanceTimersByTimeAsync(0);
      expect(refusals).toEqual([]);
      expect(sockets).toHaveLength(3);
    },
  );

  it("keeps the owner sign-in and the door untouched when a refresh that ran past the budget answers rejected after the redial was admitted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hosts = createReleasedHostMemory();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const refreshes: Array<(outcome: RevalidateOutcome) => void> = [];
    const { factory, sockets } = makeStubSocketFactory();
    const { door, refusals } = recordingDoor();
    const client = makeStreamClientHolding(
      factory,
      () => null,
      USER_ID,
      {
        signIn: () => signIn,
        recovery: {
          revalidateForReconnect: () =>
            new Promise<RevalidateOutcome>((resolve) => {
              refreshes.push(resolve);
            }),
        },
        hostTokenUnobtainable: () => true,
        ownerSignInEligible: () => true,
        heldTokenRefused: () => false,
        forgetHeldRefusal: () => undefined,
        mayPresentSignIn: () => true,
        hosts,
      },
      door,
      NO_TRANSPORT_EVIDENCE,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
    sockets[0].fireText(namedRefusal("owner_sign_in"));
    await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
    expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
    sockets[1].fireText(namedRefusal("token_expired"));
    await vi.waitFor(() => expect(refreshes).toHaveLength(1), WAIT);

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
    // The invitation was spent by the sign-in it invited: the redial asks the
    // host again, and the sign-in goes when the host invites it again.
    expect((await openFrame(sockets[2])).token).toBe(NO_HOST_TOKEN_PROBE);
    sockets[2].fireText(namedRefusal("owner_sign_in"));
    await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
    const redialed = await openFrame(sockets[3]);
    expect(redialed.token).toBe(SIGN_IN);
    ack(sockets[3], redialed, ["credentialUpdate"]);
    await untilStatus(statuses, "open");

    refreshes[0]("rejected");
    await vi.advanceTimersByTimeAsync(0);
    signIn.rotate(ROTATED_SIGN_IN);
    client.notifyBearerRotated();
    expect(credentialUpdateTokens(sockets[3])).toEqual([ROTATED_SIGN_IN]);
    expect(refusals).toEqual([]);
  });

  it("keeps the sign-in off a team computer and the door hears the refusal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      signOnFor(TEAM_ROW, signIn),
      door,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const open = await openFrame(sockets[0]);
    expect(open.token).toBe(HOST_TOKEN);
    sockets[0].fireText(releasedRefusal());
    await untilStatus(statuses, "closed");
    expect(refusals).toHaveLength(1);
    expect(hostDoorStateOfRefusal(refusals[0])).toBe("older-host");
    expect(sockets).toHaveLength(1);
    expect(tokensOf(sockets[0])).not.toContain(SIGN_IN);
    const opensAtClose = sockets.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(opensAtClose);
  });

  it("never presents the sign-in to a current local host, including after a drop", async () => {
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const first = await openFrame(sockets[0]);
    expect(first.token).toBe(HOST_TOKEN);
    ack(sockets[0], first, ["credentialUpdate"]);
    await untilStatus(statuses, "open");
    signIn.rotate(ROTATED_SIGN_IN);
    client.notifyBearerRotated();
    expect(tokensOf(sockets[0])).not.toContain(SIGN_IN);
    expect(tokensOf(sockets[0])).not.toContain(ROTATED_SIGN_IN);
    sockets[0].fireClose(1006, "drop");
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const second = await openFrame(sockets[1]);
    expect(second.token).toBe(HOST_TOKEN);
    ack(sockets[1], second, ["credentialUpdate"]);
    signIn.rotate(SIGN_IN);
    client.notifyBearerRotated();
    expect(tokensOf(sockets[1])).not.toContain(SIGN_IN);
    expect(refusals).toEqual([]);
  });

  it("returns to the host-only token after a drop once the host admits it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
    sockets[0].fireText(releasedRefusal());
    await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
    const admitted = await openFrame(sockets[1]);
    expect(admitted.token).toBe(SIGN_IN);
    ack(sockets[1], admitted, ["credentialUpdate"]);
    await untilStatus(statuses, "open");

    // The host was updated meanwhile: it admits the host-only token.
    sockets[1].fireClose(1006, "drop");
    await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
    const updated = await openFrame(sockets[2]);
    expect(updated.token).toBe(HOST_TOKEN);
    ack(sockets[2], updated, ["credentialUpdate"]);
    hostToken.rotate(ROTATED_HOST_TOKEN);
    signIn.rotate(ROTATED_SIGN_IN);
    client.notifyBearerRotated();
    expect(credentialUpdateTokens(sockets[2])).toEqual([ROTATED_HOST_TOKEN]);
    sockets[2].fireClose(1006, "drop");
    await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
    expect((await openFrame(sockets[3])).token).toBe(ROTATED_HOST_TOKEN);
    expect(sockets.flatMap((socket) => tokensOf(socket))).not.toContain(
      ROTATED_SIGN_IN,
    );
    expect(refusals).toEqual([]);
  });

  it("opens every dial sequence with the host-only token and takes the sign-in only after it is refused", async () => {
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    const { statuses } = subscribe(client);
    for (const first of [0, 2]) {
      await vi.waitFor(() => expect(sockets).toHaveLength(first + 1), WAIT);
      expect((await openFrame(sockets[first])).token).toBe(HOST_TOKEN);
      sockets[first].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(first + 2), WAIT);
      const admitted = await openFrame(sockets[first + 1]);
      expect(admitted.token).toBe(SIGN_IN);
      ack(sockets[first + 1], admitted, ["credentialUpdate"]);
      await vi.waitFor(() => expect(statuses.at(-1)).toBe("open"), WAIT);
      if (first === 0) sockets[first + 1].fireClose(1006, "drop");
    }
    expect(
      sockets.map((socket) => readFrame(socket.textSent[0]).token),
    ).toEqual([HOST_TOKEN, SIGN_IN, HOST_TOKEN, SIGN_IN]);
    expect(refusals).toEqual([]);
  });

  it("keeps the sign-in off a host remembered as released that now names a reason", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hosts = createReleasedHostMemory();
    hosts.signInAdmitted(
      USER_ID,
      hosts.currentInstance(mockLocalHostEntry.hostId),
    );
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      signOnWithMemory(PERSONAL_ROW, signIn, hosts),
      door,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
    sockets[0].fireText(namedNotAdmitted());
    await untilStatus(statuses, "closed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets.map((socket) => tokensOf(socket))).toEqual([[HOST_TOKEN]]);
    expect(refusals).toHaveLength(1);
  });

  it.each([
    {
      name: "a current personal host that admits the host-only token",
      row: PERSONAL_ROW,
      refuses: false,
    },
    {
      name: "a current team host that refuses it by name",
      row: TEAM_ROW,
      refuses: true,
    },
  ])(
    "presents no sign-in from a stale memory to $name",
    async ({ row, refuses }) => {
      const hosts = createReleasedHostMemory();
      hosts.signInAdmitted(
        USER_ID,
        hosts.currentInstance(mockLocalHostEntry.hostId),
      );
      const { factory, sockets } = makeStubSocketFactory();
      const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { door } = recordingDoor();
      const client = makeStreamClient(
        factory,
        hostToken,
        signOnWithMemory(row, signIn, hosts),
        door,
      );
      const { statuses } = subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      const open = await openFrame(sockets[0]);
      expect(open.token).toBe(HOST_TOKEN);
      if (refuses) {
        sockets[0].fireText(namedNotAdmitted());
        await untilStatus(statuses, "closed");
      } else {
        ack(sockets[0], open, ["credentialUpdate"]);
        await untilStatus(statuses, "open");
        signIn.rotate(ROTATED_SIGN_IN);
        client.notifyBearerRotated();
      }
      expect(sockets).toHaveLength(1);
      expect(sockets.flatMap((socket) => tokensOf(socket))).not.toContain(
        SIGN_IN,
      );
      expect(sockets.flatMap((socket) => tokensOf(socket))).not.toContain(
        ROTATED_SIGN_IN,
      );
    },
  );

  it("tells the door nothing when the personal host refuses the sign-in too, and ends without dialing again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    await openFrame(sockets[0]);
    sockets[0].fireText(releasedRefusal());
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const signInOpen = await openFrame(sockets[1]);
    expect(signInOpen.token).toBe(SIGN_IN);
    sockets[1].fireText(releasedRefusal());
    await untilStatus(statuses, "closed");
    // A refusal of the person's sign-in is never the "older host" cover.
    expect(refusals).toEqual([]);
    const opensAtClose = sockets.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(opensAtClose);
  });

  it.each(RELEASED_HOST_REASONS)(
    "tells the door nothing when the personal host refuses the sign-in bare with %j",
    async (reason) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { factory, sockets } = makeStubSocketFactory();
      const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { door, refused } = streamRecordingDoor();
      const client = makeStreamClient(
        factory,
        hostToken,
        signOnFor(PERSONAL_ROW, signIn),
        door,
      );
      const { statuses } = subscribe(client);
      await vi.waitFor(
        () => expect(sockets.length).toBeGreaterThanOrEqual(1),
        WAIT,
      );
      await openFrame(sockets[0]);
      sockets[0].fireText(releasedRefusalSaying(reason));
      await vi.waitFor(
        () => expect(sockets.length).toBeGreaterThanOrEqual(2),
        WAIT,
      );
      const signInOpen = await openFrame(sockets[1]);
      expect(signInOpen.token).toBe(SIGN_IN);
      sockets[1].fireText(releasedRefusalSaying(reason));
      await untilStatus(statuses, "closed");
      expect(refused).toEqual([]);
    },
  );

  describe("the row and the host's named reason are read again at every ask", () => {
    interface Dialed {
      readonly client: WsStreamClient<typeof hostStreamRpcRegistry>;
      readonly sockets: StubStreamWebSocket[];
      readonly statuses: string[];
      readonly refusals: FatalErrorDetails[];
      readonly hosts: ReleasedHostMemory;
      readonly signIn: MutableBearerLease;
    }

    function dial(readRow: () => ReleasedSignOnRow): Dialed {
      const { factory, sockets } = makeStubSocketFactory();
      const hosts = createReleasedHostMemory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { door, refusals } = recordingDoor();
      const client = makeStreamClient(
        factory,
        new MutableBearerLease(HOST_TOKEN, USER_ID),
        signOnReadingRow(readRow, signIn, hosts),
        door,
      );
      const { statuses } = subscribe(client);
      return { client, sockets, statuses, refusals, hosts, signIn };
    }

    /** The host-only token is refused bare and the sign-in's socket is admitted. */
    async function admitSignIn(dialed: Dialed): Promise<void> {
      await vi.waitFor(() => expect(dialed.sockets).toHaveLength(1), WAIT);
      expect((await openFrame(dialed.sockets[0])).token).toBe(HOST_TOKEN);
      dialed.sockets[0].fireText(releasedRefusal());
      await vi.waitFor(() => expect(dialed.sockets).toHaveLength(2), WAIT);
      const open = await openFrame(dialed.sockets[1]);
      expect(open.token).toBe(SIGN_IN);
      ack(dialed.sockets[1], open, ["credentialUpdate"]);
      await untilStatus(dialed.statuses, "open");
    }

    it("sends the sign-in when the row became the person's own between the dial and the host's bare refusal", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let row: ReleasedSignOnRow = TEAM_ROW;
      const dialed = dial(() => row);
      await vi.waitFor(() => expect(dialed.sockets).toHaveLength(1), WAIT);
      await openFrame(dialed.sockets[0]);
      row = PERSONAL_ROW;
      dialed.sockets[0].fireText(releasedRefusal());
      await vi.waitFor(() => expect(dialed.sockets).toHaveLength(2), WAIT);
      expect((await openFrame(dialed.sockets[1])).token).toBe(SIGN_IN);
      expect(dialed.refusals).toEqual([]);
    });

    it("sends no sign-in and tells the door when the row left the person between the dial and the host's bare refusal", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let row: ReleasedSignOnRow = PERSONAL_ROW;
      const dialed = dial(() => row);
      await vi.waitFor(() => expect(dialed.sockets).toHaveLength(1), WAIT);
      await openFrame(dialed.sockets[0]);
      row = TEAM_ROW;
      dialed.sockets[0].fireText(releasedRefusal());
      await untilStatus(dialed.statuses, "closed");
      expect(dialed.refusals).toHaveLength(1);
      expect(hostDoorStateOfRefusal(dialed.refusals[0])).toBe("older-host");
      expect(dialed.sockets).toHaveLength(1);
    });

    it("pushes the sign-in's rotation to an admitted sign-in socket while nothing has changed (guard)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const dialed = dial(() => PERSONAL_ROW);
      await admitSignIn(dialed);
      dialed.signIn.rotate(ROTATED_SIGN_IN);
      dialed.client.notifyBearerRotated();
      await vi.waitFor(
        () =>
          expect(credentialUpdateTokens(dialed.sockets[1])).toEqual([
            ROTATED_SIGN_IN,
          ]),
        WAIT,
      );
    });

    it("pushes the host-only token, not the sign-in, once another transport heard the host name a reason", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const dialed = dial(() => PERSONAL_ROW);
      await admitSignIn(dialed);
      dialed.hosts.refusedNamingReason(
        dialed.hosts.currentInstance(mockLocalHostEntry.hostId),
        false,
      );
      dialed.signIn.rotate(ROTATED_SIGN_IN);
      dialed.client.notifyBearerRotated();
      await vi.waitFor(
        () =>
          expect(credentialUpdateTokens(dialed.sockets[1])).toEqual([
            HOST_TOKEN,
          ]),
        WAIT,
      );
    });

    it("pushes the host-only token, not the sign-in, once the row no longer allows the sign-in", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let row: ReleasedSignOnRow = PERSONAL_ROW;
      const dialed = dial(() => row);
      await admitSignIn(dialed);
      row = TEAM_ROW;
      dialed.signIn.rotate(ROTATED_SIGN_IN);
      dialed.client.notifyBearerRotated();
      await vi.waitFor(
        () =>
          expect(credentialUpdateTokens(dialed.sockets[1])).toEqual([
            HOST_TOKEN,
          ]),
        WAIT,
      );
    });
  });

  it("keeps every later dial on the host-only token when an admitted stream is closed without a door reason", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      signOnFor(PERSONAL_ROW, signIn),
      door,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const open = await openFrame(sockets[0]);
    expect(open.token).toBe(HOST_TOKEN);
    ack(sockets[0], open, ["credentialUpdate"]);
    await untilStatus(statuses, "open");
    sockets[0].fireText(releasedRefusal());
    // The stub sends no open until the test opens it, so a dial that appears
    // after the fatal is read the same way as the first.
    await vi.waitFor(() => {
      for (const socket of sockets) {
        if (socket.textSent.length === 0) socket.fireOpen();
      }
      expect(
        sockets.flatMap((socket) =>
          socket.textSent
            .map((raw) => readFrame(raw))
            .filter((frame) => frame.kind === "open")
            .map((frame) => frame.token),
        ),
      ).toEqual([HOST_TOKEN]);
      expect(sockets.flatMap((socket) => tokensOf(socket))).not.toContain(
        SIGN_IN,
      );
      expect(sockets).toHaveLength(1);
      expect(refusals).toHaveLength(1);
      expect(hostDoorStateOfRefusal(refusals[0])).toBe("older-host");
      expect(statuses).toContain("closed");
    }, WAIT);
    const opensAtClose = sockets.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(opensAtClose);
  });

  it("redials the sign-in when the sign-in connection is closed without a door reason", async () => {
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const recovered: string[] = [];
    const recovery: SignInRecovery = {
      revalidateForReconnect: () => {
        recovered.push("revalidated");
        return Promise.resolve("rotated");
      },
    };
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      releasedSignOnForLocalRow(
        () => PERSONAL_ROW,
        mockLocalHostEntry.hostId,
        USER_ID,
        () => signIn,
        recovery,
        NO_MINTS,
        createReleasedHostMemory(),
      ),
      door,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const refused = await openFrame(sockets[0]);
    expect(refused.token).toBe(HOST_TOKEN);
    sockets[0].fireText(releasedRefusal());
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const admitted = await openFrame(sockets[1]);
    expect(admitted.token).toBe(SIGN_IN);
    ack(sockets[1], admitted, ["credentialUpdate"]);
    await untilStatus(statuses, "open");
    sockets[1].fireText(releasedRefusal());
    await vi.waitFor(() => expect(recovered).toHaveLength(1), WAIT);
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(3),
      WAIT,
    );
    const again = await openFrame(sockets[2]);
    expect(again.token).toBe(SIGN_IN);
    expect(refusals).toEqual([]);
  });

  describe("one dial sequence spends at most one sign-in refresh", () => {
    /** A refresh that rotates the sign-in to a new bearer every time it runs. */
    function rotatingRefresh(signIn: MutableBearerLease): {
      readonly recovery: StreamAuthRevalidator;
      readonly calls: () => number;
    } {
      let calls = 0;
      const rotate = (): Promise<RevalidateOutcome> => {
        calls += 1;
        signIn.rotate(`sign-in-${calls}`);
        return Promise.resolve("rotated");
      };
      return {
        calls: () => calls,
        recovery: { revalidateForReconnect: rotate, revalidateRefused: rotate },
      };
    }

    interface ReleasedStreamRig {
      readonly client: WsStreamClient<typeof hostStreamRpcRegistry>;
      readonly sockets: StubStreamWebSocket[];
      readonly session: IStreamSession;
      readonly statuses: string[];
    }

    function releasedStream(
      signIn: MutableBearerLease,
      recovery: SignInRecovery,
    ): {
      readonly client: WsStreamClient<typeof hostStreamRpcRegistry>;
      readonly sockets: StubStreamWebSocket[];
      readonly session: IStreamSession;
      readonly statuses: string[];
    } {
      const { factory, sockets } = makeStubSocketFactory();
      const client = makeStreamClient(
        factory,
        new MutableBearerLease(HOST_TOKEN, USER_ID),
        releasedSignOnForLocalRow(
          () => PERSONAL_ROW,
          mockLocalHostEntry.hostId,
          USER_ID,
          () => signIn,
          recovery,
          NO_MINTS,
          createReleasedHostMemory(),
        ),
        recordingDoor().door,
      );
      return { client, sockets, ...subscribe(client) };
    }

    it("runs the refresh once when the host refuses every sign-in bare and each refresh answers rotated with a new bearer", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const refresh = rotatingRefresh(signIn);
      const { sockets } = releasedStream(signIn, refresh.recovery);
      // The host refuses every open the released way, answered as each dial appears.
      const opened = new Set<StubStreamWebSocket>();
      const refused = new Set<StubStreamWebSocket>();
      for (let round = 0; round < 120; round += 1) {
        await vi.advanceTimersByTimeAsync(50);
        for (const socket of sockets) {
          if (!opened.has(socket)) {
            opened.add(socket);
            socket.fireOpen();
          } else if (!refused.has(socket) && socket.textSent.length > 0) {
            refused.add(socket);
            socket.fireText(releasedRefusal());
          }
        }
      }
      expect(refresh.calls()).toBe(1);
    });

    it("spends nothing when the recovery adopts a sibling's rotation, so a later refusal still gets one real refresh", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      let calls = 0;
      const { sockets } = releasedStream(signIn, {
        revalidateForReconnect: () => {
          calls += 1;
          if (calls === 1) {
            // A sibling rotated the sign-in; the store's value is taken and authn is not asked.
            signIn.rotate("sign-in-adopted");
            return Promise.resolve("adopted");
          }
          signIn.rotate("sign-in-refreshed");
          return Promise.resolve("rotated");
        },
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
      sockets[0].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
      sockets[1].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      expect((await openFrame(sockets[2])).token).toBe("sign-in-adopted");
      sockets[2].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
      expect((await openFrame(sockets[3])).token).toBe("sign-in-refreshed");
      expect(calls).toBe(2);
    });

    it("tells the recovery the sign-in the host refused, and presents the sibling's rotation it adopts next", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const asked: Array<string | null> = [];
      const { sockets } = releasedStream(signIn, {
        revalidateForReconnect: (_owner, refusal) => {
          asked.push(refusal === null ? null : refusal.signIn);
          // The store held a sibling's sign-in: it is taken, authn is not asked.
          signIn.rotate("sign-in-of-a-sibling");
          return Promise.resolve("adopted");
        },
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
      sockets[0].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);

      sockets[1].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);

      expect(asked).toEqual([hostSignInKey(SIGN_IN)]);
      expect((await openFrame(sockets[2])).token).toBe("sign-in-of-a-sibling");
    });

    describe("a refusal of a sign-in the lease has already replaced", () => {
      /** The stream presents SIGN_IN to a released host, which refuses it bare. */
      async function refusedOnSignIn(
        signIn: MutableBearerLease,
        asked: Array<string | null>,
      ): Promise<ReleasedStreamRig> {
        const rig = releasedStream(signIn, {
          revalidateForReconnect: (_owner, refusal) => {
            asked.push(refusal === null ? null : refusal.signIn);
            return Promise.resolve("rotated");
          },
        });
        await vi.waitFor(() => expect(rig.sockets).toHaveLength(1), WAIT);
        expect((await openFrame(rig.sockets[0])).token).toBe(HOST_TOKEN);
        rig.sockets[0].fireText(releasedRefusal());
        await vi.waitFor(() => expect(rig.sockets).toHaveLength(2), WAIT);
        expect((await openFrame(rig.sockets[1])).token).toBe(SIGN_IN);
        return rig;
      }

      it("is answered adopted without asking the recovery, and redials once on the lease's bearer", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
        const asked: Array<string | null> = [];
        const { sockets } = await refusedOnSignIn(signIn, asked);

        signIn.rotate("sign-in-of-a-sibling");
        sockets[1].fireText(releasedRefusal());
        await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
        expect((await openFrame(sockets[2])).token).toBe(
          "sign-in-of-a-sibling",
        );
        expect(asked).toEqual([]);
        expect(sockets).toHaveLength(3);
      });

      it("spends no refresh and no no-progress count, so the lease's own sign-in refused later still gets one real refresh", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
        const asked: Array<string | null> = [];
        const { sockets, statuses } = await refusedOnSignIn(signIn, asked);

        // More stale refusals in a row than the no-progress bound allows: each
        // judged a sign-in the lease had already replaced with a newer one.
        let presented = SIGN_IN;
        for (let round = 1; round <= 4; round += 1) {
          const next = `sign-in-of-a-sibling-${round}`;
          signIn.rotate(next);
          sockets[round].fireText(releasedRefusal());
          await vi.waitFor(() => expect(sockets).toHaveLength(round + 2), WAIT);
          expect((await openFrame(sockets[round + 1])).token).toBe(next);
          presented = next;
        }
        expect(asked).toEqual([]);

        // The sign-in the lease holds is now refused itself: the recovery is asked,
        // for that sign-in, and its refresh is the sequence's first.
        sockets[5].fireText(releasedRefusal());
        await vi.waitFor(
          () => expect(asked).toEqual([hostSignInKey(presented)]),
          WAIT,
        );
        await vi.waitFor(() => expect(sockets).toHaveLength(7), WAIT);
        expect(statuses).not.toContain("closed");
      });

      it("answers a stale refusal adopted and redials on the held sign-in after the dial sequence's refresh was spent, then again for a third sign-in", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
        const asked: Array<string | null> = [];
        const { sockets } = await refusedOnSignIn(signIn, asked);

        // The sign-in the lease holds is refused: the sequence's one refresh is spent.
        sockets[1].fireText(releasedRefusal());
        await vi.waitFor(
          () => expect(asked).toEqual([hostSignInKey(SIGN_IN)]),
          WAIT,
        );
        await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
        expect((await openFrame(sockets[2])).token).toBe(SIGN_IN);

        // Two sign-ins later the older ones are refused, both stale.
        signIn.rotate("sign-in-b");
        sockets[2].fireText(releasedRefusal());
        await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
        expect((await openFrame(sockets[3])).token).toBe("sign-in-b");
        signIn.rotate("sign-in-c");
        sockets[3].fireText(releasedRefusal());
        await vi.waitFor(() => expect(sockets).toHaveLength(5), WAIT);
        expect((await openFrame(sockets[4])).token).toBe("sign-in-c");

        expect(asked).toEqual([hostSignInKey(SIGN_IN)]);
      });

      it("asks the recovery as it does today when the lease holds no bearer", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
        const asked: Array<string | null> = [];
        const { sockets } = await refusedOnSignIn(signIn, asked);

        signIn.rotate("");
        sockets[1].fireText(releasedRefusal());

        await vi.waitFor(
          () => expect(asked).toEqual([hostSignInKey(SIGN_IN)]),
          WAIT,
        );
      });
    });

    it("starts no rotation when the consumer closes the stream as the sign-in's refusal moves it to reconnecting", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      let calls = 0;
      const { sockets, session, statuses } = releasedStream(signIn, {
        revalidateForReconnect: () => {
          calls += 1;
          signIn.rotate("sign-in-refreshed");
          return Promise.resolve("rotated");
        },
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
      sockets[0].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
      // The consumer ends the stream in the status callback of the refusal's
      // own move to reconnecting, while the recovery's owner stays alive.
      session.onStatusChange((status) => {
        statuses.push(status);
        if (status === "reconnecting") session.close();
      });

      sockets[1].fireText(releasedRefusal());
      await vi.waitFor(() => expect(statuses).toContain("reconnecting"), WAIT);
      // Past the longest redial backoff: nothing follows the end.
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS);

      expect(calls).toBe(0);
      expect(sockets).toHaveLength(2);
      expect(statuses).not.toContain("open");
    });

    describe("a refusal judged against a sign-in a credential update has since replaced", () => {
      const REPLACED_BY = "sign-in-renewed";

      /**
       * The stream is admitted on sign-in A, the renewal installs B and the
       * stream writes the credential update (never acked), then the host's
       * fatal sign-in refusal arrives: it may be of A or of B.
       */
      async function ambiguousRefusal(): Promise<{
        readonly sockets: StubStreamWebSocket[];
        readonly statuses: string[];
        readonly asked: Array<string | null>;
      }> {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
        const asked: Array<string | null> = [];
        const { client, sockets, statuses } = releasedStream(signIn, {
          revalidateForReconnect: (_owner, refusal) => {
            asked.push(refusal === null ? null : refusal.signIn);
            signIn.rotate("sign-in-refreshed");
            return Promise.resolve("rotated");
          },
        });
        await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
        expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
        sockets[0].fireText(releasedRefusal());
        await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
        const open = await openFrame(sockets[1]);
        expect(open.token).toBe(SIGN_IN);
        ack(sockets[1], open, ["credentialUpdate"]);
        await untilStatus(statuses, "open");
        signIn.rotate(REPLACED_BY);
        client.notifyBearerRotated();
        await vi.waitFor(
          () =>
            expect(credentialUpdateTokens(sockets[1])).toEqual([REPLACED_BY]),
          WAIT,
        );

        sockets[1].fireText(releasedRefusal());
        await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
        // One reconnect, on the renewed sign-in, and no rotation for it.
        expect(asked).toEqual([]);
        expect((await openFrame(sockets[2])).token).toBe(REPLACED_BY);
        return { sockets, statuses, asked };
      }

      it("reconnects once on the stored sign-in with no rotation, and spends none when that one is admitted", async () => {
        const { sockets, statuses, asked } = await ambiguousRefusal();
        const open = readFrame(sockets[2].textSent[0]);

        ack(sockets[2], open, ["credentialUpdate"]);
        await vi.waitFor(
          () => expect(statuses.filter((s) => s === "open")).toHaveLength(2),
          WAIT,
        );

        expect(asked).toEqual([]);
        expect(sockets).toHaveLength(3);
      });

      it("rotates exactly once, for the renewed sign-in, when the one reconnect is refused too", async () => {
        const { sockets, asked } = await ambiguousRefusal();

        sockets[2].fireText(releasedRefusal());
        await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);

        expect(asked).toEqual([hostSignInKey(REPLACED_BY)]);
        expect((await openFrame(sockets[3])).token).toBe("sign-in-refreshed");
      });
    });

    it("lets a new sequence spend one again once the host admitted a connection", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const refresh = rotatingRefresh(signIn);
      const { sockets, statuses } = releasedStream(signIn, refresh.recovery);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
      sockets[0].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
      sockets[1].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      const admitted = await openFrame(sockets[2]);
      expect(admitted.token).toBe("sign-in-1");
      ack(sockets[2], admitted, []);
      await untilStatus(statuses, "open");
      expect(refresh.calls()).toBe(1);

      // The connection drops; the next dial sequence refuses and refreshes again.
      sockets[2].fireClose(1006, "dropped");
      await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
      expect((await openFrame(sockets[3])).token).toBe(HOST_TOKEN);
      sockets[3].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(5), WAIT);
      expect((await openFrame(sockets[4])).token).toBe("sign-in-1");
      sockets[4].fireText(releasedRefusal());
      await vi.waitFor(() => expect(refresh.calls()).toBe(2), WAIT);
    });

    it("keeps redialing on its backoff while authn does not answer the sign-in's refresh, and recovers when it does", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      let unreachable = 6;
      const refresh = (): Promise<RevalidateOutcome> => {
        if (unreachable > 0) {
          unreachable -= 1;
          return Promise.resolve("network-error");
        }
        signIn.rotate(ROTATED_SIGN_IN);
        return Promise.resolve("rotated");
      };
      const { sockets, statuses } = releasedStream(signIn, {
        revalidateForReconnect: refresh,
      });
      // The host refuses every open the released way except the rotated
      // sign-in, answered as each dial appears.
      const opened = new Set<StubStreamWebSocket>();
      const answered = new Set<StubStreamWebSocket>();
      for (let round = 0; round < 400; round += 1) {
        if (statuses.includes("open") || statuses.includes("closed")) break;
        await vi.advanceTimersByTimeAsync(50);
        for (const socket of sockets) {
          if (!opened.has(socket)) {
            opened.add(socket);
            socket.fireOpen();
          } else if (!answered.has(socket) && socket.textSent.length > 0) {
            answered.add(socket);
            const open = readFrame(socket.textSent[0]);
            if (open.token === ROTATED_SIGN_IN) ack(socket, open, []);
            else socket.fireText(releasedRefusal());
          }
        }
      }
      expect(statuses).not.toContain("closed");
      expect(statuses).toContain("open");
      expect(tokensOf(sockets[sockets.length - 1])[0]).toBe(ROTATED_SIGN_IN);
    });
  });

  it("goes terminal after the no-progress bound when the released host refuses the sign-in on every dial and its refresh returns the same one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const recovery: StreamAuthRevalidator = {
      revalidateForReconnect: () => Promise.resolve("rotated"),
      revalidateRefused: () => Promise.resolve("rotated"),
    };
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      releasedSignOnForLocalRow(
        () => PERSONAL_ROW,
        mockLocalHostEntry.hostId,
        USER_ID,
        () => signIn,
        recovery,
        NO_MINTS,
        createReleasedHostMemory(),
      ),
      door,
    );
    const { statuses } = subscribe(client);
    // The host refuses every open the released way, so each dial is answered
    // as it appears until the session ends.
    const opened = new Set<StubStreamWebSocket>();
    const refused = new Set<StubStreamWebSocket>();
    await vi.waitFor(() => {
      for (const socket of sockets) {
        if (!opened.has(socket)) {
          opened.add(socket);
          socket.fireOpen();
        } else if (!refused.has(socket) && socket.textSent.length > 0) {
          refused.add(socket);
          socket.fireText(releasedRefusal());
        }
      }
      expect(statuses).toContain("closed");
    }, WAIT);
    expect(sockets.map((socket) => tokensOf(socket)[0])).toEqual([
      HOST_TOKEN,
      SIGN_IN,
      SIGN_IN,
      SIGN_IN,
    ]);
    expect(refusals).toEqual([]);
    const opensAtClose = sockets.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(opensAtClose);
  });

  describe("a plan, a probe and a refresh stay with the host they were learned from", () => {
    const HOST_B: HostTransportEndpoint = {
      hostId: "other-local-host",
      websocketUrl: mockLocalHostEntry.websocketUrl,
    };

    function released(hosts: ReleasedHostMemory, signIn: MutableBearerLease) {
      return {
        signIn: () => signIn,
        recovery: null,
        hostTokenUnobtainable: () => true,
        ownerSignInEligible: () => true,
        heldTokenRefused: () => false,
        forgetHeldRefusal: () => undefined,
        mayPresentSignIn: () => true,
        hosts,
      };
    }

    function pendingRefreshes(): {
      readonly recovery: StreamAuthRevalidator;
      readonly answers: Array<(outcome: RevalidateOutcome) => void>;
    } {
      const answers: Array<(outcome: RevalidateOutcome) => void> = [];
      const pending = (): Promise<RevalidateOutcome> =>
        new Promise<RevalidateOutcome>((resolve) => {
          answers.push(resolve);
        });
      return {
        answers,
        recovery: {
          revalidateForReconnect: pending,
          revalidateRefused: pending,
        },
      };
    }

    it("never sends the sign-in that host A's refusal planned to host B when the endpoint moves", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { factory, sockets } = makeStubSocketFactory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { recovery, answers } = pendingRefreshes();
      let endpoint: HostTransportEndpoint = mockLocalHostEntry;
      const client = makeStreamClientAt({
        factory,
        hostId: null,
        endpoint: () => endpoint,
        bearer: () => new MutableBearerLease(HOST_TOKEN, USER_ID),
        userId: USER_ID,
        releasedSignOn: {
          ...released(createReleasedHostMemory(), signIn),
          recovery,
        },
        auth: null,
        door: recordingDoor().door,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
      sockets[0].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
      // Host A refuses the sign-in too: its refresh runs, and the next dial is
      // planned to carry the sign-in to A.
      sockets[1].fireText(releasedRefusal());
      await vi.waitFor(() => expect(answers).toHaveLength(1), WAIT);
      endpoint = HOST_B;
      answers[0]("rotated");
      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      expect((await openFrame(sockets[2])).token).toBe(HOST_TOKEN);
    });

    it("never sends the owner's sign-in that host A's refusal planned to host B when the endpoint moves", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { factory, sockets } = makeStubSocketFactory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { recovery, answers } = pendingRefreshes();
      let endpoint: HostTransportEndpoint = mockLocalHostEntry;
      const client = makeStreamClientAt({
        factory,
        hostId: null,
        endpoint: () => endpoint,
        bearer: () => null,
        userId: USER_ID,
        releasedSignOn: {
          ...released(createReleasedHostMemory(), signIn),
          recovery,
        },
        auth: null,
        door: recordingDoor().door,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
      sockets[0].fireText(namedRefusal("owner_sign_in"));
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
      // A finds the invited sign-in expired: its refresh runs, and the next
      // dial is planned to carry the owner's sign-in to A.
      sockets[1].fireText(namedRefusal("token_expired"));
      await vi.waitFor(() => expect(answers).toHaveLength(1), WAIT);
      endpoint = HOST_B;
      answers[0]("rotated");
      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      expect((await openFrame(sockets[2])).token).toBe(NO_HOST_TOKEN_PROBE);
    });

    it("never gives host B the probe that host A's missing token queued", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { factory, sockets } = makeStubSocketFactory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const hostBToken = new MutableBearerLease("host-b-token", USER_ID);
      let endpoint: HostTransportEndpoint = mockLocalHostEntry;
      let asked = 0;
      const client = makeStreamClientAt({
        factory,
        hostId: null,
        endpoint: () => endpoint,
        // The first dial finds no token for host A and queues a probe for A;
        // by the next read the endpoint is host B, which holds a token.
        bearer: () => {
          asked += 1;
          if (asked > 1) return hostBToken;
          endpoint = HOST_B;
          return null;
        },
        userId: USER_ID,
        releasedSignOn: released(createReleasedHostMemory(), signIn),
        auth: null,
        door: recordingDoor().door,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe("host-b-token");
    });

    describe("a credential and an admission belong to the host the socket was selected for", () => {
      const HOST_B_TOKEN = "host-b-token";

      function leasesByHost(): {
        readonly a: MutableBearerLease;
        readonly b: MutableBearerLease;
        readonly read: (hostId: string) => MutableBearerLease | null;
      } {
        const a = new MutableBearerLease(HOST_TOKEN, USER_ID);
        const b = new MutableBearerLease(HOST_B_TOKEN, USER_ID);
        return {
          a,
          b,
          read: (hostId) => {
            if (hostId === mockLocalHostEntry.hostId) return a;
            return hostId === HOST_B.hostId ? b : null;
          },
        };
      }

      it("writes host A's credential in the OPEN and credits the admission to A when the endpoint and the credential move to B before the OPEN", async () => {
        const { factory, sockets } = makeStubSocketFactory();
        const leases = leasesByHost();
        const door = streamRecordingDoor();
        let endpoint: HostTransportEndpoint = mockLocalHostEntry;
        const client = makeStreamClientAt({
          factory,
          hostId: null,
          endpoint: () => endpoint,
          bearer: leases.read,
          userId: USER_ID,
          releasedSignOn: null,
          auth: null,
          door: door.door,
          evidence: NO_TRANSPORT_EVIDENCE,
        });
        const { statuses } = subscribe(client);
        await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
        // The socket is selected for A; the dial waits, and the endpoint moves.
        endpoint = HOST_B;
        const open = await openFrame(sockets[0]);
        expect(open.token).toBe(HOST_TOKEN);
        ack(sockets[0], open, []);
        await untilStatus(statuses, "open");
        expect(door.admitted).toEqual([mockLocalHostEntry.hostId]);
      });

      it("pushes host A's credential, not B's, on a credential update to an admitted socket after the endpoint moves to B", async () => {
        const { factory, sockets } = makeStubSocketFactory();
        const leases = leasesByHost();
        let endpoint: HostTransportEndpoint = mockLocalHostEntry;
        const client = makeStreamClientAt({
          factory,
          hostId: null,
          endpoint: () => endpoint,
          bearer: leases.read,
          userId: USER_ID,
          releasedSignOn: null,
          auth: null,
          door: streamRecordingDoor().door,
          evidence: NO_TRANSPORT_EVIDENCE,
        });
        const { statuses } = subscribe(client);
        await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
        const open = await openFrame(sockets[0]);
        ack(sockets[0], open, ["credentialUpdate"]);
        await untilStatus(statuses, "open");

        endpoint = HOST_B;
        leases.a.rotate(ROTATED_HOST_TOKEN);
        client.notifyBearerRotated();
        await vi.waitFor(
          () =>
            expect(credentialUpdateTokens(sockets[0])).toEqual([
              ROTATED_HOST_TOKEN,
            ]),
          WAIT,
        );
      });
    });

    it.each([
      { name: "the host-only token's refresh", answersAs: "host-token" },
      { name: "the sign-in's refresh", answersAs: "sign-in" },
    ])(
      "keeps the stream open when $name answers rejected after a wake redial was admitted",
      async ({ answersAs }) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { factory, sockets } = makeStubSocketFactory();
        const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
        const { recovery, answers } = pendingRefreshes();
        const { door, refusals } = recordingDoor();
        const signInPath = answersAs === "sign-in";
        const client = makeStreamClientAt({
          factory,
          hostId: null,
          endpoint: () => mockLocalHostEntry,
          bearer: () => new MutableBearerLease(HOST_TOKEN, USER_ID),
          userId: USER_ID,
          releasedSignOn: signInPath
            ? {
                ...released(createReleasedHostMemory(), signIn),
                recovery,
              }
            : null,
          auth: signInPath ? null : recovery,
          door,
          evidence: NO_TRANSPORT_EVIDENCE,
        });
        const { statuses } = subscribe(client);
        await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
        expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
        if (signInPath) {
          sockets[0].fireText(releasedRefusal());
          await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
          expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
          sockets[1].fireText(releasedRefusal());
        } else {
          sockets[0].fireText(namedRefusal("token_expired"));
        }
        await vi.waitFor(() => expect(answers).toHaveLength(1), WAIT);

        // A wake redials while the refresh is pending, and the host admits it.
        client.reconnectAll("wake", { probeFirst: false, wakeProbe: null });
        const redialed = signInPath ? 3 : 2;
        await vi.waitFor(() => expect(sockets).toHaveLength(redialed), WAIT);
        const open = await openFrame(sockets[redialed - 1]);
        ack(sockets[redialed - 1], open, []);
        await untilStatus(statuses, "open");

        answers[0]("rejected");
        await vi.advanceTimersByTimeAsync(0);
        expect(statuses).not.toContain("closed");
        // The host-only token's refusal is the door's at once; the sign-in's
        // is reported only if its refresh gives up on the dial that asked.
        expect(refusals).toHaveLength(signInPath ? 0 : 1);
      },
    );

    it.each([
      { name: "the released sign-in's refresh", path: "released" },
      { name: "the invited sign-in's refresh", path: "owner" },
    ])(
      "reports nothing to the door when $name answers after the subscription closed",
      async ({ path }) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { factory, sockets } = makeStubSocketFactory();
        const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
        const { recovery, answers } = pendingRefreshes();
        const { door, refusals } = recordingDoor();
        const releasedPath = path === "released";
        const client = makeStreamClientAt({
          factory,
          hostId: null,
          endpoint: () => mockLocalHostEntry,
          bearer: () =>
            releasedPath ? new MutableBearerLease(HOST_TOKEN, USER_ID) : null,
          userId: USER_ID,
          releasedSignOn: {
            ...released(createReleasedHostMemory(), signIn),
            recovery,
          },
          auth: null,
          door,
          evidence: NO_TRANSPORT_EVIDENCE,
        });
        const { session } = subscribe(client);
        await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
        if (releasedPath) {
          expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
          sockets[0].fireText(releasedRefusal());
          await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
          expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
          sockets[1].fireText(releasedRefusal());
        } else {
          expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
          sockets[0].fireText(namedRefusal("owner_sign_in"));
          await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
          expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
          sockets[1].fireText(namedRefusal("token_expired"));
        }
        await vi.waitFor(() => expect(answers).toHaveLength(1), WAIT);

        session.close();
        answers[0]("rejected");
        await vi.advanceTimersByTimeAsync(0);
        expect(refusals).toEqual([]);
      },
    );

    it("sends the host-only token, not the sign-in, when another transport hears the host name a reason between the plan and the OPEN", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { factory, sockets } = makeStubSocketFactory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const hosts = createReleasedHostMemory();
      const client = makeStreamClientAt({
        factory,
        hostId: null,
        endpoint: () => mockLocalHostEntry,
        bearer: () => new MutableBearerLease(HOST_TOKEN, USER_ID),
        userId: USER_ID,
        releasedSignOn: released(hosts, signIn),
        auth: null,
        door: recordingDoor().door,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
      sockets[0].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      // The dial is planned with the sign-in and still waiting for its slot.
      hosts.refusedNamingReason(
        hosts.currentInstance(mockLocalHostEntry.hostId),
        false,
      );
      expect((await openFrame(sockets[1])).token).toBe(HOST_TOKEN);
    });

    it("counts neither the stale answer of a refresh begun on host A toward B's give-up bound, nor ends the stream, and dials B next", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { factory, sockets } = makeStubSocketFactory();
      const hostAToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
      const hostBToken = new MutableBearerLease("host-b-token", USER_ID);
      let endpoint: HostTransportEndpoint = mockLocalHostEntry;
      let refreshes = 0;
      const lateAnswers: Array<(outcome: RevalidateOutcome) => void> = [];
      // The first two refusals are answered at once; the third's refresh stays pending.
      const refresh = (): Promise<RevalidateOutcome> => {
        refreshes += 1;
        return refreshes <= 2
          ? Promise.resolve("rotated")
          : new Promise<RevalidateOutcome>((resolve) => {
              lateAnswers.push(resolve);
            });
      };
      const client = makeStreamClientAt({
        factory,
        hostId: null,
        endpoint: () => endpoint,
        bearer: (hostId) =>
          hostId === mockLocalHostEntry.hostId ? hostAToken : hostBToken,
        userId: USER_ID,
        releasedSignOn: null,
        auth: {
          revalidateForReconnect: refresh,
          revalidateRefused: refresh,
        },
        door: recordingDoor().door,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      const { statuses } = subscribe(client);
      for (const dial of [1, 2, 3]) {
        await vi.waitFor(() => expect(sockets).toHaveLength(dial), WAIT);
        expect((await openFrame(sockets[dial - 1])).token).toBe(HOST_TOKEN);
        sockets[dial - 1].fireText(namedRefusal("token_expired"));
      }
      await vi.waitFor(() => expect(lateAnswers).toHaveLength(1), WAIT);

      // The endpoint names host B while A's third refresh is pending; it
      // answers with the bearer unchanged.
      endpoint = HOST_B;
      lateAnswers[0]("rotated");
      await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
      expect((await openFrame(sockets[3])).token).toBe("host-b-token");
      expect(statuses).not.toContain("closed");
    });

    it("counts a host's no-progress refusals toward its own give-up bound only", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { factory, sockets } = makeStubSocketFactory();
      let endpoint: HostTransportEndpoint = mockLocalHostEntry;
      const client = makeStreamClientAt({
        factory,
        hostId: null,
        endpoint: () => endpoint,
        bearer: () => new MutableBearerLease(HOST_TOKEN, USER_ID),
        userId: USER_ID,
        releasedSignOn: null,
        // The refresh answers rotated, and the same token goes again.
        auth: {
          revalidateForReconnect: () => Promise.resolve("rotated"),
          revalidateRefused: () => Promise.resolve("rotated"),
        },
        door: recordingDoor().door,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      const { statuses } = subscribe(client);
      for (const dial of [1, 2]) {
        await vi.waitFor(() => expect(sockets).toHaveLength(dial), WAIT);
        await openFrame(sockets[dial - 1]);
        sockets[dial - 1].fireText(namedRefusal("token_expired"));
      }
      // Two of the three refusals the bound allows came from host A.
      endpoint = {
        hostId: "other-local-host",
        websocketUrl: mockLocalHostEntry.websocketUrl,
      };
      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      await openFrame(sockets[2]);
      sockets[2].fireText(namedRefusal("token_expired"));
      await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
      expect(statuses).not.toContain("closed");
    });
  });

  describe("what a socket's answer does is bound to the process instance of the host it was dialed to", () => {
    const HOST_ID = mockLocalHostEntry.hostId;

    /** The invitation flow's fixture: `held` is the host-only token this machine can present, `null` for none. */
    function invitableSignOn(
      hosts: ReleasedHostMemory,
      signIn: MutableBearerLease,
      held: () => MutableBearerLease | null,
      recovery: StreamAuthRevalidator | null,
    ): ReleasedSignOn {
      return {
        signIn: () => signIn,
        recovery,
        hostTokenUnobtainable: () => held() === null,
        ownerSignInEligible: () => held() === null,
        heldTokenRefused: () => false,
        forgetHeldRefusal: () => undefined,
        mayPresentSignIn: () => true,
        hosts,
      };
    }

    function invitedClient(
      factory: IStreamWebSocketFactory,
      signOn: ReleasedSignOn,
      held: () => MutableBearerLease | null,
    ): WsStreamClient<typeof hostStreamRpcRegistry> {
      return makeStreamClientHolding(
        factory,
        held,
        USER_ID,
        signOn,
        recordingDoor().door,
        NO_TRANSPORT_EVIDENCE,
      );
    }

    /** The host invites the sign-in on the probe, and admits it. */
    async function admitInvitedSignIn(input: {
      readonly sockets: readonly StubStreamWebSocket[];
      readonly statuses: readonly string[];
    }): Promise<void> {
      await vi.waitFor(() => expect(input.sockets).toHaveLength(1), WAIT);
      expect((await openFrame(input.sockets[0])).token).toBe(
        NO_HOST_TOKEN_PROBE,
      );
      input.sockets[0].fireText(namedRefusal("owner_sign_in"));
      await vi.waitFor(() => expect(input.sockets).toHaveLength(2), WAIT);
      const invited = await openFrame(input.sockets[1]);
      expect(invited.token).toBe(SIGN_IN);
      ack(input.sockets[1], invited, ["credentialUpdate"]);
      await untilStatus(input.statuses, "open");
    }

    it("marks nothing and selects no plan for a fatal that a socket dialed to the earlier process delivers after the replacement was observed", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      hosts.observeInstance(HOST_ID, "100");
      const { factory, sockets } = makeStubSocketFactory();
      const { door, refusals } = recordingDoor();
      const client = makeStreamClient(
        factory,
        new MutableBearerLease(HOST_TOKEN, USER_ID),
        signOnWithMemory(
          PERSONAL_ROW,
          new MutableBearerLease(SIGN_IN, USER_ID),
          hosts,
        ),
        door,
      );
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);

      hosts.observeInstance(HOST_ID, "200");
      sockets[0].fireText(namedRefusal("not_provisioned"));
      expect(hosts.namedReason(HOST_ID)).toBe(false);
      // The replacement is asked its own open first, and refuses it bare, as
      // a released host does.
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(HOST_TOKEN);
      sockets[1].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      expect((await openFrame(sockets[2])).token).toBe(SIGN_IN);
      expect(refusals).toEqual([]);
    });

    it("writes the host-only token, never the sign-in, when the host is replaced between the bare refusal that planned the sign-in and its open", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      hosts.observeInstance(HOST_ID, "100");
      const { factory, sockets } = makeStubSocketFactory();
      const client = makeStreamClient(
        factory,
        new MutableBearerLease(HOST_TOKEN, USER_ID),
        signOnWithMemory(
          PERSONAL_ROW,
          new MutableBearerLease(SIGN_IN, USER_ID),
          hosts,
        ),
        recordingDoor().door,
      );
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
      sockets[0].fireText(releasedRefusal());
      // The sign-in dial is planned for the first process and waits for its slot.
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      hosts.observeInstance(HOST_ID, "200");
      expect((await openFrame(sockets[1])).token).toBe(HOST_TOKEN);
    });

    it("raises no cover for a retryable named fatal that an invited stream's earlier-process socket delivers after the replacement was observed", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      hosts.observeInstance(HOST_ID, "100");
      const shown = coverDoor();
      const { factory, sockets } = makeStubSocketFactory();
      const client = makeStreamClientHolding(
        factory,
        () => null,
        USER_ID,
        invitableSignOn(
          hosts,
          new MutableBearerLease(SIGN_IN, USER_ID),
          () => null,
          null,
        ),
        shown.door,
        NO_TRANSPORT_EVIDENCE,
      );
      const { statuses } = subscribe(client);
      await admitInvitedSignIn({ sockets, statuses });

      hosts.observeInstance(HOST_ID, "200");
      sockets[1].fireText(retryableNamedRefusal("keys_unavailable"));
      await vi.waitFor(
        () => expect(statuses.at(-1)).toBe("reconnecting"),
        WAIT,
      );
      expect(shown.cover(HOST_ID)).toBeNull();
    });

    it.each([
      { order: "the stale ack first, then the replacement's refusal" },
      { order: "the replacement's refusal first, then the stale ack" },
    ])(
      "shows the replacement's refusal on the door when an earlier process's open is acknowledged after the replacement was observed: $order",
      async ({ order }) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const hosts = createReleasedHostMemory();
        hosts.observeInstance(HOST_ID, "100");
        const shown = coverDoor();
        const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
        const earlier = makeStubSocketFactory();
        const earlierClient = makeStreamClient(
          earlier.factory,
          new MutableBearerLease(HOST_TOKEN, USER_ID),
          signOnWithMemory(PERSONAL_ROW, signIn, hosts),
          shown.door,
        );
        const { statuses } = subscribe(earlierClient);
        await vi.waitFor(() => expect(earlier.sockets).toHaveLength(1), WAIT);
        const staleOpen = await openFrame(earlier.sockets[0]);
        hosts.observeInstance(HOST_ID, "200");

        const staleAck = async (): Promise<void> => {
          ack(earlier.sockets[0], staleOpen, []);
          await vi.advanceTimersByTimeAsync(0);
        };
        // Another transport of the app dials the replacement, which refuses it.
        const replacementRefuses = async (): Promise<void> => {
          const later = makeStubSocketFactory();
          const laterClient = makeStreamClient(
            later.factory,
            new MutableBearerLease(HOST_TOKEN, USER_ID),
            signOnWithMemory(PERSONAL_ROW, signIn, hosts),
            shown.door,
          );
          subscribe(laterClient);
          await vi.waitFor(() => expect(later.sockets).toHaveLength(1), WAIT);
          await openFrame(later.sockets[0]);
          later.sockets[0].fireText(namedRefusal("enrolment_broken"));
          await vi.advanceTimersByTimeAsync(0);
        };
        if (order.startsWith("the stale ack")) {
          await staleAck();
          await replacementRefuses();
        } else {
          await replacementRefuses();
          await staleAck();
        }
        expect(statuses).not.toContain("closed");
        expect(shown.cover(HOST_ID)).toBe(
          hostDoorStateOfRefusal(namedRefusal("enrolment_broken").details),
        );
      },
    );

    it.each([
      { name: "with no acknowledgement in between", staleAck: false },
      {
        name: "with the earlier process's open acknowledged in between",
        staleAck: true,
      },
    ])(
      "lets the replacement's dial sequence spend its own answered sign-in refresh after the earlier one spent its: $name",
      async ({ staleAck }) => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const hosts = createReleasedHostMemory();
        hosts.observeInstance(HOST_ID, "100");
        const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
        let refreshes = 0;
        const rotate = (): Promise<RevalidateOutcome> => {
          refreshes += 1;
          signIn.rotate(`sign-in-refresh-${refreshes}`);
          return Promise.resolve("rotated");
        };
        const { factory, sockets } = makeStubSocketFactory();
        const client = makeStreamClient(
          factory,
          new MutableBearerLease(HOST_TOKEN, USER_ID),
          releasedSignOnForLocalRow(
            () => PERSONAL_ROW,
            HOST_ID,
            USER_ID,
            () => signIn,
            { revalidateForReconnect: rotate },
            NO_MINTS,
            hosts,
          ),
          recordingDoor().door,
        );
        subscribe(client);
        // The earlier process refuses the host-only token and then the
        // sign-in bare; its sequence spends its refresh.
        await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
        expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
        sockets[0].fireText(releasedRefusal());
        await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
        expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
        sockets[1].fireText(releasedRefusal());
        await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
        const refreshedOpen = await openFrame(sockets[2]);
        expect(refreshedOpen.token).toBe("sign-in-refresh-1");

        hosts.observeInstance(HOST_ID, "200");
        if (staleAck) ack(sockets[2], refreshedOpen, []);
        sockets[2].fireClose(1006, "dropped");

        // The replacement is asked its own open first and refuses it bare, then
        // refuses the sign-in bare: its own sequence refreshes once.
        await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
        expect((await openFrame(sockets[3])).token).toBe(HOST_TOKEN);
        sockets[3].fireText(releasedRefusal());
        await vi.waitFor(() => expect(sockets).toHaveLength(5), WAIT);
        expect((await openFrame(sockets[4])).token).toBe("sign-in-refresh-1");
        sockets[4].fireText(releasedRefusal());
        await vi.waitFor(() => expect(sockets).toHaveLength(6), WAIT);
        expect((await openFrame(sockets[5])).token).toBe("sign-in-refresh-2");
      },
    );

    it("lets a new dial sequence's first sign-in refusal refresh after an earlier sequence's refresh was answered once the stream was admitted", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const late: { answer: ((outcome: RevalidateOutcome) => void) | null } = {
        answer: null,
      };
      let asked = 0;
      const refresh = (): Promise<RevalidateOutcome> => {
        asked += 1;
        if (asked === 1)
          return new Promise<RevalidateOutcome>((resolve) => {
            late.answer = resolve;
          });
        signIn.rotate(`sign-in-refresh-${asked}`);
        return Promise.resolve("rotated");
      };
      const { factory, sockets } = makeStubSocketFactory();
      const client = makeStreamClient(
        factory,
        new MutableBearerLease(HOST_TOKEN, USER_ID),
        releasedSignOnForLocalRow(
          () => PERSONAL_ROW,
          HOST_ID,
          USER_ID,
          () => signIn,
          { revalidateForReconnect: refresh },
          NO_MINTS,
          hosts,
        ),
        recordingDoor().door,
      );
      const { statuses } = subscribe(client);
      // Sequence one: the sign-in is refused bare and its refresh stays pending.
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
      sockets[0].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
      sockets[1].fireText(releasedRefusal());
      await vi.waitFor(() => expect(late.answer).not.toBeNull(), WAIT);

      // A wake redial is admitted: sequence two begins.
      client.reconnectAll("wake", { probeFirst: false, wakeProbe: null });
      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      const admitted = await openFrame(sockets[2]);
      ack(sockets[2], admitted, ["credentialUpdate"]);
      await untilStatus(statuses, "open");

      // Sequence one's refresh answers now, with a rotated sign-in.
      signIn.rotate("sign-in-late");
      late.answer?.("rotated");
      await vi.advanceTimersByTimeAsync(0);

      // Sequence two: its first sign-in refusal still refreshes.
      sockets[2].fireClose(1006, "dropped");
      await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
      expect((await openFrame(sockets[3])).token).toBe(HOST_TOKEN);
      sockets[3].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(5), WAIT);
      expect((await openFrame(sockets[4])).token).toBe("sign-in-late");
      sockets[4].fireText(releasedRefusal());
      await vi.waitFor(() => expect(sockets).toHaveLength(6), WAIT);
      expect((await openFrame(sockets[5])).token).toBe("sign-in-refresh-2");
    });

    describe("the give-up count belongs to the host id, whatever instance refused", () => {
      /** The host-only token is refused as expired on every dial, and authn answers `rotated` with the same token. */
      function noProgressStream(
        hosts: ReleasedHostMemory,
        factory: IStreamWebSocketFactory,
        auth: StreamAuthRevalidator,
      ): WsStreamClient<typeof hostStreamRpcRegistry> {
        return makeStreamClientAt({
          factory,
          endpoint: () => mockLocalHostEntry,
          hostId: HOST_ID,
          bearer: () => new MutableBearerLease(HOST_TOKEN, USER_ID),
          userId: USER_ID,
          releasedSignOn: signOnWithMemory(
            PERSONAL_ROW,
            new MutableBearerLease(SIGN_IN, USER_ID),
            hosts,
          ),
          auth,
          door: recordingDoor().door,
          evidence: NO_TRANSPORT_EVIDENCE,
        });
      }

      const rotatedSameToken: StreamAuthRevalidator = {
        revalidateForReconnect: () => Promise.resolve("rotated"),
        revalidateRefused: () => Promise.resolve("rotated"),
      };

      it("leaves the give-up count unchanged for a refusal arriving from a socket of a replaced instance", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const hosts = createReleasedHostMemory();
        hosts.observeInstance(HOST_ID, "100");
        const { factory, sockets } = makeStubSocketFactory();
        const { statuses } = subscribe(
          noProgressStream(hosts, factory, rotatedSameToken),
        );

        // The first refusal counts.
        await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
        await openFrame(sockets[0]);
        sockets[0].fireText(namedRefusal("token_expired"));
        // The second dial is to the first process, which is replaced before it answers.
        await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
        await openFrame(sockets[1]);
        hosts.observeInstance(HOST_ID, "200");
        sockets[1].fireText(namedRefusal("token_expired"));
        // The replacement's refusals are the remaining two the bound allows.
        await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
        await openFrame(sockets[2]);
        sockets[2].fireText(namedRefusal("token_expired"));
        await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
        await openFrame(sockets[3]);
        expect(statuses).not.toContain("closed");
        sockets[3].fireText(namedRefusal("token_expired"));
        await untilStatus(statuses, "closed");
        expect(sockets).toHaveLength(4);
      });

      it("reaches the give-up bound on refusals from three successive instances with no admission between, each dial separated by the ordinary backoff", async () => {
        vi.useFakeTimers();
        const hosts = createReleasedHostMemory();
        hosts.observeInstance(HOST_ID, "100");
        const created = makeStubSocketFactory();
        const createdAt: number[] = [];
        const factory: IStreamWebSocketFactory = {
          create: (url, priority) => {
            createdAt.push(Date.now());
            return created.factory.create(url, priority);
          },
        };
        const { sockets } = created;
        const { statuses } = subscribe(
          noProgressStream(hosts, factory, rotatedSameToken),
        );
        const settle = async (): Promise<void> => {
          await vi.advanceTimersByTimeAsync(0);
        };
        const refusedAt: number[] = [];

        await settle();
        const instances = ["200", "300"];
        for (let index = 0; index < 3; index += 1) {
          expect(sockets).toHaveLength(index + 1);
          sockets[index].fireOpen();
          await settle();
          expect(sockets[index].textSent.length).toBeGreaterThan(0);
          sockets[index].fireText(namedRefusal("token_expired"));
          refusedAt.push(Date.now());
          await settle();
          if (index === 2) break;
          // The next process is observed before the redial, which waits out
          // the backoff: none is dialed before its delay has run.
          hosts.observeInstance(HOST_ID, instances[index]);
          await vi.advanceTimersByTimeAsync(9);
          expect(sockets).toHaveLength(index + 1);
          await vi.advanceTimersByTimeAsync(1_000);
          expect(sockets).toHaveLength(index + 2);
        }
        expect(statuses).toContain("closed");
        expect(sockets).toHaveLength(3);
        // Each dial after the first was created at least the initial backoff after the refusal before it.
        expect(createdAt).toHaveLength(3);
        expect(createdAt[1] - refusedAt[0]).toBeGreaterThanOrEqual(10);
        expect(createdAt[2] - refusedAt[1]).toBeGreaterThanOrEqual(10);
      });

      it("completes each refusal's count when its renewal answers after the instance was replaced, and paces every dial", async () => {
        vi.useFakeTimers();
        const hosts = createReleasedHostMemory();
        hosts.observeInstance(HOST_ID, "100");
        const answers: Array<(outcome: RevalidateOutcome) => void> = [];
        const pending = (): Promise<RevalidateOutcome> =>
          new Promise<RevalidateOutcome>((resolve) => {
            answers.push(resolve);
          });
        const created = makeStubSocketFactory();
        const createdAt: number[] = [];
        const factory: IStreamWebSocketFactory = {
          create: (url, priority) => {
            createdAt.push(Date.now());
            return created.factory.create(url, priority);
          },
        };
        const { sockets } = created;
        const { statuses } = subscribe(
          noProgressStream(hosts, factory, {
            revalidateForReconnect: pending,
            revalidateRefused: pending,
          }),
        );
        const settle = async (): Promise<void> => {
          await vi.advanceTimersByTimeAsync(0);
        };
        const answeredAt: number[] = [];
        const instances = ["200", "300"];

        await settle();
        for (let index = 0; index < 3; index += 1) {
          expect(sockets).toHaveLength(index + 1);
          sockets[index].fireOpen();
          await settle();
          sockets[index].fireText(namedRefusal("token_expired"));
          await settle();
          // The refusal arrived from the current instance; its renewal runs.
          expect(answers).toHaveLength(index + 1);
          if (index < 2) hosts.observeInstance(HOST_ID, instances[index]);
          answers[index]("rotated");
          answeredAt.push(Date.now());
          await settle();
          if (index === 2) break;
          await vi.advanceTimersByTimeAsync(9);
          expect(sockets).toHaveLength(index + 1);
          await vi.advanceTimersByTimeAsync(1_000);
          expect(sockets).toHaveLength(index + 2);
        }
        expect(statuses).toContain("closed");
        expect(sockets).toHaveLength(3);
        expect(createdAt[1] - answeredAt[0]).toBeGreaterThanOrEqual(10);
        expect(createdAt[2] - answeredAt[1]).toBeGreaterThanOrEqual(10);
      });
    });

    it("writes no sign-in when the mint answered not-admitted after the invited plan was chosen and before the socket opened", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      let eligible = true;
      const { factory, sockets } = makeStubSocketFactory();
      const client = invitedClient(
        factory,
        {
          ...invitableSignOn(hosts, signIn, () => null, null),
          hostTokenUnobtainable: () => eligible,
          ownerSignInEligible: () => eligible,
        },
        () => null,
      );
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
      sockets[0].fireText(namedRefusal("owner_sign_in"));
      // The invited dial is planned and waits for its slot; the mint then
      // answers `not-admitted`, so no host-only token and no invitation stand.
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      eligible = false;
      // The OPEN withdraws the plan; with no host-only token the socket is
      // dropped and no frame is written at all.
      sockets[1].fireOpen();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        sockets[1].textSent.map((raw) => readFrame(raw).token),
      ).not.toContain(SIGN_IN);
    });

    it("sends the placeholder, not the rotated sign-in, after the invited sign-in is refused as expired, and the sign-in only after a new invitation", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const rotate = (): Promise<RevalidateOutcome> => {
        signIn.rotate(ROTATED_SIGN_IN);
        return Promise.resolve("rotated");
      };
      const { factory, sockets } = makeStubSocketFactory();
      const client = invitedClient(
        factory,
        invitableSignOn(hosts, signIn, () => null, {
          revalidateForReconnect: rotate,
          revalidateRefused: rotate,
        }),
        () => null,
      );
      subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
      sockets[0].fireText(namedRefusal("owner_sign_in"));
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect((await openFrame(sockets[1])).token).toBe(SIGN_IN);
      sockets[1].fireText(namedRefusal("token_expired"));

      await vi.waitFor(() => expect(sockets).toHaveLength(3), WAIT);
      expect((await openFrame(sockets[2])).token).toBe(NO_HOST_TOKEN_PROBE);
      sockets[2].fireText(namedRefusal("owner_sign_in"));
      await vi.waitFor(() => expect(sockets).toHaveLength(4), WAIT);
      expect((await openFrame(sockets[3])).token).toBe(ROTATED_SIGN_IN);
    });

    describe("an admitted invited stream", () => {
      async function admittedInvited(
        heard: "nothing" | "token-expired",
      ): Promise<{
        readonly client: WsStreamClient<typeof hostStreamRpcRegistry>;
        readonly sockets: readonly StubStreamWebSocket[];
        readonly hosts: ReleasedHostMemory;
        readonly signIn: MutableBearerLease;
        readonly hold: () => void;
      }> {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const hosts = createReleasedHostMemory();
        // Another transport heard the host refuse a held token as expired
        // before this stream was invited.
        if (heard === "token-expired")
          hosts.refusedNamingReason(hosts.currentInstance(HOST_ID), false);
        const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
        let held: MutableBearerLease | null = null;
        const { factory, sockets } = makeStubSocketFactory();
        const client = invitedClient(
          factory,
          invitableSignOn(hosts, signIn, () => held, null),
          () => held,
        );
        const { statuses } = subscribe(client);
        await admitInvitedSignIn({ sockets, statuses });
        return {
          client,
          sockets,
          hosts,
          signIn,
          hold: () => {
            held = new MutableBearerLease(HOST_TOKEN, USER_ID);
          },
        };
      }

      it("pushes the sign-in's rotation while no later refusal was heard (guard)", async () => {
        const admitted = await admittedInvited("nothing");
        admitted.hold();
        admitted.signIn.rotate(ROTATED_SIGN_IN);
        admitted.client.notifyBearerRotated();
        await vi.waitFor(
          () =>
            expect(credentialUpdateTokens(admitted.sockets[1])).toEqual([
              ROTATED_SIGN_IN,
            ]),
          WAIT,
        );
      });

      it("still pushes the sign-in's rotation after a refusal of the held token that came before the invitation (guard)", async () => {
        const admitted = await admittedInvited("token-expired");
        admitted.hold();
        admitted.signIn.rotate(ROTATED_SIGN_IN);
        admitted.client.notifyBearerRotated();
        await vi.waitFor(
          () =>
            expect(credentialUpdateTokens(admitted.sockets[1])).toEqual([
              ROTATED_SIGN_IN,
            ]),
          WAIT,
        );
      });

      it("pushes the host-only token, not the rotated sign-in, once another transport heard the host refuse naming a reason after the invitation", async () => {
        const admitted = await admittedInvited("nothing");
        admitted.hold();
        admitted.hosts.refusedNamingReason(
          admitted.hosts.currentInstance(HOST_ID),
          false,
        );
        admitted.signIn.rotate(ROTATED_SIGN_IN);
        admitted.client.notifyBearerRotated();
        await vi.waitFor(
          () =>
            expect(credentialUpdateTokens(admitted.sockets[1])).toEqual([
              HOST_TOKEN,
            ]),
          WAIT,
        );
      });
    });

    it("writes the host-only token, not the rotated sign-in, at the open's ack when another transport heard the host refuse naming a reason after the invitation", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      let held: MutableBearerLease | null = null;
      const { factory, sockets } = makeStubSocketFactory();
      const client = invitedClient(
        factory,
        invitableSignOn(hosts, signIn, () => held, null),
        () => held,
      );
      const { statuses } = subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      expect((await openFrame(sockets[0])).token).toBe(NO_HOST_TOKEN_PROBE);
      sockets[0].fireText(namedRefusal("owner_sign_in"));
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      const invited = await openFrame(sockets[1]);
      expect(invited.token).toBe(SIGN_IN);

      // The invited open is written and unanswered while the refusal is heard
      // and the sign-in rotates.
      held = new MutableBearerLease(HOST_TOKEN, USER_ID);
      hosts.refusedNamingReason(hosts.currentInstance(HOST_ID), false);
      signIn.rotate(ROTATED_SIGN_IN);
      client.notifyBearerRotated();
      ack(sockets[1], invited, ["credentialUpdate"]);
      await untilStatus(statuses, "open");
      await vi.waitFor(
        () => expect(credentialUpdateTokens(sockets[1])).toEqual([HOST_TOKEN]),
        WAIT,
      );
    });
  });

  describe("a host-only token the host refused as expired is judged on the token the host examined", () => {
    const HOST_ID = mockLocalHostEntry.hostId;
    const T1 = "held-token-1";
    const T2 = "held-token-2";
    /** A bearer whose embedded expiry has passed, which the stored token's own end still calls usable. */
    const EMBEDDED_EXPIRY_PASSED = "eyJhbGciOiJub25lIn0.eyJleHAiOjF9.sig";

    function heldTokens(
      initial: string,
      hosts: ReleasedHostMemory,
    ): {
      readonly tokens: TrackedHostTokens;
      readonly replace: (token: string) => void;
    } {
      let held: HostToken = {
        token: initial,
        expiresAtMs: Date.now() + 3_600_000,
      };
      return {
        replace: (token) => {
          held = { token, expiresAtMs: Date.now() + 3_600_000 };
        },
        tokens: trackHostTokenMints(
          {
            current: () => held,
            // Authn never answers a mint.
            obtain: () => new Promise<HostTokenMintOutcome>(() => undefined),
            loaded: () => true,
            whenLoaded: () => Promise.resolve(),
            lastFailureOf: () => null,
          },
          hosts,
        ),
      };
    }

    function stream(
      factory: IStreamWebSocketFactory,
      tokens: TrackedHostTokens,
      hosts: ReleasedHostMemory,
      signIn: MutableBearerLease,
      auth: StreamAuthRevalidator | null,
    ): WsStreamClient<typeof hostStreamRpcRegistry> {
      return makeStreamClientAt({
        factory,
        endpoint: () => mockLocalHostEntry,
        hostId: HOST_ID,
        bearer: hostTokenBearer(
          tokens,
          () => signIn,
          HOST_ID,
          () => undefined,
        ),
        userId: USER_ID,
        releasedSignOn: releasedSignOnForLocalRow(
          () => PERSONAL_ROW,
          HOST_ID,
          USER_ID,
          () => signIn,
          null,
          tokens,
          hosts,
        ),
        auth,
        door: recordingDoor().door,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
    }

    it("marks no token, and presents the replacement on the next dial, when the host's expiry fatal arrives after a credential update was written", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const hosts = createReleasedHostMemory();
      const { tokens, replace } = heldTokens(T1, hosts);
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const { factory, sockets } = makeStubSocketFactory();
      const client = stream(factory, tokens, hosts, signIn, {
        revalidateForReconnect: () => Promise.resolve("rotated"),
        revalidateRefused: () => Promise.resolve("rotated"),
      });
      const { statuses } = subscribe(client);
      await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
      const open = await openFrame(sockets[0]);
      expect(open.token).toBe(T1);
      ack(sockets[0], open, ["credentialUpdate"]);
      await untilStatus(statuses, "open");

      replace(T2);
      client.notifyBearerRotated();
      await vi.waitFor(
        () => expect(credentialUpdateTokens(sockets[0])).toEqual([T2]),
        WAIT,
      );
      // The host cannot say which of the two it examined.
      sockets[0].fireText(namedRefusal("token_expired"));
      await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
      expect(tokens.heldRefused(USER_ID, HOST_ID)).toBe(false);
      expect((await openFrame(sockets[1])).token).toBe(T2);
    });

    it("writes the placeholder at once, with authn unreachable and no timer advanced, for a held token the host refused and the stored end still calls usable", async () => {
      vi.useFakeTimers();
      const hosts = createReleasedHostMemory();
      const { tokens } = heldTokens(EMBEDDED_EXPIRY_PASSED, hosts);
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const first = makeStubSocketFactory();
      const firstClient = stream(first.factory, tokens, hosts, signIn, null);
      subscribe(firstClient);
      await vi.waitFor(() => expect(first.sockets).toHaveLength(1), WAIT);
      expect((await openFrame(first.sockets[0])).token).toBe(
        EMBEDDED_EXPIRY_PASSED,
      );
      first.sockets[0].fireText(namedRefusal("token_expired"));
      await vi.waitFor(
        () => expect(tokens.heldRefused(USER_ID, HOST_ID)).toBe(true),
        WAIT,
      );
      firstClient.close("test-done");

      // The next dial's revalidation would never answer: authn is black-holed.
      const next = makeStubSocketFactory();
      const blackHole = (): Promise<RevalidateOutcome> =>
        new Promise<RevalidateOutcome>(() => undefined);
      const nextClient = stream(next.factory, tokens, hosts, signIn, {
        revalidateForReconnect: blackHole,
        revalidateRefused: blackHole,
      });
      subscribe(nextClient);
      await vi.waitFor(() => expect(next.sockets).toHaveLength(1), WAIT);
      expect((await openFrame(next.sockets[0])).token).toBe(
        NO_HOST_TOKEN_PROBE,
      );
    });
  });

  describe("a frame from a socket dialed to an owner that is no longer current crosses nothing", () => {
    const HOST_ID = mockLocalHostEntry.hostId;
    const METHOD = "git.subscribeStatus";
    const PROVISION_CAPABILITIES = [
      "credentialUpdate",
      "hostCredentialProvision",
    ];

    interface Crossings {
      readonly mints: string[];
      readonly credentialStates: string[];
      readonly availability: string[];
      readonly revalidations: string[];
      readonly serverFrames: unknown[];
    }

    /** A stream whose every outward call is recorded, bound to the memory `hosts`. */
    function observedStream(
      hosts: ReleasedHostMemory,
      factory: IStreamWebSocketFactory,
    ): {
      readonly client: WsStreamClient<typeof hostStreamRpcRegistry>;
      readonly evidence: RecordingTransportEvidence;
      readonly door: StreamRecordingDoor;
      readonly crossings: Crossings;
    } {
      const evidence = new RecordingTransportEvidence();
      const door = streamRecordingDoor();
      const crossings: Crossings = {
        mints: [],
        credentialStates: [],
        availability: [],
        revalidations: [],
        serverFrames: [],
      };
      const revalidate = (): Promise<RevalidateOutcome> => {
        crossings.revalidations.push("revalidate");
        return Promise.resolve("rejected");
      };
      const client = new WsStreamClient({
        clientIdentity: TEST_CLIENT_IDENTITY,
        registry: hostStreamRpcRegistry,
        endpoint: () => mockLocalHostEntry,
        hostId: HOST_ID,
        bearer: () => new MutableBearerLease(HOST_TOKEN, USER_ID),
        userId: USER_ID,
        releasedSignOn: signOnWithMemory(
          PERSONAL_ROW,
          new MutableBearerLease(SIGN_IN, USER_ID),
          hosts,
        ),
        auth: {
          revalidateForReconnect: revalidate,
          revalidateRefused: revalidate,
        },
        clock: null,
        hostCredentialMint: (request) => {
          crossings.mints.push(request.hostId);
          return new Promise<HostCredentialMintOutcome>(() => undefined);
        },
        onHostCredentialState: (_hostId, state) => {
          crossings.credentialStates.push(state);
        },
        evidence,
        webSocketFactory: factory,
        dialTimeoutMs: 1_000,
        openAckTimeoutMs: 1_000,
        pingIntervalMs: 25_000,
        pongTimeoutMs: 50_000,
        initialBackoffMs: 10,
        maxBackoffMs: 1_000,
        door: door.door,
      });
      clients.push(client);
      client.subscribeAvailabilityRecovered((kind) => {
        crossings.availability.push(kind);
      });
      return { client, evidence, door, crossings };
    }

    function subscribeRecording(
      client: WsStreamClient<typeof hostStreamRpcRegistry>,
      crossings: Crossings,
    ): { readonly statuses: string[] } {
      const { session, statuses } = subscribe(client);
      session.onServerFrame((envelope) => {
        crossings.serverFrames.push(envelope);
      });
      return { statuses };
    }

    const settle = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
    };

    /** Opens the socket by hand with no timer advanced; the open frame is read once it is written. */
    async function openByHand(
      socket: StubStreamWebSocket,
    ): Promise<Record<string, unknown>> {
      socket.fireOpen();
      await settle();
      return readFrame(socket.textSent[0]);
    }

    function expectNothingCrossed(input: {
      readonly crossings: Crossings;
      readonly evidence: RecordingTransportEvidence;
      readonly door: StreamRecordingDoor;
      readonly statuses: readonly string[];
    }): void {
      expect(getNegotiatedHostMethods(HOST_ID)).toBeNull();
      expect(
        input.evidence.events.filter((e) => e.kind === "sessionEstablished"),
      ).toEqual([]);
      expect(input.crossings).toEqual({
        mints: [],
        credentialStates: [],
        availability: [],
        revalidations: [],
        serverFrames: [],
      });
      expect(input.door.admitted).toEqual([]);
      expect(input.door.refused).toEqual([]);
      expect(input.statuses).not.toContain("open");
      expect(input.statuses).not.toContain("closed");
    }

    const staleBeforeAck: ReadonlyArray<{
      readonly name: string;
      readonly frame: (manifest: unknown) => object;
    }> = [
      {
        name: "a supported openAck that reports a credential state",
        frame: (manifest) => ({
          kind: "openAck",
          manifest,
          capabilities: PROVISION_CAPABILITIES,
          hostCredentialState: "missing",
        }),
      },
      {
        name: "an unsupported openAck",
        frame: () => ({
          kind: "openAck",
          manifest: {},
          capabilities: PROVISION_CAPABILITIES,
          hostCredentialState: "missing",
        }),
      },
      {
        name: "an incompatible openAck",
        frame: () => ({
          kind: "openAck",
          manifest: { [METHOD]: { major: 99, minor: 0 } },
          capabilities: PROVISION_CAPABILITIES,
          hostCredentialState: "missing",
        }),
      },
      { name: "a bare refusal", frame: () => releasedRefusal() },
      { name: "a not_admitted refusal", frame: () => namedNotAdmitted() },
      {
        name: "a token_expired refusal",
        frame: () => namedRefusal("token_expired"),
      },
    ];

    it.each(staleBeforeAck)(
      "drops $name that the earlier process's socket delivers after the replacement was observed, and redials once on the socket loss's delay",
      async ({ frame }) => {
        vi.useFakeTimers();
        const hosts = createReleasedHostMemory();
        hosts.observeInstance(HOST_ID, "100");
        const { factory, sockets } = makeStubSocketFactory();
        const observed = observedStream(hosts, factory);
        const { statuses } = subscribeRecording(
          observed.client,
          observed.crossings,
        );
        await settle();
        expect(sockets).toHaveLength(1);
        const open = await openByHand(sockets[0]);
        hosts.observeInstance(HOST_ID, "200");

        sockets[0].fireText(frame(open.manifest));
        await settle();
        expectNothingCrossed({ ...observed, statuses });

        // One redial, on the ordinary delay of a socket loss: none sooner.
        expect(sockets).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(9);
        expect(sockets).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sockets).toHaveLength(2);
      },
    );

    it("drops a snapshot, and the frames after it, from a socket whose owner was replaced after it was admitted", async () => {
      vi.useFakeTimers();
      const hosts = createReleasedHostMemory();
      hosts.observeInstance(HOST_ID, "100");
      const { factory, sockets } = makeStubSocketFactory();
      const observed = observedStream(hosts, factory);
      const { statuses } = subscribeRecording(
        observed.client,
        observed.crossings,
      );
      await settle();
      const open = await openByHand(sockets[0]);
      sockets[0].fireText({
        kind: "openAck",
        manifest: open.manifest,
        capabilities: ["credentialUpdate"],
      });
      await settle();
      expect(statuses).toContain("open");
      const delivered = observed.crossings.serverFrames.length;
      const announced = observed.evidence.events.length;

      hosts.observeInstance(HOST_ID, "200");
      sockets[0].fireText({ kind: "snapshot", hasBinaryPayload: false });
      await settle();
      expect(observed.crossings.serverFrames).toHaveLength(delivered);
      // A stale-owner drop is a socket loss: it retracts the announced session and announces nothing.
      expect(
        observed.evidence.events
          .slice(announced)
          .every((event) => event.kind === "sessionLost"),
      ).toBe(true);
      expect(observed.crossings.revalidations).toEqual([]);
      expect(statuses).not.toContain("closed");
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
    });

    it("publishes nothing from a stale unsupported openAck, does not dispose the stream, and admits the replacement's own ack", async () => {
      vi.useFakeTimers();
      const hosts = createReleasedHostMemory();
      hosts.observeInstance(HOST_ID, "100");
      const { factory, sockets } = makeStubSocketFactory();
      const observed = observedStream(hosts, factory);
      const { statuses } = subscribeRecording(
        observed.client,
        observed.crossings,
      );
      await settle();
      const staleOpen = await openByHand(sockets[0]);
      hosts.observeInstance(HOST_ID, "200");
      sockets[0].fireText({
        kind: "openAck",
        manifest: {},
        capabilities: ["credentialUpdate"],
      });
      await settle();
      expect(observed.client.getMethodSupport(METHOD)).toBe("unknown");
      expect(getNegotiatedHostMethods(HOST_ID)).toBeNull();
      expect(statuses).not.toContain("closed");

      // The stream is alive: the replacement is dialed, and its own ack opens it.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
      const open = await openByHand(sockets[1]);
      expect(open.manifest).toEqual(staleOpen.manifest);
      sockets[1].fireText({
        kind: "openAck",
        manifest: open.manifest,
        capabilities: ["credentialUpdate"],
      });
      await settle();
      expect(statuses).toContain("open");
      expect(observed.client.getMethodSupport(METHOD)).toBe("supported");
    });
  });

  describe("a host-token recovery's verdict is taken only while the instance it recovered for is current", () => {
    const HOST_ID = mockLocalHostEntry.hostId;

    function recoveringStream(
      hosts: ReleasedHostMemory,
      factory: IStreamWebSocketFactory,
      signedInAs: () => string | null,
      signIn: BearerSourceProvider,
    ): {
      readonly answerMint: (outcome: HostTokenMintOutcome) => void;
    } & { readonly statuses: string[] } {
      const mints: Array<(outcome: HostTokenMintOutcome) => void> = [];
      const stream = hostTokenStreamAuth(
        {
          tokens: {
            current: () => ({
              token: HOST_TOKEN,
              expiresAtMs: Date.now() + 3_600_000,
            }),
            obtain: () =>
              new Promise<HostTokenMintOutcome>((resolve) => {
                mints.push(resolve);
              }),
          },
          hosts,
          currentUserId: signedInAs,
          hostId: HOST_ID,
          signInRecovery: null,
          onState: () => undefined,
          now: () => Date.now(),
        },
        null,
      );
      const client = new WsStreamClient({
        clientIdentity: TEST_CLIENT_IDENTITY,
        registry: hostStreamRpcRegistry,
        endpoint: () => mockLocalHostEntry,
        hostId: HOST_ID,
        bearer: () => new MutableBearerLease(HOST_TOKEN, USER_ID),
        userId: USER_ID,
        releasedSignOn: releasedSignOnForLocalRow(
          () => PERSONAL_ROW,
          HOST_ID,
          USER_ID,
          signIn,
          null,
          NO_MINTS,
          hosts,
        ),
        auth: stream.auth,
        clock: null,
        hostCredentialMint: null,
        onHostCredentialState: null,
        evidence: NO_TRANSPORT_EVIDENCE,
        webSocketFactory: factory,
        dialTimeoutMs: 1_000,
        openAckTimeoutMs: 1_000,
        pingIntervalMs: 25_000,
        pongTimeoutMs: 50_000,
        initialBackoffMs: 10,
        maxBackoffMs: 1_000,
        door: stream.door,
      });
      clients.push(client);
      const { statuses } = subscribe(client);
      return {
        statuses,
        answerMint: (outcome) => {
          const answer = mints.shift();
          if (answer === undefined) throw new Error("no mint was asked");
          answer(outcome);
        },
      };
    }

    const settle = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
    };

    interface Refused {
      readonly sockets: StubStreamWebSocket[];
      readonly statuses: string[];
      readonly answerMint: (outcome: HostTokenMintOutcome) => void;
    }

    async function refusedNotAdmitted(
      hosts: ReleasedHostMemory,
      signedInAs: () => string | null,
      signIn: BearerSourceProvider,
    ): Promise<Refused> {
      vi.useFakeTimers();
      hosts.observeInstance(HOST_ID, "100");
      const { factory, sockets } = makeStubSocketFactory();
      const recovering = recoveringStream(hosts, factory, signedInAs, signIn);
      await settle();
      sockets[0].fireOpen();
      await settle();
      // The earlier process refuses the host-only token while it is the one observed.
      sockets[0].fireText(namedRefusal("not_admitted"));
      await settle();
      return { sockets, ...recovering };
    }

    it("is not terminal when the mint answers not-admitted for an instance that was replaced meanwhile, and dials the replacement", async () => {
      const hosts = createReleasedHostMemory();
      const refused = await refusedNotAdmitted(
        hosts,
        () => USER_ID,
        () => new MutableBearerLease(SIGN_IN, USER_ID),
      );
      hosts.observeInstance(HOST_ID, "200");
      refused.answerMint({ kind: "not-admitted" });
      await settle();
      expect(refused.statuses).not.toContain("closed");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refused.sockets).toHaveLength(2);
      refused.sockets[1].fireOpen();
      await settle();
      expect(readFrame(refused.sockets[1].textSent[0]).token).toBe(HOST_TOKEN);
    });

    /** The mint for the instance just replaced answers `not-admitted`; the person is still signed in. */
    async function replacedWhileMinting(
      hosts: ReleasedHostMemory,
      refused: Refused,
      replacement: string,
    ): Promise<void> {
      hosts.observeInstance(HOST_ID, replacement);
      refused.answerMint({ kind: "not-admitted" });
      await settle();
    }

    /** The paced dial of the observed instance, which the host then refuses by its own open. */
    async function dialAndRefuse(
      refused: Refused,
      dialed: number,
    ): Promise<void> {
      expect(refused.statuses).not.toContain("closed");
      expect(refused.sockets).toHaveLength(dialed);
      await vi.advanceTimersByTimeAsync(9);
      expect(refused.sockets).toHaveLength(dialed);
      await vi.advanceTimersByTimeAsync(200);
      expect(refused.sockets).toHaveLength(dialed + 1);
      refused.sockets[dialed].fireOpen();
      await settle();
      refused.sockets[dialed].fireText(namedRefusal("not_admitted"));
      await settle();
    }

    it("counts a stale rejection once, and the replacement's admission resets the count", async () => {
      const hosts = createReleasedHostMemory();
      const refused = await refusedNotAdmitted(
        hosts,
        () => USER_ID,
        () => new MutableBearerLease(SIGN_IN, USER_ID),
      );
      await replacedWhileMinting(hosts, refused, "200");
      // Count one. The replacement is dialed, and the host admits it.
      await vi.advanceTimersByTimeAsync(200);
      expect(refused.sockets).toHaveLength(2);
      refused.sockets[1].fireOpen();
      await settle();
      const open = readFrame(refused.sockets[1].textSent[0]);
      refused.sockets[1].fireText({
        kind: "openAck",
        manifest: open.manifest,
        capabilities: ["credentialUpdate"],
      });
      await settle();
      expect(refused.statuses).toContain("open");
      // The count resets on proof of health, a delivered application frame, not at the ack.
      refused.sockets[1].fireText({
        kind: "snapshot",
        hasBinaryPayload: false,
      });
      await settle();

      // After the admission two more stale rejections stay under the bound: with
      // the count not reset they would be the third and end the stream.
      refused.sockets[1].fireText(namedRefusal("not_admitted"));
      await settle();
      await replacedWhileMinting(hosts, refused, "300");
      await dialAndRefuse(refused, 2);
      await replacedWhileMinting(hosts, refused, "400");
      expect(refused.statuses).not.toContain("closed");
      await vi.advanceTimersByTimeAsync(200);
      expect(refused.sockets).toHaveLength(4);
    });

    it("ends the stream at the bound when three successive instances are each replaced while their mint answers not-admitted, pacing every dial", async () => {
      const hosts = createReleasedHostMemory();
      const refused = await refusedNotAdmitted(
        hosts,
        () => USER_ID,
        () => new MutableBearerLease(SIGN_IN, USER_ID),
      );
      await replacedWhileMinting(hosts, refused, "200");
      await dialAndRefuse(refused, 1);
      await replacedWhileMinting(hosts, refused, "300");
      await dialAndRefuse(refused, 2);
      expect(refused.statuses).not.toContain("closed");
      await replacedWhileMinting(hosts, refused, "400");
      // The third stale rejection reaches the bound.
      expect(refused.statuses).toContain("closed");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(refused.sockets).toHaveLength(3);
    });

    it("is terminal for any instance when the person was signed out by the recovery", async () => {
      const hosts = createReleasedHostMemory();
      let signedIn: string | null = USER_ID;
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const refused = await refusedNotAdmitted(
        hosts,
        () => signedIn,
        () => (signedIn === null ? null : signIn),
      );
      hosts.observeInstance(HOST_ID, "200");
      // The refresh signed the person out: nobody is signed in, and no sign-in is left to read.
      signedIn = null;
      refused.answerMint({ kind: "superseded" });
      await settle();
      expect(refused.statuses).toContain("closed");
    });
  });

  describe("a refused attempt announces `reconnecting` as it did before the owner API", () => {
    function refusedStream(
      auth: StreamAuthRevalidator,
      bearer: MutableBearerLease,
    ): {
      readonly sockets: StubStreamWebSocket[];
      readonly statuses: string[];
      readonly session: IStreamSession;
    } {
      const { factory, sockets } = makeStubSocketFactory();
      const client = makeStreamClientAt({
        factory,
        endpoint: () => mockLocalHostEntry,
        hostId: mockLocalHostEntry.hostId,
        bearer: () => bearer,
        userId: USER_ID,
        releasedSignOn: signOnWithMemory(
          PERSONAL_ROW,
          new MutableBearerLease(SIGN_IN, USER_ID),
          createReleasedHostMemory(),
        ),
        auth,
        door: recordingDoor().door,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      return { sockets, ...subscribe(client) };
    }

    const REFUSED_OUTCOMES = [
      {
        name: "the refresh did not reach authn (backoff)",
        answer: (): Promise<RevalidateOutcome> =>
          Promise.resolve("network-error"),
        progress: false,
        entersBackoff: true,
      },
      {
        name: "authn answered and the credential is the one just refused (backoff)",
        answer: (): Promise<RevalidateOutcome> => Promise.resolve("rotated"),
        progress: false,
        entersBackoff: true,
      },
      {
        name: "authn answered with a new credential (the timed redial)",
        answer: (): Promise<RevalidateOutcome> => Promise.resolve("rotated"),
        progress: true,
        entersBackoff: false,
      },
    ];

    /** One stream, opened, then refused once as expired; the refusal's answer is settled. */
    async function refuseOnce(
      outcome: (typeof REFUSED_OUTCOMES)[number],
    ): Promise<{
      readonly sockets: StubStreamWebSocket[];
      readonly statuses: string[];
      readonly session: IStreamSession;
      readonly refuse: () => Promise<void>;
    }> {
      vi.useFakeTimers();
      const bearer = new MutableBearerLease(HOST_TOKEN, USER_ID);
      const revalidate = (): Promise<RevalidateOutcome> => {
        if (outcome.progress) bearer.rotate(ROTATED_HOST_TOKEN);
        return outcome.answer();
      };
      const stream = refusedStream(
        { revalidateForReconnect: revalidate, revalidateRefused: revalidate },
        bearer,
      );
      await vi.advanceTimersByTimeAsync(0);
      stream.sockets[0].fireOpen();
      await vi.advanceTimersByTimeAsync(0);
      return {
        ...stream,
        refuse: async () => {
          stream.sockets[0].fireText(namedRefusal("token_expired"));
          await vi.advanceTimersByTimeAsync(0);
        },
      };
    }

    it.each(REFUSED_OUTCOMES)(
      "emits exactly one `reconnecting` for one refusal when $name",
      async (outcome) => {
        const stream = await refuseOnce(outcome);
        await stream.refuse();
        expect(
          stream.statuses.filter((status) => status === "reconnecting"),
        ).toHaveLength(1);
      },
    );

    it.each(REFUSED_OUTCOMES)(
      "tells of a backoff only when the refusal's answer waits one when $name",
      async (outcome) => {
        const stream = await refuseOnce(outcome);
        expect(signalsBackoff(stream.session)).toBe(true);
        let backoffs = 0;
        if (signalsBackoff(stream.session)) {
          stream.session.onBackoffEntered(() => {
            backoffs += 1;
          });
        }
        await stream.refuse();
        expect(backoffs).toBe(outcome.entersBackoff ? 1 : 0);
        if (!outcome.entersBackoff) {
          // The timed redial that follows a rotation is no backoff either.
          await vi.advanceTimersByTimeAsync(1_000);
          expect(stream.sockets.length).toBeGreaterThanOrEqual(2);
          expect(backoffs).toBe(0);
        }
      },
    );
  });
});

class UnarySocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code: number, _reason: string): void {}

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("released personal host, local unary", () => {
  it("retries the call with the sign-in and the door hears no refusal", async () => {
    const sockets: UnarySocket[] = [];
    const factory: IWebSocketFactory = {
      create: () => {
        const socket = new UnarySocket();
        sockets.push(socket);
        return socket;
      },
    };
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const { door, refusals } = recordingDoor();
    let nextRequestId = 0;
    const client = new WsRpcClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: echoRegistry,
      requestId: () => `req-${(nextRequestId += 1)}`,
      webSocketFactory: factory,
      dialTimeoutMs: 1_000,
      frameTimeoutMs: 1_000,
      hostAttestationWindowMs: 0,
      evidence: NO_TRANSPORT_EVIDENCE,
      hostBearerFor: () => Promise.resolve(hostToken),
      releasedSignOnFor: signInForLocalRow(() => PERSONAL_ROW, null, NO_MINTS),
      doorFor: () => door,
    });
    const settled = client
      .request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: null,
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
          authority: {
            endpoint: {
              hostId: mockLocalHostEntry.hostId,
              websocketUrl: mockLocalHostEntry.websocketUrl,
            },
            bearer: signIn,
            abortSignal: new AbortController().signal,
          },
        },
      )
      .then(
        (value) => ({ kind: "fulfilled" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
    try {
      await vi.waitFor(
        () => expect(sockets.length).toBeGreaterThanOrEqual(1),
        WAIT,
      );
      sockets[0].fireOpen();
      await vi.waitFor(
        () => expect(sockets[0].sent.length).toBeGreaterThan(0),
        WAIT,
      );
      expect(readFrame(sockets[0].sent[0]).token).toBe(HOST_TOKEN);
      sockets[0].fireMessage(releasedRefusal());
      await vi.waitFor(
        () => expect(sockets.length).toBeGreaterThanOrEqual(2),
        WAIT,
      );
      sockets[1].fireOpen();
      await vi.waitFor(
        () => expect(sockets[1].sent.length).toBeGreaterThan(0),
        WAIT,
      );
      const open = readFrame(sockets[1].sent[0]);
      expect(open.token).toBe(SIGN_IN);
      sockets[1].fireMessage({
        kind: "openAck",
        manifest: open.manifest,
        optionalManifest: open.optionalManifest,
      });
      await vi.waitFor(
        () => expect(sockets[1].sent.length).toBeGreaterThanOrEqual(2),
        WAIT,
      );
      const request = readFrame(sockets[1].sent[1]);
      sockets[1].fireMessage({
        kind: "response",
        requestId: request.requestId,
        method: request.method,
        schemaVersion: request.schemaVersion,
        result: { echoed: "hi" },
        error: null,
      });
      expect(await settled).toEqual({
        kind: "fulfilled",
        value: { echoed: "hi" },
      });
      expect(refusals).toEqual([]);
    } finally {
      client.releaseIdleLocalSessions();
    }
  });

  it("refreshes the refused sign-in once and the door hears nothing", async () => {
    const recoveryCalls: string[] = [];
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const driven = driveUnaryRefresh(signIn, {
      revalidateForReconnect: (): Promise<RevalidateOutcome> => {
        recoveryCalls.push("revalidateForReconnect");
        signIn.rotate(ROTATED_SIGN_IN);
        return Promise.resolve("rotated");
      },
    });
    try {
      await refuseHostTokenThenSignIn(driven);
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThanOrEqual(3),
        WAIT,
      );
      const rotated = driven.sockets[2];
      if (rotated === undefined) throw new Error("rotated dial missing");
      rotated.fireOpen();
      await vi.waitFor(
        () => expect(rotated.sent.length).toBeGreaterThan(0),
        WAIT,
      );
      const open = readFrame(rotated.sent[0]);
      expect(open.token).toBe(ROTATED_SIGN_IN);
      rotated.fireMessage({
        kind: "openAck",
        manifest: open.manifest,
        optionalManifest: open.optionalManifest,
      });
      await vi.waitFor(
        () => expect(rotated.sent.length).toBeGreaterThanOrEqual(2),
        WAIT,
      );
      const request = readFrame(rotated.sent[1]);
      rotated.fireMessage({
        kind: "response",
        requestId: request.requestId,
        method: request.method,
        schemaVersion: request.schemaVersion,
        result: { echoed: "hi" },
        error: null,
      });
      expect(await driven.settled).toEqual({
        kind: "fulfilled",
        value: { echoed: "hi" },
      });
      expect(recoveryCalls).toEqual(["revalidateForReconnect"]);
      expect(openTokensOf(driven.sockets)).toEqual([
        HOST_TOKEN,
        SIGN_IN,
        ROTATED_SIGN_IN,
      ]);
      expect(driven.refusals).toEqual([]);
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("fails the call when the sign-in refresh is rejected and tells the door nothing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const recoveryCalls: string[] = [];
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const driven = driveUnaryRefresh(signIn, {
      revalidateForReconnect: (): Promise<RevalidateOutcome> => {
        recoveryCalls.push("revalidateForReconnect");
        return Promise.resolve("rejected");
      },
    });
    try {
      await refuseHostTokenThenSignIn(driven);
      await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
      expect(await driven.settled).toMatchObject({ kind: "rejected" });
      expect(recoveryCalls).toEqual(["revalidateForReconnect"]);
      expect(driven.refusals).toEqual([]);
      expect(openTokensOf(driven.sockets)).toEqual([HOST_TOKEN, SIGN_IN]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(openTokensOf(driven.sockets)).toEqual([HOST_TOKEN, SIGN_IN]);
    } finally {
      vi.useRealTimers();
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("opens every call with the host-only token and sends the sign-in only after it is refused", async () => {
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const driven = startUnary(signIn, createReleasedHostMemory());
    try {
      await admitReleasedUnary(driven);
      driven.client.releaseIdleLocalSessions();
      await admitReleasedUnary(driven);
      expect(openTokensOf(driven.sockets)).toEqual([
        HOST_TOKEN,
        SIGN_IN,
        HOST_TOKEN,
        SIGN_IN,
      ]);
      expect(driven.refusals).toEqual([]);
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("keeps the sign-in off a call to a host remembered as released that now names a reason", async () => {
    const hosts = createReleasedHostMemory();
    hosts.signInAdmitted(
      USER_ID,
      hosts.currentInstance(mockLocalHostEntry.hostId),
    );
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const driven = startUnary(signIn, hosts);
    try {
      let settled = false;
      const call = requestEcho(driven.client, signIn);
      void call.then(() => {
        settled = true;
      });
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
        WAIT,
      );
      driven.sockets[0].fireOpen();
      await vi.waitFor(
        () => expect(driven.sockets[0].sent.length).toBeGreaterThan(0),
        WAIT,
      );
      driven.sockets[0].fireMessage(namedNotAdmitted());
      await vi.waitFor(
        () => expect(settled || driven.sockets.length >= 2).toBe(true),
        WAIT,
      );
      expect(await call).toMatchObject({ kind: "rejected" });
      expect(openTokensOf(driven.sockets)).toEqual([HOST_TOKEN]);
      expect(driven.refusals).toHaveLength(1);
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it.each([
    {
      name: "a current personal host that admits the host-only token",
      row: PERSONAL_ROW,
      refuses: false,
    },
    {
      name: "a current team host that refuses it by name",
      row: TEAM_ROW,
      refuses: true,
    },
  ])(
    "sends no sign-in from a stale memory to $name",
    async ({ row, refuses }) => {
      const hosts = createReleasedHostMemory();
      hosts.signInAdmitted(
        USER_ID,
        hosts.currentInstance(mockLocalHostEntry.hostId),
      );
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      const driven = startUnaryOnRow(row, () => Promise.resolve(HOST_LEASE), {
        recovery: null,
        tokens: NO_MINTS,
        hosts,
      });
      try {
        let settled = false;
        const call = requestEcho(driven.client, signIn);
        void call.then(() => {
          settled = true;
        });
        await vi.waitFor(
          () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
          WAIT,
        );
        driven.sockets[0].fireOpen();
        await vi.waitFor(
          () => expect(driven.sockets[0].sent.length).toBeGreaterThan(0),
          WAIT,
        );
        if (refuses) {
          driven.sockets[0].fireMessage(namedNotAdmitted());
          await vi.waitFor(
            () => expect(settled || driven.sockets.length >= 2).toBe(true),
            WAIT,
          );
          expect(await call).toMatchObject({ kind: "rejected" });
        } else {
          await answerEcho(driven.sockets[0]);
          expect(await call).toEqual({
            kind: "fulfilled",
            value: { echoed: "hi" },
          });
        }
        expect(openTokensOf(driven.sockets)).toEqual([HOST_TOKEN]);
      } finally {
        driven.client.releaseIdleLocalSessions();
      }
    },
  );

  it("keeps the sign-in off a team computer's unary call when a released host refuses its host-only token, and the door hears it once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const driven = startUnaryOnRow(
      TEAM_ROW,
      () => Promise.resolve(HOST_LEASE),
      {
        recovery: null,
        tokens: NO_MINTS,
        hosts: createReleasedHostMemory(),
      },
    );
    try {
      const call = requestEcho(driven.client, signIn);
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
        WAIT,
      );
      driven.sockets[0].fireOpen();
      await vi.waitFor(
        () => expect(driven.sockets[0].sent.length).toBeGreaterThan(0),
        WAIT,
      );
      driven.sockets[0].fireMessage(releasedRefusal());
      expect(await call).toMatchObject({ kind: "rejected" });
      expect(driven.refusals).toHaveLength(1);
      expect(hostDoorStateOfRefusal(driven.refusals[0])).toBe("older-host");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(openTokensOf(driven.sockets)).toEqual([HOST_TOKEN]);
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("keeps the sign-in off a personal computer's unary call when the host has already named a reason, and the door hears the refusal", async () => {
    const hosts = createReleasedHostMemory();
    hosts.refusedNamingReason(
      hosts.currentInstance(mockLocalHostEntry.hostId),
      false,
    );
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const driven = startUnary(signIn, hosts);
    try {
      let settled = false;
      const call = requestEcho(driven.client, signIn);
      void call.then(() => {
        settled = true;
      });
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
        WAIT,
      );
      driven.sockets[0].fireOpen();
      await vi.waitFor(
        () => expect(driven.sockets[0].sent.length).toBeGreaterThan(0),
        WAIT,
      );
      driven.sockets[0].fireMessage(releasedRefusal());
      await vi.waitFor(
        () => expect(settled || driven.sockets.length >= 2).toBe(true),
        WAIT,
      );
      expect(driven.sockets).toHaveLength(1);
      expect(await call).toMatchObject({ kind: "rejected" });
      expect(openTokensOf(driven.sockets)).toEqual([HOST_TOKEN]);
      expect(driven.refusals).toHaveLength(1);
      expect(hostDoorStateOfRefusal(driven.refusals[0])).toBe("older-host");
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("probes a team computer's unary call with the placeholder, never sends the sign-in, and fails it as having no token once the host names its refusal", async () => {
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const driven = startUnaryOnRow(TEAM_ROW, () => Promise.resolve(null), {
      recovery: null,
      tokens: NO_MINTS,
      hosts: createReleasedHostMemory(),
    });
    try {
      const call = requestEcho(driven.client, signIn);
      await answerDial(driven, 0, namedRefusal("not_admitted"));
      const outcome = await call;
      if (outcome.kind !== "rejected") throw new Error("call was admitted");
      expect(outcome.error).toBeInstanceOf(HostRpcError);
      expect(outcome.error).toHaveProperty(
        "message",
        "No host-only token is held for this host",
      );
      expect(openTokensOf(driven.sockets)).toEqual([NO_HOST_TOKEN_PROBE]);
      expect(driven.refusals).toEqual([]);
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("tells the door nothing and dials no more when the personal host refuses the sign-in that follows the no-host-token probe", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const unobtainable = unobtainableTokens();
    await unobtainable.obtain(USER_ID, mockLocalHostEntry.hostId, false, {
      signal: null,
      owner: null,
    });
    const driven = startUnaryOnRow(PERSONAL_ROW, () => Promise.resolve(null), {
      recovery: null,
      tokens: unobtainable,
      hosts: createReleasedHostMemory(),
    });
    try {
      const call = requestEcho(driven.client, signIn);
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
        WAIT,
      );
      driven.sockets[0].fireOpen();
      await vi.waitFor(
        () => expect(driven.sockets[0].sent.length).toBeGreaterThan(0),
        WAIT,
      );
      driven.sockets[0].fireMessage(releasedRefusal());
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
        WAIT,
      );
      driven.sockets[1].fireOpen();
      await vi.waitFor(
        () => expect(driven.sockets[1].sent.length).toBeGreaterThan(0),
        WAIT,
      );
      driven.sockets[1].fireMessage(releasedRefusal());
      expect(await call).toMatchObject({ kind: "rejected" });
      expect(driven.refusals).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(openTokensOf(driven.sockets)).toEqual([
        NO_HOST_TOKEN_PROBE,
        SIGN_IN,
      ]);
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("dials the no-host-token probe on its own socket and sends the ready persistent session nothing for it", async () => {
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const unobtainable = unobtainableTokens();
    let hostTokenHeld = true;
    const driven = startUnaryOnRow(
      PERSONAL_ROW,
      async (hostId) => {
        if (hostTokenHeld) return HOST_LEASE;
        await unobtainable.obtain(USER_ID, hostId, false, {
          signal: null,
          owner: null,
        });
        return null;
      },
      {
        recovery: null,
        tokens: unobtainable,
        hosts: createReleasedHostMemory(),
      },
    );
    try {
      const first = requestEcho(driven.client, signIn);
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
        WAIT,
      );
      const persistent = driven.sockets[0];
      persistent.fireOpen();
      await vi.waitFor(
        () => expect(persistent.sent.length).toBeGreaterThan(0),
        WAIT,
      );
      const open = readFrame(persistent.sent[0]);
      expect(open.token).toBe(HOST_TOKEN);
      persistent.fireMessage({
        kind: "openAck",
        manifest: open.manifest,
        optionalManifest: open.optionalManifest,
        capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
      });
      await vi.waitFor(
        () => expect(persistent.sent.length).toBeGreaterThanOrEqual(2),
        WAIT,
      );
      const request = readFrame(persistent.sent[1]);
      persistent.fireMessage({
        kind: "response",
        requestId: request.requestId,
        method: request.method,
        schemaVersion: request.schemaVersion,
        result: { echoed: "hi" },
        error: null,
      });
      expect(await first).toEqual({
        kind: "fulfilled",
        value: { echoed: "hi" },
      });

      hostTokenHeld = false;
      const probed = requestEcho(driven.client, signIn);
      await vi.waitFor(
        () =>
          expect(
            driven.sockets.length >= 2 || persistent.sent.length >= 3,
          ).toBe(true),
        WAIT,
      );
      expect(persistent.sent).toHaveLength(2);
      expect(driven.sockets).toHaveLength(2);
      const own = driven.sockets[1];
      own.fireOpen();
      await vi.waitFor(() => expect(own.sent.length).toBeGreaterThan(0), WAIT);
      expect(readFrame(own.sent[0]).token).toBe(NO_HOST_TOKEN_PROBE);
      own.fireMessage(namedNotAdmitted());
      expect(await probed).toMatchObject({ kind: "rejected" });
      expect(persistent.sent).toHaveLength(2);
      expect(driven.refusals).toEqual([]);
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("shares a named reason between a stream and a unary call", async () => {
    const hosts = createReleasedHostMemory();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const { factory, sockets } = makeStubSocketFactory();
    const streamDoor = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      signOnWithMemory(PERSONAL_ROW, signIn, hosts),
      streamDoor.door,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    expect((await openFrame(sockets[0])).token).toBe(HOST_TOKEN);
    sockets[0].fireText(namedNotAdmitted());
    await untilStatus(statuses, "closed");

    const driven = startUnary(signIn, hosts);
    try {
      let settled = false;
      const call = requestEcho(driven.client, signIn);
      void call.then(() => {
        settled = true;
      });
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
        WAIT,
      );
      driven.sockets[0].fireOpen();
      await vi.waitFor(
        () => expect(driven.sockets[0].sent.length).toBeGreaterThan(0),
        WAIT,
      );
      driven.sockets[0].fireMessage(releasedRefusal());
      await vi.waitFor(
        () => expect(settled || driven.sockets.length >= 2).toBe(true),
        WAIT,
      );
      expect(await call).toMatchObject({ kind: "rejected" });
      expect(openTokensOf(driven.sockets)).toEqual([HOST_TOKEN]);
      expect(driven.refusals).toHaveLength(1);
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("fails a call with a retryable error, and no frame carries the sign-in, when another transport hears the host name a reason before the OPEN", async () => {
    const hosts = createReleasedHostMemory();
    const { client, sockets } = startUnary(
      new MutableBearerLease(SIGN_IN, USER_ID),
      hosts,
    );
    const pending = requestEcho(
      client,
      new MutableBearerLease(SIGN_IN, USER_ID),
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1), WAIT);
    sockets[0].fireOpen();
    await vi.waitFor(
      () => expect(sockets[0].sent.length).toBeGreaterThan(0),
      WAIT,
    );
    sockets[0].fireMessage(releasedRefusal());
    await vi.waitFor(() => expect(sockets).toHaveLength(2), WAIT);
    // The sign-in dial is planned and waiting for its slot.
    hosts.refusedNamingReason(
      hosts.currentInstance(mockLocalHostEntry.hostId),
      false,
    );
    sockets[1].fireOpen();
    const settled = await pending;
    expect(settled.kind).toBe("rejected");
    if (settled.kind === "rejected")
      expect(settled.error).toBeInstanceOf(RetryableTransportError);
    expect(sockets[1].sent).toEqual([]);
    expect(openTokensOf([sockets[0]])).toEqual([HOST_TOKEN]);
  });

  it("reports nothing to the door when the sign-in's refresh answers network-error", async () => {
    let refreshes = 0;
    const answer = (): Promise<RevalidateOutcome> => {
      refreshes += 1;
      return Promise.resolve("network-error");
    };
    const driven = driveUnaryRefresh(new MutableBearerLease(SIGN_IN, USER_ID), {
      revalidateForReconnect: answer,
      revalidateRefused: answer,
    });
    await refuseHostTokenThenSignIn(driven);
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({ kind: "rejected" });
    expect(openTokensOf(driven.sockets)).toEqual([HOST_TOKEN, SIGN_IN]);
    expect(refreshes).toBe(1);
    expect(driven.refusals).toEqual([]);
  });

  it("reports nothing to the door when the sign-in's refresh answers rejected after another call to the host was admitted", async () => {
    const answers: Array<(outcome: RevalidateOutcome) => void> = [];
    const pending = (): Promise<RevalidateOutcome> =>
      new Promise<RevalidateOutcome>((resolve) => {
        answers.push(resolve);
      });
    const driven = driveUnaryRefresh(new MutableBearerLease(SIGN_IN, USER_ID), {
      revalidateForReconnect: pending,
      revalidateRefused: pending,
    });
    await refuseHostTokenThenSignIn(driven);
    await vi.waitFor(() => expect(answers).toHaveLength(1), WAIT);

    // Call B reaches the same host and is admitted while A's refresh runs.
    const other = requestEcho(
      driven.client,
      new MutableBearerLease(SIGN_IN, USER_ID),
    );
    await vi.waitFor(() => expect(driven.sockets).toHaveLength(3), WAIT);
    const admitted = driven.sockets[2];
    if (admitted === undefined) throw new Error("second call's dial missing");
    admitted.fireOpen();
    await vi.waitFor(
      () => expect(admitted.sent.length).toBeGreaterThan(0),
      WAIT,
    );
    await answerEcho(admitted);
    expect(await other).toMatchObject({ kind: "fulfilled" });

    answers[0]("rejected");
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
    expect(await driven.settled).toMatchObject({ kind: "rejected" });
    expect(driven.refusals).toEqual([]);
  });

  describe("a spent retry is never the door's refusal", () => {
    it("tells the door nothing when the resend after a refresh that left the bearer unchanged is refused bare again", async () => {
      const recoveryCalls: string[] = [];
      const answer = (): Promise<RevalidateOutcome> => {
        recoveryCalls.push("refresh");
        return Promise.resolve("rotated");
      };
      const driven = driveUnaryRefresh(
        new MutableBearerLease(SIGN_IN, USER_ID),
        { revalidateForReconnect: answer, revalidateRefused: answer },
      );
      await refuseHostTokenThenSignIn(driven);
      await answerDial(driven, 2, releasedRefusal());
      await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
      expect(await driven.settled).toMatchObject({ kind: "rejected" });
      expect(recoveryCalls).toEqual(["refresh"]);
      expect(openTokensOf(driven.sockets)).toEqual([
        HOST_TOKEN,
        SIGN_IN,
        SIGN_IN,
      ]);
      expect(driven.refusals).toEqual([]);
    });

    it("tells the door nothing when the refresh changed the bearer and the new one is refused bare too, and the call spends one refresh", async () => {
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      let refreshes = 0;
      const answer = (): Promise<RevalidateOutcome> => {
        refreshes += 1;
        signIn.rotate(ROTATED_SIGN_IN);
        return Promise.resolve("rotated");
      };
      const driven = driveUnaryRefresh(signIn, {
        revalidateForReconnect: answer,
        revalidateRefused: answer,
      });
      await refuseHostTokenThenSignIn(driven);
      await answerDial(driven, 2, releasedRefusal());
      await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
      expect(await driven.settled).toMatchObject({ kind: "rejected" });
      expect(openTokensOf(driven.sockets)).toEqual([
        HOST_TOKEN,
        SIGN_IN,
        ROTATED_SIGN_IN,
      ]);
      expect(refreshes).toBe(1);
      expect(driven.refusals).toEqual([]);
    });

    it("lets the next call spend one refresh again once a call was admitted", async () => {
      const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
      let refreshes = 0;
      const answer = (): Promise<RevalidateOutcome> => {
        refreshes += 1;
        signIn.rotate(`sign-in-${refreshes}`);
        return Promise.resolve("rotated");
      };
      const driven = driveUnaryRefresh(signIn, {
        revalidateForReconnect: answer,
        revalidateRefused: answer,
      });
      try {
        await refuseHostTokenThenSignIn(driven);
        await vi.waitFor(
          () => expect(driven.sockets.length).toBeGreaterThanOrEqual(3),
          WAIT,
        );
        const admitted = driven.sockets[2];
        if (admitted === undefined) throw new Error("rotated dial missing");
        admitted.fireOpen();
        await vi.waitFor(
          () => expect(admitted.sent.length).toBeGreaterThan(0),
          WAIT,
        );
        await answerEcho(admitted);
        expect(await driven.settled).toMatchObject({ kind: "fulfilled" });
        expect(refreshes).toBe(1);

        driven.client.releaseIdleLocalSessions();
        const next = requestEcho(driven.client, signIn);
        await answerDial(driven, 3, releasedRefusal());
        await answerDial(driven, 4, releasedRefusal());
        await vi.waitFor(() => expect(refreshes).toBe(2), WAIT);
        await answerDial(driven, 5, releasedRefusal());
        expect(await next).toMatchObject({ kind: "rejected" });
        expect(refreshes).toBe(2);
      } finally {
        driven.client.releaseIdleLocalSessions();
      }
    });

    it("sends the placeholder again, not the rotated sign-in, after the invited sign-in expires, and tells the door nothing", async () => {
      const answer = (): Promise<RevalidateOutcome> =>
        Promise.resolve("rotated");
      const driven = startUnaryOnRow(
        PERSONAL_ROW,
        () => Promise.resolve(null),
        {
          recovery: {
            revalidateForReconnect: answer,
            revalidateRefused: answer,
          },
          tokens: NO_MINTS,
          hosts: createReleasedHostMemory(),
        },
      );
      const call = requestEcho(
        driven.client,
        new MutableBearerLease(SIGN_IN, USER_ID),
      );
      try {
        await answerDial(driven, 0, namedRefusal("owner_sign_in"));
        await answerDial(driven, 1, namedRefusal("token_expired"));
        // The invitation was spent by the sign-in it invited: the host is
        // asked again, and the sign-in goes only when it invites again.
        await answerDial(driven, 2, namedRefusal("owner_sign_in"));
        await answerDial(driven, 3, namedRefusal("token_expired"));
        expect(await call).toMatchObject({ kind: "rejected" });
        expect(openTokensOf(driven.sockets)).toEqual([
          NO_HOST_TOKEN_PROBE,
          SIGN_IN,
          NO_HOST_TOKEN_PROBE,
          SIGN_IN,
        ]);
        expect(driven.refusals).toEqual([]);
      } finally {
        driven.client.releaseIdleLocalSessions();
      }
    });
  });

  it.each(["rejected", "local-plane-retained"] as const)(
    "tells the door nothing when the call was abandoned and the sign-in's pending refresh then answers %s",
    async (late) => {
      const answers: Array<(outcome: RevalidateOutcome) => void> = [];
      const pending = (): Promise<RevalidateOutcome> =>
        new Promise<RevalidateOutcome>((resolve) => {
          answers.push(resolve);
        });
      const driven = driveUnaryRefresh(
        new MutableBearerLease(SIGN_IN, USER_ID),
        { revalidateForReconnect: pending, revalidateRefused: pending },
      );
      await refuseHostTokenThenSignIn(driven);
      await vi.waitFor(() => expect(answers).toHaveLength(1), WAIT);

      driven.abort();
      answers[0](late);
      await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);
      expect(await driven.settled).toMatchObject({ kind: "rejected" });
      expect(driven.refusals).toEqual([]);
    },
  );

  it("hands the recovery a still-wanted check that reads the call's abort, so a recovery that awaited first sees the call ended", async () => {
    const heldRead: { release: () => void } = { release: () => undefined };
    const readHeld = new Promise<void>((resolve) => {
      heldRead.release = resolve;
    });
    let started = 0;
    const wanted: boolean[] = [];
    const driven = driveUnaryRefresh(new MutableBearerLease(SIGN_IN, USER_ID), {
      // A recovery that reads the stored sign-in before it rotates asks last, after that await.
      revalidateForReconnect: async (
        _owner: HostInstance,
        _refusal: SignInRefusal | null,
        stillWanted: () => boolean,
      ): Promise<RevalidateOutcome> => {
        started += 1;
        await readHeld;
        wanted.push(stillWanted());
        return "network-error";
      },
    });
    await refuseHostTokenThenSignIn(driven);
    await vi.waitFor(() => expect(started).toBe(1), WAIT);

    driven.abort();
    heldRead.release();
    await vi.waitFor(() => expect(driven.finished).toBe(true), WAIT);

    expect(wanted).toEqual([false]);
  });
});

/** Waits for the dial at `index`, opens it, and answers its OPEN with `frame`. */
async function answerDial(
  driven: { readonly sockets: readonly UnarySocket[] },
  index: number,
  frame: unknown,
): Promise<void> {
  await vi.waitFor(
    () => expect(driven.sockets.length).toBeGreaterThanOrEqual(index + 1),
    WAIT,
  );
  const socket = driven.sockets[index];
  if (socket === undefined) throw new Error(`dial ${index} missing`);
  socket.fireOpen();
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0), WAIT);
  socket.fireMessage(frame);
}

function openTokensOf(sockets: readonly UnarySocket[]): unknown[] {
  return sockets.map((socket) => readFrame(socket.sent[0]).token);
}

function driveUnaryRefresh(
  signIn: MutableBearerLease,
  recovery: StreamAuthRevalidator | SignInRecovery,
): {
  readonly client: WsRpcClient<typeof echoRegistry>;
  readonly sockets: UnarySocket[];
  readonly refusals: FatalErrorDetails[];
  readonly abort: () => void;
  readonly settled: Promise<
    | {
        readonly kind: "fulfilled";
        readonly value: { readonly echoed: string };
      }
    | { readonly kind: "rejected"; readonly error: unknown }
  >;
  finished: boolean;
} {
  const sockets: UnarySocket[] = [];
  const factory: IWebSocketFactory = {
    create: () => {
      const socket = new UnarySocket();
      sockets.push(socket);
      return socket;
    },
  };
  const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
  const { door, refusals } = recordingDoor();
  const aborted = new AbortController();
  let nextRequestId = 0;
  const client = new WsRpcClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: echoRegistry,
    requestId: () => `req-${(nextRequestId += 1)}`,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    frameTimeoutMs: 1_000,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
    hostBearerFor: () => Promise.resolve(hostToken),
    releasedSignOnFor: signInForLocalRow(
      () => PERSONAL_ROW,
      recovery,
      NO_MINTS,
    ),
    doorFor: () => door,
  });
  const driven = {
    client,
    sockets,
    refusals,
    abort: () => aborted.abort(),
    finished: false,
    settled: client
      .request(
        "host.echo",
        { message: "hi" },
        {
          idempotencyKey: null,
          replayMustBeKeyed: false,
          requiredHostMethodVersion: null,
          authority: {
            endpoint: {
              hostId: mockLocalHostEntry.hostId,
              websocketUrl: mockLocalHostEntry.websocketUrl,
            },
            bearer: signIn,
            abortSignal: aborted.signal,
          },
        },
      )
      .then(
        (value) => ({ kind: "fulfilled" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
  };
  void driven.settled.then(
    () => {
      driven.finished = true;
    },
    () => {
      driven.finished = true;
    },
  );
  return driven;
}

function startUnary(
  signIn: MutableBearerLease,
  hosts: ReleasedHostMemory,
): {
  readonly client: WsRpcClient<typeof echoRegistry>;
  readonly sockets: UnarySocket[];
  readonly refusals: FatalErrorDetails[];
} {
  const sockets: UnarySocket[] = [];
  const factory: IWebSocketFactory = {
    create: () => {
      const socket = new UnarySocket();
      sockets.push(socket);
      return socket;
    },
  };
  const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
  const { door, refusals } = recordingDoor();
  let nextRequestId = 0;
  const client = new WsRpcClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: echoRegistry,
    requestId: () => `req-${(nextRequestId += 1)}`,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    frameTimeoutMs: 1_000,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
    hostBearerFor: () => Promise.resolve(hostToken),
    releasedSignOnFor: signInForLocalRow(() => PERSONAL_ROW, null, NO_MINTS),
    releasedHosts: hosts,
    doorFor: () => door,
  });
  return { client, sockets, refusals };
}

const HOST_LEASE = new MutableBearerLease(HOST_TOKEN, USER_ID);

function startUnaryOnRow(
  row: ReleasedSignOnRow,
  hostBearerFor: (hostId: string) => Promise<MutableBearerLease | null>,
  deps: {
    readonly recovery: StreamAuthRevalidator | null;
    readonly tokens: TrackedHostTokens;
    readonly hosts: ReleasedHostMemory;
  },
): {
  readonly client: WsRpcClient<typeof echoRegistry>;
  readonly sockets: UnarySocket[];
  readonly refusals: FatalErrorDetails[];
} {
  const sockets: UnarySocket[] = [];
  const factory: IWebSocketFactory = {
    create: () => {
      const socket = new UnarySocket();
      sockets.push(socket);
      return socket;
    },
  };
  const { door, refusals } = recordingDoor();
  let nextRequestId = 0;
  const client = new WsRpcClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: echoRegistry,
    requestId: () => `req-${(nextRequestId += 1)}`,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    frameTimeoutMs: 1_000,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
    hostBearerFor,
    releasedSignOnFor: signInForLocalRow(() => row, deps.recovery, deps.tokens),
    releasedHosts: deps.hosts,
    doorFor: () => door,
  });
  return { client, sockets, refusals };
}

function requestEcho(
  client: WsRpcClient<typeof echoRegistry>,
  signIn: MutableBearerLease,
): Promise<
  | { readonly kind: "fulfilled"; readonly value: { readonly echoed: string } }
  | { readonly kind: "rejected"; readonly error: unknown }
> {
  return client
    .request(
      "host.echo",
      { message: "hi" },
      {
        idempotencyKey: null,
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        authority: {
          endpoint: {
            hostId: mockLocalHostEntry.hostId,
            websocketUrl: mockLocalHostEntry.websocketUrl,
          },
          bearer: signIn,
          abortSignal: new AbortController().signal,
        },
      },
    )
    .then(
      (value) => ({ kind: "fulfilled" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
}

/** Admits the host-only token's released refusal, then the sign-in. */
async function admitReleasedUnary(driven: {
  readonly client: WsRpcClient<typeof echoRegistry>;
  readonly sockets: readonly UnarySocket[];
}): Promise<void> {
  const base = driven.sockets.length;
  const pending = requestEcho(
    driven.client,
    new MutableBearerLease(SIGN_IN, USER_ID),
  );
  await vi.waitFor(
    () => expect(driven.sockets.length).toBeGreaterThanOrEqual(base + 1),
    WAIT,
  );
  const first = driven.sockets[base];
  if (first === undefined) throw new Error("host-token dial missing");
  first.fireOpen();
  await vi.waitFor(() => expect(first.sent.length).toBeGreaterThan(0), WAIT);
  expect(readFrame(first.sent[0]).token).toBe(HOST_TOKEN);
  first.fireMessage(releasedRefusal());
  await vi.waitFor(
    () => expect(driven.sockets.length).toBeGreaterThanOrEqual(base + 2),
    WAIT,
  );
  const second = driven.sockets[base + 1];
  if (second === undefined) throw new Error("sign-in dial missing");
  second.fireOpen();
  await vi.waitFor(() => expect(second.sent.length).toBeGreaterThan(0), WAIT);
  expect(readFrame(second.sent[0]).token).toBe(SIGN_IN);
  await answerEcho(second);
  expect(await pending).toEqual({ kind: "fulfilled", value: { echoed: "hi" } });
}

/** Completes the call whose `open` this socket has sent: the ack, then the echo. */
async function answerEcho(socket: UnarySocket): Promise<void> {
  const open = readFrame(socket.sent[0]);
  socket.fireMessage({
    kind: "openAck",
    manifest: open.manifest,
    optionalManifest: open.optionalManifest,
  });
  await vi.waitFor(
    () => expect(socket.sent.length).toBeGreaterThanOrEqual(2),
    WAIT,
  );
  const request = readFrame(socket.sent[1]);
  socket.fireMessage({
    kind: "response",
    requestId: request.requestId,
    method: request.method,
    schemaVersion: request.schemaVersion,
    result: { echoed: "hi" },
    error: null,
  });
}

/** Refuses the host-only token, then the first sign-in, the way a 1.5.4 host does. */
async function refuseHostTokenThenSignIn(driven: {
  readonly sockets: readonly UnarySocket[];
  finished: boolean;
}): Promise<void> {
  await vi.waitFor(
    () => expect(driven.finished || driven.sockets.length >= 1).toBe(true),
    WAIT,
  );
  const first = driven.sockets[0];
  if (first === undefined) return;
  first.fireOpen();
  await vi.waitFor(
    () => expect(driven.finished || first.sent.length > 0).toBe(true),
    WAIT,
  );
  if (first.sent.length === 0) return;
  first.fireMessage(releasedRefusal());
  await vi.waitFor(
    () => expect(driven.finished || driven.sockets.length >= 2).toBe(true),
    WAIT,
  );
  const second = driven.sockets[1];
  if (second === undefined) return;
  second.fireOpen();
  await vi.waitFor(
    () => expect(driven.finished || second.sent.length > 0).toBe(true),
    WAIT,
  );
  if (second.sent.length === 0) return;
  second.fireMessage(releasedRefusal());
}
