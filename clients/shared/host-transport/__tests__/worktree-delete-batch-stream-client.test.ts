import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
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
import { WorktreeDeleteBatchStreamClient } from "../worktree-delete-batch-stream-client";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

const COMMAND_ID = "6f1a6a0e-1f0f-4a1e-9f0d-1b6f0c2c9f11";

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
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }

  fireClose(code: number, reason: string): void {
    this.onclose?.({ code, reason, wasClean: false });
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

/** Mirrors the host: echo the client's own manifest so the method negotiates. */
function completeHandshake(socket: StubStreamWebSocket): void {
  socket.fireOpen();
  const open = JSON.parse(socket.textSent[0]) as {
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({ kind: "openAck", manifest: open.manifest });
}

function subscribeFrame(socket: StubStreamWebSocket): Record<string, unknown> {
  const raw = socket.textSent[1];
  if (raw === undefined) throw new Error("no subscribe frame was sent");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("subscribe frame was not an object");
  }
  return parsed as Record<string, unknown>;
}

function subscribeParams(socket: StubStreamWebSocket): Record<string, unknown> {
  const params = subscribeFrame(socket).params;
  if (typeof params !== "object" || params === null) {
    throw new Error("subscribe frame carried no params");
  }
  return params as Record<string, unknown>;
}

const NOOP_CALLBACKS = {
  onTargetStarted: () => undefined,
  onTargetPhase: () => undefined,
  onTargetOutput: () => undefined,
  onTargetComplete: () => undefined,
  onTargetFailed: () => undefined,
  onCommandComplete: () => undefined,
  onCommandFailed: () => undefined,
  onUnsupported: () => undefined,
  onConnectionStatus: () => undefined,
};

function openBatchClient(
  wsStreamClient: WsStreamClient<typeof hostStreamRpcRegistry>,
): WorktreeDeleteBatchStreamClient {
  return new WorktreeDeleteBatchStreamClient({
    wsStreamClient,
    commandId: COMMAND_ID,
    source: "settings",
    targets: [
      { worktreePath: "/wt/a", scripts: null },
      { worktreePath: "/wt/b", scripts: null },
    ],
    callbacks: NOOP_CALLBACKS,
  });
}

describe("WorktreeDeleteBatchStreamClient replay safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-subscribes as observe after a drop, so the transport can never replay the start", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const batch = openBatchClient(client);

    completeHandshake(sockets[0]);
    expect(subscribeParams(sockets[0])).toMatchObject({
      mode: "start",
      commandId: COMMAND_ID,
      source: "settings",
    });

    // The socket dies after the host already has the command.
    sockets[0].fireClose(1006, "abnormal");
    // The swap is synchronous inside the `reconnecting` transition, so the
    // replacement session dials before any backoff timer could re-send `start`.
    expect(sockets).toHaveLength(2);

    completeHandshake(sockets[1]);
    expect(subscribeParams(sockets[1])).toEqual({
      mode: "observe",
      commandId: COMMAND_ID,
    });

    // Every later reconnect stays on observe, however long the outage runs.
    sockets[1].fireClose(1006, "abnormal");
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(3);
    completeHandshake(sockets[2]);
    expect(subscribeParams(sockets[2])).toEqual({
      mode: "observe",
      commandId: COMMAND_ID,
    });

    const starts = sockets
      .map((socket) =>
        socket.textSent.length > 1 ? subscribeParams(socket) : null,
      )
      .filter((params) => params?.mode === "start");
    expect(starts).toHaveLength(1);
    batch.close();
  });

  it("keeps retrying start while the drop happened before the host ever saw it", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const batch = openBatchClient(client);

    // Dies during the dial: the subscribe frame never went out, so nothing was
    // started and re-issuing the user's actual request is both safe and what
    // they asked for.
    expect(sockets[0].textSent).toHaveLength(0);
    sockets[0].fireClose(1006, "abnormal");
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);

    completeHandshake(sockets[1]);
    expect(subscribeParams(sockets[1])).toMatchObject({
      mode: "start",
      commandId: COMMAND_ID,
    });
    batch.close();
  });

  it("reports an unsupported method instead of a connection failure", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    let unsupported = 0;
    let statusClosed = 0;
    const batch = new WorktreeDeleteBatchStreamClient({
      wsStreamClient: client,
      commandId: COMMAND_ID,
      source: "settings",
      targets: [{ worktreePath: "/wt/a", scripts: null }],
      callbacks: {
        ...NOOP_CALLBACKS,
        onUnsupported: () => {
          unsupported += 1;
        },
        onConnectionStatus: (status) => {
          if (status === "closed") statusClosed += 1;
        },
      },
    });

    // An older host: its manifest simply has no entry for the method.
    sockets[0].fireOpen();
    const open = JSON.parse(sockets[0].textSent[0]) as {
      readonly manifest: Record<string, { major: number; minor: number }>;
    };
    const olderManifest = { ...open.manifest };
    delete olderManifest["worktree.deleteBatchByPath"];
    sockets[0].fireText({ kind: "openAck", manifest: olderManifest });

    expect(unsupported).toBe(1);
    expect(statusClosed).toBe(0);
    // Rejected on the openAck: no subscribe frame, so no host work started.
    expect(sockets[0].textSent).toHaveLength(2);
    expect(JSON.parse(sockets[0].textSent[1])).toMatchObject({
      kind: "fatalError",
    });
    batch.close();
  });
});
