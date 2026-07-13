import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
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
import { TerminalStreamClient } from "../terminal-stream-client";
import { WsStreamClient } from "../ws-stream-client";

class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.textSent.push(data);
    }
  }

  close(_code: number, _reason: string): void {}

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
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => context.credentials,
    auth: null,
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    openAckTimeoutMs: 1_000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
  });
}

function completeHandshake(
  socket: StubStreamWebSocket,
  manifest: Record<string, { readonly major: number; readonly minor: number }>,
): void {
  socket.fireOpen();
  socket.fireText({ kind: "openAck", manifest });
}

const canonicalSession = {
  sessionId: "terminal-1",
  scope: { kind: "independent" as const },
  sessionKind: "terminal" as const,
  cwd: "/workspace/project",
  shellCommand: "zsh",
  shellArgs: [],
  cols: 80,
  rows: 24,
  status: "running" as const,
  exitCode: null,
  exitReason: null,
  createdAt: 1,
  title: null,
  activeProcessName: null,
};

const legacySession = {
  sessionId: "terminal-1",
  epicId: "epic-1",
  sessionKind: "terminal" as const,
  cwd: "/workspace/project",
  shellCommand: "zsh",
  shellArgs: [],
  cols: 80,
  rows: 24,
  status: "running" as const,
  exitCode: null,
  exitReason: null,
  createdAt: 1,
  title: null,
  activeProcessName: null,
};

describe("TerminalStreamClient", () => {
  it("parses scope-bearing frames when terminal.subscribe negotiated 1.4", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const snapshots: string[] = [];
    const updates: string[] = [];
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: {
        onSnapshot: (frame) => {
          if ("scope" in frame.session) {
            snapshots.push(frame.session.scope.kind);
          }
        },
        onData: () => undefined,
        onResized: () => undefined,
        onExit: () => undefined,
        onActionAck: () => undefined,
        onSessionUpdated: (frame) => {
          if ("scope" in frame.session) {
            updates.push(frame.session.scope.kind);
          }
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0], buildStreamManifest(hostStreamRpcRegistry));
    sockets[0].fireText({
      kind: "binarySnapshot",
      hasBinaryPayload: true,
      sessionId: "terminal-1",
      session: canonicalSession,
    });
    sockets[0].fireBinary(new Uint8Array([27, 91, 72]));
    sockets[0].fireText({
      kind: "sessionUpdated",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      session: canonicalSession,
    });

    expect(snapshots).toEqual(["independent"]);
    expect(updates).toEqual(["independent"]);
    stream.close();
  });

  it("keeps parsing frozen epicId frames when terminal.subscribe negotiated 1.3", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const snapshots: string[] = [];
    const updates: string[] = [];
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: {
        onSnapshot: (frame) => {
          if ("epicId" in frame.session) {
            snapshots.push(frame.session.epicId);
          }
        },
        onData: () => undefined,
        onResized: () => undefined,
        onExit: () => undefined,
        onActionAck: () => undefined,
        onSessionUpdated: (frame) => {
          if ("epicId" in frame.session) {
            updates.push(frame.session.epicId);
          }
        },
        onConnectionStatus: () => undefined,
      },
    });

    const manifest = {
      ...buildStreamManifest(hostStreamRpcRegistry),
      "terminal.subscribe": { major: 1, minor: 3 },
    };
    completeHandshake(sockets[0], manifest);
    sockets[0].fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      session: legacySession,
      scrollback: "",
      ackCreditSupported: true,
    });
    sockets[0].fireText({
      kind: "sessionUpdated",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      session: legacySession,
    });

    expect(snapshots).toEqual(["epic-1"]);
    expect(updates).toEqual(["epic-1"]);
    stream.close();
  });
});
