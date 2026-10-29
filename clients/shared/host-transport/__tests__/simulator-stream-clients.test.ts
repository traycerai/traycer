import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import type {
  SimulatorSessionsServerFrame,
  SimulatorStreamServerFrame,
} from "@traycer/protocol/host/simulator/stream-contracts";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../ws-stream-factory";
import { SimulatorSessionsStreamClient } from "../simulator-sessions-stream-client";
import { SimulatorStreamClient } from "../simulator-stream-client";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];

  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.textSent.push(data);
  }

  close(_code: number, _reason: string): void {}

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }

  fireBinary(data: Uint8Array): void {
    this.onmessage?.({ type: "binary", data });
  }
}

function makeFactory(): {
  readonly factory: IStreamWebSocketFactory;
  readonly sockets: StubStreamWebSocket[];
} {
  const sockets: StubStreamWebSocket[] = [];
  return {
    factory: {
      create(): StreamWebSocketLike {
        const socket = new StubStreamWebSocket();
        sockets.push(socket);
        return socket;
      },
    },
    sockets,
  };
}

function makeClient(
  factory: IStreamWebSocketFactory,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const user = createAuthenticatedUserFixture(undefined);
  const context = createRequestContext({
    identity: identityFromAuthenticatedUser(user),
    bearerToken: "token",
    origin: "renderer",
    cloudAuthorized: true,
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
  return new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    hostId: mockLocalHostEntry.hostId,
    bearer: () => context.credentials,
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
  });
}

function completeHandshake(socket: StubStreamWebSocket): void {
  socket.fireOpen();
  socket.fireText({
    kind: "openAck",
    manifest: buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    ),
  });
}

function parseSent(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

const STATE = {
  revision: 3,
  hostId: "host-1",
  platforms: [],
  packState: { kind: "ready", reason: null, progress: null },
  hubState: { kind: "running", lastError: null },
  simulators: [],
  sessions: [],
  booting: [],
};

describe("SimulatorSessionsStreamClient", () => {
  it("subscribes at @1.1 with the epic, delivers validated frames and drops malformed ones", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const frames: SimulatorSessionsServerFrame[] = [];
    const stream = new SimulatorSessionsStreamClient({
      wsStreamClient: client,
      epicId: "epic-1",
      callbacks: {
        onServerFrame: (frame) => {
          frames.push(frame);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    const subscribe = sockets[0].textSent
      .map(parseSent)
      .find((frame) => frame.kind === "subscribe");
    expect(subscribe).toMatchObject({
      method: "simulator.sessions",
      schemaVersion: { major: 1, minor: 1 },
      params: { epicId: "epic-1" },
    });

    sockets[0].fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      state: STATE,
    });
    sockets[0].fireText({
      kind: "stateChanged",
      hasBinaryPayload: false,
      revision: 4,
      patch: { booting: ["ABCDEF-0000"] },
    });
    // `revision` is required on a change.
    sockets[0].fireText({
      kind: "stateChanged",
      hasBinaryPayload: false,
      patch: {},
    });
    expect(frames.map((frame) => frame.kind)).toEqual([
      "snapshot",
      "stateChanged",
    ]);

    const before = sockets[0].textSent.length;
    stream.sendClientFrame({ kind: "refresh", hasBinaryPayload: false });
    expect(sockets[0].textSent).toHaveLength(before + 1);
    stream.close();
    stream.sendClientFrame({ kind: "refresh", hasBinaryPayload: false });
    expect(sockets[0].textSent).toHaveLength(before + 1);
  });

  it("delivers the @1.1 keys of a snapshot intact", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const frames: SimulatorSessionsServerFrame[] = [];
    new SimulatorSessionsStreamClient({
      wsStreamClient: client,
      epicId: "epic-1",
      callbacks: {
        onServerFrame: (frame) => {
          frames.push(frame);
        },
        onConnectionStatus: () => undefined,
      },
    });
    completeHandshake(sockets[0]);

    const session = {
      epicId: "epic-1",
      ownerUserId: "user-1",
      hostId: "host-1",
      simulatorId: "ABCDEF-0000",
      platform: "ios",
      openedAt: "2026-10-18T00:00:00.000Z",
      sessionId: "session-1",
    };
    const snapshot = {
      kind: "snapshot",
      hasBinaryPayload: false,
      state: { ...STATE, sessions: [session], opening: [{ requestId: "r1" }] },
    };
    sockets[0].fireText(snapshot);
    expect(frames).toEqual([snapshot]);
  });
});

describe("SimulatorStreamClient", () => {
  it("pairs a video envelope with its bytes and sends input frames", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const received: {
      readonly frame: SimulatorStreamServerFrame;
      readonly bytes: Uint8Array | null;
    }[] = [];
    const stream = new SimulatorStreamClient({
      wsStreamClient: client,
      epicId: "epic-1",
      simulatorId: "ABCDEF-0000",
      callbacks: {
        onServerFrame: (frame, bytes) => {
          received.push({ frame, bytes });
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    const subscribe = sockets[0].textSent
      .map(parseSent)
      .find((frame) => frame.kind === "subscribe");
    expect(subscribe).toMatchObject({
      method: "simulator.stream",
      schemaVersion: { major: 1, minor: 0 },
      params: { epicId: "epic-1", simulatorId: "ABCDEF-0000" },
    });

    sockets[0].fireText({
      kind: "streamConfig",
      hasBinaryPayload: false,
      config: {
        platform: "ios",
        codec: "avcc",
        width: 1170,
        height: 2532,
        orientation: "portrait",
        inputAvailable: true,
        frameIntervalMs: 200,
      },
    });
    sockets[0].fireText({
      kind: "video",
      hasBinaryPayload: true,
      unit: "keyframe",
    });
    sockets[0].fireBinary(new Uint8Array([0, 0, 0, 1, 0x65]));
    // An unknown unit is dropped with its bytes.
    sockets[0].fireText({
      kind: "video",
      hasBinaryPayload: true,
      unit: "audio",
    });
    sockets[0].fireBinary(new Uint8Array([1]));
    sockets[0].fireText({
      kind: "inputState",
      hasBinaryPayload: false,
      connected: false,
      detail: "View only.",
    });

    expect(received.map((entry) => entry.frame.kind)).toEqual([
      "streamConfig",
      "video",
      "inputState",
    ]);
    expect(received[0].bytes).toBeNull();
    expect(received[1].bytes).toEqual(new Uint8Array([0, 0, 0, 1, 0x65]));

    const before = sockets[0].textSent.length;
    stream.sendClientFrame({
      kind: "touch",
      hasBinaryPayload: false,
      phase: "begin",
      x: 0.5,
      y: 0.5,
    });
    expect(sockets[0].textSent).toHaveLength(before + 1);
    expect(parseSent(sockets[0].textSent[before])).toMatchObject({
      kind: "touch",
      phase: "begin",
      x: 0.5,
      y: 0.5,
    });
    stream.close();
    stream.sendClientFrame({
      kind: "requestKeyframe",
      hasBinaryPayload: false,
    });
    expect(sockets[0].textSent).toHaveLength(before + 1);
  });
});
