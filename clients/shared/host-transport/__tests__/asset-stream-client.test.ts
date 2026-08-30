import { describe, expect, it, vi } from "vitest";
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
import {
  AssetStreamClient,
  type AssetStreamCallbacks,
  type AssetStreamFailure,
  type AssetStreamHeader,
} from "../asset-stream-client";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];
  /** Each `AssetStreamClient` owns one dedicated session/socket (`WsStreamClient`'s per-session `close()` tears down `activeSocket` directly) - counting THIS is the close signal, not a callback the client no longer exposes. */
  closeCount = 0;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.textSent.push(data);
    }
  }

  close(_code: number, _reason: string): void {
    this.closeCount += 1;
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }

  fireBinary(data: Uint8Array): void {
    this.onmessage?.({ type: "binary", data });
  }

  fireClose(code: number, reason: string, wasClean: boolean): void {
    this.onclose?.({ code, reason, wasClean });
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

type MethodManifest = Record<string, { major: number; minor: number }>;

interface OpenFrame {
  readonly manifest: MethodManifest;
}

/**
 * Mirrors the host's manifest by default, so the method negotiates - unless
 * `mutateManifest` strips an entry, mimicking an older host that predates
 * this method.
 */
function completeHandshake(
  socket: StubStreamWebSocket,
  mutateManifest: ((manifest: MethodManifest) => MethodManifest) | undefined,
): void {
  socket.fireOpen();
  const open = JSON.parse(socket.textSent[0]) as OpenFrame;
  const manifest =
    mutateManifest === undefined
      ? open.manifest
      : mutateManifest(open.manifest);
  socket.fireText({ kind: "openAck", manifest });
}

interface RecordedCallbacks {
  readonly headers: AssetStreamHeader[];
  readonly ready: { header: AssetStreamHeader; bytes: Uint8Array }[];
  readonly failures: AssetStreamFailure[];
}

function recordingCallbacks(): {
  readonly callbacks: AssetStreamCallbacks;
  readonly recorded: RecordedCallbacks;
} {
  const recorded: RecordedCallbacks = {
    headers: [],
    ready: [],
    failures: [],
  };
  return {
    callbacks: {
      onHeader: (header) => {
        recorded.headers.push(header);
      },
      onReady: (header, bytes) => {
        recorded.ready.push({ header, bytes });
      },
      onFailure: (failure) => {
        recorded.failures.push(failure);
      },
    },
    recorded,
  };
}

/** How many times the dedicated socket actually closed so far. */
function closedCount(socket: StubStreamWebSocket): number {
  return socket.closeCount;
}

interface WorkspaceAssetScenario {
  readonly asset: AssetStreamClient<"workspace.streamAsset">;
  readonly recorded: RecordedCallbacks;
  readonly socket: StubStreamWebSocket;
}

function startWorkspaceAsset(): WorkspaceAssetScenario {
  const { factory, sockets } = makeFactory();
  const client = makeClient(factory);
  const { callbacks, recorded } = recordingCallbacks();
  const asset = new AssetStreamClient({
    wsStreamClient: client,
    method: "workspace.streamAsset",
    params: WORKSPACE_PARAMS,
    callbacks,
  });
  const socket = sockets[0];
  if (socket === undefined)
    throw new Error("asset stream socket was not created");
  completeHandshake(socket, undefined);
  return { asset, recorded, socket };
}

function fireAssetHeader(socket: StubStreamWebSocket, sizeBytes: number): void {
  socket.fireText({
    kind: "assetHeader",
    hasBinaryPayload: false,
    mediaType: "image/png",
    sizeBytes,
    width: 10,
    height: 20,
    contentIdentity: "blob-test",
  });
}

function expectFatal(
  recorded: RecordedCallbacks,
  socket: StubStreamWebSocket,
  message: string,
): void {
  expect(recorded.failures).toEqual([{ reason: "fatal", message }]);
  expect(closedCount(socket)).toBe(1);
}

const WORKSPACE_PARAMS = {
  workspacePath: "/workspace/project",
  filePath: "logo.png",
};

const GIT_PARAMS = {
  runningDir: "/workspace/project",
  filePath: "logo.png",
  previousPath: null,
  side: "new" as const,
  stage: "unstaged" as const,
};

describe("AssetStreamClient", () => {
  it("fails fatally on an unparseable server frame", () => {
    const { asset, recorded, socket } = startWorkspaceAsset();

    socket.fireText({ kind: "not-an-asset-frame", hasBinaryPayload: false });

    expectFatal(recorded, socket, "received an invalid frame");
    asset.close();
  });

  it("fails fatally when a second assetHeader arrives", () => {
    const { asset, recorded, socket } = startWorkspaceAsset();

    fireAssetHeader(socket, 1);
    fireAssetHeader(socket, 1);

    expectFatal(recorded, socket, "assetHeader arrived more than once");
    asset.close();
  });

  it("fails fatally when an assetChunk arrives before its header", () => {
    const { asset, recorded, socket } = startWorkspaceAsset();

    socket.fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 1,
    });
    socket.fireBinary(new Uint8Array([1]));

    expectFatal(recorded, socket, "assetChunk arrived before assetHeader");
    asset.close();
  });

  it("fails fatally when an assetChunk index is out of sequence", () => {
    const { asset, recorded, socket } = startWorkspaceAsset();

    fireAssetHeader(socket, 1);
    socket.fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 1,
      byteLength: 1,
    });
    socket.fireBinary(new Uint8Array([1]));

    expectFatal(
      recorded,
      socket,
      "assetChunk index 1 out of sequence, expected 0",
    );
    asset.close();
  });

  it("fails fatally when an assetChunk payload length differs from its declaration", () => {
    const { asset, recorded, socket } = startWorkspaceAsset();

    fireAssetHeader(socket, 2);
    socket.fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 2,
    });
    socket.fireBinary(new Uint8Array([1]));

    expectFatal(
      recorded,
      socket,
      "assetChunk declared byteLength 2 but carried 1",
    );
    asset.close();
  });

  it("fails fatally when cumulative chunk bytes exceed the header budget", () => {
    const { asset, recorded, socket } = startWorkspaceAsset();

    fireAssetHeader(socket, 3);
    socket.fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 2,
    });
    socket.fireBinary(new Uint8Array([1, 2]));
    socket.fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 1,
      byteLength: 2,
    });
    socket.fireBinary(new Uint8Array([3, 4]));

    expectFatal(
      recorded,
      socket,
      "assetChunk pushed cumulative bytes past the 3-byte budget",
    );
    asset.close();
  });

  it("fires onHeader immediately, then assembles chunks in arrival order for onReady", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    expect(recorded.headers).toHaveLength(0);

    sockets[0].fireText({
      kind: "assetHeader",
      hasBinaryPayload: false,
      mediaType: "image/png",
      sizeBytes: 5,
      width: 10,
      height: 20,
      contentIdentity: "blob-abc123",
    });
    // Fires before any bytes have arrived, not just before assetComplete.
    expect(recorded.headers).toHaveLength(1);
    expect(recorded.ready).toHaveLength(0);

    sockets[0].fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 3,
    });
    sockets[0].fireBinary(new Uint8Array([1, 2, 3]));
    sockets[0].fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 1,
      byteLength: 2,
    });
    sockets[0].fireBinary(new Uint8Array([4, 5]));
    sockets[0].fireText({ kind: "assetComplete", hasBinaryPayload: false });

    expect(recorded.ready).toHaveLength(1);
    expect(recorded.failures).toHaveLength(0);
    const [{ header, bytes }] = recorded.ready;
    expect(header).toEqual({
      mediaType: "image/png",
      sizeBytes: 5,
      width: 10,
      height: 20,
      contentIdentity: "blob-abc123",
    });
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);

    // The one-shot fetch closes ITS OWN session as soon as it settles - it
    // must not leave an idle subscription (and host resolver) alive for as
    // long as the caller happens to hold the instance.
    expect(closedCount(sockets[0])).toBe(1);

    // The gui-app hook closes on unmount/refetch regardless of whether this
    // already settled and closed itself first - that must stay silent.
    asset.close();
    expect(closedCount(sockets[0])).toBe(1);
    expect(recorded.ready).toHaveLength(1);
    expect(recorded.failures).toHaveLength(0);
  });

  it("resets partial assembly and resumes on a same-identity reconnect", () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    fireAssetHeader(sockets[0], 3);
    sockets[0].fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 1,
    });
    sockets[0].fireBinary(new Uint8Array([1]));
    sockets[0].fireClose(1006, "abnormal", false);

    vi.advanceTimersByTime(10);
    const reconnectedSocket = sockets[1];
    if (reconnectedSocket === undefined) {
      throw new Error("asset stream did not reconnect");
    }
    completeHandshake(reconnectedSocket, undefined);
    fireAssetHeader(reconnectedSocket, 3);
    reconnectedSocket.fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 3,
    });
    reconnectedSocket.fireBinary(new Uint8Array([4, 5, 6]));
    reconnectedSocket.fireText({
      kind: "assetComplete",
      hasBinaryPayload: false,
    });

    expect(recorded.headers).toHaveLength(1);
    expect(recorded.failures).toHaveLength(0);
    expect(recorded.ready).toHaveLength(1);
    expect(Array.from(recorded.ready[0]?.bytes ?? [])).toEqual([4, 5, 6]);
    expect(closedCount(reconnectedSocket)).toBe(1);
    asset.close();
    vi.useRealTimers();
  });

  it("fails when a reconnect reports a changed identity", () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    fireAssetHeader(sockets[0], 3);
    sockets[0].fireClose(1006, "abnormal", false);

    vi.advanceTimersByTime(10);
    const reconnectedSocket = sockets[1];
    if (reconnectedSocket === undefined) {
      throw new Error("asset stream did not reconnect");
    }
    completeHandshake(reconnectedSocket, undefined);
    fireAssetHeader(reconnectedSocket, 2);

    expectFatal(
      recorded,
      reconnectedSocket,
      "assetHeader arrived more than once",
    );
    expect(recorded.headers).toHaveLength(1);
    expect(recorded.ready).toHaveLength(0);
    asset.close();
    vi.useRealTimers();
  });

  it("fails when a reconnect sends a chunk before its retry header", () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    fireAssetHeader(sockets[0], 3);
    sockets[0].fireClose(1006, "abnormal", false);

    vi.advanceTimersByTime(10);
    const reconnectedSocket = sockets[1];
    if (reconnectedSocket === undefined) {
      throw new Error("asset stream did not reconnect");
    }
    completeHandshake(reconnectedSocket, undefined);
    reconnectedSocket.fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 3,
    });
    reconnectedSocket.fireBinary(new Uint8Array([1, 2, 3]));

    expectFatal(
      recorded,
      reconnectedSocket,
      "assetChunk arrived before the reconnect retry's assetHeader",
    );
    expect(recorded.ready).toHaveLength(0);
    asset.close();
    vi.useRealTimers();
  });

  it("accepts the first header after reconnecting before any header arrives", () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    sockets[0].fireClose(1006, "abnormal", false);

    vi.advanceTimersByTime(10);
    const reconnectedSocket = sockets[1];
    if (reconnectedSocket === undefined) {
      throw new Error("asset stream did not reconnect");
    }
    completeHandshake(reconnectedSocket, undefined);
    fireAssetHeader(reconnectedSocket, 2);
    reconnectedSocket.fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 2,
    });
    reconnectedSocket.fireBinary(new Uint8Array([4, 5]));
    reconnectedSocket.fireText({
      kind: "assetComplete",
      hasBinaryPayload: false,
    });

    expect(recorded.headers).toHaveLength(1);
    expect(recorded.failures).toHaveLength(0);
    expect(recorded.ready).toHaveLength(1);
    expect(Array.from(recorded.ready[0]?.bytes ?? [])).toEqual([4, 5]);
    expect(closedCount(reconnectedSocket)).toBe(1);
    asset.close();
    vi.useRealTimers();
  });

  it("fails with length-mismatch when assembled bytes don't match the header's sizeBytes, without calling onReady", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    sockets[0].fireText({
      kind: "assetHeader",
      hasBinaryPayload: false,
      mediaType: "image/jpeg",
      sizeBytes: 10,
      width: null,
      height: null,
      contentIdentity: "blob-def456",
    });
    sockets[0].fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 3,
    });
    sockets[0].fireBinary(new Uint8Array([1, 2, 3]));
    sockets[0].fireText({ kind: "assetComplete", hasBinaryPayload: false });

    expect(recorded.ready).toHaveLength(0);
    expect(recorded.failures).toEqual([
      { reason: "length-mismatch", message: "received 3 bytes, expected 10" },
    ]);

    // Failure paths close the session too, not just success - and a
    // redundant hook-driven close afterward stays silent (no second
    // onFailure, no second "closed" transition).
    expect(closedCount(sockets[0])).toBe(1);
    asset.close();
    expect(closedCount(sockets[0])).toBe(1);
    expect(recorded.failures).toHaveLength(1);
  });

  it("fails with the host's exact assetError reason and message when assetError replaces the header", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    sockets[0].fireText({
      kind: "assetError",
      hasBinaryPayload: false,
      error: "requested file exceeds the pixel cap",
      reason: "too-many-pixels",
    });

    expect(recorded.headers).toHaveLength(0);
    expect(recorded.ready).toHaveLength(0);
    expect(recorded.failures).toEqual([
      {
        reason: "too-many-pixels",
        message: "requested file exceeds the pixel cap",
      },
    ]);
    expect(closedCount(sockets[0])).toBe(1);
    asset.close();
  });

  it("fails with fatal when assetComplete arrives before assetHeader (wire-protocol violation)", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    sockets[0].fireText({ kind: "assetComplete", hasBinaryPayload: false });

    expect(recorded.ready).toHaveLength(0);
    expect(recorded.failures).toEqual([
      {
        reason: "fatal",
        message: "assetComplete arrived before assetHeader",
      },
    ]);
    expect(closedCount(sockets[0])).toBe(1);
    asset.close();
  });

  it("fails with interrupted when the transport closes before assetComplete, for a reason other than this fetch's own close()", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    sockets[0].fireText({
      kind: "assetHeader",
      hasBinaryPayload: false,
      mediaType: "image/gif",
      sizeBytes: 3,
      width: null,
      height: null,
      contentIdentity: "blob-ghi789",
    });

    // Something else tears down the whole transport (e.g. sign-out) while
    // this fetch is still in flight - not this AssetStreamClient's own
    // close(), so it must surface as a failure rather than go silent.
    client.close("test-teardown");

    expect(recorded.ready).toHaveLength(0);
    expect(recorded.failures).toEqual([
      { reason: "interrupted", message: "stream closed before assetComplete" },
    ]);
    // The external teardown produced the one and only "closed" transition -
    // `fail()`'s own follow-up `close()` call must not double-fire it.
    expect(closedCount(sockets[0])).toBe(1);
  });

  it("reports unsupported-method, not a crash or hang, when the host's manifest omits the method", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    // An older host: its manifest simply has no entry for the method.
    completeHandshake(sockets[0], (manifest) => {
      const older = { ...manifest };
      delete older["workspace.streamAsset"];
      return older;
    });

    // Rejected on the openAck: no subscribe frame, so no host work started.
    expect(sockets[0].textSent).toHaveLength(2);
    expect(JSON.parse(sockets[0].textSent[1])).toMatchObject({
      kind: "fatalError",
    });

    expect(recorded.failures).toHaveLength(1);
    expect(recorded.failures[0]?.reason).toBe("unsupported-method");
    expect(recorded.failures[0]?.message).toContain("workspace.streamAsset");
    expect(closedCount(sockets[0])).toBe(1);
    asset.close();
    expect(closedCount(sockets[0])).toBe(1);
  });

  it("never calls onFailure when the caller closes before any terminal frame arrives", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "workspace.streamAsset",
      params: WORKSPACE_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    sockets[0].fireText({
      kind: "assetHeader",
      hasBinaryPayload: false,
      mediaType: "image/webp",
      sizeBytes: 3,
      width: null,
      height: null,
      contentIdentity: "blob-jkl012",
    });

    asset.close();

    expect(recorded.failures).toHaveLength(0);
    expect(recorded.ready).toHaveLength(0);
    expect(closedCount(sockets[0])).toBe(1);

    // Idempotent: a second close() must not retroactively fail it either.
    asset.close();
    expect(recorded.failures).toHaveLength(0);
    expect(closedCount(sockets[0])).toBe(1);
  });

  it("smoke-tests git.streamFileAsset on the same happy path", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const { callbacks, recorded } = recordingCallbacks();
    const asset = new AssetStreamClient({
      wsStreamClient: client,
      method: "git.streamFileAsset",
      params: GIT_PARAMS,
      callbacks,
    });

    completeHandshake(sockets[0], undefined);
    expect(subscribeParams(sockets[0])).toEqual(GIT_PARAMS);

    sockets[0].fireText({
      kind: "assetHeader",
      hasBinaryPayload: false,
      mediaType: "image/svg+xml",
      sizeBytes: 4,
      width: null,
      height: null,
      contentIdentity: "oid-1234567",
    });
    sockets[0].fireText({
      kind: "assetChunk",
      hasBinaryPayload: true,
      index: 0,
      byteLength: 4,
    });
    sockets[0].fireBinary(new Uint8Array([9, 8, 7, 6]));
    sockets[0].fireText({ kind: "assetComplete", hasBinaryPayload: false });

    expect(recorded.failures).toHaveLength(0);
    expect(recorded.ready).toHaveLength(1);
    expect(Array.from(recorded.ready[0]?.bytes ?? [])).toEqual([9, 8, 7, 6]);
    expect(closedCount(sockets[0])).toBe(1);
    asset.close();
  });
});

function subscribeParams(socket: StubStreamWebSocket): Record<string, unknown> {
  const raw = socket.textSent[1];
  if (raw === undefined) throw new Error("no subscribe frame was sent");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("subscribe frame was not an object");
  }
  const params = (parsed as Record<string, unknown>).params;
  if (typeof params !== "object" || params === null) {
    throw new Error("subscribe frame carried no params");
  }
  return params as Record<string, unknown>;
}
