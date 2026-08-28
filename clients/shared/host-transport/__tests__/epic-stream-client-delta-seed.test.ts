/**
 * `epic.subscribe@1.3` delta-seeded reattach - `EpicStreamClient` side.
 *
 * Covers the two OSS client contracts the ticket calls out:
 *
 *   - `subscribeWithParamsProvider` params carry `seedOffer` only when the
 *     provider returns non-null, and the no-offer case OMITS the key rather
 *     than sending `seedOffer: undefined`.
 *   - The provider is read live at every wire subscribe (including a
 *     reconnect's re-declare), never captured once at construction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { EpicSubscribeClientSeedOffer } from "@traycer/protocol/host/epic/subscribe";
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
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

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

  fireClose(code: number, reason: string, wasClean: boolean): void {
    this.onclose?.({ code, reason, wasClean });
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
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx?.credentials ?? null,
    auth: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: factory,
    dialTimeoutMs: 10_000,
    openAckTimeoutMs: 10_000,
    pingIntervalMs: 60_000,
    pongTimeoutMs: 120_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
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

/** Every callback the contract requires, as no-ops - none are exercised here. */
function noopCallbacks(): EpicStreamCallbacks {
  return {
    onSnapshot: () => {},
    onEarlyMeta: () => {},
    onUpdate: () => {},
    onAwareness: () => {},
    onPermissionChanged: () => {},
    onEpicDeleted: () => {},
    onArtifactRoomSnapshot: () => {},
    onArtifactRoomUpdate: () => {},
    onArtifactRoomAwareness: () => {},
    onArtifactRoomState: () => {},
    onArtifactRoomDirty: () => {},
    onRootDirty: () => {},
    onDirtySnapshot: () => {},
    onCloudSyncStatus: () => {},
    onMigrationStarted: () => {},
    onMigrationProgress: () => {},
    onMigrationFailed: () => {},
    onMigrationNotAllowed: () => {},
    onConnectionStatus: () => {},
  };
}

describe("EpicStreamClient delta-seeded reattach (epic.subscribe@1.3)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("omits seedOffer entirely (not seedOffer: undefined) when the provider returns null", () => {
    const { factory, sockets } = makeFactory();
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: noopCallbacks(),
      seedOfferProvider: () => null,
    });
    completeHandshake(sockets[0]);

    const subscribeEnvelope = parseText(sockets[0].textSent[1]);
    expect(subscribeEnvelope).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 3, supportedMajors: [1] },
      params: { epicId: "epic-1" },
    });
    expect(
      (subscribeEnvelope.params as Record<string, unknown>) ?? {},
    ).not.toHaveProperty("seedOffer");

    client.close();
  });

  it("carries seedOffer on the wire when the provider returns an offer", () => {
    const { factory, sockets } = makeFactory();
    const offer: EpicSubscribeClientSeedOffer = {
      stateVectorBase64: "AQ==",
      roomId: "room-1",
    };
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: noopCallbacks(),
      seedOfferProvider: () => offer,
    });
    completeHandshake(sockets[0]);

    expect(parseText(sockets[0].textSent[1])).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 3, supportedMajors: [1] },
      params: {
        epicId: "epic-1",
        seedOffer: { stateVectorBase64: "AQ==", roomId: "room-1" },
      },
    });

    client.close();
  });

  it("re-reads the seed offer provider at every wire subscribe - a reconnect sees the CURRENT offer, not the one captured at construction", () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    let currentOffer: EpicSubscribeClientSeedOffer | null = null;
    const client = new EpicStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      callbacks: noopCallbacks(),
      seedOfferProvider: () => currentOffer,
    });

    completeHandshake(sockets[0]);
    expect(parseText(sockets[0].textSent[1])).toMatchObject({
      params: { epicId: "epic-1" },
    });

    // The underlying doc advances while this physical session stays live -
    // exactly the case a captured-once value would miss.
    currentOffer = { stateVectorBase64: "Ag==", roomId: "room-2" };

    sockets[0].fireClose(1006, "physical connection lost", false);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);

    completeHandshake(sockets[1]);
    expect(parseText(sockets[1].textSent[1])).toMatchObject({
      params: {
        epicId: "epic-1",
        seedOffer: { stateVectorBase64: "Ag==", roomId: "room-2" },
      },
    });

    client.close();
    vi.useRealTimers();
  });
});
