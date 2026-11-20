import type { StreamAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import type { FatalErrorDetails } from "@traycer/protocol/framework/index";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SessionDoorObserver } from "@traycer/protocol/host-transport/remote/auth";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "@traycer/protocol/host-transport/websocket";
import type { IWebSocketFactory } from "../ws-factory";
import type { IStreamWebSocketFactory } from "../ws-stream-factory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { hostDoorStateOfRefusal } from "../host-door-state";
import type { IStreamSession } from "../i-stream-session";
import { resetNegotiatedManifests } from "../negotiated-manifest-registry";
import { resetNegotiatedStreamVersions } from "../negotiated-stream-version-registry";
import { trackHostTokenMints } from "../../auth/host-token-lease";
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
  return releasedSignOnForLocalRow(
    row,
    mockLocalHostEntry.hostId,
    USER_ID,
    () => signIn,
    null,
    NO_MINTS,
    createReleasedHostMemory(),
  );
}

function makeStreamClient(
  factory: IStreamWebSocketFactory,
  hostToken: MutableBearerLease,
  releasedSignOn: ReleasedSignOn | null,
  door: SessionDoorObserver,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    hostId: mockLocalHostEntry.hostId,
    bearer: () => hostToken,
    userId: hostToken.identity.userId,
    releasedSignOn,
    auth: null,
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

  it("keeps the sign-in off a team computer and the door hears the refusal", async () => {
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
    vi.useFakeTimers();
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

  it("redials the sign-in after a drop, then the host-only token once that sign-in is refused by name", async () => {
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
    sockets[1].fireClose(1006, "drop");
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(3),
      WAIT,
    );
    const remembered = await openFrame(sockets[2]);
    expect(remembered.token).toBe(SIGN_IN);
    sockets[2].fireText(namedNotAdmitted());
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(4),
      WAIT,
    );
    const updated = await openFrame(sockets[3]);
    expect(updated.token).toBe(HOST_TOKEN);
    ack(sockets[3], updated, ["credentialUpdate"]);
    signIn.rotate(ROTATED_SIGN_IN);
    client.notifyBearerRotated();
    expect(tokensOf(sockets[3])).not.toContain(SIGN_IN);
    expect(tokensOf(sockets[3])).not.toContain(ROTATED_SIGN_IN);
    sockets[3].fireClose(1006, "drop");
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(5),
      WAIT,
    );
    const held = await openFrame(sockets[4]);
    expect(held.token).toBe(HOST_TOKEN);
    expect(tokensOf(sockets[4])).not.toContain(SIGN_IN);
    expect(refusals).toEqual([]);
    const opensAtHold = sockets.length;
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(opensAtHold);
    expect(refusals).toEqual([]);
  });

  it("dials the sign-in first when a released connection drops", async () => {
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
    sockets[1].fireClose(1006, "drop");
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(3),
      WAIT,
    );
    const redial = await openFrame(sockets[2]);
    expect(redial.token).toBe(SIGN_IN);
    expect(refusals).toEqual([]);
  });

  it("reports the refusal once when the personal host refuses the sign-in too", async () => {
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
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(opensAtClose);
  });

  it("keeps every later dial on the host-only token when an admitted stream is closed without a door reason", async () => {
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
    vi.useFakeTimers();
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

  it("dials the host-only token when a remembered host's row no longer allows the sign-in", async () => {
    const { factory, sockets } = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const hosts = createReleasedHostMemory();
    let rowAllows = true;
    const { door, refusals } = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      {
        signIn: () => signIn,
        recovery: null,
        allowed: () => Promise.resolve(rowAllows),
        hostTokenUnobtainable: () => false,
        ownerSignInEligible: () => false,
        heldTokenRefused: () => false,
        hosts,
      },
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
    rowAllows = false;
    sockets[1].fireClose(1006, "drop");
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(3),
      WAIT,
    );
    const redial = await openFrame(sockets[2]);
    expect(redial.token).toBe(HOST_TOKEN);
    expect(tokensOf(sockets[2])).not.toContain(SIGN_IN);
    expect(refusals).toEqual([]);
  });

  it("does not present one person's remembered sign-in on another person's dial", async () => {
    const hosts = createReleasedHostMemory();
    const first = makeStubSocketFactory();
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door } = recordingDoor();
    const client = makeStreamClient(
      first.factory,
      hostToken,
      {
        signIn: () => signIn,
        recovery: null,
        allowed: () => Promise.resolve(true),
        hostTokenUnobtainable: () => false,
        ownerSignInEligible: () => false,
        heldTokenRefused: () => false,
        hosts,
      },
      door,
    );
    const { statuses } = subscribe(client);
    await vi.waitFor(
      () => expect(first.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const refused = await openFrame(first.sockets[0]);
    first.sockets[0].fireText(releasedRefusal());
    await vi.waitFor(
      () => expect(first.sockets.length).toBeGreaterThanOrEqual(2),
      WAIT,
    );
    const admitted = await openFrame(first.sockets[1]);
    expect(admitted.token).toBe(SIGN_IN);
    ack(first.sockets[1], admitted, ["credentialUpdate"]);
    await untilStatus(statuses, "open");
    const otherSignIn = "other-person-sign-in";
    const second = makeStubSocketFactory();
    const other = new MutableBearerLease(otherSignIn, "user-b");
    const otherDoor = recordingDoor();
    const otherClient = makeStreamClient(
      second.factory,
      new MutableBearerLease(HOST_TOKEN, "user-b"),
      {
        signIn: () => other,
        recovery: null,
        allowed: () => Promise.resolve(true),
        hostTokenUnobtainable: () => false,
        ownerSignInEligible: () => false,
        heldTokenRefused: () => false,
        hosts,
      },
      otherDoor.door,
    );
    subscribe(otherClient);
    await vi.waitFor(
      () => expect(second.sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const opened = await openFrame(second.sockets[0]);
    expect(opened.token).toBe(HOST_TOKEN);
    expect(tokensOf(second.sockets[0])).not.toContain(otherSignIn);
    expect(tokensOf(second.sockets[0])).not.toContain(SIGN_IN);
  });

  it("asks the row again when the endpoint changes while the first answer is in flight", async () => {
    const hosts = createReleasedHostMemory();
    const h1 = "remembered-host-1";
    const h2 = "remembered-host-2";
    hosts.signInAdmitted(USER_ID, h1);
    hosts.signInAdmitted(USER_ID, h2);
    let currentHost = h1;
    const gates: Array<(allowed: boolean) => void> = [];
    let calls = 0;
    const { factory, sockets } = makeStubSocketFactory();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const { door } = recordingDoor();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => ({
        hostId: currentHost,
        websocketUrl: "ws://127.0.0.1:9/rpc",
      }),
      hostId: h1,
      bearer: () => new MutableBearerLease(HOST_TOKEN, USER_ID),
      userId: USER_ID,
      releasedSignOn: {
        signIn: () => signIn,
        recovery: null,
        allowed: () => {
          calls += 1;
          return new Promise<boolean>((resolve) => {
            gates.push(resolve);
          });
        },
        hostTokenUnobtainable: () => false,
        ownerSignInEligible: () => false,
        heldTokenRefused: () => false,
        hosts,
      },
      auth: null,
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
      door,
    });
    clients.push(client);
    subscribe(client);
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(1), WAIT);
    expect(sockets).toHaveLength(0);
    currentHost = h2;
    const firstAnswer = gates[0];
    if (firstAnswer === undefined) throw new Error("row ask missing");
    firstAnswer(true);
    await vi.waitFor(
      () => expect(calls >= 2 || sockets.length > 0).toBe(true),
      WAIT,
    );
    expect(calls).toBe(2);
    expect(sockets).toHaveLength(0);
    const secondAnswer = gates[1];
    if (secondAnswer === undefined) throw new Error("second row ask missing");
    secondAnswer(true);
    await vi.waitFor(
      () => expect(sockets.length).toBeGreaterThanOrEqual(1),
      WAIT,
    );
    const opened = await openFrame(sockets[0]);
    expect(opened.token).toBe(SIGN_IN);
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
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(openTokensOf(driven.sockets)).toEqual([HOST_TOKEN, SIGN_IN]);
    } finally {
      vi.useRealTimers();
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("sends the sign-in on the first socket of a later call", async () => {
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const driven = startUnary(signIn, createReleasedHostMemory());
    try {
      await admitReleasedUnary(driven);
      driven.client.releaseIdleLocalSessions();
      const before = driven.sockets.length;
      const again = requestEcho(driven.client, signIn);
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThan(before),
        WAIT,
      );
      const socket = driven.sockets[before];
      if (socket === undefined) throw new Error("remembered dial missing");
      socket.fireOpen();
      await vi.waitFor(
        () => expect(socket.sent.length).toBeGreaterThan(0),
        WAIT,
      );
      expect(readFrame(socket.sent[0]).token).toBe(SIGN_IN);
      expect(driven.refusals).toEqual([]);
      void again;
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("dials the host-only token after a remembered sign-in is refused by name", async () => {
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const driven = startUnary(signIn, createReleasedHostMemory());
    try {
      await admitReleasedUnary(driven);
      driven.client.releaseIdleLocalSessions();
      const before = driven.sockets.length;
      const again = requestEcho(driven.client, signIn);
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThan(before),
        WAIT,
      );
      const remembered = driven.sockets[before];
      if (remembered === undefined) throw new Error("remembered dial missing");
      remembered.fireOpen();
      await vi.waitFor(
        () => expect(remembered.sent.length).toBeGreaterThan(0),
        WAIT,
      );
      expect(readFrame(remembered.sent[0]).token).toBe(SIGN_IN);
      remembered.fireMessage(namedNotAdmitted());
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThan(before + 1),
        WAIT,
      );
      const updated = driven.sockets[before + 1];
      if (updated === undefined) throw new Error("token redial missing");
      updated.fireOpen();
      await vi.waitFor(
        () => expect(updated.sent.length).toBeGreaterThan(0),
        WAIT,
      );
      expect(readFrame(updated.sent[0]).token).toBe(HOST_TOKEN);
      expect(driven.refusals).toEqual([]);
      const open = readFrame(updated.sent[0]);
      updated.fireMessage({
        kind: "openAck",
        manifest: open.manifest,
        optionalManifest: open.optionalManifest,
      });
      await vi.waitFor(
        () => expect(updated.sent.length).toBeGreaterThanOrEqual(2),
        WAIT,
      );
      const request = readFrame(updated.sent[1]);
      updated.fireMessage({
        kind: "response",
        requestId: request.requestId,
        method: request.method,
        schemaVersion: request.schemaVersion,
        result: { echoed: "hi" },
        error: null,
      });
      expect(await again).toEqual({
        kind: "fulfilled",
        value: { echoed: "hi" },
      });
      driven.client.releaseIdleLocalSessions();
      const heldAt = driven.sockets.length;
      const held = requestEcho(driven.client, signIn);
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThan(heldAt),
        WAIT,
      );
      const tokenDial = driven.sockets[heldAt];
      if (tokenDial === undefined) throw new Error("held dial missing");
      tokenDial.fireOpen();
      await vi.waitFor(
        () => expect(tokenDial.sent.length).toBeGreaterThan(0),
        WAIT,
      );
      expect(readFrame(tokenDial.sent[0]).token).toBe(HOST_TOKEN);
      expect(openTokensOf(driven.sockets.slice(heldAt))).not.toContain(SIGN_IN);
      expect(driven.refusals).toEqual([]);
      void held;
    } finally {
      driven.client.releaseIdleLocalSessions();
    }
  });

  it("shares one memory between a stream and a unary call", async () => {
    const hosts = createReleasedHostMemory();
    const signIn = new MutableBearerLease(SIGN_IN, USER_ID);
    const hostToken = new MutableBearerLease(HOST_TOKEN, USER_ID);
    const { factory, sockets } = makeStubSocketFactory();
    const streamDoor = recordingDoor();
    const client = makeStreamClient(
      factory,
      hostToken,
      {
        signIn: () => signIn,
        recovery: null,
        allowed: () => Promise.resolve(true),
        hostTokenUnobtainable: () => false,
        ownerSignInEligible: () => false,
        heldTokenRefused: () => false,
        hosts,
      },
      streamDoor.door,
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
    const driven = startUnary(signIn, hosts);
    const pending = requestEcho(driven.client, signIn);
    try {
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
        WAIT,
      );
      const remembered = driven.sockets[0];
      if (remembered === undefined) throw new Error("shared dial missing");
      remembered.fireOpen();
      await vi.waitFor(
        () => expect(remembered.sent.length).toBeGreaterThan(0),
        WAIT,
      );
      expect(readFrame(remembered.sent[0]).token).toBe(SIGN_IN);
      remembered.fireMessage(namedNotAdmitted());
      await vi.waitFor(
        () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
        WAIT,
      );
      const tokenDial = driven.sockets[1];
      if (tokenDial === undefined) throw new Error("token redial missing");
      tokenDial.fireOpen();
      await vi.waitFor(
        () => expect(tokenDial.sent.length).toBeGreaterThan(0),
        WAIT,
      );
      expect(readFrame(tokenDial.sent[0]).token).toBe(HOST_TOKEN);
      expect(driven.refusals).toEqual([]);
      const before = sockets.length;
      sockets[1].fireClose(1006, "drop");
      await vi.waitFor(
        () => expect(sockets.length).toBeGreaterThan(before),
        WAIT,
      );
      const redial = await openFrame(sockets[before]);
      expect(redial.token).toBe(HOST_TOKEN);
      expect(streamDoor.refusals).toEqual([]);
      void pending;
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
  const pending = requestEcho(
    driven.client,
    new MutableBearerLease(SIGN_IN, USER_ID),
  );
  await vi.waitFor(
    () => expect(driven.sockets.length).toBeGreaterThanOrEqual(1),
    WAIT,
  );
  const first = driven.sockets[0];
  if (first === undefined) throw new Error("host-token dial missing");
  first.fireOpen();
  await vi.waitFor(() => expect(first.sent.length).toBeGreaterThan(0), WAIT);
  expect(readFrame(first.sent[0]).token).toBe(HOST_TOKEN);
  first.fireMessage(releasedRefusal());
  await vi.waitFor(
    () => expect(driven.sockets.length).toBeGreaterThanOrEqual(2),
    WAIT,
  );
  const second = driven.sockets[1];
  if (second === undefined) throw new Error("sign-in dial missing");
  second.fireOpen();
  await vi.waitFor(() => expect(second.sent.length).toBeGreaterThan(0), WAIT);
  const open = readFrame(second.sent[0]);
  expect(open.token).toBe(SIGN_IN);
  second.fireMessage({
    kind: "openAck",
    manifest: open.manifest,
    optionalManifest: open.optionalManifest,
  });
  await vi.waitFor(
    () => expect(second.sent.length).toBeGreaterThanOrEqual(2),
    WAIT,
  );
  const request = readFrame(second.sent[1]);
  second.fireMessage({
    kind: "response",
    requestId: request.requestId,
    method: request.method,
    schemaVersion: request.schemaVersion,
    result: { echoed: "hi" },
    error: null,
  });
  expect(await pending).toEqual({ kind: "fulfilled", value: { echoed: "hi" } });
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
