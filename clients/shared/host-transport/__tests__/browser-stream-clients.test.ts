import { describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
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
import { BrowserScreencastStreamClient } from "../browser-screencast-stream-client";
import { BrowserSessionsStreamClient } from "../browser-sessions-stream-client";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];
  failSends = false;

  send(data: string | Uint8Array): void {
    if (this.failSends) throw new Error("socket refused the write");
    if (typeof data === "string") {
      this.textSent.push(data);
    }
  }

  close(_code: number, _reason: string): void {}

  fireClose(code: number, reason: string): void {
    if (this.onclose !== null) {
      this.onclose({ code, reason, wasClean: false });
    }
  }

  fireOpen(): void {
    if (this.onopen !== null) {
      this.onopen({ type: "open" });
    }
  }

  fireText(data: unknown): void {
    if (this.onmessage !== null) {
      this.onmessage({ type: "text", data: JSON.stringify(data) });
    }
  }

  fireBinary(data: Uint8Array): void {
    if (this.onmessage !== null) {
      this.onmessage({ type: "binary", data });
    }
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
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
  return new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => context.credentials,
    auth: null,
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

describe("BrowserSessionsStreamClient", () => {
  it("delivers validated server frames and drops malformed ones", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const kinds: string[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      epicId: "epic-1",
      callbacks: {
        onServerFrame: (frame) => {
          kinds.push(frame.kind);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    sockets[0].fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      sessions: [],
    });
    sockets[0].fireText({
      kind: "sessionClosed",
      hasBinaryPayload: false,
      sessionId: "browser-session-1",
      reason: "completed",
    });
    // `reason` is not one of the enumerated closed reasons.
    sockets[0].fireText({
      kind: "sessionClosed",
      hasBinaryPayload: false,
      sessionId: "browser-session-1",
      reason: "made-up",
    });

    expect(kinds).toEqual(["snapshot", "sessionClosed"]);
    stream.close();
  });

  it("delivers one pong per application ping and swallows heartbeat pongs", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const kinds: string[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      epicId: "epic-1",
      callbacks: {
        onServerFrame: (frame) => {
          kinds.push(frame.kind);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    // No application ping outstanding: this answers the heartbeat and must
    // stay inside the transport.
    sockets[0].fireText({ kind: "pong", hasBinaryPayload: false });
    expect(kinds).toEqual([]);

    // Two overlapping flushes: two pings, two pongs, two delivered frames.
    stream.sendClientFrame({ kind: "ping", hasBinaryPayload: false });
    stream.sendClientFrame({ kind: "ping", hasBinaryPayload: false });
    sockets[0].fireText({ kind: "pong", hasBinaryPayload: false });
    expect(kinds).toEqual(["pong"]);
    sockets[0].fireText({ kind: "pong", hasBinaryPayload: false });
    expect(kinds).toEqual(["pong", "pong"]);

    // Both are answered; a later heartbeat pong is swallowed again.
    sockets[0].fireText({ kind: "pong", hasBinaryPayload: false });
    expect(kinds).toEqual(["pong", "pong"]);
    stream.close();
  });

  it("never credits a pong on a NEW socket to a ping sent on the old one", async () => {
    // The ping queue is per-socket. A reconnect strands whatever the old
    // socket never answered, and if that backlog survived, the first pong of
    // the new connection would settle it - telling a quitting shell that a
    // capture it never delivered had reached the host.
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const kinds: string[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      epicId: "epic-1",
      callbacks: {
        onServerFrame: (frame) => {
          kinds.push(frame.kind);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    stream.sendClientFrame({ kind: "ping", hasBinaryPayload: false });
    sockets[0].fireClose(1006, "dropped");

    await vi.waitFor(() => {
      expect(sockets).toHaveLength(2);
    });
    completeHandshake(sockets[1]);
    sockets[1].fireText({ kind: "pong", hasBinaryPayload: false });
    expect(kinds).toEqual([]);

    // The new socket keeps its own pairing.
    stream.sendClientFrame({ kind: "ping", hasBinaryPayload: false });
    sockets[1].fireText({ kind: "pong", hasBinaryPayload: false });
    expect(kinds).toEqual(["pong"]);
    stream.close();
  });

  it("never credits a pong to a ping the socket refused to write", async () => {
    // A refused write tears the socket down; the ping never reached the host,
    // so nothing may later answer it. Both the `return` after `onSendFailure`
    // and the per-socket reset above enforce this - the assertion is on the
    // invariant, not on either line.
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const kinds: string[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      epicId: "epic-1",
      callbacks: {
        onServerFrame: (frame) => {
          kinds.push(frame.kind);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    sockets[0].failSends = true;
    stream.sendClientFrame({ kind: "ping", hasBinaryPayload: false });

    await vi.waitFor(() => {
      expect(sockets).toHaveLength(2);
    });
    completeHandshake(sockets[1]);
    sockets[1].fireText({ kind: "pong", hasBinaryPayload: false });
    expect(kinds).toEqual([]);
    stream.close();
  });

  it("stops sending client frames once closed", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      epicId: "epic-1",
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    const beforeClose = sockets[0].textSent.length;
    stream.sendClientFrame({ kind: "ping", hasBinaryPayload: false });
    expect(sockets[0].textSent).toHaveLength(beforeClose + 1);

    stream.close();
    stream.sendClientFrame({ kind: "ping", hasBinaryPayload: false });
    expect(sockets[0].textSent).toHaveLength(beforeClose + 1);
  });
});

describe("BrowserScreencastStreamClient", () => {
  it("pairs a frame envelope with its binary payload and leaves acking to the consumer", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const received: {
      readonly frame: BrowserScreencastServerFrame;
      readonly bytes: Uint8Array | null;
    }[] = [];
    const stream = new BrowserScreencastStreamClient({
      wsStreamClient: client,
      epicId: "epic-1",
      sessionId: "browser-session-1",
      tabId: "browser-tab-1",
      maxWidth: 1280,
      maxHeight: 720,
      quality: 80,
      format: "jpeg",
      role: "tile",
      callbacks: {
        onServerFrame: (frame, bytes) => {
          received.push({ frame, bytes });
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    const sentBeforeFrames = sockets[0].textSent.length;
    sockets[0].fireText({
      kind: "started",
      hasBinaryPayload: false,
      frameWidth: 1280,
      frameHeight: 720,
      deviceScaleFactor: 2,
    });
    sockets[0].fireText({
      kind: "frame",
      hasBinaryPayload: true,
      sequence: 1,
      metadata: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 1280,
        deviceHeight: 720,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        timestamp: 1,
      },
    });
    sockets[0].fireBinary(new Uint8Array([255, 216, 255]));

    expect(received.map((entry) => entry.frame.kind)).toEqual([
      "started",
      "frame",
    ]);
    expect(received[0].bytes).toBeNull();
    expect(received[1].bytes).toEqual(new Uint8Array([255, 216, 255]));
    // The host gates the next frame on an ack; the client must not send one on
    // the consumer's behalf, which would ack a frame that was never painted.
    expect(sockets[0].textSent).toHaveLength(sentBeforeFrames);

    stream.sendClientFrame({
      kind: "ack",
      hasBinaryPayload: false,
      sequence: 1,
    });
    expect(sockets[0].textSent).toHaveLength(sentBeforeFrames + 1);
    stream.close();
  });

  it("delivers the WebRTC video-plane frames and still drops unknown kinds", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const received: BrowserScreencastServerFrame[] = [];
    const stream = new BrowserScreencastStreamClient({
      wsStreamClient: client,
      epicId: "epic-1",
      sessionId: "browser-session-1",
      tabId: "browser-tab-1",
      maxWidth: 1280,
      maxHeight: 720,
      quality: 80,
      format: "jpeg",
      role: "tile",
      callbacks: {
        onServerFrame: (frame) => {
          received.push(frame);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    sockets[0].fireText({
      kind: "sdpOffer",
      hasBinaryPayload: false,
      negotiationId: 1,
      sdp: "v=0\r\n",
    });
    sockets[0].fireText({
      kind: "captureMode",
      hasBinaryPayload: false,
      mode: "video",
    });
    // A future frame kind this client build has never heard of - must drop,
    // not crash the connection.
    sockets[0].fireText({
      kind: "aFutureVideoPlaneFrame",
      hasBinaryPayload: false,
    });

    expect(received.map((frame) => frame.kind)).toEqual([
      "sdpOffer",
      "captureMode",
    ]);
    stream.close();
  });
});
