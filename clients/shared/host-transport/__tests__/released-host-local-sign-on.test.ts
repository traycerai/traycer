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
import type { SessionDoorObserver } from "@traycer/protocol/host-transport/remote/auth";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "@traycer/protocol/host-transport/websocket";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";
import type { IWebSocketFactory } from "../ws-factory";
import type { IStreamWebSocketFactory } from "../ws-stream-factory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { hostDoorStateOfRefusal } from "../host-door-state";
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
});

const sessions: IStreamSession[] = [];
const clients: WsStreamClient<typeof hostStreamRpcRegistry>[] = [];

function releasedRefusal(): {
  readonly kind: "fatalError";
  readonly details: FatalErrorDetails;
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "released-host-token-refusal",
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
  readonly door: SessionDoorObserver;
  readonly refusals: FatalErrorDetails[];
} {
  const refusals: FatalErrorDetails[] = [];
  return {
    refusals,
    door: {
      refused: (details) => {
        refusals.push(details);
      },
      admitted: () => undefined,
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
  return releasedSignOnForLocalRow(
    row,
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
  door: SessionDoorObserver,
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
  door: SessionDoorObserver,
  evidence: TransportEvidenceReporter,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    hostId: mockLocalHostEntry.hostId,
    bearer,
    userId,
    releasedSignOn,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    openAckTimeoutMs: 1_000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
    door,
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
        PERSONAL_ROW,
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
    { reason: "keys_unavailable", state: "keys-unavailable" },
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
          PERSONAL_ROW,
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

  it("reports the refusal once when the personal host refuses the sign-in too", async () => {
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
    expect(refusals).toHaveLength(1);
    expect(hostDoorStateOfRefusal(refusals[0])).toBe("older-host");
    const opensAtClose = sockets.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(opensAtClose);
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
        PERSONAL_ROW,
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
        PERSONAL_ROW,
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

  it("fails the call when the sign-in refresh is rejected and the door hears that refusal once", async () => {
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
      expect(driven.refusals).toHaveLength(1);
      expect(hostDoorStateOfRefusal(driven.refusals[0])).toBe("older-host");
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

  it("dials nothing for a team computer's unary call with no host-only token, and fails it as having no token", async () => {
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const driven = startUnaryOnRow(TEAM_ROW, () => Promise.resolve(null), {
      recovery: null,
      tokens: NO_MINTS,
      hosts: createReleasedHostMemory(),
    });
    try {
      const outcome = await requestEcho(driven.client, signIn);
      if (outcome.kind !== "rejected") throw new Error("call was admitted");
      expect(outcome.error).toBeInstanceOf(HostRpcError);
      expect(outcome.error).toHaveProperty(
        "message",
        "No host-only token is held for this host",
      );
      expect(driven.sockets).toHaveLength(0);
      expect(driven.refusals).toEqual([]);
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("reports the refusal once and dials no more when the personal host refuses the sign-in that follows the no-host-token probe", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const unobtainable = trackHostTokenMints({
      current: () => null,
      obtain: () => Promise.resolve({ kind: "not-admitted" }),
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
      expect(driven.refusals).toHaveLength(1);
      expect(hostDoorStateOfRefusal(driven.refusals[0])).toBe("older-host");
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
});

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
            abortSignal: new AbortController().signal,
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
