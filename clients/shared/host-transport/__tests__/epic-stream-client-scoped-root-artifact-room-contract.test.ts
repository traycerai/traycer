/**
 * B6 scoped root/artifact-room stream-client contract
 * (ticket:e86b8372-ad33-45d7-9672-2e1851d777e8/900a0484).
 *
 * Pins the artifact-room-aware `epic.subscribe@1.0` contract from the shared
 * `EpicStreamClient` perspective:
 *
 *   - Outbound root `applyUpdate` / `awareness` carry only `epicId`.
 *   - Outbound artifactRoom `artifactRoomApplyUpdate` / `artifactRoomAwareness` carry `artifactRoomId`.
 *   - Inbound root `snapshot` / `update` / `awareness` route to the
 *     root-doc callbacks; inbound `artifactRoomSnapshot` / `artifactRoomUpdate` /
 *     `artifactRoomAwareness` / `artifactRoomState` route to the per-artifact-room callbacks.
 *   - Inbound `permissionChanged` carries the parent-Epic permission only.
 */
import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
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
import { WsStreamClient } from "../ws-stream-client";
import {
  EpicStreamClient,
  type EpicStreamCallbacks,
} from "../epic-stream-client";

class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];
  readonly binarySent: Uint8Array[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.textSent.push(data);
      return;
    }
    this.binarySent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
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
}

function makeFactory(): {
  readonly factory: IStreamWebSocketFactory;
  readonly sockets: StubStreamWebSocket[];
} {
  const sockets: StubStreamWebSocket[] = [];
  const factory: IStreamWebSocketFactory = {
    create(): StreamWebSocketLike {
      const socket = new StubStreamWebSocket();
      sockets.push(socket);
      return socket;
    },
  };
  return { factory, sockets };
}

function makeRequestContext(bearer: string): RequestContext {
  const fixture = createAuthenticatedUserFixture(undefined);
  return createRequestContext({
    identity: identityFromAuthenticatedUser(fixture),
    bearerToken: bearer,
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
}

function makeWsStreamClient(
  factory: IStreamWebSocketFactory,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const ctx = makeRequestContext("token");
  return new WsStreamClient({
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx?.credentials ?? null,
    auth: null,
    webSocketFactory: factory,
    dialTimeoutMs: 1000,
    openAckTimeoutMs: 1000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1000,
  });
}

function completeHandshake(socket: StubStreamWebSocket): void {
  socket.fireOpen();
  const openParsed = JSON.parse(socket.textSent[0]) as {
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({
    kind: "openAck",
    manifest: openParsed.manifest,
  });
}

function parseText(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object text frame");
  }
  return value as Record<string, unknown>;
}

interface Recorder {
  readonly callbacks: EpicStreamCallbacks;
  readonly snapshots: Array<{
    readonly metaPermissionRole: string | null;
    readonly bytesLength: number;
  }>;
  readonly updates: Uint8Array[];
  readonly awareness: Uint8Array[];
  readonly permissionChanges: Array<string | null>;
  readonly cloudSyncStatuses: string[];
  readonly artifactRoomSnapshots: Array<{
    readonly artifactRoomId: string;
    readonly bytesLength: number;
    readonly hostArtifactRoomStateVectorBase64: string;
  }>;
  readonly artifactRoomUpdates: Array<{
    readonly artifactRoomId: string;
    readonly bytesLength: number;
    readonly hostArtifactRoomStateVectorBase64: string;
  }>;
  readonly artifactRoomAwarenessFrames: Array<{
    readonly artifactRoomId: string;
    readonly bytesLength: number;
  }>;
  readonly artifactRoomStates: Array<{
    readonly artifactRoomId: string;
    readonly state: string;
  }>;
  readonly statusEvents: number;
}

function makeRecorder(): Recorder {
  const snapshots: Array<{
    readonly metaPermissionRole: string | null;
    readonly bytesLength: number;
  }> = [];
  const updates: Uint8Array[] = [];
  const awareness: Uint8Array[] = [];
  const permissionChanges: Array<string | null> = [];
  const cloudSyncStatuses: string[] = [];
  const artifactRoomSnapshots: Array<{
    readonly artifactRoomId: string;
    readonly bytesLength: number;
    readonly hostArtifactRoomStateVectorBase64: string;
  }> = [];
  const artifactRoomUpdates: Array<{
    readonly artifactRoomId: string;
    readonly bytesLength: number;
    readonly hostArtifactRoomStateVectorBase64: string;
  }> = [];
  const artifactRoomAwarenessFrames: Array<{
    readonly artifactRoomId: string;
    readonly bytesLength: number;
  }> = [];
  const artifactRoomStates: Array<{
    readonly artifactRoomId: string;
    readonly state: string;
  }> = [];
  let statusEvents = 0;
  const callbacks: EpicStreamCallbacks = {
    onSnapshot: (meta, bytes) => {
      snapshots.push({
        metaPermissionRole: meta.permissionRole,
        bytesLength: bytes.length,
      });
    },
    onEarlyMeta: () => {
      // not exercised by this test; satisfies the contract type
    },
    onUpdate: (bytes) => updates.push(bytes),
    onAwareness: (bytes) => awareness.push(bytes),
    onPermissionChanged: (role) => permissionChanges.push(role),
    onCloudSyncStatus: (status) => cloudSyncStatuses.push(status),
    onArtifactRoomSnapshot: (
      artifactRoomId,
      bytes,
      hostArtifactRoomStateVectorBase64,
    ) => {
      artifactRoomSnapshots.push({
        artifactRoomId,
        bytesLength: bytes.length,
        hostArtifactRoomStateVectorBase64,
      });
    },
    onArtifactRoomUpdate: (
      artifactRoomId,
      bytes,
      hostArtifactRoomStateVectorBase64,
    ) => {
      artifactRoomUpdates.push({
        artifactRoomId,
        bytesLength: bytes.length,
        hostArtifactRoomStateVectorBase64,
      });
    },
    onArtifactRoomAwareness: (artifactRoomId, bytes) => {
      artifactRoomAwarenessFrames.push({
        artifactRoomId,
        bytesLength: bytes.length,
      });
    },
    onArtifactRoomState: (artifactRoomId, state) => {
      artifactRoomStates.push({ artifactRoomId, state });
    },
    onMigrationStarted: () => {
      // not exercised by this test; satisfies the contract type
    },
    onMigrationProgress: () => {
      // not exercised by this test; satisfies the contract type
    },
    onMigrationFailed: () => {
      // not exercised by this test; satisfies the contract type
    },
    onMigrationNotAllowed: () => {
      // not exercised by this test; satisfies the contract type
    },
    onConnectionStatus: () => {
      statusEvents += 1;
    },
    onEpicDeleted: () => {},
  };
  return {
    callbacks,
    snapshots,
    updates,
    awareness,
    permissionChanges,
    cloudSyncStatuses,
    artifactRoomSnapshots,
    artifactRoomUpdates,
    artifactRoomAwarenessFrames,
    artifactRoomStates,
    get statusEvents(): number {
      return statusEvents;
    },
  };
}

describe("EpicStreamClient scoped root/artifact-room contract (B6)", () => {
  it("subscribes via epic.subscribe@1.0 with epicId only", () => {
    const { factory, sockets } = makeFactory();
    const recorder = makeRecorder();
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: recorder.callbacks,
    });
    completeHandshake(sockets[0]);

    expect(parseText(sockets[0].textSent[1])).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 0 },
      params: { epicId: "epic-1" },
    });
    client.close();
  });

  it("applyUpdate emits a frame with epicId only - no artifactRoom scope discriminator", () => {
    const { factory, sockets } = makeFactory();
    const recorder = makeRecorder();
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: recorder.callbacks,
    });
    completeHandshake(sockets[0]);

    client.applyUpdate(new Uint8Array([1, 2, 3]));
    // textSent[0] is the open handshake, [1] is the subscribe frame, [2]
    // is the applyUpdate envelope.
    const envelope = parseText(sockets[0].textSent[2]);
    expect(envelope.kind).toBe("applyUpdate");
    expect(envelope["epicId"]).toBe("epic-1");
    expect(envelope).not.toHaveProperty("artifactRoomId");
    expect(envelope).not.toHaveProperty("scope");
    client.close();
  });

  it("awareness emits a frame with epicId only - no artifactRoom scope discriminator", () => {
    const { factory, sockets } = makeFactory();
    const recorder = makeRecorder();
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: recorder.callbacks,
    });
    completeHandshake(sockets[0]);

    client.awareness(new Uint8Array([7, 8, 9]));
    const envelope = parseText(sockets[0].textSent[2]);
    expect(envelope.kind).toBe("awareness");
    expect(envelope["epicId"]).toBe("epic-1");
    expect(envelope).not.toHaveProperty("artifactRoomId");
    expect(envelope).not.toHaveProperty("scope");
    client.close();
  });

  it("dispatches inbound update / awareness binary payloads to the root-doc callbacks", () => {
    const { factory, sockets } = makeFactory();
    const recorder = makeRecorder();
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: recorder.callbacks,
    });
    completeHandshake(sockets[0]);

    sockets[0].fireText({
      kind: "update",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    sockets[0].fireBinary(new Uint8Array([1]));
    sockets[0].fireText({
      kind: "awareness",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    sockets[0].fireBinary(new Uint8Array([2]));
    sockets[0].fireText({
      kind: "permissionChanged",
      epicId: "epic-1",
      permissionRole: "viewer",
      hasBinaryPayload: false,
    });

    expect(recorder.updates).toHaveLength(1);
    expect(recorder.awareness).toHaveLength(1);
    expect(recorder.permissionChanges).toEqual(["viewer"]);
    client.close();
  });

  it("dispatches inbound cloud sync status frames to the cloud status callback", () => {
    const { factory, sockets } = makeFactory();
    const recorder = makeRecorder();
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: recorder.callbacks,
    });
    completeHandshake(sockets[0]);

    sockets[0].fireText({
      kind: "cloudSyncStatus",
      epicId: "epic-1",
      status: "disconnected",
      hasBinaryPayload: false,
    });

    expect(recorder.cloudSyncStatuses).toEqual(["disconnected"]);
    client.close();
  });

  it("routes inbound artifactRoom frames to the per-artifact-room callbacks keyed by artifactRoomId", () => {
    const { factory, sockets } = makeFactory();
    const recorder = makeRecorder();
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: recorder.callbacks,
    });
    completeHandshake(sockets[0]);

    sockets[0].fireText({
      kind: "artifactRoomSnapshot",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-0",
      hostArtifactRoomStateVectorBase64: "AQ==",
      hasBinaryPayload: true,
    });
    sockets[0].fireBinary(new Uint8Array([99, 100]));
    sockets[0].fireText({
      kind: "artifactRoomUpdate",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-0",
      hostArtifactRoomStateVectorBase64: "Ag==",
      hasBinaryPayload: true,
    });
    sockets[0].fireBinary(new Uint8Array([1]));
    sockets[0].fireText({
      kind: "artifactRoomAwareness",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-0",
      hasBinaryPayload: true,
    });
    sockets[0].fireBinary(new Uint8Array([2, 3, 4]));
    sockets[0].fireText({
      kind: "artifactRoomState",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-1",
      state: "unavailable",
      hasBinaryPayload: false,
    });
    sockets[0].fireText({
      kind: "artifactRoomState",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-1",
      state: "retrying",
      hasBinaryPayload: false,
    });

    expect(recorder.artifactRoomSnapshots).toEqual([
      {
        artifactRoomId: "artifact-room-0",
        bytesLength: 2,
        hostArtifactRoomStateVectorBase64: "AQ==",
      },
    ]);
    expect(recorder.artifactRoomUpdates).toEqual([
      {
        artifactRoomId: "artifact-room-0",
        bytesLength: 1,
        hostArtifactRoomStateVectorBase64: "Ag==",
      },
    ]);
    expect(recorder.artifactRoomAwarenessFrames).toEqual([
      { artifactRoomId: "artifact-room-0", bytesLength: 3 },
    ]);
    expect(recorder.artifactRoomStates).toEqual([
      { artifactRoomId: "artifact-room-1", state: "unavailable" },
      { artifactRoomId: "artifact-room-1", state: "retrying" },
    ]);
    // Root callbacks must not be touched by artifactRoom frames.
    expect(recorder.snapshots).toHaveLength(0);
    expect(recorder.updates).toHaveLength(0);
    client.close();
  });

  it("applyArtifactRoomUpdate emits a frame carrying artifactRoomId for host routing", () => {
    const { factory, sockets } = makeFactory();
    const recorder = makeRecorder();
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: recorder.callbacks,
    });
    completeHandshake(sockets[0]);

    client.applyArtifactRoomUpdate(
      "artifact-room-0",
      new Uint8Array([4, 5, 6]),
    );
    const envelope = parseText(sockets[0].textSent[2]);
    expect(envelope).toMatchObject({
      kind: "artifactRoomApplyUpdate",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-0",
      hasBinaryPayload: true,
    });
    client.close();
  });

  it("artifactRoomAwareness emits a frame carrying artifactRoomId so the host can fan it out", () => {
    const { factory, sockets } = makeFactory();
    const recorder = makeRecorder();
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: recorder.callbacks,
    });
    completeHandshake(sockets[0]);

    client.artifactRoomAwareness("artifact-room-0", new Uint8Array([8, 9]));
    const envelope = parseText(sockets[0].textSent[2]);
    expect(envelope).toMatchObject({
      kind: "artifactRoomAwareness",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-0",
      hasBinaryPayload: true,
    });
    client.close();
  });
});
