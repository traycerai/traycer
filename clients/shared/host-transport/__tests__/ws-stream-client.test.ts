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
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type { HostDirectoryEntry } from "../../host-client/host-directory";
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
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx?.credentials ?? null,
    auth: null,
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
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx.credentials,
    auth: null,
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

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Drives the handshake portion of the state machine forward: fires open,
 * parses the emitted `open` envelope into the manifest, then fires an
 * `openAck` that echoes that manifest so the mirror compatibility check
 * passes. Returns after the `subscribe` frame has been emitted.
 */
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

    stub.fireText({
      kind: "openAck",
      manifest: buildStreamManifest(hostStreamRpcRegistry),
    });

    expect(stub.textSent).toHaveLength(2);
    const subscribeFrame = parseText(stub.textSent[1]);
    expect(subscribeFrame).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 0 },
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
    stub.fireText({ kind: "openAck", manifest: skewedManifest });

    expect(stub.textSent).toHaveLength(2);
    expect(parseText(stub.textSent[1])).toEqual({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 0 },
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
    stub.fireText({ kind: "openAck", manifest: hostV100Manifest });

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
      registry: versionSkewRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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

    stub.fireText({
      kind: "openAck",
      manifest: { "version-skew.subscribe": { major: 1, minor: 0 } },
    });

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

  it("pushes a credentialUpdate frame on bearer rotation when the host advertises support", async () => {
    const { factory, sockets } = makeFactory();
    const { client, ctx } = makeRotatableClient(factory, "token-1");

    const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();
    stub.fireText({
      kind: "openAck",
      manifest: buildStreamManifest(hostStreamRpcRegistry),
      capabilities: ["credentialUpdate"],
    });
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
    stub.fireText({
      kind: "openAck",
      manifest: buildStreamManifest(hostStreamRpcRegistry),
    });
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
    stub.fireText({
      kind: "openAck",
      manifest: buildStreamManifest(hostStreamRpcRegistry),
      capabilities: ["credentialUpdate"],
    });

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

  it("closes the socket after two missed pongs and triggers a reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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
      schemaVersion: { major: 1, minor: 0 },
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
      schemaVersion: { major: 1, minor: 0 },
      params: { epicId: "epic-42" },
    });

    session.close();
    vi.useRealTimers();
  });

  it("escalates reconnect backoff across consecutive slow-client evictions", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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
    // backoffFor(1) = 20ms even though the successful subscribe reset
    // `reconnectAttempt` to 0.
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

  it("does not escalate backoff for an ordinary (non-slow-client) transport drop", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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

    // An abnormal close with no SLOW_CLIENT reason leaves the streak at 0, so
    // the backoff stays at the initial 10ms across repeated ordinary drops.
    sockets[0].socket.fireClose(1006, "abnormal", false);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    completeHandshake(sockets[1].socket);

    sockets[1].socket.fireClose(1006, "abnormal", false);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(3);

    session.close();
    vi.useRealTimers();
  });

  it("treats a socket error as a recoverable drop without waiting for close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    const { factory, sockets } = makeFactory();
    const client = new WsStreamClient({
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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

    expect(client.isClosed()).toBe(false);
    client.close();
    expect(client.isClosed()).toBe(true);

    expect(sockets[0].socket.closed).toEqual({
      code: 1000,
      reason: "closed-by-caller",
    });
    expect(sockets[1].socket.closed).toEqual({
      code: 1000,
      reason: "closed-by-caller",
    });
    // Defense-in-depth: a stale subscribe on a closed client degrades to an
    // inert no-op session instead of throwing into the renderer error boundary.
    // No new socket is dialed, and the returned session is safe to drive.
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const inert = client.subscribe("epic.subscribe", { epicId: "epic-2" });
    expect(sockets).toHaveLength(2);
    expect(() => {
      inert.onServerFrame(() => undefined);
      inert.onStatusChange(() => undefined);
      inert.sendClientFrame({ kind: "noop", hasBinaryPayload: false }, null);
      inert.close();
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("rewrites a directory entry's '/rpc' suffix to '/stream' on first dial", async () => {
    const { factory, sockets } = makeFactory();
    const entry: HostDirectoryEntry = {
      hostId: "rpc-entry",
      label: "Host advertising /rpc",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-test",
      status: "available",
    };
    const client = new WsStreamClient({
      registry: hostStreamRpcRegistry,
      endpoint: () => entry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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
      status: "available",
    };
    const client = new WsStreamClient({
      registry: hostStreamRpcRegistry,
      endpoint: () => entry,
      bearer: () => makeRequestContext("t")?.credentials ?? null,
      auth: null,
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
      registry: hostStreamRpcRegistry,
      endpoint: () => mockLocalHostEntry,
      // A fixed bearer the host keeps rejecting (the test's revalidator never
      // actually rotates it), which is what lets the no-progress bound trip.
      bearer: () => makeRequestContext("expired").credentials,
      auth,
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

    const driveFatal = async (frame: typeof UNAUTHORIZED_FATAL) => {
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
    client.reconnectAll("wake-resume");
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
