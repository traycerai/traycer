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
import {
  releasedSignOnForRow,
  signInForReleasedRow,
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
  return releasedSignOnForRow(row, USER_ID, () => signIn, null);
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
    userId: USER_ID,
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

  it("dials the host-only token again after the sign-in connection drops", async () => {
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
    expect(redial.token).toBe(HOST_TOKEN);
    ack(sockets[2], redial, ["credentialUpdate"]);
    signIn.rotate(ROTATED_SIGN_IN);
    client.notifyBearerRotated();
    expect(tokensOf(sockets[2])).not.toContain(SIGN_IN);
    expect(tokensOf(sockets[2])).not.toContain(ROTATED_SIGN_IN);
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
      releasedSignOnForRow(PERSONAL_ROW, USER_ID, () => signIn, recovery),
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
      releasedSignOnFor: signInForReleasedRow(() => PERSONAL_ROW),
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
});
