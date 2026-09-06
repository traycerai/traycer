import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  type ServedMajorsByMethod,
} from "@traycer/protocol/framework/capability-manifest";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import type {
  BrowserScreencastServerFrame,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import {
  browserScreencastOpenRequestSchemaV10,
  browserSessionsClientFrameSchemaV10,
} from "@traycer/protocol/host/browser/contracts-v1";
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
import { BROWSER_SESSIONS_V1_NO_WINDOW_BINDING_REASON } from "../browser-contracts-v1-bridge";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "../i-stream-session";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { browserSessionsLifecycle } from "@traycer-clients/shared/platform/browser-view";

/**
 * The served-majors restriction a v1.3.0 host advertises: it never got the
 * `@2.0` contracts, so its manifest installs only `@1` for both streams.
 * Distinct from {@link SERVES_EVERY_INSTALLED_MAJOR}, which is what a
 * current host advertises and is what `completeHandshake` below already
 * exercises.
 */
const V1_ONLY_SERVED: ServedMajorsByMethod = {
  "browser.sessions": [1],
  "browser.screencast": [1],
};

const CLOSE_TAB_FRAME: BrowserSessionsClientFrame = {
  kind: "closeTab",
  hasBinaryPayload: false,
  requestId: "close-tab-1",
  sessionId: "browser-session-1",
  tabId: "browser-tab-1",
};

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
  completeHandshakeWithManifest(socket, SERVES_EVERY_INSTALLED_MAJOR);
}

/**
 * Like {@link completeHandshake}, but the host's advertised manifest is
 * restricted to `served` - the shape of a v1.3.0 host that never got the
 * `@2.0` browser contracts.
 */
function completeHandshakeWithManifest(
  socket: StubStreamWebSocket,
  served: ServedMajorsByMethod,
): void {
  socket.fireOpen();
  socket.fireText({
    kind: "openAck",
    manifest: buildStreamManifest(hostStreamRpcRegistry, served),
  });
}

/** Parses one text frame written to the wire into a plain record. */
function parseSent(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

const V1_ONLY_SESSION_V10 = {
  sessionId: "browser-session-1",
  epicId: "epic-1",
  hostId: "host-1",
  profile: "primary" as const,
  lastActivityAt: 1,
  runtime: { kind: "headless" as const, revision: 0 },
  tabs: [
    {
      tabId: "browser-tab-1",
      url: "https://example.com",
      originTier: "external" as const,
      status: "ready" as const,
      title: "Example",
      viewed: false,
      drivenBy: [],
    },
  ],
};

describe("BrowserSessionsStreamClient", () => {
  it("delivers validated server frames and drops malformed ones", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const kinds: string[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
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

  it("stops sending client frames once closed", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);
    const beforeClose = sockets[0].textSent.length;
    stream.sendClientFrame(CLOSE_TAB_FRAME);
    expect(sockets[0].textSent).toHaveLength(beforeClose + 1);

    stream.close();
    stream.sendClientFrame(CLOSE_TAB_FRAME);
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
      scope: { kind: "epic", epicId: "epic-1" },
      sessionId: "browser-session-1",
      tabId: "browser-tab-1",
      maxWidth: 1280,
      maxHeight: 720,
      quality: 80,
      format: "jpeg",
      role: "tile",
      handoffToken: null,
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
      scope: { kind: "epic", epicId: "epic-1" },
      sessionId: "browser-session-1",
      tabId: "browser-tab-1",
      maxWidth: 1280,
      maxHeight: 720,
      quality: 80,
      format: "jpeg",
      role: "tile",
      handoffToken: null,
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

describe("BrowserSessionsStreamClient against a @1-only host (epic scope)", () => {
  it("declares the subscribe at @1 with epicId as the ONLY param key", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);

    const subscribeFrame = parseSent(sockets[0].textSent[1]);
    expect(subscribeFrame.kind).toBe("subscribe");
    expect(subscribeFrame.method).toBe("browser.sessions");
    expect(subscribeFrame.schemaVersion).toMatchObject({ major: 1, minor: 0 });
    // Strictness on the v1.3.0 host is the whole point of this major: a
    // `scope` riding along the params would be silently dropped by its
    // `.strict()` open-request schema, so the key set - not merely
    // `epicId`'s presence - is what proves the projection actually ran.
    const params = subscribeFrame.params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(["epicId"]);
    expect(params.epicId).toBe("epic-1");

    stream.close();
  });

  it("lifts snapshot/sessionCreated/sessionUpdated to the live scope+boundWindowId shape", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const received: BrowserSessionsServerFrame[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onServerFrame: (frame) => {
          received.push(frame);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);
    sockets[0].fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      sessions: [V1_ONLY_SESSION_V10],
    });
    sockets[0].fireText({
      kind: "sessionCreated",
      hasBinaryPayload: false,
      session: V1_ONLY_SESSION_V10,
    });
    sockets[0].fireText({
      kind: "sessionUpdated",
      hasBinaryPayload: false,
      session: V1_ONLY_SESSION_V10,
    });

    expect(received.map((frame) => frame.kind)).toEqual([
      "snapshot",
      "sessionCreated",
      "sessionUpdated",
    ]);
    const snapshot = received[0];
    if (snapshot.kind !== "snapshot") throw new Error("expected snapshot");
    const session = snapshot.sessions[0];
    expect(session).not.toHaveProperty("epicId");
    expect(session.scope).toEqual({ kind: "epic", epicId: "epic-1" });
    expect(session.tabs[0].boundWindowId).toBeNull();

    const created = received[1];
    if (created.kind !== "sessionCreated")
      throw new Error("expected sessionCreated");
    expect(created.session.scope).toEqual({ kind: "epic", epicId: "epic-1" });
    expect(created.session.tabs[0].boundWindowId).toBeNull();

    const updated = received[2];
    if (updated.kind !== "sessionUpdated")
      throw new Error("expected sessionUpdated");
    expect(updated.session.scope).toEqual({ kind: "epic", epicId: "epic-1" });
    expect(updated.session.tabs[0].boundWindowId).toBeNull();

    stream.close();
  });

  it("lifts tabOpened's missing opener to openerTabId: null", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const received: BrowserSessionsServerFrame[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onServerFrame: (frame) => {
          received.push(frame);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);
    sockets[0].fireText({
      kind: "tabOpened",
      hasBinaryPayload: false,
      sessionId: "browser-session-1",
      tabId: "browser-tab-1",
      source: "page",
    });

    expect(received).toHaveLength(1);
    const frame = received[0];
    if (frame.kind !== "tabOpened") throw new Error("expected tabOpened");
    expect(frame.openerTabId).toBeNull();

    stream.close();
  });

  it("lifts openTabResult's ok:true arm to handoffToken: null, leaves ok:false unchanged", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const received: BrowserSessionsServerFrame[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onServerFrame: (frame) => {
          received.push(frame);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);
    sockets[0].fireText({
      kind: "openTabResult",
      hasBinaryPayload: false,
      requestId: "open-1",
      result: {
        ok: true,
        sessionId: "browser-session-1",
        tabId: "browser-tab-1",
      },
    });
    sockets[0].fireText({
      kind: "openTabResult",
      hasBinaryPayload: false,
      requestId: "open-2",
      result: { ok: false, reason: "session is closing" },
    });

    expect(received).toHaveLength(2);
    const ok = received[0];
    if (ok.kind !== "openTabResult") throw new Error("expected openTabResult");
    if (!ok.result.ok) throw new Error("expected an ok:true result");
    expect(ok.result.handoffToken).toBeNull();

    const failed = received[1];
    if (failed.kind !== "openTabResult")
      throw new Error("expected openTabResult");
    if (failed.result.ok) throw new Error("expected an ok:false result");
    expect(failed.result.reason).toBe("session is closing");

    stream.close();
  });

  it("passes sessionClosed and actionAck through unchanged, and drops a malformed frame without throwing", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const received: BrowserSessionsServerFrame[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onServerFrame: (frame) => {
          received.push(frame);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);
    sockets[0].fireText({
      kind: "sessionClosed",
      hasBinaryPayload: false,
      sessionId: "browser-session-1",
      reason: "completed",
    });
    sockets[0].fireText({
      kind: "actionAck",
      hasBinaryPayload: false,
      requestId: "req-1",
      ok: true,
      reason: null,
    });
    expect(() =>
      sockets[0].fireText({
        kind: "snapshot",
        hasBinaryPayload: false,
        // Missing `sessions` - fails the v1 schema.
      }),
    ).not.toThrow();

    expect(received.map((frame) => frame.kind)).toEqual([
      "sessionClosed",
      "actionAck",
    ]);

    stream.close();
  });

  it("answers attachTab/moveTab locally with no window binding on this line, and sends nothing on the wire", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const received: BrowserSessionsServerFrame[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onServerFrame: (frame) => {
          received.push(frame);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);
    const sentBefore = sockets[0].textSent.length;

    stream.sendClientFrame({
      kind: "attachTab",
      hasBinaryPayload: false,
      requestId: "attach-1",
      tabId: "browser-tab-1",
    });
    stream.sendClientFrame({
      kind: "moveTab",
      hasBinaryPayload: false,
      requestId: "move-1",
      tabId: "browser-tab-1",
    });

    expect(sockets[0].textSent).toHaveLength(sentBefore);
    expect(received).toEqual([
      {
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId: "attach-1",
        ok: false,
        reason: BROWSER_SESSIONS_V1_NO_WINDOW_BINDING_REASON,
      },
      {
        kind: "actionAck",
        hasBinaryPayload: false,
        requestId: "move-1",
        ok: false,
        reason: BROWSER_SESSIONS_V1_NO_WINDOW_BINDING_REASON,
      },
    ]);

    stream.close();
  });

  it("drops desktopWindowId from electronTabLifecycleReady, and passes closeTab through unchanged", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);
    const sentBefore = sockets[0].textSent.length;

    stream.sendClientFrame({
      kind: "electronTabLifecycleReady",
      hasBinaryPayload: false,
      coLocatedHostId: "host-1",
      desktopWindowId: "window-1",
    });

    expect(sockets[0].textSent).toHaveLength(sentBefore + 1);
    const projected = parseSent(sockets[0].textSent[sentBefore]);
    expect(projected).not.toHaveProperty("desktopWindowId");
    // Round-trips against the frozen wire schema: the frame the v1.3.0 host
    // actually parses, not merely a shape that happens to match by eye.
    expect(() =>
      browserSessionsClientFrameSchemaV10.parse(projected),
    ).not.toThrow();

    stream.sendClientFrame(CLOSE_TAB_FRAME);
    expect(sockets[0].textSent).toHaveLength(sentBefore + 2);
    expect(parseSent(sockets[0].textSent[sentBefore + 1])).toEqual(
      CLOSE_TAB_FRAME,
    );

    stream.close();
  });
});

describe("BrowserScreencastStreamClient against a @1-only host (epic scope)", () => {
  it("declares the subscribe with the exact @1 key set - no scope, no handoffToken", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const stream = new BrowserScreencastStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      sessionId: "browser-session-1",
      tabId: "browser-tab-1",
      maxWidth: 1280,
      maxHeight: 720,
      quality: 80,
      format: "jpeg",
      role: "tile",
      // A handed-off token exercises the drop: `@1` mints none, so a viewer
      // presenting one against this host must still open cleanly.
      handoffToken: "token-1",
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);

    const subscribeFrame = parseSent(sockets[0].textSent[1]);
    expect(subscribeFrame.schemaVersion).toMatchObject({ major: 1, minor: 0 });
    const params = subscribeFrame.params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual([
      "epicId",
      "format",
      "maxHeight",
      "maxWidth",
      "quality",
      "role",
      "sessionId",
      "tabId",
    ]);
    expect(() =>
      browserScreencastOpenRequestSchemaV10.parse(params),
    ).not.toThrow();

    stream.close();
  });

  it("still delivers unprojected frame/started frames - there is no lift path for screencast", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const received: BrowserScreencastServerFrame[] = [];
    const stream = new BrowserScreencastStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      sessionId: "browser-session-1",
      tabId: "browser-tab-1",
      maxWidth: 1280,
      maxHeight: 720,
      quality: 80,
      format: "jpeg",
      role: "tile",
      handoffToken: null,
      callbacks: {
        onServerFrame: (frame) => {
          received.push(frame);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);
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
    sockets[0].fireBinary(new Uint8Array([1, 2, 3]));

    expect(received.map((frame) => frame.kind)).toEqual(["started", "frame"]);

    stream.close();
  });
});

describe("browser.sessions / browser.screencast: the `independent` scope pins @2", () => {
  it("fails the open against a @1-only host as `unsupported`, with no subscribe frame written", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const statuses: {
      readonly status: StreamConnectionStatus;
      readonly reason: StreamCloseReason | null;
    }[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "independent" },
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: (status, reason) => {
          statuses.push({ status, reason });
        },
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);

    const kinds = sockets[0].textSent.map((raw) => parseSent(raw).kind);
    expect(kinds).not.toContain("subscribe");
    expect(kinds).toContain("fatalError");

    const last = statuses[statuses.length - 1];
    expect(last.status).toBe("closed");
    expect(browserSessionsLifecycle(last.status, last.reason)).toBe(
      "unsupported",
    );

    stream.close();
  });

  it("screencast also fails the open against a @1-only host as `unsupported`", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const statuses: {
      readonly status: StreamConnectionStatus;
      readonly reason: StreamCloseReason | null;
    }[] = [];
    const stream = new BrowserScreencastStreamClient({
      wsStreamClient: client,
      scope: { kind: "independent" },
      sessionId: "browser-session-1",
      tabId: "browser-tab-1",
      maxWidth: 1280,
      maxHeight: 720,
      quality: 80,
      format: "jpeg",
      role: "tile",
      handoffToken: null,
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: (status, reason) => {
          statuses.push({ status, reason });
        },
      },
    });

    completeHandshakeWithManifest(sockets[0], V1_ONLY_SERVED);

    const kinds = sockets[0].textSent.map((raw) => parseSent(raw).kind);
    expect(kinds).not.toContain("subscribe");

    const last = statuses[statuses.length - 1];
    expect(browserSessionsLifecycle(last.status, last.reason)).toBe(
      "unsupported",
    );

    stream.close();
  });

  it("subscribes at @2 with scope: independent against a host serving both majors", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "independent" },
      callbacks: {
        onServerFrame: () => undefined,
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);

    const subscribeFrame = parseSent(sockets[0].textSent[1]);
    expect(subscribeFrame.schemaVersion).toMatchObject({ major: 2, minor: 0 });
    expect(subscribeFrame.params).toEqual({ scope: { kind: "independent" } });

    stream.close();
  });
});

describe("browser.sessions against a host serving @1 and @2 (epic scope)", () => {
  it("negotiates @2 verbatim: params carry scope, and window-bound frames pass through unprojected", () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory);
    const received: BrowserSessionsServerFrame[] = [];
    const stream = new BrowserSessionsStreamClient({
      wsStreamClient: client,
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onServerFrame: (frame) => {
          received.push(frame);
        },
        onConnectionStatus: () => undefined,
      },
    });

    completeHandshake(sockets[0]);

    const subscribeFrame = parseSent(sockets[0].textSent[1]);
    expect(subscribeFrame.schemaVersion).toMatchObject({ major: 2, minor: 0 });
    expect(subscribeFrame.params).toEqual({
      scope: { kind: "epic", epicId: "epic-1" },
    });

    const liveSession = {
      sessionId: "browser-session-1",
      scope: { kind: "epic" as const, epicId: "epic-1" },
      hostId: "host-1",
      profile: "primary" as const,
      lastActivityAt: 1,
      runtime: { kind: "headless" as const, revision: 0 },
      tabs: [
        {
          tabId: "browser-tab-1",
          url: "https://example.com",
          originTier: "external" as const,
          status: "ready" as const,
          title: "Example",
          viewed: false,
          drivenBy: [],
          boundWindowId: "window-1",
        },
      ],
    };
    sockets[0].fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      sessions: [liveSession],
    });

    expect(received).toHaveLength(1);
    const snapshot = received[0];
    if (snapshot.kind !== "snapshot") throw new Error("expected snapshot");
    expect(snapshot.sessions[0]).toEqual(liveSession);

    const sentBeforeClientFrames = sockets[0].textSent.length;
    stream.sendClientFrame({
      kind: "attachTab",
      hasBinaryPayload: false,
      requestId: "attach-1",
      tabId: "browser-tab-1",
    });
    stream.sendClientFrame({
      kind: "electronTabLifecycleReady",
      hasBinaryPayload: false,
      coLocatedHostId: "host-1",
      desktopWindowId: "window-1",
    });
    expect(sockets[0].textSent).toHaveLength(sentBeforeClientFrames + 2);
    expect(parseSent(sockets[0].textSent[sentBeforeClientFrames])).toEqual({
      kind: "attachTab",
      hasBinaryPayload: false,
      requestId: "attach-1",
      tabId: "browser-tab-1",
    });
    expect(parseSent(sockets[0].textSent[sentBeforeClientFrames + 1])).toEqual({
      kind: "electronTabLifecycleReady",
      hasBinaryPayload: false,
      coLocatedHostId: "host-1",
      desktopWindowId: "window-1",
    });

    stream.close();
  });
});
