import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import {
  hostDoorStateOfRefusal,
  type HostDoorObserver,
  type StreamDoorObserver,
} from "../host-door-state";
import type { IStreamSession } from "../i-stream-session";
import { resetNegotiatedManifests } from "../negotiated-manifest-registry";
import { resetNegotiatedStreamVersions } from "../negotiated-stream-version-registry";
import {
  trackHostTokenMints,
  type TrackedHostTokens,
} from "../../auth/host-token-lease";
import {
  createReleasedHostMemory,
  releasedSignOnForLocalRow,
  signInForLocalRow,
  type ReleasedHostMemory,
  type ReleasedSignOn,
  type ReleasedSignOnRow,
} from "../released-sign-on";
import {
  makeStubSocketFactory,
  StubStreamWebSocket,
} from "../__testing__/stub-stream-socket";
import { WsRpcClient } from "../ws-rpc-client";
import { WsStreamClient } from "../ws-stream-client";
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
const NO_MINTS = trackHostTokenMints({
  current: () => null,
  obtain: () => Promise.resolve({ kind: "no-sign-in" }),
  loaded: () => true,
  whenLoaded: () => Promise.resolve(),
});

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
function streamRecordingDoor(): {
  readonly door: StreamDoorObserver;
  readonly admitted: string[];
  readonly refused: Array<{ readonly hostId: string; readonly reason: string }>;
} {
  const admitted: string[] = [];
  const refused: Array<{ readonly hostId: string; readonly reason: string }> =
    [];
  return {
    admitted,
    refused,
    door: {
      admitted: (hostId) => {
        admitted.push(hostId);
        return () => undefined;
      },
      refused: (details, hostId) => {
        refused.push({ hostId, reason: details.reason });
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
  readonly bearer: (hostId: string) => MutableBearerLease | null;
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

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  for (const client of clients.splice(0)) client.close("test-done");
  resetNegotiatedStreamVersions();
  resetNegotiatedManifests();
  vi.useRealTimers();
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
    hosts.refusedNamingReason(mockLocalHostEntry.hostId);
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
      hosts.refusedNamingReason(mockLocalHostEntry.hostId);
      // What the directory service calls when the same host id comes back under another pid.
      if (forgetBefore) hosts.forgetNamed(mockLocalHostEntry.hostId);
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
    const redialed = await openFrame(sockets[2]);
    expect(redialed.token).toBe(SIGN_IN);
    ack(sockets[2], redialed, ["credentialUpdate"]);
    await untilStatus(statuses, "open");

    refreshes[0]("rejected");
    await vi.advanceTimersByTimeAsync(0);
    signIn.rotate(ROTATED_SIGN_IN);
    client.notifyBearerRotated();
    expect(credentialUpdateTokens(sockets[2])).toEqual([ROTATED_SIGN_IN]);
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
    hosts.signInAdmitted(USER_ID, mockLocalHostEntry.hostId);
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
      hosts.signInAdmitted(USER_ID, mockLocalHostEntry.hostId);
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
      dialed.hosts.refusedNamingReason(mockLocalHostEntry.hostId);
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
    const recovered: FatalErrorDetails[] = [];
    const recovery: StreamAuthRevalidator = {
      revalidateForReconnect: () => Promise.resolve("rotated"),
      revalidateRefused: (refusal) => {
        recovered.push(refusal);
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
    expect(hostDoorStateOfRefusal(recovered[0])).toBe("older-host");
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

    function releasedStream(
      signIn: MutableBearerLease,
      recovery: StreamAuthRevalidator,
    ): {
      readonly sockets: StubStreamWebSocket[];
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
      return { sockets, ...subscribe(client) };
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
      hosts.refusedNamingReason(mockLocalHostEntry.hostId);
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
      revalidateForReconnect: () => {
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
      revalidateForReconnect: () => {
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
    hosts.signInAdmitted(USER_ID, mockLocalHostEntry.hostId);
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
      hosts.signInAdmitted(USER_ID, mockLocalHostEntry.hostId);
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
    hosts.refusedNamingReason(mockLocalHostEntry.hostId);
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
    const unobtainable = trackHostTokenMints({
      current: () => null,
      obtain: () => Promise.resolve({ kind: "not-admitted" }),
      loaded: () => true,
      whenLoaded: () => Promise.resolve(),
    });
    await unobtainable.obtain(USER_ID, mockLocalHostEntry.hostId, false, null);
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
    const unobtainable = trackHostTokenMints({
      current: () => null,
      obtain: () => Promise.resolve({ kind: "not-admitted" }),
      loaded: () => true,
      whenLoaded: () => Promise.resolve(),
    });
    let hostTokenHeld = true;
    const driven = startUnaryOnRow(
      PERSONAL_ROW,
      async (hostId) => {
        if (hostTokenHeld) return HOST_LEASE;
        await unobtainable.obtain(USER_ID, hostId, false, null);
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
    hosts.refusedNamingReason(mockLocalHostEntry.hostId);
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

    it("tells the door nothing when the invited owner sign-in is refused token_expired again after its refresh", async () => {
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
        await answerDial(driven, 2, namedRefusal("token_expired"));
        expect(await call).toMatchObject({ kind: "rejected" });
        expect(openTokensOf(driven.sockets)).toEqual([
          NO_HOST_TOKEN_PROBE,
          SIGN_IN,
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
  recovery: StreamAuthRevalidator,
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
