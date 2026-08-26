import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  defineStreamRpcContract,
  defineVersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "../../host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type { HostDirectoryEntry } from "../../host-client/host-directory";
import type {
  HostCredentialMintFlow,
  HostCredentialMintOutcome,
} from "../host-credential-mint-flow";
import type { HostCredentialState } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  hostNotificationsSubscribeServerFrameSchema,
  type HostNotificationEntry,
  type HostNotificationsSummary,
} from "@traycer/protocol/host/notifications/contracts";
import { toStreamDialUrl } from "../ws-stream-client";
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
import type {
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "../i-stream-session";
import { WsStreamClient } from "../ws-stream-client";
import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "../../auth/bearer-revalidator";
import {
  NO_TRANSPORT_EVIDENCE,
  type TransportEvidenceReporter,
} from "@traycer-clients/shared/host-selection/transport-evidence";
import { RecordingTransportEvidence } from "../../host-selection/__tests__/recording-transport-evidence";
import { HOST_RESTARTING_FATAL_CODE } from "@traycer/protocol/framework/index";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

/**
 * StubWebSocket - fully scriptable `StreamWebSocketLike` mirror of the
 * text+binary WS surface. Every inbound event is fired explicitly from the
 * test so the stream client's state machine is exercised deterministically
 * without resorting to real timers.
 */
class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];
  readonly binarySent: Uint8Array[] = [];
  /**
   * Ordered record of every frame the client emitted - strings for text
   * envelopes, `Uint8Array` for binary payloads. Lets tests assert exact
   * interleaving across the wire.
   */
  readonly wire: Array<string | Uint8Array> = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  failNextSend = false;

  send(data: string | Uint8Array): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("simulated send failure");
    }
    if (typeof data === "string") {
      this.textSent.push(data);
      this.wire.push(data);
      return;
    }
    this.binarySent.push(data);
    this.wire.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
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

  fireRawText(raw: string): void {
    if (this.onmessage !== null) {
      this.onmessage({ type: "text", data: raw });
    }
  }

  fireBinary(data: Uint8Array): void {
    if (this.onmessage !== null) {
      this.onmessage({ type: "binary", data });
    }
  }

  fireClose(code: number, reason: string, wasClean: boolean): void {
    if (this.onclose !== null) {
      this.onclose({ code, reason, wasClean });
    }
  }

  fireError(): void {
    if (this.onerror !== null) {
      this.onerror({ message: "simulated socket error" });
    }
  }
}

interface RecordedSocket {
  readonly url: string;
  readonly socket: StubStreamWebSocket;
}

function makeFactory(): {
  readonly factory: IStreamWebSocketFactory;
  readonly sockets: RecordedSocket[];
} {
  const sockets: RecordedSocket[] = [];
  const factory: IStreamWebSocketFactory = {
    create(url: string): StreamWebSocketLike {
      const socket = new StubStreamWebSocket();
      sockets.push({ url, socket });
      return socket;
    },
  };
  return { factory, sockets };
}

function makeClient(options: {
  readonly factory: IStreamWebSocketFactory;
  readonly authToken: string | null;
  readonly pingIntervalMs: number;
  readonly pongTimeoutMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
}): WsStreamClient<typeof hostStreamRpcRegistry> {
  const ctx =
    options.authToken === null ? null : makeRequestContext(options.authToken);
  return new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx?.credentials ?? null,
    auth: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: options.factory,
    dialTimeoutMs: 1000,
    openAckTimeoutMs: 1000,
    pingIntervalMs: options.pingIntervalMs,
    pongTimeoutMs: options.pongTimeoutMs,
    initialBackoffMs: options.initialBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
  });
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

/**
 * A client whose bearer can be rotated in place via the returned `ctx`, so
 * `credentialUpdate` tests can refresh the credential and assert what the client
 * pushes onto the open session.
 */
function makeRotatableClient(
  factory: IStreamWebSocketFactory,
  bearer: string,
): {
  readonly client: WsStreamClient<typeof hostStreamRpcRegistry>;
  readonly ctx: RequestContext;
} {
  const ctx = makeRequestContext(bearer);
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx.credentials,
    auth: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: factory,
    dialTimeoutMs: 1000,
    openAckTimeoutMs: 1000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
  });
  return { client, ctx };
}

/**
 * A client whose evidence reporter and dialed endpoint are both caller-
 * controlled - suite D's restart-tombstone tests need a recording reporter
 * (not `NO_TRANSPORT_EVIDENCE`), and the identity-pin test additionally needs
 * to repoint `endpoint()` mid-connection.
 */
function makeClientWithEvidence(options: {
  readonly factory: IStreamWebSocketFactory;
  readonly authToken: string | null;
  readonly evidence: TransportEvidenceReporter;
  readonly endpoint: () => HostDirectoryEntry | null;
}): WsStreamClient<typeof hostStreamRpcRegistry> {
  const ctx =
    options.authToken === null ? null : makeRequestContext(options.authToken);
  return new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: options.endpoint,
    bearer: () => ctx?.credentials ?? null,
    auth: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: options.evidence,
    webSocketFactory: options.factory,
    dialTimeoutMs: 1000,
    openAckTimeoutMs: 1000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Drives the handshake portion of the state machine forward: fires open,
 * parses the emitted `open` envelope into the manifest, then fires an
 * `openAck` that echoes that manifest so the mirror compatibility check
 * passes. Returns after the `subscribe` frame has been emitted.
 */
/**
 * Read from the LIVE registry rather than hardcoded, because
 * `completeHandshake` echoes the client's own manifest back: pinning a literal
 * minor here would make every future `git.subscribeStatus` bump fail a test
 * that is about per-session ROUTING, not about any particular version.
 */
const GIT_STATUS_VERSION = {
  major: 1,
  minor: hostStreamRpcRegistry["git.subscribeStatus"][1].latestMinor,
};

function completeHandshake(socket: StubStreamWebSocket): void {
  socket.fireOpen();
  const openRaw = socket.textSent[0];
  const openParsed = JSON.parse(openRaw) as {
    readonly kind: "open";
    readonly token: string;
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({
    kind: "openAck",
    manifest: openParsed.manifest,
  });
}

function streamOpenAck(
  manifest: Record<string, { major: number; minor: number }>,
  capabilities: readonly string[] | undefined,
): Record<string, unknown> {
  return {
    kind: "openAck",
    manifest,
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function parseText(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected object text frame, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

describe("WsStreamClient", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("walks dial → open → openAck → subscribe and transitions to open status", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    session.onStatusChange((status) => {
      statuses.push(status);
    });

    await flush();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(
      toStreamDialUrl(mockLocalHostEntry.websocketUrl ?? ""),
    );

    const stub = sockets[0].socket;
    stub.fireOpen();

    expect(stub.textSent).toHaveLength(1);
    const openFrame = parseText(stub.textSent[0]);
    expect(openFrame.kind).toBe("open");
    expect(openFrame.token).toBe("token-abc");
    // The open frame's manifest is the client's raw canonical - no per-method
    // substitution needed. A same-major minor skew (e.g. host-v1.0.0's
    // chat.subscribe@1.0 vs this client's @1.1) is safe for the old host's own
    // full-manifest check: `canBridgeStream` trusts an older peer receiving a
    // newer minor unconditionally (additive minors), so it never poisons an
    // unrelated method's open handshake the way the old major bump once did.
    expect(openFrame.manifest).toEqual(
      buildStreamManifest(hostStreamRpcRegistry),
    );
    expect(openFrame).not.toHaveProperty("optionalManifest");
    // WHO IS CONNECTING. `/stream` authenticates independently of `/rpc`, so a
    // stream socket that forgot to identify itself would read to a floored
    // host as a legacy client no matter what the unary transport sent.
    expect(openFrame.clientIdentity).toEqual({
      kind: TEST_CLIENT_IDENTITY.kind,
      compatibilityEpoch: TEST_CLIENT_IDENTITY.compatibilityEpoch,
      appVersion: TEST_CLIENT_IDENTITY.appVersion,
    });

    stub.fireText(
      streamOpenAck(buildStreamManifest(hostStreamRpcRegistry), undefined),
    );

    expect(stub.textSent).toHaveLength(2);
    const subscribeFrame = parseText(stub.textSent[1]);
    expect(subscribeFrame).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { epicId: "epic-1" },
    });

    expect(statuses).toContain("open");

    session.close();
  });

  it("subscribes to a compatible method even when an unrelated method has major skew", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });

    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();

    // A hypothetical peer on some future, unbridgeable chat.subscribe major -
    // exercises method isolation, independent of chat.subscribe's real,
    // currently-bridgeable version history.
    const skewedManifest = {
      ...buildStreamManifest(hostStreamRpcRegistry),
      "chat.subscribe": { major: 2, minor: 0 },
    };
    stub.fireText(streamOpenAck(skewedManifest, undefined));

    expect(stub.textSent).toHaveLength(2);
    expect(parseText(stub.textSent[1])).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { epicId: "epic-1" },
    });

    session.close();
  });

  it("advertises the canonical chat stream version for chat subscriptions", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("chat.subscribe", {
      epicId: "epic-1",
      chatId: "chat-1",
    });
    await flush();

    sockets[0].socket.fireOpen();
    const openFrame = parseText(sockets[0].socket.textSent[0]);
    expect(openFrame.manifest).toEqual(
      buildStreamManifest(hostStreamRpcRegistry),
    );
    expect(openFrame).not.toHaveProperty("optionalManifest");

    session.close();
  });

  it("subscribes to shipped hosts that ack the legacy manifest intersection", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    const stub = sockets[0].socket;
    stub.fireOpen();

    const openFrame = parseText(stub.textSent[0]);
    expect(openFrame.manifest).toEqual(
      buildStreamManifest(hostStreamRpcRegistry),
    );
    expect(openFrame).not.toHaveProperty("optionalManifest");

    // Shipped stream hosts do not run a fatal open-time manifest check. They
    // acknowledge the intersection of their manifest with the client's legacy
    // advertised entries, without an optional channel.
    stub.fireText({
      kind: "openAck",
      manifest: {
        "epic.subscribe": buildStreamManifest(hostStreamRpcRegistry)[
          "epic.subscribe"
        ],
      },
    });

    expect(parseText(stub.textSent[1])).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { epicId: "epic-1" },
    });

    session.close();
  });

  // Regression test for the release-v1.1.0 RC incident: the compatibility
  // check correctly determined chat.subscribe@1.1 bridges to a host still on
  // @1.0, but the subscribe frame kept declaring this client's own canonical
  // (1.1) regardless - a version host-v1.0.0's dispatch table has never heard
  // of, so it rejected the subscribe outright even though the handshake
  // passed. The client must downgrade what it declares to the version the
  // host actually advertised.
  it("declares the host's own chat.subscribe version when the host is still on 1.0", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("chat.subscribe", {
      epicId: "epic-1",
      chatId: "chat-1",
    });
    await flush();

    const stub = sockets[0].socket;
    stub.fireOpen();

    const hostV100Manifest = {
      ...buildStreamManifest(hostStreamRpcRegistry),
      "chat.subscribe": { major: 1, minor: 0 },
    };
    stub.fireText(streamOpenAck(hostV100Manifest, undefined));

    expect(stub.textSent).toHaveLength(2);
    expect(parseText(stub.textSent[1])).toEqual({
      kind: "subscribe",
      method: "chat.subscribe",
      schemaVersion: { major: 1, minor: 0 },
      params: { epicId: "epic-1", chatId: "chat-1" },
    });

    session.close();
  });

  // chat.subscribe's own openRequestSchema never changed across 1.0/1.1, so
  // the test above can't prove `prepareStreamSubscribeRequest` actually
  // reprojects params through the older contract - only that it downgrades
  // the declared version. A synthetic method with a genuinely different
  // open-request shape per minor closes that gap.
  it("rewrites the subscribe params onto the host's older contract when the open-request shape changed", async () => {
    const openRequestSchemaV10 = z.object({ id: z.string() });
    const openRequestSchemaV11 = z.object({
      id: z.string(),
      locale: z.string().nullable(),
    });
    const frameSchemas = {
      serverFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("snapshot"),
          hasBinaryPayload: z.literal(false),
          id: z.string(),
        }),
      ]),
      clientFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("noop"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
    };
    const versionSkewRegistry = defineVersionedStreamRpcRegistry({
      "version-skew.subscribe": {
        1: {
          latestMinor: 1,
          versions: {
            0: {
              contract: defineStreamRpcContract({
                method: "version-skew.subscribe",
                schemaVersion: { major: 1, minor: 0 } as const,
                openRequestSchema: openRequestSchemaV10,
                ...frameSchemas,
              }),
            },
            1: {
              contract: defineStreamRpcContract({
                method: "version-skew.subscribe",
                schemaVersion: { major: 1, minor: 1 } as const,
                openRequestSchema: openRequestSchemaV11,
                ...frameSchemas,
              }),
            },
          },
        },
      },
    });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: versionSkewRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      openAckTimeoutMs: 1000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("version-skew.subscribe", {
      id: "item-1",
      locale: "en-US",
    });
    await flush();

    const stub = sockets[0].socket;
    stub.fireOpen();

    stub.fireText(
      streamOpenAck(
        { "version-skew.subscribe": { major: 1, minor: 0 } },
        undefined,
      ),
    );

    expect(stub.textSent).toHaveLength(2);
    expect(parseText(stub.textSent[1])).toEqual({
      kind: "subscribe",
      method: "version-skew.subscribe",
      schemaVersion: { major: 1, minor: 0 },
      // `locale` is stripped - the 1.0 contract the host actually has never
      // declared that field, so the params get reprojected onto it.
      params: { id: "item-1" },
    });

    session.close();
  });

  it("selects an installed older major before subscribing to an RC host", async () => {
    const openRequestSchema = z.object({ id: z.string() });
    const clientFrameSchema = z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("noop"),
        hasBinaryPayload: z.literal(false),
      }),
    ]);
    const registry = defineVersionedStreamRpcRegistry({
      "dual-major.subscribe": {
        1: {
          latestMinor: 0,
          versions: {
            0: {
              contract: defineStreamRpcContract({
                method: "dual-major.subscribe",
                schemaVersion: { major: 1, minor: 0 } as const,
                openRequestSchema,
                serverFrameSchema: z.object({
                  kind: z.literal("snapshot"),
                  hasBinaryPayload: z.literal(false),
                  id: z.string(),
                }),
                clientFrameSchema,
              }),
            },
          },
        },
        2: {
          latestMinor: 1,
          versions: {
            1: {
              contract: defineStreamRpcContract({
                method: "dual-major.subscribe",
                schemaVersion: { major: 2, minor: 1 } as const,
                openRequestSchema,
                serverFrameSchema: z.object({
                  kind: z.literal("state"),
                  hasBinaryPayload: z.literal(false),
                  id: z.string(),
                }),
                clientFrameSchema,
              }),
            },
          },
        },
      },
    });
    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      openAckTimeoutMs: 1000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("dual-major.subscribe", { id: "item-1" });
    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();
    stub.fireText(
      streamOpenAck(
        { "dual-major.subscribe": { major: 1, minor: 0 } },
        undefined,
      ),
    );

    expect(parseText(stub.textSent[1])).toEqual({
      kind: "subscribe",
      method: "dual-major.subscribe",
      schemaVersion: { major: 1, minor: 0 },
      params: { id: "item-1" },
    });

    session.close();
  });

  it("pushes a credentialUpdate frame on bearer rotation when the host advertises support", async () => {
    const { factory, sockets } = makeFactory();
    const { client, ctx } = makeRotatableClient(factory, "token-1");

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();
    stub.fireText(
      streamOpenAck(buildStreamManifest(hostStreamRpcRegistry), [
        "credentialUpdate",
      ]),
    );
    const sentBeforeRotation = stub.textSent.length;

    ctx.credentials.rotateBearerToken({
      userId: ctx.identity.userId,
      bearerToken: "token-2",
    });
    client.notifyBearerRotated();

    expect(stub.textSent).toHaveLength(sentBeforeRotation + 1);
    expect(parseText(stub.textSent[sentBeforeRotation])).toEqual({
      kind: "credentialUpdate",
      token: "token-2",
    });

    session.close();
  });

  it("does not push a credentialUpdate frame when the host did not advertise support", async () => {
    const { factory, sockets } = makeFactory();
    const { client, ctx } = makeRotatableClient(factory, "token-1");

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();
    // Older host: openAck omits `capabilities` (schema defaults it to []).
    stub.fireText(
      streamOpenAck(buildStreamManifest(hostStreamRpcRegistry), undefined),
    );
    const sentBeforeRotation = stub.textSent.length;

    ctx.credentials.rotateBearerToken({
      userId: ctx.identity.userId,
      bearerToken: "token-2",
    });
    client.notifyBearerRotated();

    expect(stub.textSent).toHaveLength(sentBeforeRotation);

    session.close();
  });

  it("reconciles a bearer rotation that happened during the handshake (before openAck)", async () => {
    const { factory, sockets } = makeFactory();
    const { client, ctx } = makeRotatableClient(factory, "token-1");

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();
    // The open frame carried token-1. Rotate BEFORE the openAck arrives: the
    // session isn't subscribed yet, so this push is dropped at the time.
    ctx.credentials.rotateBearerToken({
      userId: ctx.identity.userId,
      bearerToken: "token-2",
    });
    client.notifyBearerRotated();
    const credentialUpdatesBeforeAck = stub.textSent.filter(
      (raw) => parseText(raw).kind === "credentialUpdate",
    );
    expect(credentialUpdatesBeforeAck).toHaveLength(0);

    // openAck (capability-advertising) → on becoming subscribed the client
    // reconciles the missed rotation and pushes exactly one credentialUpdate.
    stub.fireText(
      streamOpenAck(buildStreamManifest(hostStreamRpcRegistry), [
        "credentialUpdate",
      ]),
    );

    const credentialUpdates = stub.textSent
      .map((raw) => parseText(raw))
      .filter((frame) => frame.kind === "credentialUpdate");
    expect(credentialUpdates).toHaveLength(1);
    expect(credentialUpdates[0].token).toBe("token-2");

    session.close();
  });

  it("does not dial or send an open frame without an authenticated request context", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: null,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    expect(sockets).toHaveLength(0);
    session.close();
  });

  it("pairs a binary frame with its preceding envelope even when interleaved with text-only frames", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const received: Array<{
      readonly envelope: StreamFrameEnvelope;
      readonly payload: Uint8Array | null;
    }> = [];
    session.onServerFrame((envelope, payload) => {
      received.push({ envelope, payload });
    });

    await flush();
    completeHandshake(sockets[0].socket);

    const stub = sockets[0].socket;

    // Interleave: text-only permissionChanged, then binary-pairing snapshot,
    // then text-only permissionChanged again, then binary-pairing update.
    stub.fireText({
      kind: "permissionChanged",
      epicId: "epic-1",
      permissionRole: "editor",
      hasBinaryPayload: false,
    });

    stub.fireText({
      kind: "snapshot",
      epicId: "epic-1",
      meta: {
        schemaVersion: "2.0.0",
        epicLight: null,
        permissionRole: "editor",
        repos: [],
        workspaces: [],
        repoMapping: [],
        workspaceFolders: [],
        unresolvedRepos: [],
      },
      hasBinaryPayload: true,
    });
    const snapshotBytes = new Uint8Array([1, 2, 3, 4]);
    stub.fireBinary(snapshotBytes);

    stub.fireText({
      kind: "permissionChanged",
      epicId: "epic-1",
      permissionRole: "viewer",
      hasBinaryPayload: false,
    });

    stub.fireText({
      kind: "update",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    const updateBytes = new Uint8Array([5, 6, 7]);
    stub.fireBinary(updateBytes);

    expect(received).toHaveLength(4);
    expect(received[0].envelope.kind).toBe("permissionChanged");
    expect(received[0].payload).toBeNull();
    expect(received[1].envelope.kind).toBe("snapshot");
    expect(received[1].payload).toStrictEqual(snapshotBytes);
    expect(received[2].envelope.kind).toBe("permissionChanged");
    expect(received[2].payload).toBeNull();
    expect(received[3].envelope.kind).toBe("update");
    expect(received[3].payload).toStrictEqual(updateBytes);

    session.close();
  });

  it("surfaces a host fatalError frame as a 'closed' status with typed reason", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "bad",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const capture: {
      status: StreamConnectionStatus | null;
      reason: StreamCloseReason | null;
    } = { status: null, reason: null };
    session.onStatusChange((status, reason) => {
      if (status === "closed") {
        capture.status = status;
        capture.reason = reason;
      }
    });

    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();

    stub.fireText({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "Bearer token rejected",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(capture.status).toBe("closed");
    const finalReason = capture.reason;
    if (finalReason === null || finalReason.kind !== "fatalError") {
      throw new Error("expected fatalError close reason");
    }
    expect(finalReason.details.code).toBe("UNAUTHORIZED");
    // No further reconnect attempts after a fatal error.
    await flush();
    expect(sockets).toHaveLength(1);
  });

  it("emits a client fatalError frame and closes when the mirror compatibility check fails", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    let observedCode: string | null = null;
    session.onStatusChange((status, reason) => {
      if (
        status === "closed" &&
        reason !== null &&
        reason.kind === "fatalError"
      ) {
        observedCode = reason.details.code;
      }
    });

    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();

    // Host reports a method at major=2, minor=0 which the client at
    // major=1, minor=0 cannot bridge in v1 (no cross-major stream
    // bridges), so the mirror check must fail and the client must emit
    // its own fatalError before closing.
    stub.fireText({
      kind: "openAck",
      manifest: {
        "epic.subscribe": { major: 2, minor: 0 },
        "chat.subscribe": { major: 1, minor: 0 },
        "notifications.subscribe": { major: 1, minor: 0 },
      },
    });

    const emitted = stub.textSent[stub.textSent.length - 1];
    const emittedFrame = parseText(emitted);
    expect(emittedFrame.kind).toBe("fatalError");
    expect(observedCode).toBe("INCOMPATIBLE");
  });

  describe("live-session evidence (invariant 5)", () => {
    it("announces the local stream session once subscribed, and retracts it against the SAME host on teardown", async () => {
      // `/stream` is a live session and the authority's strongest evidence
      // class: it suppresses death accumulation entirely. Unannounced, a
      // healthy long-lived stream counted for nothing, so unary dials refused
      // during an accept-loop stall could reach the confirmed-death streak and
      // fail the local host over while its stream was still carrying frames.
      const { factory, sockets } = makeFactory();
      const recorder = new RecordingTransportEvidence();
      const client = makeClientWithEvidence({
        factory,
        authToken: "t",
        evidence: recorder,
        endpoint: () => mockLocalHostEntry,
      });

      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      await flush();
      expect(recorder.ofKind("sessionEstablished")).toHaveLength(0);

      completeHandshake(sockets[0].socket);
      await flush();

      const announced = recorder.ofKind("sessionEstablished");
      expect(announced).toHaveLength(1);
      expect(announced[0].hostId).toBe(mockLocalHostEntry.hostId);
      expect(announced[0].transportKind).toBe("local-ws");
      expect(recorder.ofKind("sessionLost")).toHaveLength(0);

      session.close();
      await flush();

      const retracted = recorder.ofKind("sessionLost");
      expect(retracted).toHaveLength(1);
      // Retracted against the host it was announced FOR, under the same id -
      // an announcement that is never matched means the host can never be
      // declared dead again.
      expect(retracted[0].hostId).toBe(announced[0].hostId);
      expect(retracted[0].sessionId).toBe(announced[0].sessionId);
    });
  });

  describe("restart tombstone forwarding (P1.4 / D5 / M1)", () => {
    it("a fatalError frame carrying restartIntent + retryable:true reports exactly one reportRestartIntent, and the session does not go terminal", async () => {
      const { factory, sockets } = makeFactory();
      const recorder = new RecordingTransportEvidence();
      const client = makeClientWithEvidence({
        factory,
        authToken: "t",
        evidence: recorder,
        endpoint: () => mockLocalHostEntry,
      });

      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      let sawClosed = false;
      session.onStatusChange((status) => {
        if (status === "closed") sawClosed = true;
      });

      await flush();
      const stub = sockets[0].socket;
      stub.fireOpen();

      stub.fireText({
        kind: "fatalError",
        details: {
          code: HOST_RESTARTING_FATAL_CODE,
          reason: "The host is restarting and expects to be back shortly",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
          restartIntent: {
            tombstoneId: "tombstone-d1",
            expiresAt: 1_700_000_000_000,
          },
        },
      });

      const tombstones = recorder.ofKind("restartIntent");
      expect(tombstones).toHaveLength(1);
      expect(tombstones[0].hostId).toBe(mockLocalHostEntry.hostId);
      expect(tombstones[0].tombstoneId).toBe("tombstone-d1");
      expect(tombstones[0].expiresAt).toBe(1_700_000_000_000);
      expect(sawClosed).toBe(false);

      // Retryable, so the transport reconnects rather than going terminal -
      // a fresh socket is dialed once backoff elapses.
      await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1), {
        timeout: 2_000,
      });
    });

    it("a fatalError frame with NO restartIntent produces zero reportRestartIntent calls - old-host compat", async () => {
      const { factory, sockets } = makeFactory();
      const recorder = new RecordingTransportEvidence();
      const client = makeClientWithEvidence({
        factory,
        authToken: "t",
        evidence: recorder,
        endpoint: () => mockLocalHostEntry,
      });

      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      let sawClosed = false;
      session.onStatusChange((status) => {
        if (status === "closed") sawClosed = true;
      });

      await flush();
      const stub = sockets[0].socket;
      stub.fireOpen();

      stub.fireText({
        kind: "fatalError",
        details: {
          code: "SOME_TRANSIENT_CODE",
          reason: "a transient host-side rejection carrying no tombstone",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
        },
      });

      // Positive control in the same test: the retryable path DOES still
      // reconnect, so the absence of a tombstone report below is not because
      // nothing happened at all.
      await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1), {
        timeout: 2_000,
      });
      expect(sawClosed).toBe(false);
      expect(recorder.ofKind("restartIntent")).toHaveLength(0);
    });

    it("a fatalError frame carrying restartIntent with retryable absent still reports the tombstone - every arm reports it, not only the retryable one", async () => {
      const { factory, sockets } = makeFactory();
      const recorder = new RecordingTransportEvidence();
      const client = makeClientWithEvidence({
        factory,
        authToken: "t",
        evidence: recorder,
        endpoint: () => mockLocalHostEntry,
      });

      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      let closedCode: string | null = null;
      session.onStatusChange((status, reason) => {
        if (
          status === "closed" &&
          reason !== null &&
          reason.kind === "fatalError"
        ) {
          closedCode = reason.details.code;
        }
      });

      await flush();
      const stub = sockets[0].socket;
      stub.fireOpen();

      stub.fireText({
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "Bearer token rejected",
          incompatibleMethods: null,
          upgradeGuidance: null,
          restartIntent: { tombstoneId: "tombstone-d3", expiresAt: null },
        },
      });

      // No `auth` revalidator is wired on this client, so an UNAUTHORIZED
      // fatal with no `retryable` flag stays terminal - the tombstone report
      // must still have fired before that routing decision was made.
      expect(closedCode).toBe("UNAUTHORIZED");
      const tombstones = recorder.ofKind("restartIntent");
      expect(tombstones).toHaveLength(1);
      expect(tombstones[0].tombstoneId).toBe("tombstone-d3");
    });

    it("files the tombstone against the hostId THIS connection dialed, not whatever the endpoint provider returns later", async () => {
      const { factory, sockets } = makeFactory();
      const recorder = new RecordingTransportEvidence();
      let currentEndpoint = mockLocalHostEntry;
      const client = makeClientWithEvidence({
        factory,
        authToken: "t",
        evidence: recorder,
        endpoint: () => currentEndpoint,
      });

      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      session.onStatusChange(() => {});

      await flush();
      const stub = sockets[0].socket;
      stub.fireOpen();

      // The endpoint provider now points at a DIFFERENT host than the one
      // this socket dialed - simulating a host switch that raced an
      // in-flight connection.
      expect(mockRemoteHostEntry.hostId).not.toBe(mockLocalHostEntry.hostId);
      currentEndpoint = mockRemoteHostEntry;

      stub.fireText({
        kind: "fatalError",
        details: {
          code: HOST_RESTARTING_FATAL_CODE,
          reason: "restarting",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
          restartIntent: { tombstoneId: "tombstone-d4", expiresAt: null },
        },
      });

      const tombstones = recorder.ofKind("restartIntent");
      expect(tombstones).toHaveLength(1);
      // The ORIGINAL dialed identity, not the provider's current answer -
      // filing against the wrong host would hold the wrong lease.
      expect(tombstones[0].hostId).toBe(mockLocalHostEntry.hostId);
      expect(tombstones[0].hostId).not.toBe(mockRemoteHostEntry.hostId);
    });
  });

  it("remembers stream method support after a successful subscribe", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const observed: string[] = [];
    const unsubscribe = client.subscribeMethodSupport(() => {
      observed.push(client.getMethodSupport("resources.subscribe"));
    });

    const session = client.subscribe("resources.subscribe", {
      epicId: "epic-1",
    });

    await flush();
    completeHandshake(sockets[0].socket);

    expect(client.getMethodSupport("resources.subscribe")).toBe("supported");
    expect(observed).toEqual(["supported"]);

    unsubscribe();
    session.close();
  });

  it("remembers a missing stream method as unsupported for newer-client older-host pairs", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const observed: string[] = [];
    const unsubscribe = client.subscribeMethodSupport(() => {
      observed.push(client.getMethodSupport("resources.subscribe"));
    });

    const session = client.subscribe("resources.subscribe", {
      epicId: "epic-1",
    });

    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();
    stub.fireText({
      kind: "openAck",
      manifest: {
        "epic.subscribe": { major: 1, minor: 0 },
        "chat.subscribe": { major: 1, minor: 2 },
        "terminal.subscribe": { major: 1, minor: 3 },
      },
    });

    expect(client.getMethodSupport("resources.subscribe")).toBe("unsupported");
    expect(observed).toEqual(["unsupported"]);

    unsubscribe();
    session.close();
  });

  it("re-probes the full host manifest after reconnect and discovers a newly enabled method", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const session = client.subscribe("host.notifications.feed.subscribe", {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });

    await vi.advanceTimersByTimeAsync(0);
    const firstSocket = sockets[0].socket;
    firstSocket.fireOpen();
    const firstOpen = parseText(firstSocket.textSent[0]);
    const firstManifest = firstOpen.manifest as Record<
      string,
      { major: number; minor: number }
    >;
    const methodlessManifest = { ...firstManifest };
    delete methodlessManifest["host.notifications.cloudFeed.subscribe"];
    firstSocket.fireText(streamOpenAck(methodlessManifest, undefined));
    expect(
      client.getMethodSupport("host.notifications.cloudFeed.subscribe"),
    ).toBe("unsupported");

    client.reconnectAll("host-endpoint-change", { probeFirst: false });
    expect(
      client.getMethodSupport("host.notifications.cloudFeed.subscribe"),
    ).toBe("unknown");
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1].socket);
    expect(
      client.getMethodSupport("host.notifications.cloudFeed.subscribe"),
    ).toBe("supported");

    session.close();
  });

  it("preserves Git routing on one repo while another Git session reconnects", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const reconnectingGitSession = client.subscribe("git.subscribeStatus", {
      hostId: "host-1",
      runningDir: "/repo-a",
      ignoreWhitespace: false,
      freshNonce: null,
    });
    const liveGitSession = client.subscribe("git.subscribeStatus", {
      hostId: "host-1",
      runningDir: "/repo-b",
      ignoreWhitespace: false,
      freshNonce: null,
    });
    const routedGitMinors: number[] = [];
    liveGitSession.onServerFrame(() => {
      routedGitMinors.push(
        client.getMethodSchemaVersion("git.subscribeStatus")?.minor ?? -1,
      );
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[0].socket);
    completeHandshake(sockets[1].socket);
    expect(client.getMethodSchemaVersion("git.subscribeStatus")).toEqual(
      GIT_STATUS_VERSION,
    );

    reconnectingGitSession.requestReconnect();
    expect(client.getMethodSchemaVersion("git.subscribeStatus")).toEqual(
      GIT_STATUS_VERSION,
    );
    sockets[1].socket.fireText({
      kind: "update",
      hasBinaryPayload: false,
      value: { type: "error", message: "during reconnect", isFatal: false },
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(3);
    completeHandshake(sockets[2].socket);
    expect(client.getMethodSchemaVersion("git.subscribeStatus")).toEqual(
      GIT_STATUS_VERSION,
    );
    sockets[1].socket.fireText({
      kind: "update",
      hasBinaryPayload: false,
      value: { type: "error", message: "after reconnect", isFatal: false },
    });
    expect(routedGitMinors).toEqual([
      GIT_STATUS_VERSION.minor,
      GIT_STATUS_VERSION.minor,
    ]);

    reconnectingGitSession.close();
    expect(client.getMethodSchemaVersion("git.subscribeStatus")).toEqual(
      GIT_STATUS_VERSION,
    );
    liveGitSession.close();
    expect(client.getMethodSchemaVersion("git.subscribeStatus")).toBeNull();
  });

  it("closes the socket after two missed pongs and triggers a reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 10_000,
      openAckTimeoutMs: 10_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });

    completeHandshake(sockets[0].socket);
    const firstSocket = sockets[0].socket;
    expect(firstSocket.closed).toBeNull();

    // First tick: a ping is sent; no missed-pong cutoff yet because
    // lastPongAt was just set when we transitioned to "open".
    vi.advanceTimersByTime(25_000);
    const pingFrame = parseText(
      firstSocket.textSent[firstSocket.textSent.length - 1],
    );
    expect(pingFrame.kind).toBe("ping");

    // Second tick (total elapsed 50s since last pong) is the cutoff: the
    // client tears down the socket with code 4004 before sending.
    vi.advanceTimersByTime(25_000);
    const closedWith = firstSocket.closed;
    if (closedWith === null) {
      throw new Error("expected socket to be closed after missed pongs");
    }
    expect(closedWith.code).toBe(4004);
    expect(closedWith.reason).toBe("missed-pongs");

    // Reconnect backoff fires → a fresh socket is created with the same URL.
    vi.advanceTimersByTime(1_000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(sockets[1].url).toBe(
      toStreamDialUrl(mockLocalHostEntry.websocketUrl ?? ""),
    );

    session.close();
    vi.useRealTimers();
  });

  it("re-issues the same subscribe declaration after a recoverable server close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
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

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });

    completeHandshake(sockets[0].socket);
    const firstSubscribeRaw = sockets[0].socket.textSent[1];
    const firstSubscribe = parseText(firstSubscribeRaw);
    expect(firstSubscribe).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { epicId: "epic-42" },
    });

    // Slow-client eviction closes the socket without a fatalError frame; that
    // must stay recoverable so the next snapshot can catch the stream up.
    sockets[0].socket.fireClose(1000, "SLOW_CLIENT: queue overflowed", true);

    // Let the backoff timer fire to create the next socket.
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);

    // Complete the handshake on the second socket and assert the same
    // method + params are re-issued.
    completeHandshake(sockets[1].socket);
    const secondSubscribeRaw = sockets[1].socket.textSent[1];
    const secondSubscribe = parseText(secondSubscribeRaw);
    expect(secondSubscribe).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { epicId: "epic-42" },
    });

    session.close();
    vi.useRealTimers();
  });

  it("re-reads dynamic subscribe params after a physical reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
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
    let sinceCursor: {
      readonly ingestVersion: number;
      readonly eventId: string;
    } | null = null;
    const session = client.subscribeWithParamsProvider(
      "host.communicationGraph.subscribe",
      () => ({ epicId: "epic-42", sinceCursor }),
    );

    completeHandshake(sockets[0].socket);
    expect(parseText(sockets[0].socket.textSent[1])).toMatchObject({
      kind: "subscribe",
      method: "host.communicationGraph.subscribe",
      params: { epicId: "epic-42", sinceCursor: null },
    });

    // The consumer applies through C100 while this physical session remains
    // live. A socket loss must ask it for the current cursor rather than reuse
    // the null captured at the first subscribe.
    sinceCursor = { ingestVersion: 100, eventId: "event-100" };
    sockets[0].socket.fireClose(1006, "physical connection lost", false);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);

    completeHandshake(sockets[1].socket);
    expect(parseText(sockets[1].socket.textSent[1])).toMatchObject({
      kind: "subscribe",
      method: "host.communicationGraph.subscribe",
      params: {
        epicId: "epic-42",
        sinceCursor: { ingestVersion: 100, eventId: "event-100" },
      },
    });

    session.close();
    vi.useRealTimers();
  });

  it("emits availability recovery when a session re-opens after a drop, not on the initial clean open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const recovered = vi.fn();
    client.subscribeAvailabilityRecovered(recovered);

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    completeHandshake(sockets[0].socket);
    // The first clean connect is not recovery - nothing was stranded yet.
    expect(recovered).not.toHaveBeenCalled();

    // Recoverable drop → backoff → fresh dial → handshake completes: the host
    // just proved it is reachable again.
    sockets[0].socket.fireClose(1006, "connection-lost", false);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1].socket);
    expect(recovered).toHaveBeenCalledTimes(1);

    session.close();
    vi.useRealTimers();
  });

  it("emits availability recovery when a pong lands after a stall-length gap without any drop", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const recovered = vi.fn();
    client.subscribeAvailabilityRecovered(recovered);

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const socket = sockets[0].socket;
    completeHandshake(socket);

    // Healthy cadence: the pong answering the t=25s ping arrives one ping
    // interval after `lastPongAt` was seeded at openAck - below the
    // interval-plus-slack recovery threshold, so no emission.
    vi.advanceTimersByTime(25_000);
    socket.fireText({ kind: "pong", hasBinaryPayload: false });
    expect(recovered).not.toHaveBeenCalled();

    // Host event-loop stall: the t=50s ping goes unanswered until t=60s. The
    // 35s pong gap exceeds pingIntervalMs + 5s slack → recovery evidence,
    // while staying under the 50s missed-pong cutoff → the socket never
    // dropped and the reconnect-recovery path never ran.
    vi.advanceTimersByTime(25_000);
    vi.advanceTimersByTime(10_000);
    socket.fireText({ kind: "pong", hasBinaryPayload: false });
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(socket.closed).toBeNull();

    session.close();
    vi.useRealTimers();
  });

  it("requestReconnect drops the live socket and redials through existing backoff without disposing the session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
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

    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    session.onStatusChange((status) => {
      statuses.push(status);
    });
    completeHandshake(sockets[0].socket);
    expect(statuses).toContain("open");

    // Consumer asks the session-owned state machine to redial; it must not
    // create a second session and must not dial before the initial backoff.
    session.requestReconnect();
    expect(sockets[0].socket.closed).toEqual({
      code: 1000,
      reason: "reconnect-requested-by-consumer",
    });
    expect(statuses).toContain("reconnecting");
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(9);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    completeHandshake(sockets[1].socket);
    expect(parseText(sockets[1].socket.textSent[1])).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 3 },
      params: { epicId: "epic-42" },
    });
    expect(statuses.at(-1)).toBe("open");

    // Same session object stays live; close only when the consumer tears down.
    session.close();
    expect(statuses.at(-1)).toBe("closed");
    vi.useRealTimers();
  });

  it("requestReconnect preserves escalated reconnectAttempt instead of force-resetting like forceReconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
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
      maxBackoffMs: 10_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    completeHandshake(sockets[0].socket);

    // Ordinary drop schedules backoffFor(0)=10ms and leaves reconnectAttempt=1
    // on the subsequent dial. Leave the replacement mid-handshake so the
    // attempt counter is still elevated while a live socket exists.
    sockets[0].socket.fireClose(1006, "abnormal", false);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    sockets[1].socket.fireOpen();
    expect(sockets[1].socket.textSent).toHaveLength(1);

    // requestReconnect must schedule with the preserved attempt (backoffFor(1)
    // = 20ms), not reset counters the way forceReconnect does.
    session.requestReconnect();
    expect(sockets[1].socket.closed).toEqual({
      code: 1000,
      reason: "reconnect-requested-by-consumer",
    });
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(19);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    session.close();
    vi.useRealTimers();
  });

  it("requestReconnect is a no-op once the session is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
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

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    completeHandshake(sockets[0].socket);
    session.close();
    expect(sockets[0].socket.closed).toEqual({
      code: 1000,
      reason: "closed-by-caller",
    });

    session.requestReconnect();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(1);

    vi.useRealTimers();
  });

  it("escalates reconnect backoff across consecutive slow-client evictions", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
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
      maxBackoffMs: 10_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    completeHandshake(sockets[0].socket);

    // First SLOW_CLIENT eviction: streak -> 1, so the backoff is
    // backoffFor(1) = 20ms - `reconnectAttempt` no longer resets at the
    // subscribe-ack (it resets on a delivered frame or healthy dwell), but
    // max(attempt, streak) is driven by the streak here either way.
    sockets[0].socket.fireClose(1000, "SLOW_CLIENT: queue overflowed", true);
    vi.advanceTimersByTime(19);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1].socket);

    // Second consecutive SLOW_CLIENT eviction: streak -> 2, so the backoff
    // escalates to backoffFor(2) = 40ms - strictly larger than the first,
    // which is the whole point (a persistently slow renderer must not retry at
    // the fixed initial delay forever).
    sockets[1].socket.fireClose(1000, "SLOW_CLIENT: queue overflowed", true);
    vi.advanceTimersByTime(20);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(20);
    expect(sockets).toHaveLength(3);

    session.close();
    vi.useRealTimers();
  });

  it("escalates backoff for ordinary drops when no application frame arrives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
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
      maxBackoffMs: 10_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    completeHandshake(sockets[0].socket);

    // An abnormal close with no SLOW_CLIENT reason leaves the slow-client
    // streak at 0, but the reconnect attempt still escalates because the
    // subscribe-ack was not followed by an application frame.
    sockets[0].socket.fireClose(1006, "abnormal", false);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1].socket);

    sockets[1].socket.fireClose(1006, "abnormal", false);
    vi.advanceTimersByTime(19);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    session.close();
    vi.useRealTimers();
  });

  it("resets event-only backoff after a sustained healthy subscription dwell", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 10_000,
      openAckTimeoutMs: 10_000,
      pingIntervalMs: 60_000,
      pongTimeoutMs: 120_000,
      initialBackoffMs: 5,
      maxBackoffMs: 10_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    completeHandshake(sockets[0].socket);

    // No application frame arrives, but ten seconds of sustained subscription
    // is enough to reset the ordinary reconnect backoff to its 5ms floor.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    sockets[0].socket.fireClose(1006, "abnormal", false);
    await vi.advanceTimersByTimeAsync(4);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1].socket);

    // A second quiet connection that drops after only 5ms has not reached the
    // dwell gate, so its reconnect attempt escalates to 10ms.
    await vi.advanceTimersByTimeAsync(5);
    sockets[1].socket.fireClose(1006, "abnormal", false);
    await vi.advanceTimersByTimeAsync(9);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    session.close();
    vi.useRealTimers();
  });

  // Codex review, PR #978 thread PRRT_kwDOL6Tbrc6WdfpB: "Reset dwell based on
  // elapsed time, not only timer firing". A backgrounded renderer throttles
  // `setTimeout` (Chromium clamps hidden pages to >=1/min), and a quiet
  // event-only stream has no application frames to reset on - so the dwell
  // callback is the ONLY reset signal it has, and discarding it on the drop
  // leaves `reconnectAttempt` a lifetime drop counter again.
  it("settles the dwell on ELAPSED time when a throttled timer never fired", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 10_000,
      openAckTimeoutMs: 10_000,
      pingIntervalMs: 60_000,
      pongTimeoutMs: 120_000,
      initialBackoffMs: 5_000,
      maxBackoffMs: 20_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    completeHandshake(sockets[0].socket);

    // One ordinary drop, well inside the dwell, consumes attempt 0.
    sockets[0].socket.fireClose(1006, "abnormal", false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1].socket);

    // The renderer is backgrounded: wall clock moves 30s - three times the
    // dwell - while the throttled dwell timer has NOT run. `setSystemTime`
    // shifts pending timers with it, so the callback is still queued exactly
    // as it would be under throttling.
    vi.setSystemTime(Date.now() + 30_000);

    sockets[1].socket.fireClose(1006, "abnormal", false);

    // The connection was genuinely subscribed past the dwell, so its reset is
    // owed: the redial must come at the 5s floor. Without the elapsed-time
    // settle the discarded timer leaves attempt 1 standing and this waits
    // 10s - the lifetime-counter behavior the dwell exists to remove.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    session.close();
    vi.useRealTimers();
  });

  it("clears the healthy dwell timer when a quiet subscription drops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 10_000,
      openAckTimeoutMs: 10_000,
      pingIntervalMs: 60_000,
      pongTimeoutMs: 120_000,
      initialBackoffMs: 5_000,
      maxBackoffMs: 20_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    completeHandshake(sockets[0].socket);
    await vi.advanceTimersByTimeAsync(9_000);
    sockets[0].socket.fireClose(1006, "abnormal", false);

    // The first reconnect remains in backoff past the original 10s dwell
    // deadline. A stray dwell timer would reset reconnectAttempt here.
    await vi.advanceTimersByTimeAsync(1_001);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1].socket);

    sockets[1].socket.fireClose(1006, "abnormal", false);
    // The first drop consumed attempt 0, so this drop must use 10s rather than
    // falling back to the 5s floor if the cleared dwell timer had fired.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(3);

    session.close();
    vi.useRealTimers();
  });

  it("treats a socket error as a recoverable drop without waiting for close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
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

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    const statuses: StreamConnectionStatus[] = [];
    session.onStatusChange((status) => {
      statuses.push(status);
    });
    completeHandshake(sockets[0].socket);

    sockets[0].socket.fireError();

    expect(sockets[0].socket.closed).toEqual({
      code: 4005,
      reason: "socket-error",
    });
    expect(statuses).toContain("reconnecting");
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);

    session.close();
    vi.useRealTimers();
  });

  it("ignores stale socket errors after a replacement socket becomes active", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      pingIntervalMs: 60_000,
      pongTimeoutMs: 120_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    completeHandshake(sockets[0].socket);
    const staleOnError = sockets[0].socket.onerror;
    if (staleOnError === null) {
      throw new Error("Expected socket error handler to be installed");
    }

    sockets[0].socket.fireError();
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1].socket);

    staleOnError({ message: "late stale socket error" });

    expect(sockets[1].socket.closed).toBeNull();
    expect(sockets).toHaveLength(2);

    session.close();
    vi.useRealTimers();
  });

  it("treats heartbeat send failure as a recoverable drop without waiting for close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 10_000,
      openAckTimeoutMs: 10_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 120_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    completeHandshake(sockets[0].socket);

    sockets[0].socket.failNextSend = true;
    vi.advanceTimersByTime(25_000);

    expect(sockets[0].socket.closed).toEqual({
      code: 4005,
      reason: "send-failed",
    });
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);

    session.close();
    vi.useRealTimers();
  });

  it("treats application-frame send failure as a recoverable drop without waiting for heartbeat", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 10_000,
      openAckTimeoutMs: 10_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 120_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-42" });
    const statuses: StreamConnectionStatus[] = [];
    session.onStatusChange((status) => {
      statuses.push(status);
    });
    completeHandshake(sockets[0].socket);

    sockets[0].socket.failNextSend = true;
    session.sendClientFrame(
      { kind: "applyUpdate", hasBinaryPayload: true },
      new Uint8Array([1, 2, 3]),
    );

    expect(sockets[0].socket.closed).toEqual({
      code: 4005,
      reason: "send-failed",
    });
    expect(statuses).toContain("reconnecting");
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);

    session.close();
    vi.useRealTimers();
  });

  it("closing a stream client closes every owned session socket", async () => {
    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 10_000,
      openAckTimeoutMs: 10_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 120_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    client.subscribe("epic.subscribe", { epicId: "epic-1" });
    client.subscribe("chat.subscribe", { epicId: "epic-1", chatId: "chat-1" });
    completeHandshake(sockets[0].socket);
    completeHandshake(sockets[1].socket);

    const closedListenerCalls: number[] = [];
    const unsubscribeClosed = client.onClosed(() => {
      closedListenerCalls.push(1);
    });

    expect(client.isClosed()).toBe(false);
    expect(client.getClosedReason()).toBeNull();
    client.close("test-teardown");
    expect(client.isClosed()).toBe(true);
    expect(client.getClosedReason()).toBe("test-teardown");
    expect(closedListenerCalls).toHaveLength(1);
    // A second close is a no-op: the first reason wins, listeners fire once.
    client.close("second-close");
    expect(client.getClosedReason()).toBe("test-teardown");
    expect(closedListenerCalls).toHaveLength(1);
    unsubscribeClosed();

    expect(sockets[0].socket.closed).toEqual({
      code: 1000,
      reason: "closed-by-caller",
    });
    expect(sockets[1].socket.closed).toEqual({
      code: 1000,
      reason: "closed-by-caller",
    });
    // Defense-in-depth: a stale subscribe on a closed client degrades to an
    // inert session instead of throwing into the renderer error boundary. No
    // new socket is dialed, the returned session is safe to drive, and it
    // emits ONE terminal status (on a microtask) so the consumer learns its
    // subscription is dead instead of pending forever.
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const inert = client.subscribe("epic.subscribe", { epicId: "epic-2" });
    expect(sockets).toHaveLength(2);
    const inertStatuses: Array<{
      status: StreamConnectionStatus;
      reason: StreamCloseReason | null;
    }> = [];
    expect(() => {
      inert.onServerFrame(() => undefined);
      inert.onStatusChange((status, reason) => {
        inertStatuses.push({ status, reason });
      });
      inert.sendClientFrame({ kind: "noop", hasBinaryPayload: false }, null);
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("closedReason=test-teardown");
    warnSpy.mockRestore();

    await Promise.resolve();
    expect(inertStatuses).toHaveLength(1);
    expect(inertStatuses[0].status).toBe("closed");
    expect(inertStatuses[0].reason).toEqual({
      kind: "fatalError",
      details: {
        code: "CLIENT_CLOSED",
        reason: "stream client was already closed (test-teardown)",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    // Closing the inert session before the microtask suppresses the emission.
    const closeWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const closedFirst = client.subscribe("epic.subscribe", { epicId: "e3" });
    closeWarnSpy.mockRestore();
    const lateStatuses: StreamConnectionStatus[] = [];
    closedFirst.onStatusChange((status) => {
      lateStatuses.push(status);
    });
    closedFirst.close();
    await Promise.resolve();
    expect(lateStatuses).toHaveLength(0);
  });

  it("rewrites a directory entry's '/rpc' suffix to '/stream' on first dial", async () => {
    const { factory, sockets } = makeFactory();
    const entry: HostDirectoryEntry = {
      hostId: "rpc-entry",
      label: "Host advertising /rpc",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-test",
      transportDialability: "dialable",
    };
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => entry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
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

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("ws://127.0.0.1:4917/stream");

    session.close();
  });

  it("leaves a directory entry already advertising '/stream' unchanged on first dial", async () => {
    const { factory, sockets } = makeFactory();
    const entry: HostDirectoryEntry = {
      hostId: "stream-entry",
      label: "Host advertising /stream",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/stream",
      version: "0.0.0-test",
      transportDialability: "dialable",
    };
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => entry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
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

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("ws://127.0.0.1:4917/stream");

    session.close();
  });

  it("auto-answers a host-originated ping with pong and does not surface it to the server-frame handler", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 60_000,
      pongTimeoutMs: 120_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const received: StreamFrameEnvelope[] = [];
    session.onServerFrame((envelope) => {
      received.push(envelope);
    });
    await flush();

    const stub = sockets[0].socket;
    completeHandshake(stub);

    const emittedBeforePing = stub.textSent.length;
    stub.fireText({
      kind: "ping",
      hasBinaryPayload: false,
    });

    expect(received).toHaveLength(0);
    expect(stub.textSent.length).toBe(emittedBeforePing + 1);
    const pongFrame = parseText(stub.textSent[stub.textSent.length - 1]);
    expect(pongFrame).toEqual({
      kind: "pong",
      hasBinaryPayload: false,
    });

    session.close();
  });

  it("intercepts pong frames internally and does not forward them to the server-frame handler", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const received: StreamFrameEnvelope[] = [];
    session.onServerFrame((envelope) => {
      received.push(envelope);
    });
    await flush();
    completeHandshake(sockets[0].socket);

    sockets[0].socket.fireText({
      kind: "pong",
      hasBinaryPayload: false,
    });

    expect(received).toHaveLength(0);
    session.close();
  });
});

/**
 * Component-2 (unified stream auth): on an `UNAUTHORIZED` open-frame rejection
 * the session revalidates the credential and acts on the outcome - re-dial on a
 * fresh/valid credential, stay in backoff on a transient error, terminal on a
 * rejected credential, and a bounded no-progress loop also goes terminal.
 */
describe("WsStreamClient UNAUTHORIZED auth recovery", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const UNAUTHORIZED_FATAL = {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "bearer expired",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  } as const;
  const CHAT_INVALID_FATAL = {
    kind: "fatalError",
    details: {
      code: "CHAT_INVALID",
      reason: "Chat could not be read from persisted state",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  } as const;
  // A transient, host-side rejection (e.g. the host's JWKS fetch timed out): the
  // wire `code` stays `UNAUTHORIZED` for older clients, but `retryable: true`
  // tells a newer client the credential is fine and to just reconnect.
  const RETRYABLE_FATAL = {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "Signing key unavailable: request timed out",
      incompatibleMethods: null,
      upgradeGuidance: null,
      retryable: true,
    },
  } as const;
  const LEGACY_SUBSCRIBE_TIMEOUT_FATAL = {
    kind: "fatalError",
    details: {
      code: "STREAM_SUBSCRIBE_TIMEOUT",
      reason: "Timed out waiting for 'subscribe' frame after openAck (30000ms)",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  } as const;

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function makeAuthRevalidator(outcomes: readonly RevalidateOutcome[]): {
    readonly auth: StreamAuthRevalidator;
    readonly calls: { count: number };
  } {
    const calls = { count: 0 };
    const queue = [...outcomes];
    return {
      calls,
      auth: {
        revalidateForReconnect: async (): Promise<RevalidateOutcome> => {
          calls.count += 1;
          return queue.shift() ?? "network-error";
        },
      },
    };
  }

  // A revalidator whose promise the test resolves explicitly, so a concurrent
  // reconnect can be driven WHILE the revalidation is still pending.
  function makeDeferredRevalidator(): {
    readonly auth: StreamAuthRevalidator;
    readonly resolve: (outcome: RevalidateOutcome) => void;
    readonly calls: { count: number };
  } {
    const calls = { count: 0 };
    let resolveFn: (outcome: RevalidateOutcome) => void = () => undefined;
    return {
      calls,
      resolve: (outcome) => resolveFn(outcome),
      auth: {
        revalidateForReconnect: (): Promise<RevalidateOutcome> => {
          calls.count += 1;
          return new Promise<RevalidateOutcome>((res) => {
            resolveFn = res;
          });
        },
      },
    };
  }

  function makeAuthClient(
    factory: IStreamWebSocketFactory,
    auth: StreamAuthRevalidator,
    initialBackoffMs: number,
  ): WsStreamClient<typeof hostStreamRpcRegistry> {
    return new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      // A fixed bearer the host keeps rejecting (the test's revalidator never
      // actually rotates it), which is what lets the no-progress bound trip.
      bearer: () => makeRequestContext("expired").credentials,
      auth,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs,
      maxBackoffMs: 1_000,
    });
  }

  it("revalidates and re-dials on an UNAUTHORIZED open-frame rejection (rotated)", async () => {
    const { factory, sockets } = makeFactory();
    const revalidator = makeAuthRevalidator(["rotated"]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));

    await flush();
    expect(sockets).toHaveLength(1);
    sockets[0].socket.fireOpen();
    sockets[0].socket.fireText(UNAUTHORIZED_FATAL);

    // revalidate (microtask) + backoff (5ms) → re-dial.
    await wait(50);
    expect(revalidator.calls.count).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(statuses).not.toContain("closed");
    session.close();
  });

  it("stays in backoff and re-dials (no sign-out) on a transient revalidation error", async () => {
    const { factory, sockets } = makeFactory();
    const revalidator = makeAuthRevalidator(["network-error"]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));

    await flush();
    sockets[0].socket.fireOpen();
    sockets[0].socket.fireText(UNAUTHORIZED_FATAL);

    await wait(50);
    expect(revalidator.calls.count).toBe(1);
    // Transient → recoverable, never terminal.
    expect(statuses).not.toContain("closed");
    expect(sockets).toHaveLength(2);
    session.close();
  });

  it("treats a SYNCHRONOUSLY thrown revalidation as transient, not an unhandled rejection", async () => {
    // `revalidateForReconnect` is typed to RETURN a promise, but nothing stops
    // an implementation throwing before it returns one. Called bare, that throw
    // skips the `.catch` that maps a failed revalidation to "network-error" and
    // the `finally` that clears the budget timer, then escapes the
    // `void`-discarded recovery task: an unhandled rejection, and a session left
    // in backoff with no re-dial armed.
    const { factory, sockets } = makeFactory();
    const calls = { count: 0 };
    const auth: StreamAuthRevalidator = {
      revalidateForReconnect: (): Promise<RevalidateOutcome> => {
        calls.count += 1;
        throw new Error("revalidation threw before returning a promise");
      },
    };
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const client = makeAuthClient(factory, auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));

    try {
      await flush();
      sockets[0].socket.fireOpen();
      sockets[0].socket.fireText(UNAUTHORIZED_FATAL);

      await wait(50);
      expect(calls.count).toBe(1);
      // Degrades exactly like a rejected promise: transient → re-dial, never
      // terminal, and nothing escapes.
      expect(sockets).toHaveLength(2);
      expect(statuses).not.toContain("closed");
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      session.close();
    }
  });

  it("goes terminal on an UNAUTHORIZED rejection when revalidation is rejected", async () => {
    const { factory, sockets } = makeFactory();
    const revalidator = makeAuthRevalidator(["rejected"]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const closeReasons: Array<StreamCloseReason | null> = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status, reason) => {
      statuses.push(status);
      closeReasons.push(reason);
    });

    await flush();
    sockets[0].socket.fireOpen();
    sockets[0].socket.fireText(UNAUTHORIZED_FATAL);

    await wait(50);
    expect(revalidator.calls.count).toBe(1);
    expect(statuses).toContain("closed");
    // Rejected → no re-dial.
    expect(sockets).toHaveLength(1);
    const fatalClose = closeReasons.find((r) => r?.kind === "fatalError");
    expect(fatalClose).not.toBeUndefined();
    if (fatalClose?.kind === "fatalError") {
      expect(fatalClose.details.code).toBe("UNAUTHORIZED");
    }
  });

  it("does not revalidate stream-domain fatal errors", async () => {
    const { factory, sockets } = makeFactory();
    const revalidator = makeAuthRevalidator(["rotated"]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const closeReasons: Array<StreamCloseReason | null> = [];
    const session = client.subscribe("chat.subscribe", {
      epicId: "epic-1",
      chatId: "chat-1",
    });
    session.onStatusChange((status, reason) => {
      statuses.push(status);
      closeReasons.push(reason);
    });

    await flush();
    sockets[0].socket.fireOpen();
    sockets[0].socket.fireText(CHAT_INVALID_FATAL);

    await wait(50);
    expect(revalidator.calls.count).toBe(0);
    expect(statuses).toContain("closed");
    expect(sockets).toHaveLength(1);
    const fatalClose = closeReasons.find((r) => r?.kind === "fatalError");
    expect(fatalClose).not.toBeUndefined();
    if (fatalClose?.kind === "fatalError") {
      expect(fatalClose.details.code).toBe("CHAT_INVALID");
    }
    session.close();
  });

  it("treats a `retryable` transient rejection as a transport drop: reconnects, never revalidates, never gives up", async () => {
    const { factory, sockets } = makeFactory();
    // Even though authn would report the credential current ("rotated"), a
    // retryable host-side rejection must skip credential recovery entirely.
    const revalidator = makeAuthRevalidator([
      "rotated",
      "rotated",
      "rotated",
      "rotated",
      "rotated",
    ]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));

    await flush();
    // Drive MORE consecutive rejections than the no-progress bound (3): a
    // transient host-side rejection must never terminate the session.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const socket = sockets[sockets.length - 1].socket;
      socket.fireOpen();
      socket.fireText(RETRYABLE_FATAL);
      await wait(50);
    }

    // Credential recovery is never engaged for a host-side transient rejection.
    expect(revalidator.calls.count).toBe(0);
    // Recoverable throughout - reconnecting, never terminal.
    expect(statuses).toContain("reconnecting");
    expect(statuses).not.toContain("closed");
    // Reconnected well past the no-progress bound (3) that a misclassified
    // UNAUTHORIZED would have hit - proof the transient path never gives up.
    expect(sockets.length).toBeGreaterThan(4);
    session.close();
  });

  it("recovers an older host's subscribe timeout even when it omits `retryable`", async () => {
    const { factory, sockets } = makeFactory();
    const revalidator = makeAuthRevalidator(["rotated"]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));

    await flush();
    completeHandshake(sockets[0].socket);
    sockets[0].socket.fireText(LEGACY_SUBSCRIBE_TIMEOUT_FATAL);
    await wait(50);

    expect(revalidator.calls.count).toBe(0);
    expect(statuses).toContain("reconnecting");
    expect(statuses).not.toContain("closed");
    expect(sockets).toHaveLength(2);
    session.close();
  });

  it("proves the real host.notifications.feed.subscribe retry sequence: retryable snapshot failure skips auth recovery, redials, and accepts the replacement snapshot", async () => {
    const { factory, sockets } = makeFactory();
    const revalidator = makeAuthRevalidator(["rotated"]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const frames: StreamFrameEnvelope[] = [];
    const session = client.subscribe("host.notifications.feed.subscribe", {
      initialAttentionLimit: 50,
      initialRecentLimit: 50,
    });
    session.onServerFrame((envelope) => {
      frames.push(envelope);
    });

    await flush();
    expect(sockets).toHaveLength(1);
    // Complete the real open/openAck handshake so the client actually emits
    // `host.notifications.feed.subscribe` on socket 0 before the host rejects
    // the snapshot init - the failure must land on a real subscription
    // attempt, not a pre-subscribe open-only socket.
    completeHandshake(sockets[0].socket);
    expect(sockets[0].socket.textSent).toHaveLength(2);
    expect(parseText(sockets[0].socket.textSent[1])).toEqual({
      kind: "subscribe",
      method: "host.notifications.feed.subscribe",
      // `@1.1` is the newest installed minor of the feed (the arm carrying
      // `host.operation.finished`); the mirrored handshake negotiates it.
      schemaVersion: { major: 1, minor: 1 },
      params: {
        initialAttentionLimit: 50,
        initialRecentLimit: 50,
      },
    });
    // Mirrors `HostNotificationsStreamResolver`'s real termination when its
    // initial snapshot read fails: the wire code is host-domain
    // (`NOTIFICATIONS_SNAPSHOT_UNAVAILABLE`), not `UNAUTHORIZED`, and
    // `retryable: true` routes the client through the plain transport-drop
    // path rather than credential recovery.
    sockets[0].socket.fireText({
      kind: "fatalError",
      details: {
        code: "NOTIFICATIONS_SNAPSHOT_UNAVAILABLE",
        reason: "Failed to initialize host notifications stream for user=u1",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      },
    });
    await wait(50);

    expect(revalidator.calls.count).toBe(0);
    expect(sockets).toHaveLength(2);

    // The redial completes a real handshake and re-issues the same subscribe
    // declaration before the host lands a fresh atomic notification snapshot.
    completeHandshake(sockets[1].socket);
    expect(sockets[1].socket.textSent).toHaveLength(2);
    expect(parseText(sockets[1].socket.textSent[1])).toEqual({
      kind: "subscribe",
      method: "host.notifications.feed.subscribe",
      // `@1.1` is the newest installed minor of the feed (the arm carrying
      // `host.operation.finished`); the mirrored handshake negotiates it.
      schemaVersion: { major: 1, minor: 1 },
      params: {
        initialAttentionLimit: 50,
        initialRecentLimit: 50,
      },
    });
    const attentionEntry: HostNotificationEntry = {
      id: "notif-attention",
      updatedAt: 90,
      readAt: null,
      sourceRef: "notif-attention",
      severity: "needs_action",
      epicId: "epic-1",
      chatId: "chat-2",
      kind: "interview.requested",
      outcome: null,
      resolvedAt: null,
      payload: {},
    };
    const recentEntry: HostNotificationEntry = {
      id: "notif-recent",
      updatedAt: 100,
      readAt: null,
      sourceRef: "notif-recent",
      severity: "done",
      epicId: "epic-1",
      chatId: "chat-1",
      kind: "agent.stopped",
      outcome: "completed",
      payload: { outcome: "completed" },
    };
    const summary: HostNotificationsSummary = {
      unreadCount: 2,
      attentionCount: 1,
    };
    const attentionCursor = {
      kind: "attention" as const,
      tier: "blocking" as const,
      updatedAt: 90,
      id: "notif-attention",
    };
    const recentCursor = {
      kind: "chronological" as const,
      updatedAt: 100,
      id: "notif-recent",
    };
    sockets[1].socket.fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      attention: { entries: [attentionEntry], nextCursor: attentionCursor },
      recent: { entries: [recentEntry], nextCursor: recentCursor },
      summary,
    });

    expect(frames).toHaveLength(1);
    const decoded = hostNotificationsSubscribeServerFrameSchema.parse(
      frames[0],
    );
    expect(decoded).toEqual({
      kind: "snapshot",
      hasBinaryPayload: false,
      attention: { entries: [attentionEntry], nextCursor: attentionCursor },
      recent: { entries: [recentEntry], nextCursor: recentCursor },
      summary,
    });

    session.close();
  });

  it("clears the no-progress streak on a retryable interlude so a later genuine UNAUTHORIZED still gets the full bound", async () => {
    const { factory, sockets } = makeFactory();
    // Every revalidation reports the same never-rotated bearer ("rotated"),
    // the no-progress case. Enough entries for a 2-cycle then a 3-cycle episode;
    // the retryable interlude between them never revalidates.
    const revalidator = makeAuthRevalidator([
      "rotated",
      "rotated",
      "rotated",
      "rotated",
      "rotated",
    ]);
    // Tiny initial backoff: this episode drives ~5 reconnects and the shared
    // `reconnectAttempt` escalates the delay each time, so keep it well under
    // the per-cycle wait so every reconnected socket is live before the next.
    const client = makeAuthClient(factory, revalidator.auth, 1);
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));

    // Both fixtures are `as const`, so their `details.reason` (and the
    // retryable variant's extra `retryable` flag) are literal types: this
    // helper drives BOTH, and typing it as only the UNAUTHORIZED shape rejects
    // the transient interlude the test is specifically about.
    const driveFatal = async (
      frame: typeof UNAUTHORIZED_FATAL | typeof RETRYABLE_FATAL,
    ) => {
      const socket = sockets[sockets.length - 1].socket;
      socket.fireOpen();
      socket.fireText(frame);
      await wait(50);
    };

    await flush();
    // Two genuine UNAUTHORIZED cycles: streak climbs to 2 (both re-dial).
    await driveFatal(UNAUTHORIZED_FATAL);
    await driveFatal(UNAUTHORIZED_FATAL);
    expect(statuses).not.toContain("closed");

    // A transient interlude clears the streak back to 0 (and re-dials).
    await driveFatal(RETRYABLE_FATAL);

    // With the streak cleared, the next two genuine cycles are 1 and 2 - still
    // recoverable. WITHOUT the reset the first of these would hit 3 and go
    // terminal here; this is the regression guard for the reset.
    await driveFatal(UNAUTHORIZED_FATAL);
    await driveFatal(UNAUTHORIZED_FATAL);
    expect(statuses).not.toContain("closed");

    // The third post-interlude cycle reaches the bound (3) and goes terminal.
    await driveFatal(UNAUTHORIZED_FATAL);
    expect(statuses).toContain("closed");
    // 2 pre + 3 post revalidations; the retryable interlude never revalidates.
    expect(revalidator.calls.count).toBe(5);
    session.close();
  });

  it("bounds a no-progress UNAUTHORIZED loop and goes terminal", async () => {
    const { factory, sockets } = makeFactory();
    // Authn keeps reporting the credential current ("rotated") yet the host
    // keeps rejecting the same (never-rotated) bearer - the skew/config case.
    const revalidator = makeAuthRevalidator([
      "rotated",
      "rotated",
      "rotated",
      "rotated",
    ]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));

    await flush();
    // Drive consecutive UNAUTHORIZED open-frame rejections. Each revalidates,
    // returns "rotated" with the SAME (never-rotated) bearer, so the streak
    // grows; the 3rd cycle reaches the cap (3) and goes terminal. (The 4th
    // iteration runs against the already-torn-down socket and no-ops.)
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const socket = sockets[sockets.length - 1].socket;
      socket.fireOpen();
      socket.fireText(UNAUTHORIZED_FATAL);
      await wait(50);
    }

    expect(statuses).toContain("closed");
    // 3 cycles each revalidate; the 3rd increments the streak to the cap and
    // goes terminal without re-dialing.
    expect(revalidator.calls.count).toBe(3);
    // Initial dial + 2 redials (after cycles 1 and 2); the terminal 3rd cycle
    // does not re-dial.
    expect(sockets).toHaveLength(3);
  });

  it("bounds post-subscribe UNAUTHORIZED failures when no application frame arrives", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const revalidator = makeAuthRevalidator([
      "rotated",
      "rotated",
      "rotated",
      "rotated",
    ]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));
    const startedAt = Date.now();

    // Each host cycle completes the open/openAck/subscribe handshake and then
    // fails resolver initialization with UNAUTHORIZED before delivering any
    // application frame. The subscribe-ack alone must not clear the streak.
    completeHandshake(sockets[0].socket);
    sockets[0].socket.fireText(UNAUTHORIZED_FATAL);
    await vi.advanceTimersByTimeAsync(5);
    expect(sockets).toHaveLength(2);

    completeHandshake(sockets[1].socket);
    sockets[1].socket.fireText(UNAUTHORIZED_FATAL);
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(3);

    completeHandshake(sockets[2].socket);
    sockets[2].socket.fireText(UNAUTHORIZED_FATAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses).toContain("closed");
    // The three ack-then-fatal laps complete well before the 10s healthy dwell,
    // so the dwell must not defeat the no-progress terminal bound.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(revalidator.calls.count).toBe(3);
    expect(sockets).toHaveLength(3);
    session.close();
  });

  it("resets the no-progress streak only after a snapshot", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const revalidator = makeAuthRevalidator([
      "rotated",
      "rotated",
      "rotated",
      "rotated",
      "rotated",
    ]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const frames: StreamFrameEnvelope[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));
    session.onServerFrame((envelope) => frames.push(envelope));

    // Build a two-cycle no-progress streak without delivering a snapshot,
    // frames, then prove a snapshot clears it before the next auth episode.
    completeHandshake(sockets[0].socket);
    sockets[0].socket.fireText(UNAUTHORIZED_FATAL);
    await vi.advanceTimersByTimeAsync(5);
    completeHandshake(sockets[1].socket);
    sockets[1].socket.fireText(UNAUTHORIZED_FATAL);
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(3);

    completeHandshake(sockets[2].socket);
    sockets[2].socket.fireText({
      kind: "snapshot",
      epicId: "e1",
      meta: {
        schemaVersion: "2.0.0",
        epicLight: null,
        permissionRole: "editor",
        repos: [],
        workspaces: [],
        repoMapping: [],
        workspaceFolders: [],
        unresolvedRepos: [],
      },
      hasBinaryPayload: true,
    });
    sockets[2].socket.fireBinary(new Uint8Array());
    expect(frames).toHaveLength(1);

    // Start the later UNAUTHORIZED episode on a fresh socket. If the
    // snapshot did not reset the streak, this first rejection would
    // reach the bound immediately instead of reconnecting.
    sockets[2].socket.fireClose(1006, "abnormal", false);
    await vi.advanceTimersByTimeAsync(5);
    expect(sockets).toHaveLength(4);

    completeHandshake(sockets[3].socket);
    sockets[3].socket.fireText(UNAUTHORIZED_FATAL);
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(5);
    expect(statuses).not.toContain("closed");

    completeHandshake(sockets[4].socket);
    sockets[4].socket.fireText(UNAUTHORIZED_FATAL);
    await vi.advanceTimersByTimeAsync(20);
    expect(sockets).toHaveLength(6);
    expect(statuses).not.toContain("closed");

    completeHandshake(sockets[5].socket);
    sockets[5].socket.fireText(UNAUTHORIZED_FATAL);
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses).toContain("closed");
    expect(revalidator.calls.count).toBe(5);
    session.close();
  });

  it("recovers a handshake-time UNAUTHORIZED after a real bearer rotation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const ctx = makeRequestContext("expired");
    const calls = { count: 0 };
    const auth: StreamAuthRevalidator = {
      revalidateForReconnect: async (): Promise<RevalidateOutcome> => {
        calls.count += 1;
        ctx.credentials.rotateBearerToken({
          userId: ctx.identity.userId,
          bearerToken: "fresh",
        });
        return "rotated";
      },
    };
    const client = new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => ctx.credentials,
      auth,
      hostCredentialMint: null,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: factory,
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 5,
      maxBackoffMs: 1_000,
    });
    const statuses: StreamConnectionStatus[] = [];
    const frames: StreamFrameEnvelope[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));
    session.onServerFrame((envelope) => frames.push(envelope));

    sockets[0].socket.fireOpen();
    sockets[0].socket.fireText(UNAUTHORIZED_FATAL);
    await vi.advanceTimersByTimeAsync(5);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1].socket);
    expect(parseText(sockets[1].socket.textSent[0]).token).toBe("fresh");

    sockets[1].socket.fireText({
      kind: "permissionChanged",
      epicId: "e1",
      permissionRole: "editor",
      hasBinaryPayload: false,
    });
    expect(calls.count).toBe(1);
    expect(frames).toHaveLength(1);
    expect(statuses).toContain("open");
    expect(statuses).not.toContain("closed");

    // The delivered frame also clears reconnectAttempt: a later ordinary drop
    // returns to the configured floor rather than inheriting handshake delay.
    sockets[1].socket.fireClose(1006, "abnormal", false);
    await vi.advanceTimersByTimeAsync(4);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    session.close();
  });

  it("does NOT count transient network-errors toward the no-progress bound (a wake-network blip stays recoverable)", async () => {
    const { factory, sockets } = makeFactory();
    // Authn is briefly unreachable on wake: every revalidation is a transient
    // network-error. This must NEVER terminate the session - it keeps
    // re-dialing on backoff until connectivity returns. (The pre-fix code
    // wrongly incremented the no-progress streak here and went terminal after
    // 3, the exact overnight-wake failure.)
    const revalidator = makeAuthRevalidator([
      "network-error",
      "network-error",
      "network-error",
      "network-error",
    ]);
    const client = makeAuthClient(factory, revalidator.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));

    await flush();
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const socket = sockets[sockets.length - 1].socket;
      socket.fireOpen();
      socket.fireText(UNAUTHORIZED_FATAL);
      await wait(80);
    }

    // 4 transient cycles (> the cap of 3) and still NOT terminal.
    expect(statuses).not.toContain("closed");
    expect(revalidator.calls.count).toBe(4);
    // Each cycle re-dialed: initial + 4 redials.
    expect(sockets.length).toBeGreaterThanOrEqual(5);
    session.close();
  });

  it("wake probe KEEPS a session whose socket still answers a ping", async () => {
    // The overnight-sleep incident in miniature: a lid-open fires a wake while
    // the localhost socket to a local host is perfectly alive. Dropping it
    // re-runs every stream's open against a machine whose network has not
    // finished coming back - which is what turned the RECOVERY signal into the
    // damage. A session that answers must be left alone.
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      // Far outside the 5s probe window, so the heartbeat cannot re-dial and
      // confuse what this test is measuring.
      pingIntervalMs: 120_000,
      pongTimeoutMs: 600_000,
      initialBackoffMs: 5,
      maxBackoffMs: 50,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    await flush();
    completeHandshake(sockets[0].socket);
    await flush();
    expect(sockets).toHaveLength(1);

    // Fake timers only for the probe window; the handshake above needs real
    // ones (this describe block runs on real timers).
    vi.useFakeTimers();
    try {
      client.reconnectAll("wake-resume", { probeFirst: true });
      // The probe is a real ping on the wire...
      const pinged = sockets[0].socket.textSent.some((raw) =>
        raw.includes('"kind":"ping"'),
      );
      expect(pinged).toBe(true);
      // ...answered before the probe deadline.
      sockets[0].socket.fireText({ kind: "pong", hasBinaryPayload: false });
      await vi.advanceTimersByTimeAsync(6_000);

      // No re-dial, and the original socket was never closed.
      expect(sockets).toHaveLength(1);
      expect(sockets[0].socket.closed).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    session.close();
  });

  it("wake probe RE-DIALS a session whose socket has gone silent", async () => {
    // The other half, and the reason the timeout IS the mechanism: a half-open
    // socket after sleep fails only by not answering. Without this arm the
    // probe would be a way to never reconnect anything.
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      pingIntervalMs: 120_000,
      pongTimeoutMs: 600_000,
      initialBackoffMs: 5,
      maxBackoffMs: 50,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    await flush();
    completeHandshake(sockets[0].socket);
    await flush();
    expect(sockets).toHaveLength(1);

    vi.useFakeTimers();
    try {
      client.reconnectAll("wake-resume", { probeFirst: true });
      // A probe really went out, so the re-dial below is the TIMEOUT path and
      // not the "nothing live to probe" shortcut.
      expect(
        sockets[0].socket.textSent.some((raw) => raw.includes('"kind":"ping"')),
      ).toBe(true);
      // No pong: the socket is half-open. Cross the probe deadline.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(50);

      expect(sockets.length).toBeGreaterThanOrEqual(2);
      expect(sockets[0].socket.closed).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
    session.close();
  });

  it("does not orphan a healthy socket when a stale revalidation resolves after a concurrent wake reconnect", async () => {
    const { factory, sockets } = makeFactory();
    const deferred = makeDeferredRevalidator();
    const client = makeAuthClient(factory, deferred.auth, 5);
    const statuses: StreamConnectionStatus[] = [];
    const session = client.subscribe("epic.subscribe", { epicId: "e1" });
    session.onStatusChange((status) => statuses.push(status));

    await flush();
    expect(sockets).toHaveLength(1);

    // UNAUTHORIZED on socket 0 → revalidation starts and HANGS on the deferred.
    sockets[0].socket.fireOpen();
    sockets[0].socket.fireText(UNAUTHORIZED_FATAL);
    await flush();
    expect(deferred.calls.count).toBe(1);

    // A concurrent wake re-dials and FULLY reconnects socket 1 while the
    // revalidation is still pending.
    client.reconnectAll("wake-resume", { probeFirst: false });
    await wait(30);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const socket1 = sockets[1].socket;
    completeHandshake(socket1);
    expect(statuses).toContain("open");
    const socketCountAfterReconnect = sockets.length;

    // The stale revalidation now resolves "rotated" → it must NOT dial a second
    // socket over the live one (the connect() single-dial guard), and socket 1
    // must stay live.
    deferred.resolve("rotated");
    await wait(30);
    expect(sockets.length).toBe(socketCountAfterReconnect);
    expect(statuses).not.toContain("closed");
    expect(socket1.closed).toBeNull();
    session.close();
  });
});

/**
 * Phase-2 delegated host credentials: the client mints a device credential for
 * a connected host that reports it has none, then hands it over the `/stream`
 * socket. Pins capability gating, UUID preflight, one-attempt-per-host, per-host
 * pending delivery (adoption tuple on the wire), expiry via server expiresIn,
 * never-cross-host, and close teardown.
 */
describe("WsStreamClient host credential provisioning", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const CAP_PROVISION = "hostCredentialProvision";
  // Server requires UUID hostIds; fixtures like "mock-local" never enter the mint.
  const HOST_A: HostDirectoryEntry = {
    hostId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    label: "Host A",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:4917/rpc",
    version: "0.0.0-mock",
    transportDialability: "dialable",
  };
  const HOST_B: HostDirectoryEntry = {
    hostId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    label: "Host B",
    kind: "remote",
    websocketUrl: "wss://mock-remote.traycer.invalid/rpc",
    version: "0.0.0-mock",
    transportDialability: "dialable",
  };

  type Provisioned = Extract<
    HostCredentialMintOutcome,
    { readonly kind: "provisioned" }
  >;

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function provisioned(
    overrides: Partial<Provisioned> &
      Pick<Provisioned, "token" | "refreshToken">,
  ): Provisioned {
    return {
      kind: "provisioned",
      familyId: "family-host-1",
      provisionedAt: "2026-07-08T12:00:00.123Z",
      expiresIn: 900,
      ...overrides,
    };
  }

  function provisionFrames(socket: StubStreamWebSocket): Array<{
    readonly kind: string;
    readonly token: string;
    readonly refreshToken: string;
    readonly familyId: string;
    readonly provisionedAt: string;
  }> {
    return socket.textSent
      .map((raw) => parseText(raw))
      .filter((frame) => frame.kind === "hostCredentialProvision")
      .map((frame) => ({
        kind: String(frame.kind),
        token: String(frame.token),
        refreshToken: String(frame.refreshToken),
        familyId: String(frame.familyId),
        provisionedAt: String(frame.provisionedAt),
      }));
  }

  function allProvisionFrames(sockets: readonly RecordedSocket[]): Array<{
    readonly token: string;
    readonly familyId: string;
  }> {
    return sockets.flatMap((entry) =>
      provisionFrames(entry.socket).map((frame) => ({
        token: frame.token,
        familyId: frame.familyId,
      })),
    );
  }

  function pendingMap(
    client: WsStreamClient<typeof hostStreamRpcRegistry>,
  ): Map<string, unknown> {
    // Private transport state: needed for expiry/close/two-host assertions.
    const value = Reflect.get(client, "pendingProvisions");
    if (!(value instanceof Map)) {
      throw new Error("expected pendingProvisions Map");
    }
    return value;
  }

  function makeProvisioningClient(options: {
    readonly factory: IStreamWebSocketFactory;
    readonly mint: HostCredentialMintFlow | null;
    readonly endpoint: () => HostDirectoryEntry | null;
    readonly authToken: string | undefined;
  }): WsStreamClient<typeof hostStreamRpcRegistry> {
    const token = options.authToken ?? "token-abc";
    const ctx = makeRequestContext(token);
    return new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: options.endpoint,
      bearer: () => ctx.credentials,
      auth: null,
      hostCredentialMint: options.mint,
      onHostCredentialState: null,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: options.factory,
      dialTimeoutMs: 1000,
      openAckTimeoutMs: 1000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  /**
   * Same wiring as `makeProvisioningClient`, plus a caller-supplied
   * `onHostCredentialState` observer - the tap the client fires on every ack
   * that carries a state, ahead of (and independent from) the mint machinery
   * above.
   */
  function makeProvisioningClientWithObserver(options: {
    readonly factory: IStreamWebSocketFactory;
    readonly mint: HostCredentialMintFlow | null;
    readonly endpoint: () => HostDirectoryEntry | null;
    readonly authToken: string | undefined;
    readonly onState: (hostId: string, state: HostCredentialState) => void;
  }): WsStreamClient<typeof hostStreamRpcRegistry> {
    const token = options.authToken ?? "token-abc";
    const ctx = makeRequestContext(token);
    return new WsStreamClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry: hostStreamRpcRegistry,
      endpoint: options.endpoint,
      bearer: () => ctx.credentials,
      auth: null,
      hostCredentialMint: options.mint,
      onHostCredentialState: options.onState,
      evidence: NO_TRANSPORT_EVIDENCE,
      webSocketFactory: options.factory,
      dialTimeoutMs: 1000,
      openAckTimeoutMs: 1000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
  }

  function completeProvisionHandshake(
    socket: StubStreamWebSocket,
    state: "missing" | "active" | "needs-reauth" | null | "omit",
  ): void {
    socket.fireOpen();
    const openRaw = socket.textSent[0];
    const openParsed = JSON.parse(openRaw) as {
      readonly manifest: Record<string, { major: number; minor: number }>;
    };
    if (state === "omit") {
      socket.fireText(streamOpenAck(openParsed.manifest, undefined));
      return;
    }
    if (state === null) {
      socket.fireText({
        ...streamOpenAck(openParsed.manifest, [CAP_PROVISION]),
        hostCredentialState: null,
      });
      return;
    }
    socket.fireText({
      ...streamOpenAck(openParsed.manifest, [CAP_PROVISION]),
      hostCredentialState: state,
    });
  }

  it("does not mint when hostCredentialMint is null (opt-out)", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint: null,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();
    expect(allProvisionFrames(sockets)).toHaveLength(0);
    session.close();
  });

  it("does not mint when an older host omits the capability and state (still parses)", async () => {
    const mint = vi.fn(async () => ({ kind: "unavailable" as const }));
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    completeProvisionHandshake(sockets[0].socket, "omit");
    await flush();
    expect(mint).not.toHaveBeenCalled();
    expect(allProvisionFrames(sockets)).toHaveLength(0);
    session.close();
  });

  it("does not mint when hostCredentialState is null even if capability is advertised", async () => {
    const mint = vi.fn(async () => ({ kind: "unavailable" as const }));
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    completeProvisionHandshake(sockets[0].socket, null);
    await flush();
    expect(mint).not.toHaveBeenCalled();
    session.close();
  });

  it("does not mint when hostCredentialState is active", async () => {
    const mint = vi.fn(async () =>
      provisioned({ token: "should-not", refreshToken: "should-not" }),
    );
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    completeProvisionHandshake(sockets[0].socket, "active");
    await flush();
    expect(mint).not.toHaveBeenCalled();
    expect(allProvisionFrames(sockets)).toHaveLength(0);
    session.close();
  });

  it("skips mint when hostId is not a UUID (marks attempted, no OTP)", async () => {
    const mint = vi.fn(async () => ({ kind: "unavailable" as const }));
    const { factory, sockets } = makeFactory();
    // mockLocalHostEntry.hostId is "mock-local" — not a UUID.
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => mockLocalHostEntry,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();
    expect(mint).not.toHaveBeenCalled();

    // Attempt marker set: further reconnects still never mint.
    sockets[0].socket.fireClose(1000, "drop", false);
    await wait(30);
    completeProvisionHandshake(sockets[sockets.length - 1].socket, "missing");
    await flush();
    expect(mint).not.toHaveBeenCalled();
    session.close();
  });

  it("mints once and pushes hostCredentialProvision carrying the adoption tuple verbatim", async () => {
    const outcome = provisioned({
      token: "host-access-jws",
      refreshToken: "refresh-jwe-1",
      familyId: "family-adopt-1",
      provisionedAt: "2026-07-08T15:30:00.456Z",
      expiresIn: 900,
    });
    const mint = vi.fn(async () => outcome);
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();

    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith({
      hostId: HOST_A.hostId,
      reason: "missing",
    });
    const frames = provisionFrames(sockets[0].socket);
    expect(frames).toHaveLength(1);
    // Phase 3 adoption depends on these fields surviving the client boundary.
    expect(frames[0]).toEqual({
      kind: "hostCredentialProvision",
      token: outcome.token,
      refreshToken: outcome.refreshToken,
      familyId: outcome.familyId,
      provisionedAt: outcome.provisionedAt,
    });
    session.close();
  });

  it("never sends a hostCredentialProvision frame when mint returns unavailable (409 path)", async () => {
    const mint = vi.fn(async () => ({ kind: "unavailable" as const }));
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(allProvisionFrames(sockets)).toHaveLength(0);
    session.close();
  });

  it("attempts the mint flow exactly once per hostId across many reconnects reporting missing", async () => {
    const mint = vi.fn(async () => ({ kind: "unavailable" as const }));
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 4; i += 1) {
      sockets[sockets.length - 1].socket.fireClose(1000, "drop", false);
      await wait(30);
      const latest = sockets[sockets.length - 1].socket;
      completeProvisionHandshake(latest, "missing");
      await flush();
    }

    expect(mint).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("re-arms after a SUCCESSFUL handoff, so a later burn can mint again", async () => {
    // T1. There is no ack that says "adopted": the host confirms only on its
    // NEXT `openAck`, and the socket that carried the credential has already
    // seen `needs-reauth`. So after a successful delivery `lastHostCredentialState`
    // still read `needs-reauth`, and when the replacement was later burned the
    // next ack was `needs-reauth` again - no transition, marker still set, and
    // the replacement mint suppressed until the client was recreated.
    //
    // Recording the handoff as `active` (assumed-adopted; the host confirms or
    // corrects on its next ack) is what makes that later burn a transition.
    const mint = vi.fn(async () =>
      provisioned({
        token: "tok-handoff",
        refreshToken: "refresh-handoff",
        familyId: "family-handoff",
        provisionedAt: "2026-07-08T16:00:00.000Z",
      }),
    );
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    completeProvisionHandshake(sockets[0].socket, "needs-reauth");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);
    // Delivered on this very socket.
    expect(allProvisionFrames(sockets)).toHaveLength(1);

    // The replacement is later burned; the host asks again on the SAME socket's
    // next ack. Without the handoff being recorded this reads as unchanged.
    sockets[sockets.length - 1].socket.fireClose(1000, "drop", false);
    await wait(30);
    completeProvisionHandshake(
      sockets[sockets.length - 1].socket,
      "needs-reauth",
    );
    await flush();

    expect(mint).toHaveBeenCalledTimes(2);
    session.close();
  });

  it("retries after the wait a pending-elsewhere answer asks for, with no new ack", async () => {
    // T2. Giving the marker back is not enough on its own: nothing re-asks
    // until another `openAck` arrives, and the claim TTL is only evaluated when
    // the flow is next called. A host whose only surviving transport asked
    // during the window therefore sat un-provisioned with nobody scheduled to
    // look again.
    const mint = vi
      .fn<HostCredentialMintFlow>()
      .mockResolvedValueOnce({ kind: "pending-elsewhere", retryAfterMs: 0 })
      .mockResolvedValue({ kind: "unavailable" });
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    completeProvisionHandshake(sockets[0].socket, "needs-reauth");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    // No new ack, no state transition - only the timer. A zero-length wait is
    // floored to `PROVISION_RETRY_MIN_DELAY_MS` (+ jitter), which is exactly
    // what stops a just-expired claim spinning, so wait past that.
    await wait(1_600);
    expect(mint).toHaveBeenCalledTimes(2);
    session.close();
  });

  it("does not retry a pending-elsewhere wait on a closed client", async () => {
    // The negative direction, and the one that matters: a timer that outlives
    // the transport would mint a credential with nothing left to deliver it on.
    const mint = vi
      .fn<HostCredentialMintFlow>()
      .mockResolvedValue({ kind: "pending-elsewhere", retryAfterMs: 0 });
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    completeProvisionHandshake(sockets[0].socket, "needs-reauth");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    client.close("test");
    await wait(1_600);

    expect(mint).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("does not consume the client's one attempt on a pending-elsewhere answer", async () => {
    // The liveness half of the app-wide claim. Another transport's credential
    // is already in flight, so this client has not actually attempted
    // anything - and if that delivery never lands and this client is the only
    // one left, it must still be able to ask. Answering `unavailable` here
    // spent the client's single attempt and could strand the host on the
    // client lease until the app restarted.
    const mint = vi
      .fn(async () => ({
        kind: "pending-elsewhere" as const,
        retryAfterMs: 60_000,
      }))
      .mockName("mint");
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    completeProvisionHandshake(sockets[0].socket, "needs-reauth");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    // Same state on the next ack - no transition, so the re-arm edge does NOT
    // fire. Only giving the marker back can let this ask again.
    sockets[sockets.length - 1].socket.fireClose(1000, "drop", false);
    await wait(30);
    completeProvisionHandshake(
      sockets[sockets.length - 1].socket,
      "needs-reauth",
    );
    await flush();

    expect(mint).toHaveBeenCalledTimes(2);
    session.close();
  });

  it("a stale active ack does not eat an armed provision retry", async () => {
    // Regression: `armProvisionRetry`'s timer used to re-read
    // `lastHostCredentialState` at fire time and bail unless it was still
    // `missing`/`needs-reauth`. One `WsStreamClient` owns several sessions
    // and `handleHostCredentialAck` runs per `openAck` with no cross-session
    // ordering, so an `active` ack FORMED BEFORE the burn that armed this
    // retry can be PROCESSED AFTER it - the arm sits behind a mint network
    // round trip, so an ack racing across it is ordinary, not exotic. The
    // old timer read that stale `active`, bailed, and never rescheduled -
    // leaving the host unprovisioned with no further `openAck` left to wake
    // it while its socket stayed up.
    const mint = vi
      .fn<HostCredentialMintFlow>()
      .mockResolvedValueOnce({ kind: "pending-elsewhere", retryAfterMs: 0 })
      .mockResolvedValue({ kind: "unavailable" });
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    completeProvisionHandshake(sockets[0].socket, "needs-reauth");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    // The pre-burn ack arrives late, on a reconnect of the very session that
    // armed the retry - the same mechanics a sibling session's stale
    // handshake would produce, minus the second socket. Nothing was handed
    // off, so this must not be read as recovery.
    sockets[sockets.length - 1].socket.fireClose(1000, "drop", false);
    await wait(30);
    completeProvisionHandshake(sockets[sockets.length - 1].socket, "active");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    // Past the floor + jitter ceiling (1_000 + 250) with margin - the retry
    // must fire regardless of the stale `active` sitting in
    // `lastHostCredentialState`.
    await wait(1_600);
    expect(mint).toHaveBeenCalledTimes(2);

    session.close();
  });

  it("this client's own successful handoff does cancel an armed retry", async () => {
    // The one thing allowed to cancel the timer - see
    // `WsStreamClient.armProvisionRetry`'s doc comment. A delivery this
    // client performed has provenance an `active` report does not, so unlike
    // the regression above it IS correct for this to be read as recovery.
    //
    // The setup below is deliberately roundabout so that `handedOffHostIds`
    // is the ONLY thing standing between the armed retry and a third mint
    // call. If call B's credential were instead delivered straight off the
    // ack that minted it (the simpler shape), `provisionAttemptedHostIds`
    // would still be set from that same ack - since only a `pending-
    // elsewhere` outcome or a re-arm transition ever gives it back - and
    // would ALSO block a third call, hiding a regression in the
    // `handedOffHostIds` check specifically. Routing the handoff through a
    // credential that was already pending when a re-arm transition (the
    // "burn" below) delivered it keeps the marker clear: that transition's
    // own top-of-function flush runs and returns before the attempt-marker
    // code could set it again.
    const deferredB: { resolve: ((outcome: Provisioned) => void) | null } = {
      resolve: null,
    };
    const mint = vi
      .fn<HostCredentialMintFlow>()
      .mockResolvedValueOnce({ kind: "pending-elsewhere", retryAfterMs: 0 })
      .mockImplementationOnce(
        () =>
          new Promise<Provisioned>((resolve) => {
            deferredB.resolve = resolve;
          }),
      )
      .mockResolvedValue({ kind: "unavailable" });
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    // Call A: arms the retry and gives the attempt marker back.
    completeProvisionHandshake(sockets[0].socket, "needs-reauth");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    // Call B: same state, no transition - only the marker being clear lets
    // this ask again. Left deferred so it can resolve with nothing
    // subscribed to receive it.
    sockets[0].socket.fireClose(1000, "drop", false);
    await wait(30);
    completeProvisionHandshake(
      sockets[sockets.length - 1].socket,
      "needs-reauth",
    );
    await flush();
    expect(mint).toHaveBeenCalledTimes(2);

    sockets[sockets.length - 1].socket.fireClose(1000, "drop-again", false);
    await wait(30);
    const resolveB = deferredB.resolve;
    if (resolveB === null) {
      throw new Error("mint call B was never started");
    }
    resolveB(
      provisioned({
        token: "tok-cancels-retry",
        refreshToken: "refresh-cancels-retry",
        familyId: "family-cancels-retry",
        provisionedAt: "2026-07-08T17:00:00.000Z",
      }),
    );
    await flush();
    // Nothing is subscribed yet, so call B's credential sits pending rather
    // than being delivered here.
    expect(pendingMap(client).has(HOST_A.hostId)).toBe(true);

    // The burn: a transition ack. It clears the (already-clear) attempt
    // marker and `handedOffHostIds`, then its own top-of-function flush
    // delivers call B's pending credential before the attempt gate can run
    // again - so the handoff lands with the marker still clear.
    completeProvisionHandshake(sockets[sockets.length - 1].socket, "missing");
    await flush();
    expect(mint).toHaveBeenCalledTimes(2);
    expect(provisionFrames(sockets[sockets.length - 1].socket)).toHaveLength(1);

    // Past the floor + jitter ceiling: call A's retry - armed long before any
    // of this and untouched by it - must not fire a third mint now that this
    // client has actually delivered.
    await wait(1_600);
    expect(mint).toHaveBeenCalledTimes(2);

    session.close();
  });

  it("a later missing/needs-reauth ack clears the handoff record so an armed retry can still fire", async () => {
    // The re-arm edge in `handleHostCredentialAck` clears BOTH
    // `provisionAttemptedHostIds` and `handedOffHostIds`. If only the former
    // were cleared, a host that had a credential handed to it, burned it,
    // and got a NEW retry armed for that burn would find the retry silently
    // swallowed by a handoff record left over from the credential it already
    // burned - the timer's `handedOffHostIds` check cannot tell "still holds
    // it" from "held it once, and burned it since" unless this edge clears
    // the record.
    const outcome = provisioned({
      token: "tok-first-handoff",
      refreshToken: "refresh-first-handoff",
      familyId: "family-first-handoff",
      provisionedAt: "2026-07-08T18:00:00.000Z",
    });
    const mint = vi
      .fn<HostCredentialMintFlow>()
      .mockResolvedValueOnce(outcome)
      .mockResolvedValueOnce({ kind: "pending-elsewhere", retryAfterMs: 0 })
      .mockResolvedValue({ kind: "unavailable" });
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    // Call 1: a clean handoff on the very socket that asked.
    completeProvisionHandshake(sockets[0].socket, "needs-reauth");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(provisionFrames(sockets[0].socket)).toHaveLength(1);

    // Call 2: the delivered credential is burned; the host asks again. This
    // transition must clear the stale handoff record left by call 1, or the
    // retry it arms below would be swallowed by a fact about a DIFFERENT
    // credential.
    sockets[0].socket.fireClose(1000, "drop", false);
    await wait(30);
    completeProvisionHandshake(
      sockets[sockets.length - 1].socket,
      "needs-reauth",
    );
    await flush();
    expect(mint).toHaveBeenCalledTimes(2);

    // Past the floor + jitter ceiling: the retry call 2 armed must still
    // fire a third mint.
    await wait(1_600);
    expect(mint).toHaveBeenCalledTimes(3);

    session.close();
  });

  it("carries the reason that armed the retry, not whatever lastHostCredentialState reads at fire time", async () => {
    // `reason` is passed into `armProvisionRetry` and closed over by its
    // timer rather than re-read from `lastHostCredentialState` at fire time,
    // because the map can - and, per the regression above, does - hold
    // something else by then. Arm with `missing`, then let a stale `active`
    // land (same mechanics as the regression test), and check the request
    // the timer eventually fires: it must still say `missing`, which a
    // re-read could not even express - `active` is excluded from the mint
    // request's `reason` type.
    const mint = vi
      .fn<HostCredentialMintFlow>()
      .mockResolvedValueOnce({ kind: "pending-elsewhere", retryAfterMs: 0 })
      .mockResolvedValue({ kind: "unavailable" });
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenNthCalledWith(1, {
      hostId: HOST_A.hostId,
      reason: "missing",
    });

    sockets[sockets.length - 1].socket.fireClose(1000, "drop", false);
    await wait(30);
    completeProvisionHandshake(sockets[sockets.length - 1].socket, "active");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    await wait(1_600);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(mint).toHaveBeenNthCalledWith(2, {
      hostId: HOST_A.hostId,
      reason: "missing",
    });

    session.close();
  });

  it("re-arms the mint when a host that went active comes back needs-reauth", async () => {
    // The once-per-host bound was written for a host that reports `missing`
    // and keeps reporting it: repeating the attempt could only repeat the same
    // failure, and an unbounded policy turns a reconnect loop into a stream of
    // mints. A host that has since HELD a credential and burned it is not that
    // host - it burned it precisely so a client would mint another - and
    // refusing on the strength of an attempt that already succeeded would
    // leave it on the client lease until the app is restarted.
    const mint = vi.fn(async () => ({ kind: "unavailable" as const }));
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    const reconnectReporting = async (
      state: "missing" | "active" | "needs-reauth",
    ): Promise<void> => {
      const before = sockets.length;
      sockets[sockets.length - 1].socket.fireClose(1000, "drop", false);
      // WAIT FOR THE SOCKET, not for a fixed delay. The re-dial backs off, so
      // by the fourth drop a flat 30ms expires before the new socket exists -
      // and the handshake below would then be completed on the CLOSED one,
      // delivering no ack at all. A case that asserts a mint count is
      // UNCHANGED passes vacuously when that happens, which is how the
      // reconnect that never landed went unnoticed.
      for (let i = 0; i < 100 && sockets.length === before; i += 1) {
        await wait(10);
      }
      expect(sockets.length).toBeGreaterThan(before);
      completeProvisionHandshake(sockets[sockets.length - 1].socket, state);
      await flush();
    };

    // The host adopts something (from another client, or an earlier session):
    // no ask, so no mint.
    await reconnectReporting("active");
    expect(mint).toHaveBeenCalledTimes(1);

    // ...and the cloud then refuses it in a way refreshing cannot repair.
    await reconnectReporting("needs-reauth");
    expect(mint).toHaveBeenCalledTimes(2);

    // The bound still holds where it was meant to: a host that keeps saying
    // the same thing is asked once, however long the reconnect loop runs.
    await reconnectReporting("needs-reauth");
    await reconnectReporting("needs-reauth");
    expect(mint).toHaveBeenCalledTimes(2);

    // The re-arm is a VALUE CHANGE, not a return to `active`. A burned
    // credential the host then deletes reports `missing`, and that host is
    // asking for one just as plainly as the `needs-reauth` before it - so a
    // rule that only re-armed via `active` would strand exactly the host that
    // cleaned up after itself.
    await reconnectReporting("missing");
    expect(mint).toHaveBeenCalledTimes(3);

    session.close();
  });

  it("holds a pending credential across a reconnect and delivers it exactly once", async () => {
    const deferred: { resolve: ((outcome: Provisioned) => void) | null } = {
      resolve: null,
    };
    const mint = vi.fn(
      () =>
        new Promise<Provisioned>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();

    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    sockets[0].socket.fireClose(1000, "user-still-typing-otp", false);
    await wait(30);

    const outcome = provisioned({
      token: "tok-pending",
      refreshToken: "refresh-pending",
      familyId: "family-pending",
      provisionedAt: "2026-07-08T16:00:00.000Z",
    });
    const resolvePending = deferred.resolve;
    if (resolvePending === null) {
      throw new Error("mint was never started");
    }
    resolvePending(outcome);
    await flush();

    expect(allProvisionFrames(sockets)).toHaveLength(0);
    expect(pendingMap(client).has(HOST_A.hostId)).toBe(true);

    const next = sockets[sockets.length - 1].socket;
    completeProvisionHandshake(next, "missing");
    await flush();

    expect(provisionFrames(next)).toHaveLength(1);
    expect(provisionFrames(next)[0]).toEqual({
      kind: "hostCredentialProvision",
      token: outcome.token,
      refreshToken: outcome.refreshToken,
      familyId: outcome.familyId,
      provisionedAt: outcome.provisionedAt,
    });
    expect(pendingMap(client).size).toBe(0);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(allProvisionFrames(sockets)).toHaveLength(1);

    session.close();
  });

  it("never delivers a credential minted for host A to host B", async () => {
    const deferred: { resolve: ((outcome: Provisioned) => void) | null } = {
      resolve: null,
    };
    const mint = vi.fn(
      () =>
        new Promise<Provisioned>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    let currentEntry: HostDirectoryEntry = HOST_A;
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => currentEntry,
      authToken: undefined,
    });

    const sessionA = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    await flush();
    const localSocketIndex = sockets.length - 1;
    completeProvisionHandshake(sockets[localSocketIndex].socket, "missing");
    await flush();
    expect(mint).toHaveBeenCalledWith({
      hostId: HOST_A.hostId,
      reason: "missing",
    });

    sockets[localSocketIndex].socket.fireClose(1000, "switch-host", false);
    await wait(20);
    sessionA.close();

    currentEntry = HOST_B;
    const sessionB = client.subscribe("epic.subscribe", { epicId: "epic-b" });
    await flush();
    const remoteSocket = sockets[sockets.length - 1].socket;
    completeProvisionHandshake(remoteSocket, "active");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);

    const resolvePending = deferred.resolve;
    if (resolvePending === null) {
      throw new Error("mint was never started");
    }
    resolvePending(
      provisioned({
        token: "tok-a",
        refreshToken: "refresh-for-a",
        familyId: "family-a",
      }),
    );
    await flush();

    expect(provisionFrames(remoteSocket)).toHaveLength(0);
    expect(allProvisionFrames(sockets)).toHaveLength(0);
    expect(pendingMap(client).has(HOST_A.hostId)).toBe(true);
    expect(pendingMap(client).has(HOST_B.hostId)).toBe(false);

    sessionB.close();
  });

  it("keeps pending credentials for two hosts without overwriting either", async () => {
    // Regression: a single-slot pending field would drop host A's credential
    // when host B's mint resolved.
    const deferredA: { resolve: ((outcome: Provisioned) => void) | null } = {
      resolve: null,
    };
    const deferredB: { resolve: ((outcome: Provisioned) => void) | null } = {
      resolve: null,
    };
    const mint = vi.fn(async (request: { hostId: string }) => {
      if (request.hostId === HOST_A.hostId) {
        return await new Promise<Provisioned>((resolve) => {
          deferredA.resolve = resolve;
        });
      }
      return await new Promise<Provisioned>((resolve) => {
        deferredB.resolve = resolve;
      });
    });

    let currentEntry: HostDirectoryEntry = HOST_A;
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => currentEntry,
      authToken: undefined,
    });

    const sessionA = client.subscribe("epic.subscribe", { epicId: "epic-a" });
    await flush();
    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();
    // Dispose A so it cannot redial; mint for A is already in flight.
    sessionA.close();

    currentEntry = HOST_B;
    const sessionB = client.subscribe("epic.subscribe", { epicId: "epic-b" });
    await flush();
    const socketB = sockets[sockets.length - 1].socket;
    completeProvisionHandshake(socketB, "missing");
    await flush();
    expect(mint).toHaveBeenCalledTimes(2);
    // Dispose B before mints resolve so both credentials stay pending.
    sessionB.close();

    const resolveA = deferredA.resolve;
    const resolveB = deferredB.resolve;
    if (resolveA === null || resolveB === null) {
      throw new Error("both mints must have started");
    }
    resolveA(
      provisioned({
        token: "tok-a",
        refreshToken: "ref-a",
        familyId: "family-a",
        provisionedAt: "2026-07-08T10:00:00.000Z",
      }),
    );
    resolveB(
      provisioned({
        token: "tok-b",
        refreshToken: "ref-b",
        familyId: "family-b",
        provisionedAt: "2026-07-08T11:00:00.000Z",
      }),
    );
    await flush();

    const pending = pendingMap(client);
    expect(pending.has(HOST_A.hostId)).toBe(true);
    expect(pending.has(HOST_B.hostId)).toBe(true);
    expect(pending.size).toBe(2);
    expect(allProvisionFrames(sockets)).toHaveLength(0);

    client.close("two-host-teardown");
    expect(pendingMap(client).size).toBe(0);
  });

  it("discards a pending credential when expiresIn elapses and does not re-mint", async () => {
    const deferred: { resolve: ((outcome: Provisioned) => void) | null } = {
      resolve: null,
    };
    const mint = vi.fn(
      () =>
        new Promise<Provisioned>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();

    sockets[0].socket.fireClose(1000, "otp-slow", false);
    await wait(30);

    const resolveExpired = deferred.resolve;
    if (resolveExpired === null) {
      throw new Error("mint was never started");
    }
    // Server-stated lifetime drives the hold timer (not JWS exp). expiresIn:0
    // schedules an immediate setTimeout(0) discard.
    resolveExpired(
      provisioned({
        token: "tok-exp",
        refreshToken: "refresh-expired",
        expiresIn: 0,
      }),
    );
    await flush();
    await wait(10);
    expect(pendingMap(client).size).toBe(0);
    expect(allProvisionFrames(sockets)).toHaveLength(0);

    // Next reconnect still missing: attempt marker stays set → no second OTP.
    const next = sockets[sockets.length - 1].socket;
    completeProvisionHandshake(next, "missing");
    await flush();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(allProvisionFrames(sockets)).toHaveLength(0);

    session.close();
  });

  it("drops all pending credentials on close()", async () => {
    const deferred: { resolve: ((outcome: Provisioned) => void) | null } = {
      resolve: null,
    };
    const mint = vi.fn(
      () =>
        new Promise<Provisioned>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const { factory, sockets } = makeFactory();
    const client = makeProvisioningClient({
      factory,
      mint,
      endpoint: () => HOST_A,
      authToken: undefined,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    completeProvisionHandshake(sockets[0].socket, "missing");
    await flush();

    sockets[0].socket.fireClose(1000, "gone", false);
    await wait(20);

    const resolvePending = deferred.resolve;
    if (resolvePending === null) {
      throw new Error("mint was never started");
    }
    resolvePending(
      provisioned({
        token: "tok-drop",
        refreshToken: "refresh-will-drop",
      }),
    );
    await flush();
    expect(pendingMap(client).size).toBe(1);

    client.close("test-teardown");
    expect(pendingMap(client).size).toBe(0);
    expect(allProvisionFrames(sockets)).toHaveLength(0);
    void session;
  });

  describe("onHostCredentialState observer", () => {
    it("fires with the host's active state, ahead of the mint machinery, which ignores active", async () => {
      const mint = vi.fn(async () => ({ kind: "unavailable" as const }));
      const observed: Array<{ hostId: string; state: HostCredentialState }> =
        [];
      const { factory, sockets } = makeFactory();
      const client = makeProvisioningClientWithObserver({
        factory,
        mint,
        endpoint: () => HOST_A,
        authToken: undefined,
        onState: (hostId, state) => {
          observed.push({ hostId, state });
        },
      });
      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      await flush();
      completeProvisionHandshake(sockets[0].socket, "active");
      await flush();

      expect(observed).toEqual([{ hostId: HOST_A.hostId, state: "active" }]);
      expect(mint).not.toHaveBeenCalled();
      session.close();
    });

    it("fires even when the subscribed method's version is INCOMPATIBLE", async () => {
      // The credential state is a HANDSHAKE fact, not a per-method one. It
      // used to be reported only after the compatibility gate, so a host that
      // advertised the capability but disagreed with this build about one
      // method's version looked indistinguishable from an unreachable host -
      // and the CLI's install probe reported it as such and could not
      // provision it.
      const mint = vi.fn(async () => ({ kind: "unavailable" as const }));
      const observed: Array<{ hostId: string; state: HostCredentialState }> =
        [];
      const { factory, sockets } = makeFactory();
      const client = makeProvisioningClientWithObserver({
        factory,
        mint,
        endpoint: () => HOST_A,
        authToken: undefined,
        onState: (hostId, state) => {
          observed.push({ hostId, state });
        },
      });
      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      await flush();

      const socket = sockets[0].socket;
      socket.fireOpen();
      const openParsed = JSON.parse(socket.textSent[0]) as {
        readonly manifest: Record<string, { major: number; minor: number }>;
      };
      // Same ack, but the host claims a major this build cannot speak.
      const theirManifest = {
        ...openParsed.manifest,
        "epic.subscribe": {
          major: openParsed.manifest["epic.subscribe"].major + 1,
          minor: 0,
        },
      };
      socket.fireText({
        ...streamOpenAck(theirManifest, [CAP_PROVISION]),
        hostCredentialState: "missing",
      });
      await flush();

      expect(observed).toEqual([{ hostId: HOST_A.hostId, state: "missing" }]);
      session.close();
    });

    it("fires before the mint flow is invoked for a non-active state", async () => {
      const order: string[] = [];
      const mint = vi.fn(async () => {
        order.push("mint-invoked");
        return { kind: "unavailable" as const };
      });
      const { factory, sockets } = makeFactory();
      const client = makeProvisioningClientWithObserver({
        factory,
        mint,
        endpoint: () => HOST_A,
        authToken: undefined,
        onState: () => {
          order.push("observer-fired");
        },
      });
      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      await flush();
      completeProvisionHandshake(sockets[0].socket, "missing");
      await flush();

      expect(order).toEqual(["observer-fired", "mint-invoked"]);
      expect(mint).toHaveBeenCalledTimes(1);
      session.close();
    });

    it("does not stop the mint flow from running when the observer throws", async () => {
      const outcome = provisioned({
        token: "host-access-jws-throw",
        refreshToken: "refresh-jwe-throw",
      });
      const mint = vi.fn(async () => outcome);
      const { factory, sockets } = makeFactory();
      const client = makeProvisioningClientWithObserver({
        factory,
        mint,
        endpoint: () => HOST_A,
        authToken: undefined,
        onState: () => {
          throw new Error("observer boom");
        },
      });
      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      await flush();
      completeProvisionHandshake(sockets[0].socket, "missing");
      await flush();

      expect(mint).toHaveBeenCalledTimes(1);
      const frames = provisionFrames(sockets[0].socket);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual({
        kind: "hostCredentialProvision",
        token: outcome.token,
        refreshToken: outcome.refreshToken,
        familyId: outcome.familyId,
        provisionedAt: outcome.provisionedAt,
      });
      session.close();
    });

    it("is not called when the ack carries no hostCredentialState, or the capability is absent", async () => {
      const mint = vi.fn(async () => ({ kind: "unavailable" as const }));
      const observed: Array<{ hostId: string; state: HostCredentialState }> =
        [];
      const { factory, sockets } = makeFactory();
      const client = makeProvisioningClientWithObserver({
        factory,
        mint,
        endpoint: () => HOST_A,
        authToken: undefined,
        onState: (hostId, state) => {
          observed.push({ hostId, state });
        },
      });
      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      await flush();
      // Older host: no `hostCredentialProvision` capability advertised at all.
      completeProvisionHandshake(sockets[0].socket, "omit");
      await flush();
      expect(observed).toHaveLength(0);
      expect(mint).not.toHaveBeenCalled();

      // Capability advertised, but the host reports no state yet.
      sockets[0].socket.fireClose(1000, "drop", false);
      await wait(30);
      const next = sockets[sockets.length - 1].socket;
      completeProvisionHandshake(next, null);
      await flush();

      expect(observed).toHaveLength(0);
      expect(mint).not.toHaveBeenCalled();
      session.close();
    });
  });
});

describe("WsStreamClient readiness", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function readinessClient(): {
    readonly client: WsStreamClient<typeof hostStreamRpcRegistry>;
    readonly sockets: { url: string; socket: StubStreamWebSocket }[];
  } {
    const { factory, sockets } = makeFactory();
    return {
      client: makeClient({
        factory,
        authToken: "token-abc",
        pingIntervalMs: 25_000,
        pongTimeoutMs: 50_000,
        initialBackoffMs: 10,
        maxBackoffMs: 1_000,
      }),
      sockets,
    };
  }

  it("reports ready while it owns no sessions at all", () => {
    const { client } = readinessClient();

    // Vacuously ready ON PURPOSE. This client is not one connection - it owns
    // N independent per-method sockets - so "ready" can only mean "nothing I
    // own is down". A client that has not subscribed to anything is not
    // evidence of an outage, and answering `false` here would make every
    // client flip to not-ready the moment its last stream is legitimately
    // unsubscribed. Do not "fix" this to false-when-empty.
    expect(client.isReady()).toBe(true);

    client.close("test-teardown");
  });

  it("is not ready while an owned session is still dialing, and is once it opens", async () => {
    const { client, sockets } = readinessClient();
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });

    await flush();
    // The socket exists but has not opened: this session is `connecting`, so
    // the client owns something that is not carrying traffic.
    expect(client.isReady()).toBe(false);

    const stub = sockets[0].socket;
    stub.fireOpen();
    stub.fireText(
      streamOpenAck(buildStreamManifest(hostStreamRpcRegistry), undefined),
    );

    expect(client.isReady()).toBe(true);

    session.close();
    client.close("test-teardown");
  });

  it("is not ready once an owned session loses its socket", async () => {
    const { client, sockets } = readinessClient();
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });

    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();
    stub.fireText(
      streamOpenAck(buildStreamManifest(hostStreamRpcRegistry), undefined),
    );
    expect(client.isReady()).toBe(true);

    // The drop puts the session into its reconnect loop. The client still
    // owns it, and it is not carrying traffic.
    stub.fireClose(1006, "abnormal-closure", false);

    expect(client.isReady()).toBe(false);

    session.close();
    client.close("test-teardown");
  });

  it("is never ready once closed", () => {
    const { client } = readinessClient();

    client.close("test-teardown");

    expect(client.isReady()).toBe(false);
  });
});

describe("WsStreamClient wake probe vs the stale heartbeat deadline", () => {
  // Fake timers are installed BEFORE the client exists: the heartbeat interval
  // is armed at subscribe time, and an interval created under real timers is
  // never advanced by `advanceTimersByTime` - a test that installs them later
  // passes whether or not the bug is present.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function settleHandshake(
    sockets: ReadonlyArray<{ socket: StubStreamWebSocket }>,
  ) {
    await vi.advanceTimersByTimeAsync(0);
    const stub = sockets[0].socket;
    stub.fireOpen();
    stub.fireText(
      streamOpenAck(buildStreamManifest(hostStreamRpcRegistry), undefined),
    );
    await vi.advanceTimersByTimeAsync(0);
    return stub;
  }

  // The wake probe exists to KEEP a socket that survived a lid-open. But the
  // heartbeat interval is still armed across the sleep holding a PRE-sleep
  // `lastPongAt`, so its next tick took the `missed-pongs` branch and tore the
  // socket down before the probe could be answered - the stale deadline
  // pre-empting the detector meant to decide, and re-running every stream's
  // open on a machine whose Wi-Fi is still re-associating.
  it("does not let the pre-sleep pong deadline tear down a socket the probe is still testing", async () => {
    const { factory, sockets } = makeFactory();
    // The heartbeat must be able to TICK inside the 5s wake-probe window, or
    // the race this pins cannot occur at all.
    const client = makeClient({
      factory,
      authToken: "token-abc",
      pingIntervalMs: 1_000,
      pongTimeoutMs: 2_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const stub = await settleHandshake(sockets);

    // Sleep: the wall clock jumps far past `pongTimeoutMs` while no timer got
    // to run, which is exactly what a suspended machine does.
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);

    const sentBeforeProbe = stub.textSent.length;
    client.reconnectAll("wake-resume", { probeFirst: true });
    // The probe really went out on the SAME socket.
    expect(stub.textSent.length).toBe(sentBeforeProbe + 1);
    expect(parseText(stub.textSent[sentBeforeProbe]).kind).toBe("ping");
    expect(stub.closed).toBeNull();

    // The heartbeat's next tick lands while the probe is still outstanding. It
    // must not fire `missed-pongs` on the strength of the pre-sleep timestamp.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stub.closed).toBeNull();
    expect(sockets).toHaveLength(1);

    session.close();
  });

  // The other direction: rebasing the deadline must not make a genuinely dead
  // socket immortal - the probe timeout still has to condemn it, and for its
  // own reason rather than the heartbeat's.
  it("still force-reconnects when the probe goes unanswered", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const stub = await settleHandshake(sockets);

    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
    client.reconnectAll("wake-resume", { probeFirst: true });
    expect(stub.closed).toBeNull();

    // No pong arrives; the 5s wake-probe timeout is the detector.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stub.closed?.reason).toBe("wake-resume-probe-timeout");

    session.close();
  });

  // Keeping the socket must not also swallow the recovery signal. Rebasing
  // `lastPongAt` at probe time makes the probe's own pong read as a round
  // trip, and since a successful probe deliberately AVOIDS the reconnect, the
  // handshake-time recovery emission never runs either - the wake that
  // bridged a sleep-length gap fired neither signal, and host RPC queries
  // stranded in error state before the sleep (whose other automatic recovery
  // routes are disabled) stayed stranded until a manual refresh.
  it("still emits availability recovery when the wake probe's pong bridges a sleep-length gap", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      pingIntervalMs: 1_000,
      pongTimeoutMs: 2_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const recovered = vi.fn();
    client.subscribeAvailabilityRecovered(recovered);
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const stub = await settleHandshake(sockets);
    expect(recovered).not.toHaveBeenCalled();

    // Sleep: the wall clock jumps far past every threshold with no timer run.
    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
    client.reconnectAll("wake-resume", { probeFirst: true });

    // The probe's pong: the socket survived (kept, no reconnect) AND the gap
    // it answers is the whole sleep - that positive edge is the only recovery
    // signal this path has.
    stub.fireText({ kind: "pong", hasBinaryPayload: false });
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(stub.closed).toBeNull();

    // The baseline was consumed: the next healthy-cadence pong is measured
    // against the rebased timestamp and must NOT double-fire.
    await vi.advanceTimersByTimeAsync(1_000);
    stub.fireText({ kind: "pong", hasBinaryPayload: false });
    expect(recovered).toHaveBeenCalledTimes(1);

    session.close();
  });

  // A probe is only ever sent on a device-wake / network-online signal - an
  // epoch in which host-scoped queries may have failed while the socket
  // survived. When that cycle is SHORTER than the heartbeat threshold
  // (pingIntervalMs + slack), the gap check reads the probe's pong as a round
  // trip and fires nothing - and with `refetchOnReconnect` disabled on the
  // query client, the errored queries have no other automatic route back. A
  // successful probe is a recovery edge in its own right, independent of the
  // stall threshold.
  it("emits availability recovery for a successful wake probe even when the outage was shorter than the heartbeat threshold", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      pingIntervalMs: 1_000,
      pongTimeoutMs: 2_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    const recovered = vi.fn();
    client.subscribeAvailabilityRecovered(recovered);
    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    const stub = await settleHandshake(sockets);
    expect(recovered).not.toHaveBeenCalled();

    // A brief offline/resume cycle: well under pingIntervalMs (1s) + the 5s
    // recovery slack, so the gap-based arm can never fire for it.
    vi.setSystemTime(Date.now() + 2_000);
    client.reconnectAll("wake-resume", { probeFirst: true });

    stub.fireText({ kind: "pong", hasBinaryPayload: false });
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(stub.closed).toBeNull();

    // Healthy-cadence pongs after the probe settled stay silent.
    await vi.advanceTimersByTimeAsync(1_000);
    stub.fireText({ kind: "pong", hasBinaryPayload: false });
    expect(recovered).toHaveBeenCalledTimes(1);

    session.close();
  });
});
