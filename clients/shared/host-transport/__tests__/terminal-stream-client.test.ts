import { describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
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
import type { TerminalSubscribeClientFrameV17 } from "@traycer/protocol/host/terminal/subscribe";
import {
  TerminalStreamClient,
  type TerminalStreamCallbacks,
} from "../terminal-stream-client";
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
    cloudAuthorized: true,
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
  it("opens terminal.subscribe with the given viewer intent", () => {
    const { factory } = makeFactory();
    const client = makeClient(factory);
    const subscribe = vi.spyOn(client, "subscribeWithParamsProvider");
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      viewer: "cache",
      callbacks: {
        onSnapshot: () => undefined,
        onData: () => undefined,
        onResized: () => undefined,
        onExit: () => undefined,
        onActionAck: () => undefined,
        onSessionUpdated: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0][0]).toBe("terminal.subscribe");
    expect(subscribe.mock.calls[0][1](null)).toEqual({
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      viewer: "cache",
    });
    stream.close();
  });

  it("defaults omitted viewer intent to presentation", () => {
    const { factory } = makeFactory();
    const client = makeClient(factory);
    const subscribe = vi.spyOn(client, "subscribeWithParamsProvider");
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: {
        onSnapshot: () => undefined,
        onData: () => undefined,
        onResized: () => undefined,
        onExit: () => undefined,
        onActionAck: () => undefined,
        onSessionUpdated: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0][0]).toBe("terminal.subscribe");
    expect(subscribe.mock.calls[0][1](null)).toEqual({
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      viewer: "presentation",
    });
    stream.close();
  });

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

    completeHandshake(sockets[0], {
      ...buildStreamManifest(
        hostStreamRpcRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      ),
      "terminal.subscribe": { major: 1, minor: 4 },
    });
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

  it("parses live current-directory metadata when negotiated at 1.5", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const currentDirectories: string[] = [];
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: {
        onSnapshot: () => undefined,
        onData: () => undefined,
        onResized: () => undefined,
        onExit: () => undefined,
        onActionAck: () => undefined,
        onSessionUpdated: (frame) => {
          if ("currentCwd" in frame.session) {
            currentDirectories.push(frame.session.currentCwd);
          }
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(
      sockets[0],
      buildStreamManifest(hostStreamRpcRegistry, SERVES_EVERY_INSTALLED_MAJOR),
    );
    sockets[0].fireText({
      kind: "sessionUpdated",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      session: { ...canonicalSession, currentCwd: "/workspace/next" },
    });

    expect(currentDirectories).toEqual(["/workspace/next"]);
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
      ...buildStreamManifest(
        hostStreamRpcRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      ),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseText(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error("Expected object text frame");
  }
  return value;
}

function viewerFramesSent(
  socket: StubStreamWebSocket,
): readonly Record<string, unknown>[] {
  return socket.textSent
    .map(parseText)
    .filter((frame) => frame.kind === "viewer");
}

function terminalCallbacks(
  onConnectionStatus: TerminalStreamCallbacks["onConnectionStatus"],
): TerminalStreamCallbacks {
  return {
    onSnapshot: () => undefined,
    onData: () => undefined,
    onResized: () => undefined,
    onExit: () => undefined,
    onActionAck: () => undefined,
    onSessionUpdated: () => undefined,
    onConnectionStatus,
  };
}

function viewerFrame(
  viewer: "presentation" | "cache",
): TerminalSubscribeClientFrameV17 {
  return {
    kind: "viewer",
    hasBinaryPayload: false,
    sessionId: "terminal-1",
    viewer,
  };
}

/**
 * A host that negotiates `terminal.subscribe` at exactly `1.<minor>`.
 * `WsStreamClient` settles on the older of its own canonical line and the
 * `openAck` manifest's, so pinning the manifest is how a black-box test stands
 * up a 1.6 host without touching production code.
 */
function completeHandshakeAtTerminalMinor(
  socket: StubStreamWebSocket,
  minor: number,
): void {
  completeHandshake(socket, {
    ...buildStreamManifest(hostStreamRpcRegistry, SERVES_EVERY_INSTALLED_MAJOR),
    "terminal.subscribe": { major: 1, minor },
  });
}

describe("TerminalStreamClient viewer frame (terminal.subscribe@1.7)", () => {
  it("puts exactly the viewer frame on the wire when the stream is open at 1.7", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const statuses: string[] = [];
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: terminalCallbacks((status) => {
        statuses.push(status);
      }),
    });
    completeHandshakeAtTerminalMinor(sockets[0], 7);
    expect(statuses).toContain("open");
    // The negotiated line is what gates the frame, so pin that this is 1.7.
    expect(parseText(sockets[0].textSent[1]).schemaVersion).toMatchObject({
      major: 1,
      minor: 7,
    });
    const sentBefore = sockets[0].textSent.length;

    stream.sendAction(viewerFrame("cache"));

    expect(sockets[0].textSent.slice(sentBefore).map(parseText)).toEqual([
      viewerFrame("cache"),
    ]);
    stream.close();
  });

  it("sends nothing at 1.6 and records the intent so the next subscribe declares it", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const subscribe = vi.spyOn(client, "subscribeWithParamsProvider");
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: terminalCallbacks(() => undefined),
    });
    completeHandshakeAtTerminalMinor(sockets[0], 6);
    expect(parseText(sockets[0].textSent[1]).schemaVersion).toMatchObject({
      major: 1,
      minor: 6,
    });
    const provider = subscribe.mock.calls[0][1];
    expect(provider(null)).toMatchObject({ viewer: "presentation" });
    const sentBefore = sockets[0].textSent.length;

    stream.sendAction(viewerFrame("cache"));

    // A 1.6 host's frame schema cannot parse `viewer`: nothing may reach it.
    expect(sockets[0].textSent.length).toBe(sentBefore);
    expect(viewerFramesSent(sockets[0])).toEqual([]);
    // The params provider is what every wire subscribe reads, so a reconnect
    // opens with the intent the view has now, not the one it was built with.
    expect(provider(null)).toEqual({
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      viewer: "cache",
    });
    stream.close();
  });

  it("holds a viewer frame sent before the stream is open and flushes it once, after the consumer's open callback", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    // What the consumer's own open handling could already see on the wire
    // when its callback ran: the flush must not have happened yet.
    const viewerFramesAtOpenCallback: number[] = [];
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: terminalCallbacks((status) => {
        if (status === "open") {
          viewerFramesAtOpenCallback.push(viewerFramesSent(sockets[0]).length);
        }
      }),
    });

    stream.sendAction(viewerFrame("cache"));
    expect(sockets[0].textSent).toEqual([]);

    completeHandshakeAtTerminalMinor(sockets[0], 7);

    expect(viewerFramesAtOpenCallback).toEqual([0]);
    expect(viewerFramesSent(sockets[0])).toEqual([viewerFrame("cache")]);
    stream.close();
  });

  it("keeps only the latest intent held before open", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: terminalCallbacks(() => undefined),
    });

    stream.sendAction(viewerFrame("cache"));
    stream.sendAction(viewerFrame("presentation"));
    completeHandshakeAtTerminalMinor(sockets[0], 7);

    expect(viewerFramesSent(sockets[0])).toEqual([viewerFrame("presentation")]);
    stream.close();
  });

  it("drops a held viewer frame when the stream opens at 1.6, keeping the intent for the next subscribe", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const subscribe = vi.spyOn(client, "subscribeWithParamsProvider");
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: terminalCallbacks(() => undefined),
    });

    stream.sendAction(viewerFrame("cache"));
    completeHandshakeAtTerminalMinor(sockets[0], 6);

    expect(viewerFramesSent(sockets[0])).toEqual([]);
    expect(subscribe.mock.calls[0][1](null)).toMatchObject({ viewer: "cache" });
    stream.close();
  });

  it("still sends a non-viewer frame straight through", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: terminalCallbacks(() => undefined),
    });
    completeHandshakeAtTerminalMinor(sockets[0], 7);
    const sentBefore = sockets[0].textSent.length;
    const resize: TerminalSubscribeClientFrameV17 = {
      kind: "resize",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      clientActionId: "action-1",
      cols: 100,
      rows: 30,
    };

    stream.sendAction(resize);

    expect(sockets[0].textSent.slice(sentBefore).map(parseText)).toEqual([
      resize,
    ]);
    expect(viewerFramesSent(sockets[0])).toEqual([]);
    stream.close();
  });

  it("sends a non-viewer frame at 1.6 as well", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const stream = new TerminalStreamClient({
      wsStreamClient: client,
      sessionId: "terminal-1",
      cols: 80,
      rows: 24,
      callbacks: terminalCallbacks(() => undefined),
    });
    completeHandshakeAtTerminalMinor(sockets[0], 6);
    const sentBefore = sockets[0].textSent.length;
    const resize: TerminalSubscribeClientFrameV17 = {
      kind: "resize",
      hasBinaryPayload: false,
      sessionId: "terminal-1",
      clientActionId: "action-2",
      cols: 90,
      rows: 20,
    };

    stream.sendAction(resize);

    expect(sockets[0].textSent.slice(sentBefore).map(parseText)).toEqual([
      resize,
    ]);
    stream.close();
  });
});
