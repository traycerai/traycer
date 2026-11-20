import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineFallbackMethodDegrade,
  defineRpcContract,
  defineUpgradePath,
  defineVersionedRpcRegistry,
  RPC_REQUEST_TIMEOUT_FATAL_CODE,
  UNARY_CAPABILITY_IDEMPOTENCY_KEY,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
  type ConnectionManifest,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  clientFrameSchema,
  type ClientCancelFrame,
  type ClientFrame,
  type ClientOpenFrame,
  type ClientRequestFrame,
  type HostFatalErrorFrame,
  type HostOpenAckFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { mayHaveReachedHost } from "@traycer/protocol/host-transport/remote/rpc-types";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import type { DialPriority } from "../dial-priority";
import {
  HostMethodVersionUnsatisfiedError,
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type HostRequestAuthority,
  type HostRequestOptions,
  type HostTransportEndpoint,
} from "../host-messenger";
import { createAuthAwareMessenger } from "../auth-aware-messenger";
import {
  LocalUnarySession,
  LocalUnarySessionDirectory,
  localUnarySessionKey,
  type MultiplexSocket,
} from "../local-unary-session";
import { resetNegotiatedManifests } from "../negotiated-manifest-registry";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import { WsRpcClient } from "../ws-rpc-client";

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const statusV10 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ ready: z.boolean() }),
});

const testRegistry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
  "host.status": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: statusV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const echoMinor0 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ legacy: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const echoMinor1 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const upgradeEchoMinor = defineUpgradePath<
  typeof echoMinor0,
  typeof echoMinor1
>({
  from: echoMinor0.schemaVersion,
  to: echoMinor1.schemaVersion,
  upgradeRequest: (request) => ({ message: request.legacy }),
  upgradeResponse: (response) => response,
});

const downgradeRegistry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 1,
      versions: {
        0: { contract: echoMinor0, upgradeFromPreviousVersion: null },
        1: {
          contract: echoMinor1,
          upgradeFromPreviousVersion: upgradeEchoMinor,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
});

/** Optional echo installed only at minor 1. A host optional minor 0 has no contract here. */
const hostMinorAbsentRegistry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 1,
      versions: {
        1: {
          contract: echoMinor1,
          upgradeFromPreviousVersion: null,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const extraV10 = defineRpcContract({
  method: "host.extra",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const brokenV10 = defineRpcContract({
  method: "host.broken",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const unsupportedV10 = defineRpcContract({
  method: "host.unsupported",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const spareV10 = defineRpcContract({
  method: "host.spare",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ ready: z.boolean() }),
});

const gapV10 = defineRpcContract({
  method: "host.gap",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const adaptV10 = defineRpcContract({
  method: "host.adapt",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const line = <Contract extends { method: string }>(contract: Contract) => ({
  1: {
    latestMinor: 0 as const,
    versions: {
      0: { contract, upgradeFromPreviousVersion: null },
    },
    downgradePathsFromLatest: {},
  },
});

const degradeRegistry = defineVersionedRpcRegistry({
  "host.status": line(statusV10),
  "host.extra": {
    degrade: defineFallbackMethodDegrade<
      typeof extraV10,
      typeof statusV10,
      "host.status"
    >({
      kind: "fallback",
      to: { method: "host.status", major: 1, minor: 0 },
      adaptRequest: () => ({}),
      adaptResponse: () => ({ echoed: "adapted" }),
    }),
    ...line(extraV10),
  },
  "host.broken": {
    degrade: defineFallbackMethodDegrade<
      typeof brokenV10,
      typeof statusV10,
      "host.status"
    >({
      kind: "fallback",
      to: { method: "host.status", major: 1, minor: 0 },
      adaptRequest: () => {
        throw new Error("adapt rejected");
      },
      adaptResponse: () => ({ echoed: "adapted" }),
    }),
    ...line(brokenV10),
  },
  "host.unsupported": {
    degrade: { kind: "unsupported" },
    ...line(unsupportedV10),
  },
  "host.spare": line(spareV10),
  "host.gap": {
    degrade: defineFallbackMethodDegrade<
      typeof gapV10,
      typeof spareV10,
      "host.spare"
    >({
      kind: "fallback",
      to: { method: "host.spare", major: 1, minor: 0 },
      adaptRequest: () => ({}),
      adaptResponse: () => ({ echoed: "adapted" }),
    }),
    ...line(gapV10),
  },
  "host.adapt": {
    degrade: defineFallbackMethodDegrade<
      typeof adaptV10,
      typeof statusV10,
      "host.status"
    >({
      kind: "fallback",
      to: { method: "host.status", major: 1, minor: 0 },
      adaptRequest: () => ({}),
      adaptResponse: () => {
        throw new Error("adapt response rejected");
      },
    }),
    ...line(adaptV10),
  },
});

/** Same degrade shape as `degradeRegistry`, without the fallback target installed. */
const unknownTargetRegistry = defineVersionedRpcRegistry({
  "host.status": line(statusV10),
  "host.gap": {
    degrade: defineFallbackMethodDegrade<
      typeof gapV10,
      typeof spareV10,
      "host.spare"
    >({
      kind: "fallback",
      to: { method: "host.spare", major: 1, minor: 0 },
      adaptRequest: () => ({}),
      adaptResponse: () => ({ echoed: "adapted" }),
    }),
    ...line(gapV10),
  },
});

const decodeMinor0 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const decodeMinor1 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const throwingResponseUpgrade = defineUpgradePath<
  typeof decodeMinor0,
  typeof decodeMinor1
>({
  from: decodeMinor0.schemaVersion,
  to: decodeMinor1.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: () => {
    throw new Error("response upgrade rejected");
  },
});

const decodeThrowRegistry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 1,
      versions: {
        0: { contract: decodeMinor0, upgradeFromPreviousVersion: null },
        1: {
          contract: decodeMinor1,
          upgradeFromPreviousVersion: throwingResponseUpgrade,
        },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const statusV20 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ ready: z.boolean() }),
});

const statusNoBridgeRegistry = defineVersionedRpcRegistry({
  "host.status": {
    2: {
      latestMinor: 0,
      versions: {
        0: { contract: statusV20, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const HOST_ID = "local-unary-session-host";
const SOCKET_URL = "ws://127.0.0.1/rpc";
const USER_A = "user-a";
const USER_B = "user-b";

class StubWebSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sentFrames: ClientFrame[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  private readonly sendWaiters: Array<() => void> = [];

  send(data: string): void {
    this.sentFrames.push(
      clientFrameSchema.parse(JSON.parse(data)) as ClientFrame,
    );
    const waiters = this.sendWaiters.splice(0, this.sendWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }
  }

  nextSend(): Promise<void> {
    return new Promise((resolve) => {
      this.sendWaiters.push(resolve);
    });
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  /** When set, an `openAck` closes the socket before `fireMessage` returns. */
  closeOnAck = false;
  /** When set, an `openAck` is followed by a host fatal before `fireMessage` returns. */
  fatalAfterAck = false;
  /** Raw text delivered synchronously after an `openAck`, before the caller continues. */
  trailingRaw: string | null = null;
  /** Transport error delivered synchronously after an `openAck`. */
  trailingError: string | null = null;
  /** Runs synchronously after an `openAck`, before the caller continues. */
  abortOnAck: (() => void) | null = null;

  fireMessage(
    frame:
      | HostOpenAckFrame
      | HostFatalErrorFrame
      | {
          readonly kind: "response";
          readonly requestId: string;
          readonly method: string;
          readonly schemaVersion: {
            readonly major: number;
            readonly minor: number;
          };
          readonly result:
            | { readonly echoed: string }
            | { readonly ready: boolean }
            | null;
          readonly error: {
            readonly code: string;
            readonly message: string;
            readonly retryable?: boolean;
          } | null;
        },
  ): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
    if (frame.kind !== "openAck") {
      return;
    }
    if (this.closeOnAck) {
      this.fireClose(1006, "peer-dropped", false);
    }
    if (this.fatalAfterAck) {
      this.fireMessage({
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "host refused the session",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: false,
        },
      });
    }
    if (this.trailingRaw !== null) {
      const raw = this.trailingRaw;
      this.trailingRaw = null;
      this.onmessage?.({ data: raw });
    }
    if (this.trailingError !== null) {
      const message = this.trailingError;
      this.trailingError = null;
      this.onerror?.({ message });
    }
    const abort = this.abortOnAck;
    if (abort !== null) {
      this.abortOnAck = null;
      abort();
    }
  }

  fireClose(code: number, reason: string, wasClean: boolean): void {
    this.onclose?.({ code, reason, wasClean });
  }
}

type RecordedSocket = {
  readonly socket: StubWebSocket;
  readonly sent: ClientFrame[];
};

function makeFactory(): {
  readonly factory: IWebSocketFactory;
  readonly sockets: RecordedSocket[];
  readonly nextSocket: () => Promise<void>;
} {
  const sockets: RecordedSocket[] = [];
  const socketWaiters: Array<() => void> = [];
  const factory: IWebSocketFactory = {
    create(url: string, priority: DialPriority): WebSocketLike {
      void url;
      void priority;
      const socket = new StubWebSocket();
      sockets.push({ socket, sent: socket.sentFrames });
      const waiters = socketWaiters.splice(0, socketWaiters.length);
      for (const resolve of waiters) {
        resolve();
      }
      return socket;
    },
  };
  return {
    factory,
    sockets,
    nextSocket(): Promise<void> {
      return new Promise((resolve) => {
        socketWaiters.push(resolve);
      });
    },
  };
}

function captureRejection(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => null,
    (cause: unknown) => cause,
  );
}

function requestFrames(recorded: RecordedSocket): ClientRequestFrame[] {
  return recorded.sent.filter(
    (frame): frame is ClientRequestFrame => frame.kind === "request",
  );
}

function openFrames(recorded: RecordedSocket): ClientOpenFrame[] {
  return recorded.sent.filter(
    (frame): frame is ClientOpenFrame => frame.kind === "open",
  );
}

function cancelFrames(recorded: RecordedSocket): ClientCancelFrame[] {
  return recorded.sent.filter(
    (frame): frame is ClientCancelFrame => frame.kind === "cancel",
  );
}

function sessionAck(idempotency: boolean): HostOpenAckFrame {
  const capabilities: string[] = [UNARY_CAPABILITY_PERSISTENT_SESSION];
  if (idempotency) {
    capabilities.unshift(UNARY_CAPABILITY_IDEMPOTENCY_KEY);
  }
  return {
    kind: "openAck",
    manifest: { "host.status": { major: 1, minor: 0 } },
    optionalManifest: { "host.echo": { major: 1, minor: 0 } },
    capabilities,
  };
}

function statusAck(major: number): HostOpenAckFrame {
  return {
    kind: "openAck",
    manifest: { "host.status": { major, minor: 0 } },
    capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
  };
}

function legacyAck(): HostOpenAckFrame {
  return {
    kind: "openAck",
    manifest: { "host.status": { major: 1, minor: 0 } },
    optionalManifest: { "host.echo": { major: 1, minor: 0 } },
    capabilities: [UNARY_CAPABILITY_IDEMPOTENCY_KEY],
  };
}

function respondEcho(
  socket: StubWebSocket,
  frame: ClientRequestFrame,
  echoed: string,
): void {
  socket.fireMessage({
    kind: "response",
    requestId: frame.requestId,
    method: frame.method,
    schemaVersion: frame.schemaVersion,
    result: { echoed },
    error: null,
  });
}

function respondStatus(
  socket: StubWebSocket,
  frame: ClientRequestFrame,
  ready: boolean,
): void {
  socket.fireMessage({
    kind: "response",
    requestId: frame.requestId,
    method: frame.method,
    schemaVersion: frame.schemaVersion,
    result: { ready },
    error: null,
  });
}

async function classify(
  recorded: RecordedSocket,
  ack: HostOpenAckFrame,
): Promise<void> {
  const opened = recorded.socket.nextSend();
  recorded.socket.fireOpen();
  await opened;
  const requested = recorded.socket.nextSend();
  recorded.socket.fireMessage(ack);
  await requested;
}

function authorityFor(
  bearer: MutableBearerLease,
  signal: AbortSignal,
  cloudAuthorized: (() => boolean) | null,
): HostRequestAuthority {
  const endpoint: HostTransportEndpoint = {
    hostId: HOST_ID,
    websocketUrl: SOCKET_URL,
  };
  if (cloudAuthorized === null) {
    return { endpoint, bearer, abortSignal: signal };
  }
  return { endpoint, bearer, abortSignal: signal, cloudAuthorized };
}

function optionsFor(
  bearer: MutableBearerLease,
  signal: AbortSignal,
  idempotencyKey: string | null,
  replayMustBeKeyed: boolean,
  cloudAuthorized: (() => boolean) | null,
): HostRequestOptions {
  return {
    idempotencyKey,
    replayMustBeKeyed,
    requiredHostMethodVersion: null,
    authority: authorityFor(bearer, signal, cloudAuthorized),
  };
}

function makeClient(
  factory: IWebSocketFactory,
  hostAttestationWindowMs: number,
): WsRpcClient<typeof testRegistry> {
  let issued = 0;
  return new WsRpcClient<typeof testRegistry>({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: testRegistry,
    requestId: () => {
      issued += 1;
      return `req-${issued}`;
    },
    webSocketFactory: factory,
    dialTimeoutMs: 5_000,
    frameTimeoutMs: 5_000,
    hostAttestationWindowMs,
    evidence: NO_TRANSPORT_EVIDENCE,
  });
}

function makeClientFor<Registry extends VersionedRpcRegistry>(
  registry: Registry,
  factory: IWebSocketFactory,
): WsRpcClient<Registry> {
  let issued = 0;
  return new WsRpcClient<Registry>({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry,
    requestId: () => {
      issued += 1;
      return `req-${issued}`;
    },
    webSocketFactory: factory,
    dialTimeoutMs: 5_000,
    frameTimeoutMs: 5_000,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
  });
}

function versionFloorOptions(bearer: MutableBearerLease): HostRequestOptions {
  return {
    ...optionsFor(bearer, new AbortController().signal, null, false, null),
    requiredHostMethodVersion: {
      method: "host.echo",
      version: { major: 2, minor: 0 },
    },
  };
}

class RecordingSocket implements MultiplexSocket {
  readonly sent: ClientFrame[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  failSend: "request" | "cancel" | null = null;

  send(frame: ClientFrame): void {
    this.sent.push(frame);
    if (this.failSend === frame.kind) {
      throw new Error(`send ${frame.kind} failed`);
    }
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

const BOTH_MANIFESTS: ConnectionManifest = {
  "host.echo": { major: 1, minor: 0 },
  "host.status": { major: 1, minor: 0 },
};

function directEchoSession(manifests: {
  readonly clientManifest: ConnectionManifest;
  readonly hostManifest: ConnectionManifest;
}): {
  readonly session: LocalUnarySession<typeof testRegistry>;
  readonly socket: RecordingSocket;
} {
  const directory = new LocalUnarySessionDirectory<typeof testRegistry>();
  const session = new LocalUnarySession<typeof testRegistry>({
    key: localUnarySessionKey(HOST_ID, USER_A, SOCKET_URL),
    registry: testRegistry,
    hostId: HOST_ID,
    directory,
  });
  const socket = new RecordingSocket();
  session.attach({
    socket,
    clientManifest: manifests.clientManifest,
    hostManifest: manifests.hostManifest,
    idempotency: true,
  });
  return { session, socket };
}

function directSession<Registry extends VersionedRpcRegistry>(
  registry: Registry,
  manifests: {
    readonly clientManifest: ConnectionManifest;
    readonly hostManifest: ConnectionManifest;
  },
): {
  readonly session: LocalUnarySession<Registry>;
  readonly socket: RecordingSocket;
} {
  const directory = new LocalUnarySessionDirectory<Registry>();
  const session = new LocalUnarySession<Registry>({
    key: localUnarySessionKey(HOST_ID, USER_A, SOCKET_URL),
    registry,
    hostId: HOST_ID,
    directory,
  });
  const socket = new RecordingSocket();
  session.attach({
    socket,
    clientManifest: manifests.clientManifest,
    hostManifest: manifests.hostManifest,
    idempotency: true,
  });
  return { session, socket };
}

function expectDirectoryEmpty(
  directory: LocalUnarySessionDirectory<typeof testRegistry>,
  key: string,
): void {
  expect(directory.dialHoldCount(key)).toBe(0);
  const probe = directory.acquireDialHold(key);
  expect(directory.dialHoldCount(key)).toBe(0);
  probe.release();
}

function incompatibleHandshake(): HostRpcError {
  return new HostRpcError({
    code: "INCOMPATIBLE",
    message: "host build is incompatible",
    requestId: "req-owner",
    method: "host.echo",
    fatalDetails: {
      code: "INCOMPATIBLE",
      reason: "host build is incompatible",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function echoCall(
  session: LocalUnarySession<typeof testRegistry>,
  requestId: string,
  signal: AbortSignal,
) {
  const bearer = new MutableBearerLease("token-a", USER_A);
  return session.call({
    requestId,
    method: "host.echo",
    params: { message: requestId },
    responseTimeoutMs: 5_000,
    options: optionsFor(bearer, signal, null, false, null),
    boundToDialRelease: true,
  });
}

async function openDiscoveringSocket(
  sockets: RecordedSocket[],
): Promise<RecordedSocket> {
  const discovering = sockets[0];
  if (discovering === undefined) {
    throw new Error("expected the discovering socket");
  }
  const opened = discovering.socket.nextSend();
  discovering.socket.fireOpen();
  await opened;
  return discovering;
}

async function releaseOutstandingHandshake(
  client: WsRpcClient<typeof testRegistry>,
  sockets: RecordedSocket[],
): Promise<RecordedSocket> {
  const discovering = await openDiscoveringSocket(sockets);
  client.releaseIdleLocalSessions();
  return discovering;
}

function makeTimedClient(
  factory: IWebSocketFactory,
  dialTimeoutMs: number,
  frameTimeoutMs: number,
): WsRpcClient<typeof testRegistry> {
  let issued = 0;
  return new WsRpcClient<typeof testRegistry>({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: testRegistry,
    requestId: () => {
      issued += 1;
      return `req-${issued}`;
    },
    webSocketFactory: factory,
    dialTimeoutMs,
    frameTimeoutMs,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
  });
}

async function completeReplacementOnFakeClock(
  sockets: RecordedSocket[],
  waiter: Promise<{ readonly echoed: string }>,
  created: Promise<void>,
): Promise<void> {
  await created;
  expect(sockets).toHaveLength(2);
  const retried = sockets[1];
  if (retried === undefined) {
    throw new Error("expected the replacement dial");
  }
  const opened = retried.socket.nextSend();
  retried.socket.fireOpen();
  await opened;
  const requested = retried.socket.nextSend();
  retried.socket.fireMessage(sessionAck(true));
  await requested;
  const frame = requestFrames(retried)[0];
  if (frame === undefined) {
    throw new Error("expected the waiter request on the replacement");
  }
  respondEcho(retried.socket, frame, "waiter");
  await expect(waiter).resolves.toEqual({ echoed: "waiter" });
  expect(retried.socket.closed).toEqual({
    code: 1000,
    reason: "session-closed",
  });
}

function admittedPair(client: WsRpcClient<typeof testRegistry>): {
  readonly owner: Promise<unknown>;
  readonly waiter: Promise<{ readonly echoed: string }>;
} {
  const bearer = new MutableBearerLease("token-a", USER_A);
  return {
    owner: captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    ),
    waiter: client.request(
      "host.echo",
      { message: "waiter" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    ),
  };
}

async function expectReplacementClosed(
  sockets: RecordedSocket[],
  waiter: Promise<{ readonly echoed: string }>,
): Promise<void> {
  expect(sockets).toHaveLength(2);
  const retried = sockets[1];
  if (retried === undefined) {
    throw new Error("expected the replacement dial");
  }
  await classify(retried, sessionAck(true));
  const frame = requestFrames(retried)[0];
  if (frame === undefined) {
    throw new Error("expected the waiter request on the replacement");
  }
  respondEcho(retried.socket, frame, "waiter");
  await expect(waiter).resolves.toEqual({ echoed: "waiter" });
  expect(retried.socket.closed).toEqual({
    code: 1000,
    reason: "session-closed",
  });
  expect(sockets).toHaveLength(2);
}

describe("local unary session", () => {
  afterEach(() => {
    resetNegotiatedManifests();
  });

  it("binds a second call synchronously and adopts the discovering socket", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = client.request(
      "host.echo",
      { message: "one" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const second = client.request(
      "host.echo",
      { message: "two" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );

    expect(sockets).toHaveLength(1);
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));

    const sent = requestFrames(discovering);
    expect(openFrames(discovering)).toHaveLength(1);
    expect(openFrames(discovering)[0]?.capabilities).toContain(
      UNARY_CAPABILITY_PERSISTENT_SESSION,
    );
    expect(sent.map((frame) => frame.params)).toEqual([
      { message: "one" },
      { message: "two" },
    ]);
    expect(sockets).toHaveLength(1);

    respondEcho(discovering.socket, sent[0] as ClientRequestFrame, "one");
    respondEcho(discovering.socket, sent[1] as ClientRequestFrame, "two");

    await expect(first).resolves.toEqual({ echoed: "one" });
    await expect(second).resolves.toEqual({ echoed: "two" });
    expect(sockets).toHaveLength(1);
    expect(openFrames(discovering)).toHaveLength(1);
  });

  it("reuses one session for a rotated token and opens another for a different userId", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = client.request(
      "host.echo",
      { message: "first" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const firstRequest = requestFrames(discovering)[0];
    if (firstRequest === undefined) {
      throw new Error("expected the first request");
    }
    expect(firstRequest.token).toBe("token-a");
    respondEcho(discovering.socket, firstRequest, "first");
    await expect(first).resolves.toEqual({ echoed: "first" });

    bearer.rotate("token-a-rotated");
    const rotatedWrite = discovering.socket.nextSend();
    const rotated = client.request(
      "host.echo",
      { message: "rotated" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await rotatedWrite;
    const rotatedRequest = requestFrames(discovering)[1];
    if (rotatedRequest === undefined) {
      throw new Error("expected the rotated request on the same socket");
    }
    expect(rotatedRequest.token).toBe("token-a-rotated");
    expect(sockets).toHaveLength(1);
    respondEcho(discovering.socket, rotatedRequest, "rotated");
    await expect(rotated).resolves.toEqual({ echoed: "rotated" });

    const other = new MutableBearerLease("token-b", USER_B);
    const secondUser = client.request(
      "host.echo",
      { message: "other" },
      optionsFor(other, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const separate = sockets[1];
    if (separate === undefined) {
      throw new Error("expected a new socket for the other user");
    }
    await classify(separate, sessionAck(true));
    expect(openFrames(separate)[0]?.token).toBe("token-b");
    expect(requestFrames(discovering)).toHaveLength(2);
    const otherRequest = requestFrames(separate)[0];
    if (otherRequest === undefined) {
      throw new Error("expected the other user's request");
    }
    expect(otherRequest.token).toBe("token-b");
    respondEcho(separate.socket, otherRequest, "other");
    await expect(secondUser).resolves.toEqual({ echoed: "other" });
    expect(localUnarySessionKey(HOST_ID, USER_A, SOCKET_URL)).not.toBe(
      localUnarySessionKey(HOST_ID, USER_B, SOCKET_URL),
    );
  });

  it("does not rotate the session when the reported host status changes", async () => {
    expect(localUnarySessionKey(HOST_ID, USER_A, SOCKET_URL)).toBe(
      `${HOST_ID}\u0000${USER_A}\u0000${SOCKET_URL}`,
    );

    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const ready = client.request(
      "host.status",
      {},
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const firstStatus = requestFrames(discovering)[0];
    if (firstStatus === undefined) {
      throw new Error("expected the first status request");
    }
    respondStatus(discovering.socket, firstStatus, true);
    await expect(ready).resolves.toEqual({ ready: true });

    const statusWrite = discovering.socket.nextSend();
    const notReady = client.request(
      "host.status",
      {},
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await statusWrite;
    const secondStatus = requestFrames(discovering)[1];
    if (secondStatus === undefined) {
      throw new Error("expected the second status request on the same socket");
    }
    respondStatus(discovering.socket, secondStatus, false);
    await expect(notReady).resolves.toEqual({ ready: false });
    expect(sockets).toHaveLength(1);
    expect(openFrames(discovering)).toHaveLength(1);
  });

  it("dials one socket per call when the ack omits the session, including a call waiting on the handshake", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = client.request(
      "host.echo",
      { message: "one" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const second = client.request(
      "host.echo",
      { message: "two" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );

    expect(sockets).toHaveLength(1);
    const firstSocket = sockets[0];
    if (firstSocket === undefined) {
      throw new Error("expected the first socket");
    }
    await classify(firstSocket, legacyAck());
    expect(sockets).toHaveLength(2);
    const firstRequest = requestFrames(firstSocket)[0];
    if (firstRequest === undefined) {
      throw new Error("expected the one-shot request");
    }
    expect(firstRequest).not.toHaveProperty("token");
    expect(firstRequest).not.toHaveProperty("cloudAuthorized");
    respondEcho(firstSocket.socket, firstRequest, "one");
    await expect(first).resolves.toEqual({ echoed: "one" });

    const secondSocket = sockets[1];
    if (secondSocket === undefined) {
      throw new Error("expected the waiting call to dial its own socket");
    }
    await classify(secondSocket, legacyAck());
    const secondRequest = requestFrames(secondSocket)[0];
    if (secondRequest === undefined) {
      throw new Error("expected the second one-shot request");
    }
    expect(secondRequest).not.toHaveProperty("token");
    respondEcho(secondSocket.socket, secondRequest, "two");
    await expect(second).resolves.toEqual({ echoed: "two" });
    expect(openFrames(firstSocket)).toHaveLength(1);
    expect(openFrames(firstSocket)[0]?.capabilities).toContain(
      UNARY_CAPABILITY_PERSISTENT_SESSION,
    );
    expect(openFrames(secondSocket)).toHaveLength(1);
    expect(openFrames(secondSocket)[0]?.capabilities ?? []).not.toContain(
      UNARY_CAPABILITY_PERSISTENT_SESSION,
    );
    expect(requestFrames(firstSocket)).toHaveLength(1);
    expect(requestFrames(secondSocket)).toHaveLength(1);
  });

  it("reads the bearer and cloud verdict at send time on a session request", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const verdict = { cloudAuthorized: true };
    const readVerdict = (): boolean => verdict.cloudAuthorized;
    const first = client.request(
      "host.echo",
      { message: "one" },
      optionsFor(
        bearer,
        new AbortController().signal,
        null,
        false,
        readVerdict,
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    bearer.rotate("token-at-send");
    verdict.cloudAuthorized = false;
    await classify(discovering, sessionAck(true));
    const sent = requestFrames(discovering)[0];
    if (sent === undefined) {
      throw new Error("expected the discovering request");
    }
    expect(sent.token).toBe("token-at-send");
    expect(sent.cloudAuthorized).toBe(false);

    bearer.rotate("token-later");
    verdict.cloudAuthorized = true;
    const laterWrite = discovering.socket.nextSend();
    const later = client.request(
      "host.echo",
      { message: "later" },
      optionsFor(
        bearer,
        new AbortController().signal,
        null,
        false,
        readVerdict,
      ),
    );
    await laterWrite;
    const sentLater = requestFrames(discovering)[1];
    if (sentLater === undefined) {
      throw new Error("expected the later request to send immediately");
    }
    expect(sentLater.token).toBe("token-later");
    expect(sentLater.cloudAuthorized).toBe(true);
    expect(sockets).toHaveLength(1);
    respondEcho(discovering.socket, sent, "one");
    respondEcho(discovering.socket, sentLater, "later");
    await expect(first).resolves.toEqual({ echoed: "one" });
    await expect(later).resolves.toEqual({ echoed: "later" });
  });

  it("settles a sent request as uncertain on close and does not write it again", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const pending = captureRejection(
      client.request(
        "host.echo",
        { message: "sent" },
        optionsFor(
          bearer,
          new AbortController().signal,
          "sent-key",
          false,
          null,
        ),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const sent = requestFrames(discovering);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.idempotencyKey).toBe("sent-key");

    discovering.socket.fireClose(1006, "peer-dropped", false);

    const error = await pending;
    expect(error).toBeInstanceOf(HostTransportFailureError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
    expect(mayHaveReachedHost(error)).toBe(true);
    expect(requestFrames(discovering)).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });

  it("fails replayMustBeKeyed before send when the ack has no idempotency capability", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const replay = captureRejection(
      client.request(
        "host.echo",
        { message: "replay" },
        optionsFor(
          bearer,
          new AbortController().signal,
          "must-key",
          true,
          null,
        ),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    discovering.socket.fireMessage(sessionAck(false));

    const error = await replay;
    expect(error).toBeInstanceOf(HostTransportFailureError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
    expect(mayHaveReachedHost(error)).toBe(false);
    if (!(error instanceof HostTransportFailureError)) {
      throw new Error("expected the unkeyed replay refusal");
    }
    expect(error.fatalDetails).not.toBeNull();
    expect(requestFrames(discovering)).toHaveLength(0);

    const followUpWrite = discovering.socket.nextSend();
    const followUp = client.request(
      "host.echo",
      { message: "fresh" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await followUpWrite;
    const sent = requestFrames(discovering);
    expect(sent).toHaveLength(1);
    const sentFrame = sent[0];
    if (sentFrame === undefined) {
      throw new Error("expected the follow-up request on the same socket");
    }
    respondEcho(discovering.socket, sentFrame, "fresh");
    await expect(followUp).resolves.toEqual({ echoed: "fresh" });
    expect(sockets).toHaveLength(1);
  });

  it("keeps a post-send RPC_REQUEST_TIMEOUT retryable and does not redial", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const pending = captureRejection(
      client.request(
        "host.echo",
        { message: "timed" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    expect(requestFrames(discovering)).toHaveLength(1);
    const fatal: HostFatalErrorFrame = {
      kind: "fatalError",
      details: {
        code: RPC_REQUEST_TIMEOUT_FATAL_CODE,
        reason: "Timed out waiting for 'request' frame after openAck (30ms)",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      },
    };
    discovering.socket.fireMessage(fatal);

    const error = await pending;
    expect(error).toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof RetryableTransportError)) {
      throw new Error("expected the timeout fatal to stay retryable");
    }
    expect(error.replaySafetyFromKey).toBe(false);
    expect(mayHaveReachedHost(error)).toBe(false);
    expect(requestFrames(discovering)).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });

  it("marks any other post-send host fatal uncertain and does not resend or redial", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const pending = captureRejection(
      client.request(
        "host.echo",
        { message: "sent" },
        optionsFor(
          bearer,
          new AbortController().signal,
          "once-key",
          false,
          null,
        ),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const fatal: HostFatalErrorFrame = {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "session rejected",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    };
    discovering.socket.fireMessage(fatal);

    const error = await pending;
    expect(error).toBeInstanceOf(HostRpcError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
    expect(mayHaveReachedHost(error)).toBe(true);
    expect(requestFrames(discovering)).toHaveLength(1);
    expect(requestFrames(discovering)[0]?.idempotencyKey).toBe("once-key");
    expect(sockets).toHaveLength(1);
  });

  it("aborts a call waiting for admission before send with no cancel frame", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const discoveringCall = client.request(
      "host.echo",
      { message: "discover" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const controller = new AbortController();
    const queued = captureRejection(
      client.request(
        "host.echo",
        { message: "queued" },
        optionsFor(bearer, controller.signal, null, false, null),
      ),
    );
    controller.abort();
    await classify(discovering, sessionAck(true));

    const sent = requestFrames(discovering);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toEqual({ message: "discover" });
    expect(cancelFrames(discovering)).toHaveLength(0);
    const error = await queued;
    expect(error).toBeInstanceOf(HostRequestAbortedError);
    if (!(error instanceof HostRequestAbortedError)) {
      throw new Error("expected the queued abort");
    }
    expect(error.mayHaveDispatched).toBe(false);

    const discoveringRequest = sent[0];
    if (discoveringRequest === undefined) {
      throw new Error("expected the discovering request");
    }
    respondEcho(discovering.socket, discoveringRequest, "discover");
    await expect(discoveringCall).resolves.toEqual({ echoed: "discover" });
    expect(sockets).toHaveLength(1);
  });

  it("cancels one sent call and leaves the other call and the session going", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const controller = new AbortController();
    const aborted = captureRejection(
      client.request(
        "host.echo",
        { message: "stop" },
        optionsFor(bearer, controller.signal, null, false, null),
      ),
    );
    const kept = client.request(
      "host.echo",
      { message: "keep" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    expect(requestFrames(discovering)).toHaveLength(2);
    const cancelWrite = discovering.socket.nextSend();
    controller.abort();
    await cancelWrite;

    expect(cancelFrames(discovering)).toEqual([
      { kind: "cancel", requestId: "req-1" },
    ]);
    const error = await aborted;
    expect(error).toBeInstanceOf(HostRequestAbortedError);
    if (!(error instanceof HostRequestAbortedError)) {
      throw new Error("expected the in-flight abort");
    }
    expect(error.mayHaveDispatched).toBe(true);

    const keptRequest = requestFrames(discovering)[1];
    if (keptRequest === undefined) {
      throw new Error("expected the other call to stay in flight");
    }
    respondEcho(discovering.socket, keptRequest, "keep");
    await expect(kept).resolves.toEqual({ echoed: "keep" });

    const laterWrite = discovering.socket.nextSend();
    const later = client.request(
      "host.echo",
      { message: "later" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await laterWrite;
    const laterRequest = requestFrames(discovering)[2];
    if (laterRequest === undefined) {
      throw new Error("expected a later call on the same session");
    }
    respondEcho(discovering.socket, laterRequest, "later");
    await expect(later).resolves.toEqual({ echoed: "later" });
    expect(sockets).toHaveLength(1);
    expect(openFrames(discovering)).toHaveLength(1);
  });

  it("times out on the per-call timer with one cancel and leaves the session open", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 5_000);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const pending = client.requestWithResponseTimeout(
      "host.echo",
      { message: "slow" },
      40,
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    expect(requestFrames(discovering)).toHaveLength(1);

    let timer: NodeJS.Timeout | null = null;
    const deadline = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        resolve("still-waiting");
      }, 400);
    });
    const outcome = await Promise.race([
      pending.then(
        (value) => value,
        (cause: unknown) => cause,
      ),
      deadline,
    ]);
    if (timer !== null) {
      clearTimeout(timer);
    }

    expect(outcome).toBeInstanceOf(HostTransportFailureError);
    expect(outcome).not.toBeInstanceOf(RetryableTransportError);
    if (!(outcome instanceof HostTransportFailureError)) {
      throw new Error("expected the per-call timeout");
    }
    expect(outcome.message).toBe("WebSocket frame timed out after 40ms");
    expect(mayHaveReachedHost(outcome)).toBe(true);
    expect(cancelFrames(discovering)).toEqual([
      { kind: "cancel", requestId: "req-1" },
    ]);
    expect(discovering.socket.closed).toBeNull();

    const laterWrite = discovering.socket.nextSend();
    const later = client.request(
      "host.echo",
      { message: "later" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await laterWrite;
    const laterRequest = requestFrames(discovering)[1];
    if (laterRequest === undefined) {
      throw new Error("expected a later call on the same session");
    }
    respondEcho(discovering.socket, laterRequest, "later");
    await expect(later).resolves.toEqual({ echoed: "later" });
    expect(sockets).toHaveLength(1);
  });

  it("writes every queued call once the socket is up", async () => {
    const burst = 40;
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const calls: Promise<{ readonly echoed: string }>[] = [];
    for (let index = 0; index < burst; index += 1) {
      calls.push(
        client.request(
          "host.echo",
          { message: `flight-${index}` },
          optionsFor(bearer, new AbortController().signal, null, false, null),
        ),
      );
    }
    expect(sockets).toHaveLength(1);
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }

    await classify(discovering, sessionAck(true));
    const sent = requestFrames(discovering);
    expect(sent).toHaveLength(burst);
    expect(discovering.socket.closed).toBeNull();
    for (const frame of sent) {
      respondEcho(discovering.socket, frame, "flight");
    }
    const results = await Promise.all(calls);
    expect(results).toEqual(
      Array.from({ length: burst }, () => ({ echoed: "flight" })),
    );
    expect(sockets).toHaveLength(1);
    expect(discovering.socket.closed).toBeNull();
  });

  it("aborts a caller waiting on discovery without waiting for the handshake", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const discoveringCall = client.request(
      "host.echo",
      { message: "discover" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const controller = new AbortController();
    const waiting = captureRejection(
      client.request(
        "host.echo",
        { message: "wait" },
        optionsFor(bearer, controller.signal, null, false, null),
      ),
    );
    controller.abort();
    const error = await waiting;
    expect(error).toBeInstanceOf(HostRequestAbortedError);
    if (!(error instanceof HostRequestAbortedError)) {
      throw new Error("expected the waiting call to abort");
    }
    expect(error.mayHaveDispatched).toBe(false);
    expect(sockets).toHaveLength(1);

    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const sent = requestFrames(discovering);
    expect(sent).toHaveLength(1);
    const discoveringRequest = sent[0];
    if (discoveringRequest === undefined) {
      throw new Error("expected the discovering request");
    }
    respondEcho(discovering.socket, discoveringRequest, "discover");
    await expect(discoveringCall).resolves.toEqual({ echoed: "discover" });
  });

  it("lets the next call dial when discovery fails before the socket exists", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const owner = captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        optionsFor(
          new MutableBearerLease("", USER_A),
          new AbortController().signal,
          null,
          false,
          null,
        ),
      ),
    );
    const waiter = client.request(
      "host.echo",
      { message: "waiter" },
      optionsFor(
        new MutableBearerLease("token-a", USER_A),
        new AbortController().signal,
        null,
        false,
        null,
      ),
    );
    const ownerError = await owner;
    expect(ownerError).toBeInstanceOf(HostRpcError);
    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    if (socket === undefined) {
      throw new Error("expected the waiter to dial");
    }
    await classify(socket, sessionAck(true));
    const sent = requestFrames(socket);
    expect(sent).toHaveLength(1);
    const frame = sent[0];
    if (frame === undefined) {
      throw new Error("expected the waiter request");
    }
    respondEcho(socket.socket, frame, "waiter");
    await expect(waiter).resolves.toEqual({ echoed: "waiter" });
  });

  it("dials again after an incompatible discovery instead of keeping the failure", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = captureRejection(
      client.request(
        "host.echo",
        { message: "first" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    discovering.socket.fireMessage({
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "host build is incompatible",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    const error = await first;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the incompatible handshake");
    }
    expect(error.code).toBe("INCOMPATIBLE");

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected a new dial");
    }
    await classify(retried, sessionAck(true));
    const sent = requestFrames(retried);
    const frame = sent[0];
    if (frame === undefined) {
      throw new Error("expected the retried request");
    }
    respondEcho(retried.socket, frame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("lets the next call dial when socket construction throws", async () => {
    const sockets: RecordedSocket[] = [];
    let creations = 0;
    const factory: IWebSocketFactory = {
      create(url: string, priority: DialPriority): WebSocketLike {
        void url;
        void priority;
        creations += 1;
        if (creations === 1) {
          throw new Error(
            "No global `WebSocket` available for the host transport on this runtime.",
          );
        }
        const socket = new StubWebSocket();
        sockets.push({ socket, sent: socket.sentFrames });
        return socket;
      },
    };
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = captureRejection(
      client.request(
        "host.echo",
        { message: "first" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const error = await first;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected socket construction to reject the call");
    }
    expect(error.message).toContain("No global");

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(1);
    const retried = sockets[0];
    if (retried === undefined) {
      throw new Error("expected the next call to dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the retried request");
    }
    respondEcho(retried.socket, frame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("closes an idle session when the client releases it and dials again", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = client.request(
      "host.echo",
      { message: "first" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const firstRequest = requestFrames(discovering)[0];
    if (firstRequest === undefined) {
      throw new Error("expected the first request");
    }
    respondEcho(discovering.socket, firstRequest, "first");
    await expect(first).resolves.toEqual({ echoed: "first" });
    expect(discovering.socket.closed).toBeNull();

    client.releaseIdleLocalSessions();
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected a new dial after the release");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the request on the new socket");
    }
    respondEcho(retried.socket, frame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("does not publish a socket that closed before adoption, and the next call dials", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = captureRejection(
      client.request(
        "host.echo",
        { message: "first" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    discovering.socket.closeOnAck = true;
    discovering.socket.fireMessage(sessionAck(true));

    const error = await first;
    expect(error).toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof RetryableTransportError)) {
      throw new Error("expected the closed handshake to be retryable");
    }
    expect(error.replaySafetyFromKey).toBe(false);
    expect(mayHaveReachedHost(error)).toBe(false);
    expect(error.message).toBe(
      "WebSocket closed (code=1006, reason='peer-dropped')",
    );
    expect(requestFrames(discovering)).toHaveLength(0);

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the next call to dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the retried request");
    }
    respondEcho(retried.socket, frame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("reports a fatal buffered behind openAck and does not publish the session", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = captureRejection(
      client.request(
        "host.echo",
        { message: "first" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    discovering.socket.fatalAfterAck = true;
    discovering.socket.fireMessage(sessionAck(true));

    const error = await first;
    expect(error).toBeInstanceOf(HostRpcError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the host fatal");
    }
    expect(error.message).toBe("host refused the session");
    expect(mayHaveReachedHost(error)).toBe(false);
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "ok",
    });

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the next call to dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the retried request");
    }
    respondEcho(retried.socket, frame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("closes a session released during an in-flight call once that call settles", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = client.request(
      "host.echo",
      { message: "first" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const firstRequest = requestFrames(discovering)[0];
    if (firstRequest === undefined) {
      throw new Error("expected the first request");
    }
    client.releaseIdleLocalSessions();
    expect(discovering.socket.closed).toBeNull();

    respondEcho(discovering.socket, firstRequest, "first");
    await expect(first).resolves.toEqual({ echoed: "first" });
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected a new dial after the released call settled");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the request on the new socket");
    }
    respondEcho(retried.socket, frame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("keeps the socket when a call starts after a release and before the previous call settles", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = client.request(
      "host.echo",
      { message: "first" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const firstRequest = requestFrames(discovering)[0];
    if (firstRequest === undefined) {
      throw new Error("expected the first request");
    }
    client.releaseIdleLocalSessions();
    const secondWrite = discovering.socket.nextSend();
    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await secondWrite;
    const secondRequest = requestFrames(discovering)[1];
    if (secondRequest === undefined) {
      throw new Error("expected the second request on the same socket");
    }
    expect(sockets).toHaveLength(1);

    respondEcho(discovering.socket, firstRequest, "first");
    respondEcho(discovering.socket, secondRequest, "second");
    await expect(first).resolves.toEqual({ echoed: "first" });
    await expect(second).resolves.toEqual({ echoed: "second" });
    expect(discovering.socket.closed).toBeNull();
  });

  it("fails discovery on a malformed frame after openAck and dials again", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = captureRejection(
      client.request(
        "host.echo",
        { message: "first" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    discovering.socket.trailingRaw = "not-json";
    discovering.socket.fireMessage(sessionAck(true));

    const error = await first;
    expect(error).toBeInstanceOf(HostRpcError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the malformed frame");
    }
    expect(error.code).toBe("RPC_ERROR");
    expect(error.message).toBe(
      "Malformed host frame: not valid JSON (length 8)",
    );
    expect(error.fatalDetails).toBeNull();
    expect(mayHaveReachedHost(error)).toBe(false);
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({ code: 1000, reason: "ok" });

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the next call to dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the retried request");
    }
    respondEcho(retried.socket, frame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("fails discovery on a schema-invalid frame after openAck and dials again", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = captureRejection(
      client.request(
        "host.echo",
        { message: "first" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    discovering.socket.trailingRaw = JSON.stringify({ kind: "nope" });
    discovering.socket.fireMessage(sessionAck(true));

    const error = await first;
    expect(error).toBeInstanceOf(HostRpcError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the invalid frame");
    }
    expect(error.message).toBe(
      "Malformed host frame: failed schema validation (length 15)",
    );
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({ code: 1000, reason: "ok" });

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the next call to dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the retried request");
    }
    respondEcho(retried.socket, frame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("fails discovery on a transport error after openAck and dials again", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = captureRejection(
      client.request(
        "host.echo",
        { message: "first" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    discovering.socket.trailingError = "socket reset";
    discovering.socket.fireMessage(sessionAck(true));

    const error = await first;
    expect(error).toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof RetryableTransportError)) {
      throw new Error("expected the transport error");
    }
    expect(error.message).toBe("WebSocket transport error: socket reset");
    expect(error.replaySafetyFromKey).toBe(false);
    expect(mayHaveReachedHost(error)).toBe(false);
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({ code: 1000, reason: "ok" });

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the next call to dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the retried request");
    }
    respondEcho(retried.socket, frame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("fails discovery when the authority aborts after openAck and dials again", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const controller = new AbortController();
    const first = captureRejection(
      client.request(
        "host.echo",
        { message: "first" },
        optionsFor(bearer, controller.signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    discovering.socket.abortOnAck = () => {
      controller.abort();
    };
    discovering.socket.fireMessage(sessionAck(true));

    const error = await first;
    expect(error).toBeInstanceOf(HostRequestAbortedError);
    if (!(error instanceof HostRequestAbortedError)) {
      throw new Error("expected the authority abort");
    }
    expect(error.mayHaveDispatched).toBe(false);
    expect(mayHaveReachedHost(error)).toBe(false);
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "authority-aborted",
    });

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the next call to dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the retried request");
    }
    respondEcho(retried.socket, frame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("closes the adopted socket when release arrives before the socket opens", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = client.request(
      "host.echo",
      { message: "first" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    client.releaseIdleLocalSessions();
    await classify(discovering, sessionAck(true));
    expect(discovering.socket.closed).toBeNull();
    const frame = requestFrames(discovering)[0];
    if (frame === undefined) {
      throw new Error("expected the discovering request");
    }
    respondEcho(discovering.socket, frame, "first");
    await expect(first).resolves.toEqual({ echoed: "first" });
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });

    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected a new dial after the released call settled");
    }
    await classify(retried, sessionAck(true));
    const retriedFrame = requestFrames(retried)[0];
    if (retriedFrame === undefined) {
      throw new Error("expected the request on the new socket");
    }
    respondEcho(retried.socket, retriedFrame, "second");
    await expect(second).resolves.toEqual({ echoed: "second" });
  });

  it("closes the adopted socket when release arrives while openAck is outstanding", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = client.request(
      "host.echo",
      { message: "first" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    client.releaseIdleLocalSessions();
    const requested = discovering.socket.nextSend();
    discovering.socket.fireMessage(sessionAck(true));
    await requested;
    expect(requestFrames(discovering)).toHaveLength(1);
    expect(discovering.socket.closed).toBeNull();
    const frame = requestFrames(discovering)[0];
    if (frame === undefined) {
      throw new Error("expected the discovering request");
    }
    respondEcho(discovering.socket, frame, "first");
    await expect(first).resolves.toEqual({ echoed: "first" });
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("keeps the socket when a call claims the session after publish", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const first = client.request(
      "host.echo",
      { message: "first" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    client.releaseIdleLocalSessions();
    await classify(discovering, sessionAck(true));
    const secondWrite = discovering.socket.nextSend();
    const second = client.request(
      "host.echo",
      { message: "second" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await secondWrite;
    const sent = requestFrames(discovering);
    const firstRequest = sent[0];
    const secondRequest = sent[1];
    if (firstRequest === undefined || secondRequest === undefined) {
      throw new Error("expected both requests on the released socket");
    }
    expect(sockets).toHaveLength(1);
    respondEcho(discovering.socket, firstRequest, "first");
    respondEcho(discovering.socket, secondRequest, "second");
    await expect(first).resolves.toEqual({ echoed: "first" });
    await expect(second).resolves.toEqual({ echoed: "second" });
    expect(discovering.socket.closed).toBeNull();
  });

  it("closes the socket after both calls admitted before openAck settle when release arrives during the dial", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const owner = client.request(
      "host.echo",
      { message: "owner" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const waiter = client.request(
      "host.echo",
      { message: "waiter" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    expect(sockets).toHaveLength(1);
    client.releaseIdleLocalSessions();
    await classify(discovering, sessionAck(true));
    const sent = requestFrames(discovering);
    const ownerFrame = sent[0];
    const waiterFrame = sent[1];
    if (ownerFrame === undefined || waiterFrame === undefined) {
      throw new Error("expected both requests on the discovering socket");
    }
    expect(sockets).toHaveLength(1);
    expect(discovering.socket.closed).toBeNull();
    respondEcho(discovering.socket, ownerFrame, "owner");
    await expect(owner).resolves.toEqual({ echoed: "owner" });
    expect(discovering.socket.closed).toBeNull();
    respondEcho(discovering.socket, waiterFrame, "waiter");
    await expect(waiter).resolves.toEqual({ echoed: "waiter" });
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes the socket when the waiting call runs after publish records the dial release", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const owner = client.request(
      "host.echo",
      { message: "owner" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const waiter = client.request(
      "host.echo",
      { message: "waiter" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    client.releaseIdleLocalSessions();
    const ownerSent = discovering.socket.nextSend();
    discovering.socket.fireMessage(sessionAck(true));
    await ownerSent;
    const waiterSent = discovering.socket.nextSend();
    await waiterSent;
    const sent = requestFrames(discovering);
    const ownerFrame = sent[0];
    const waiterFrame = sent[1];
    if (ownerFrame === undefined || waiterFrame === undefined) {
      throw new Error("expected the waiter request after publish");
    }
    expect(sockets).toHaveLength(1);
    expect(discovering.socket.closed).toBeNull();
    respondEcho(discovering.socket, ownerFrame, "owner");
    await expect(owner).resolves.toEqual({ echoed: "owner" });
    expect(discovering.socket.closed).toBeNull();
    respondEcho(discovering.socket, waiterFrame, "waiter");
    await expect(waiter).resolves.toEqual({ echoed: "waiter" });
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("lets a waiter with a valid bearer dial after the owner's open credential is refused", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const ownerBearer = new MutableBearerLease("stale-token", USER_A);
    const waiterBearer = new MutableBearerLease("fresh-token", USER_A);
    const revalidated: MutableBearerLease[] = [];
    const wrapped = createAuthAwareMessenger<typeof testRegistry>(
      client,
      {
        revalidateExpectedBearer: (expected) => {
          if (expected instanceof MutableBearerLease) {
            revalidated.push(expected);
          }
          return Promise.resolve("rejected");
        },
      },
      "always",
    );
    const owner = captureRejection(
      wrapped.request(
        "host.echo",
        { message: "owner" },
        optionsFor(
          ownerBearer,
          new AbortController().signal,
          null,
          false,
          null,
        ),
      ),
    );
    const waiter = wrapped.request(
      "host.echo",
      { message: "waiter" },
      optionsFor(waiterBearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(1);
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    expect(openFrames(discovering)[0]?.token).toBe("stale-token");
    client.releaseIdleLocalSessions();
    discovering.socket.fireMessage({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "stale bearer",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: false,
      },
    });

    const ownerError = await owner;
    expect(ownerError).toBeInstanceOf(HostRpcError);
    expect(ownerError).not.toBeInstanceOf(RetryableTransportError);
    if (!(ownerError instanceof HostRpcError)) {
      throw new Error("expected the owner's refusal");
    }
    expect(ownerError.code).toBe("UNAUTHORIZED");
    expect(ownerError.requestId).toBe("req-1");
    expect(ownerError.method).toBe("host.echo");
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(revalidated).toEqual([ownerBearer]);

    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the waiter to dial");
    }
    await classify(retried, sessionAck(true));
    expect(openFrames(retried)[0]?.token).toBe("fresh-token");
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the waiter's request");
    }
    expect(frame.token).toBe("fresh-token");
    respondEcho(retried.socket, frame, "waiter");
    await expect(waiter).resolves.toEqual({ echoed: "waiter" });
    expect(revalidated).toEqual([ownerBearer]);
    expect(retried.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
    expect(sockets).toHaveLength(2);
  });

  it("gives each waiter its own error when discovery fails for every caller", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const owner = captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const statusWaiter = captureRejection(
      client.request(
        "host.status",
        {},
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const echoWaiter = captureRejection(
      client.request(
        "host.echo",
        { message: "other" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    discovering.socket.fireMessage({
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "host build is incompatible",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    const ownerError = await owner;
    const statusError = await statusWaiter;
    const echoError = await echoWaiter;
    expect(ownerError).toBeInstanceOf(HostRpcError);
    expect(statusError).toBeInstanceOf(HostRpcError);
    expect(echoError).toBeInstanceOf(HostRpcError);
    if (
      !(ownerError instanceof HostRpcError) ||
      !(statusError instanceof HostRpcError) ||
      !(echoError instanceof HostRpcError)
    ) {
      throw new Error("expected each discovery caller to fail");
    }
    expect(statusError).not.toBe(ownerError);
    expect(echoError).not.toBe(ownerError);
    expect(echoError).not.toBe(statusError);
    expect(ownerError.requestId).toBe("req-1");
    expect(ownerError.method).toBe("host.echo");
    expect(statusError.requestId).toBe("req-2");
    expect(statusError.method).toBe("host.status");
    expect(echoError.requestId).toBe("req-3");
    expect(echoError.method).toBe("host.echo");
    expect(statusError.message).toBe(ownerError.message);
    expect(echoError.message).toBe(ownerError.message);
    expect(statusError.code).toBe("INCOMPATIBLE");
    expect(echoError.code).toBe("INCOMPATIBLE");
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });

  it("does not refresh a bearer for a retryable session unauthorized, and does for a permanent one", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const revalidated: MutableBearerLease[] = [];
    const wrapped = createAuthAwareMessenger<typeof testRegistry>(
      client,
      {
        revalidateExpectedBearer: (expected) => {
          if (expected instanceof MutableBearerLease) {
            revalidated.push(expected);
          }
          return Promise.resolve("rejected");
        },
      },
      "always",
    );
    const transient = captureRejection(
      wrapped.request(
        "host.echo",
        { message: "transient" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const keptWrite = discovering.socket.nextSend();
    const kept = wrapped.request(
      "host.echo",
      { message: "kept" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await keptWrite;
    const sent = requestFrames(discovering);
    const transientRequest = sent[0];
    const keptRequest = sent[1];
    if (transientRequest === undefined || keptRequest === undefined) {
      throw new Error("expected both session requests");
    }
    discovering.socket.fireMessage({
      kind: "response",
      requestId: transientRequest.requestId,
      method: transientRequest.method,
      schemaVersion: transientRequest.schemaVersion,
      result: null,
      error: {
        code: "UNAUTHORIZED",
        message: "verifier unreachable",
        retryable: true,
      },
    });
    const transientError = await transient;
    expect(transientError).toBeInstanceOf(RetryableTransportError);
    if (!(transientError instanceof RetryableTransportError)) {
      throw new Error("expected the transient unauthorized");
    }
    expect(transientError.code).toBe("UNAUTHORIZED");
    expect(transientError.replaySafetyFromKey).toBe(false);
    expect(mayHaveReachedHost(transientError)).toBe(false);
    expect(transientError.fatalDetails?.retryable).toBe(true);
    expect(revalidated).toEqual([]);

    respondEcho(discovering.socket, keptRequest, "kept");
    await expect(kept).resolves.toEqual({ echoed: "kept" });
    expect(discovering.socket.closed).toBeNull();
    expect(sockets).toHaveLength(1);

    const permanentWrite = discovering.socket.nextSend();
    const permanent = captureRejection(
      wrapped.request(
        "host.echo",
        { message: "permanent" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    await permanentWrite;
    const permanentRequest = requestFrames(discovering)[2];
    if (permanentRequest === undefined) {
      throw new Error("expected the permanent unauthorized request");
    }
    discovering.socket.fireMessage({
      kind: "response",
      requestId: permanentRequest.requestId,
      method: permanentRequest.method,
      schemaVersion: permanentRequest.schemaVersion,
      result: null,
      error: { code: "UNAUTHORIZED", message: "Invalid or expired token" },
    });
    const permanentError = await permanent;
    expect(permanentError).toBeInstanceOf(HostRpcError);
    expect(permanentError).not.toBeInstanceOf(RetryableTransportError);
    if (!(permanentError instanceof HostRpcError)) {
      throw new Error("expected the permanent unauthorized");
    }
    expect(permanentError.fatalDetails).toBeNull();
    expect(revalidated).toEqual([bearer]);
    expect(discovering.socket.closed).toBeNull();

    const laterWrite = discovering.socket.nextSend();
    const later = client.request(
      "host.echo",
      { message: "later" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await laterWrite;
    const laterRequest = requestFrames(discovering)[3];
    if (laterRequest === undefined) {
      throw new Error("expected a later call on the same session");
    }
    respondEcho(discovering.socket, laterRequest, "later");
    await expect(later).resolves.toEqual({ echoed: "later" });
    expect(sockets).toHaveLength(1);
  });

  it("completes a call only through settle", () => {
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../local-unary-session.ts",
      ),
      "utf8",
    );
    expect(source.includes("call.fail")).toBe(false);
    expect(source.includes("call.succeed")).toBe(false);
    expect(source.split("call.resolve(").length - 1).toBe(1);
    expect(source.split("call.reject(").length - 1).toBe(1);
  });

  it("aborts a queued session call before send and retires the released session", async () => {
    const { session, socket } = directEchoSession({
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
    });
    session.retainDialRelease();
    const controller = new AbortController();
    controller.abort();
    const error = await captureRejection(
      echoCall(session, "req-queued", controller.signal),
    );
    expect(error).toBeInstanceOf(HostRequestAbortedError);
    if (!(error instanceof HostRequestAbortedError)) {
      throw new Error("expected the queued abort");
    }
    expect(error.mayHaveDispatched).toBe(false);
    expect(socket.sent).toHaveLength(0);
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
    expect(session.isRetired).toBe(true);
  });

  it("aborts a call in pump when the signal flips after it is queued", async () => {
    const { session, socket } = directEchoSession({
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
    });
    session.retainDialRelease();
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get: () => {
        reads += 1;
        return reads >= 2;
      },
    });
    const error = await captureRejection(
      echoCall(session, "req-pump", controller.signal),
    );
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(error).toBeInstanceOf(HostRequestAbortedError);
    expect(socket.sent).toHaveLength(0);
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
  });

  it("closes a released session when the version floor fails before send", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const refused = captureRejection(
      client.request(
        "host.echo",
        { message: "floor" },
        versionFloorOptions(bearer),
      ),
    );
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.fireMessage(sessionAck(true));
    const error = await refused;
    expect(error).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("lets a waiter send when the discovering call fails the version floor", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const owner = captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        versionFloorOptions(bearer),
      ),
    );
    const waiter = client.request(
      "host.echo",
      { message: "waiter" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = await releaseOutstandingHandshake(client, sockets);
    const waiterSent = discovering.socket.nextSend();
    discovering.socket.fireMessage(sessionAck(true));
    await waiterSent;
    const error = await owner;
    expect(error).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    const frame = requestFrames(discovering)[0];
    if (frame === undefined) {
      throw new Error("expected the waiter request");
    }
    expect(frame.params).toEqual({ message: "waiter" });
    expect(discovering.socket.closed).toBeNull();
    respondEcho(discovering.socket, frame, "waiter");
    await expect(waiter).resolves.toEqual({ echoed: "waiter" });
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
    expect(sockets).toHaveLength(1);
  });

  it("closes a released session when the client manifest omits the method", async () => {
    const { session, socket } = directEchoSession({
      clientManifest: { "host.status": { major: 1, minor: 0 } },
      hostManifest: BOTH_MANIFESTS,
    });
    session.retainDialRelease();
    const error = await captureRejection(
      echoCall(session, "req-client", new AbortController().signal),
    );
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the missing client canonical");
    }
    expect(error.message).toBe(
      "Client registry has no canonical manifest entry for method 'host.echo'",
    );
    expect(socket.sent).toHaveLength(0);
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
  });

  it("closes a released session when the host omits a method with no degrade", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const refused = captureRejection(
      client.request(
        "host.echo",
        { message: "missing" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.fireMessage({
      kind: "openAck",
      manifest: { "host.status": { major: 1, minor: 0 } },
      optionalManifest: {},
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    const error = await refused;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the missing degrade");
    }
    expect(error.message).toBe(
      "Host does not advertise method 'host.echo', and the client registry declares no degrade strategy",
    );
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when the method degrades as unsupported", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClientFor(degradeRegistry, factory);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const refused = captureRejection(
      client.request(
        "host.unsupported",
        { message: "nope" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    client.releaseIdleLocalSessions();
    discovering.socket.fireMessage({
      kind: "openAck",
      manifest: { "host.status": { major: 1, minor: 0 } },
      optionalManifest: {},
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    const error = await refused;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the unsupported degrade");
    }
    expect(error.code).toBe("E_HOST_UNSUPPORTED");
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when the fallback target is absent", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClientFor(degradeRegistry, factory);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const refused = captureRejection(
      client.request(
        "host.gap",
        { message: "gap" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    client.releaseIdleLocalSessions();
    discovering.socket.fireMessage({
      kind: "openAck",
      manifest: { "host.status": { major: 1, minor: 0 } },
      optionalManifest: {},
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    const error = await refused;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the absent fallback");
    }
    expect(error.message).toBe(
      "Fallback for method 'host.gap' targets unavailable floor method 'host.spare'",
    );
    // The target is installed on the client and absent from the host
    // manifest. `defineVersionedRpcRegistry` does not reject a missing
    // target; that arm is the unknown-target test below.
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("returns the adapted fallback and then closes a released session", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClientFor(degradeRegistry, factory);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const pending = client.request(
      "host.extra",
      { message: "extra" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    client.releaseIdleLocalSessions();
    const requested = discovering.socket.nextSend();
    discovering.socket.fireMessage({
      kind: "openAck",
      manifest: { "host.status": { major: 1, minor: 0 } },
      optionalManifest: {},
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    await requested;
    const frame = requestFrames(discovering)[0];
    if (frame === undefined) {
      throw new Error("expected the fallback request");
    }
    expect(frame.method).toBe("host.status");
    expect(frame.params).toEqual({});
    expect(discovering.socket.closed).toBeNull();
    respondStatus(discovering.socket, frame, true);
    await expect(pending).resolves.toEqual({ echoed: "adapted" });
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when fallback adaptRequest throws", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClientFor(degradeRegistry, factory);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const refused = captureRejection(
      client.request(
        "host.broken",
        { message: "broken" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    client.releaseIdleLocalSessions();
    discovering.socket.fireMessage({
      kind: "openAck",
      manifest: { "host.status": { major: 1, minor: 0 } },
      optionalManifest: {},
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    const error = await refused;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected the adapt rejection");
    }
    expect(error.message).toBe("adapt rejected");
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when preparing the payload rejects the downgrade", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClientFor(downgradeRegistry, factory);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const refused = captureRejection(
      client.request(
        "host.echo",
        { message: "newer" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    client.releaseIdleLocalSessions();
    discovering.socket.fireMessage({
      kind: "openAck",
      manifest: {},
      optionalManifest: { "host.echo": { major: 1, minor: 0 } },
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    const error = await refused;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the downgrade refusal");
    }
    expect(error.code).toBe("DOWNGRADE_UNSUPPORTED");
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when the host minor is not installed", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClientFor(hostMinorAbsentRegistry, factory);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const refused = captureRejection(
      client.request(
        "host.echo",
        { message: "newer" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    client.releaseIdleLocalSessions();
    discovering.socket.fireMessage({
      kind: "openAck",
      manifest: {},
      optionalManifest: { "host.echo": { major: 1, minor: 0 } },
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    const error = await refused;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the missing older minor");
    }
    expect(error.message).toBe(
      "No installed contract for method 'host.echo' 1.0",
    );
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when a replay key cannot be honoured", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const replay = captureRejection(
      client.request(
        "host.echo",
        { message: "replay" },
        optionsFor(
          bearer,
          new AbortController().signal,
          "must-key",
          true,
          null,
        ),
      ),
    );
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.fireMessage(sessionAck(false));
    const error = await replay;
    expect(error).toBeInstanceOf(HostTransportFailureError);
    if (!(error instanceof HostTransportFailureError)) {
      throw new Error("expected the unkeyed replay refusal");
    }
    expect(error.fatalDetails).not.toBeNull();
    expect(mayHaveReachedHost(error)).toBe(false);
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
    const followUp = client.request(
      "host.echo",
      { message: "fresh" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected a new dial after the released refusal");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the follow-up on the new socket");
    }
    respondEcho(retried.socket, frame, "fresh");
    await expect(followUp).resolves.toEqual({ echoed: "fresh" });
  });

  it("closes a released session when the bearer lease is empty before send", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const refused = captureRejection(
      client.request(
        "host.echo",
        { message: "late" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    bearer.rotate("");
    client.releaseIdleLocalSessions();
    discovering.socket.fireMessage(sessionAck(true));
    const error = await refused;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the released lease");
    }
    expect(error.message).toContain("No bearer available");
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("keeps a released session up until the original in-flight id settles", async () => {
    const { session, socket } = directEchoSession({
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
    });
    session.retainDialRelease();
    const first = echoCall(session, "req-dup", new AbortController().signal);
    const duplicate = await captureRejection(
      echoCall(session, "req-dup", new AbortController().signal),
    );
    expect(duplicate).toBeInstanceOf(HostRpcError);
    if (!(duplicate instanceof HostRpcError)) {
      throw new Error("expected the duplicate id");
    }
    expect(duplicate.message).toBe(
      "Duplicate request id 'req-dup' on the persistent session",
    );
    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toBeNull();
    session.handlers.onFrame({
      kind: "response",
      requestId: "req-dup",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "req-dup" },
      error: null,
    });
    await expect(first).resolves.toEqual({ echoed: "req-dup" });
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
  });

  it("carries a dial release onto the socket opened after a pre-ack close", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const { owner, waiter } = admittedPair(client);
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.fireClose(1006, "peer-dropped", false);
    await owner;
    await expectReplacementClosed(sockets, waiter);
  });

  it("carries a dial release onto the socket opened after an authority abort", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const controller = new AbortController();
    const owner = captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        optionsFor(bearer, controller.signal, null, false, null),
      ),
    );
    const waiter = client.request(
      "host.echo",
      { message: "waiter" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.abortOnAck = () => {
      controller.abort();
    };
    discovering.socket.fireMessage(sessionAck(true));
    await owner;
    await expectReplacementClosed(sockets, waiter);
  });

  it("carries a dial release onto the socket opened after a transport error", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const { owner, waiter } = admittedPair(client);
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.trailingError = "socket reset";
    discovering.socket.fireMessage(sessionAck(true));
    await owner;
    await expectReplacementClosed(sockets, waiter);
  });

  it("carries a dial release onto the socket opened after a malformed frame", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const { owner, waiter } = admittedPair(client);
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.trailingRaw = "not-json";
    discovering.socket.fireMessage(sessionAck(true));
    await owner;
    await expectReplacementClosed(sockets, waiter);
  });

  it("carries a dial release onto the socket opened after a schema-invalid frame", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const { owner, waiter } = admittedPair(client);
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.trailingRaw = JSON.stringify({ kind: "nope" });
    discovering.socket.fireMessage(sessionAck(true));
    await owner;
    await expectReplacementClosed(sockets, waiter);
  });

  it("carries a dial release onto the socket opened after a non-ack frame", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const { owner, waiter } = admittedPair(client);
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.fireMessage({
      kind: "response",
      requestId: "req-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "early" },
      error: null,
    });
    await owner;
    await expectReplacementClosed(sockets, waiter);
  });

  it("does not carry a dial release onto a later call after a connection-wide failure", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const { owner, waiter } = admittedPair(client);
    const waiterError = captureRejection(waiter);
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.fireMessage({
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "host build is incompatible",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    await owner;
    await waiterError;
    expect(sockets).toHaveLength(1);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const later = client.request(
      "host.echo",
      { message: "later" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the later dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the later request");
    }
    respondEcho(retried.socket, frame, "later");
    await expect(later).resolves.toEqual({ echoed: "later" });
    expect(retried.socket.closed).toBeNull();
  });

  it("keeps the published session open when release arrives before an admitted waiter enters", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const owner = captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        versionFloorOptions(bearer),
      ),
    );
    const waiter = client.request(
      "host.echo",
      { message: "waiter" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = await openDiscoveringSocket(sockets);
    const waiterSent = discovering.socket.nextSend();
    discovering.socket.fireMessage(sessionAck(true));
    queueMicrotask(() => {
      client.releaseIdleLocalSessions();
    });
    await waiterSent;
    const error = await owner;
    expect(error).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    const frame = requestFrames(discovering)[0];
    if (frame === undefined) {
      throw new Error("expected the waiter request");
    }
    expect(frame.params).toEqual({ message: "waiter" });
    expect(discovering.socket.closed).toBeNull();
    respondEcho(discovering.socket, frame, "waiter");
    await expect(waiter).resolves.toEqual({ echoed: "waiter" });
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
    expect(sockets).toHaveLength(1);
  });

  it("carries a dial release that arrives after a pre-ack close and before the waiter resumes", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const { owner, waiter } = admittedPair(client);
    const discovering = await openDiscoveringSocket(sockets);
    discovering.socket.fireClose(1006, "peer-dropped", false);
    queueMicrotask(() => {
      client.releaseIdleLocalSessions();
    });
    await owner;
    await expectReplacementClosed(sockets, waiter);
  });

  it("drops the retry when the handed waiter aborts before it claims", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const waiterController = new AbortController();
    const owner = captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const waiter = captureRejection(
      client.request(
        "host.echo",
        { message: "waiter" },
        optionsFor(bearer, waiterController.signal, null, false, null),
      ),
    );
    const discovering = await openDiscoveringSocket(sockets);
    client.releaseIdleLocalSessions();
    discovering.socket.fireClose(1006, "peer-dropped", false);
    queueMicrotask(() => {
      waiterController.abort();
    });
    await owner;
    const waiterError = await waiter;
    expect(waiterError).toBeInstanceOf(HostRequestAbortedError);
    const later = client.request(
      "host.echo",
      { message: "later" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the later dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the later request");
    }
    respondEcho(retried.socket, frame, "later");
    await expect(later).resolves.toEqual({ echoed: "later" });
    expect(retried.socket.closed).toBeNull();
  });

  it("dials the next caller when the handed waiter aborts before it claims", async () => {
    const { factory, sockets, nextSocket } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const waiterController = new AbortController();
    const owner = captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const waiter = captureRejection(
      client.request(
        "host.echo",
        { message: "waiter" },
        optionsFor(bearer, waiterController.signal, null, false, null),
      ),
    );
    const discovering = await openDiscoveringSocket(sockets);
    const replacement = nextSocket();
    client.releaseIdleLocalSessions();
    let follower: Promise<{ readonly echoed: string }> | null = null;
    discovering.socket.fireClose(1006, "peer-dropped", false);
    queueMicrotask(() => {
      waiterController.abort();
      follower = client.request(
        "host.echo",
        { message: "waiter" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      );
    });
    await owner;
    const waiterError = await waiter;
    expect(waiterError).toBeInstanceOf(HostRequestAbortedError);
    await replacement;
    const next = follower;
    if (next === null) {
      throw new Error("expected the next caller");
    }
    await expectReplacementClosed(sockets, next);
  });

  it("carries a dial release when the first handed waiter fails before the second claims", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearerA = new MutableBearerLease("token-a", USER_A);
    const bearerB = new MutableBearerLease("token-b", USER_A);
    const bearerC = new MutableBearerLease("token-c", USER_A);
    const owner = captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        optionsFor(bearerA, new AbortController().signal, null, false, null),
      ),
    );
    const bridge = captureRejection(
      client.request(
        "host.echo",
        { message: "bridge" },
        optionsFor(bearerB, new AbortController().signal, null, false, null),
      ),
    );
    const survivor = client.request(
      "host.echo",
      { message: "waiter" },
      optionsFor(bearerC, new AbortController().signal, null, false, null),
    );
    const discovering = await openDiscoveringSocket(sockets);
    client.releaseIdleLocalSessions();
    bearerB.rotate("");
    discovering.socket.fireClose(1006, "peer-dropped", false);
    const ownerError = await owner;
    expect(ownerError).toBeInstanceOf(Error);
    const bridgeError = await bridge;
    expect(bridgeError).toBeInstanceOf(HostRpcError);
    if (!(bridgeError instanceof HostRpcError)) {
      throw new Error("expected the released lease to fail the first waiter");
    }
    expect(bridgeError.message).toContain("No bearer available");
    await expectReplacementClosed(sockets, survivor);
  });

  it("carries a dial release onto the socket opened after a dial timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const { factory, sockets, nextSocket } = makeFactory();
      const client = makeTimedClient(factory, 5_000, 5_000);
      const { owner, waiter } = admittedPair(client);
      expect(sockets).toHaveLength(1);
      client.releaseIdleLocalSessions();
      const replacement = nextSocket();
      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await owner;
      expect(outcome).toBeInstanceOf(RetryableTransportError);
      if (!(outcome instanceof Error)) {
        throw new Error("expected the dial timeout");
      }
      expect(outcome.message).toContain("WebSocket dial timed out");
      await completeReplacementOnFakeClock(sockets, waiter, replacement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries a dial release onto the socket opened after an ack timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const { factory, sockets, nextSocket } = makeFactory();
      const client = makeTimedClient(factory, 5_000, 5_000);
      const { owner, waiter } = admittedPair(client);
      const discovering = sockets[0];
      if (discovering === undefined) {
        throw new Error("expected the discovering socket");
      }
      const opened = discovering.socket.nextSend();
      discovering.socket.fireOpen();
      await opened;
      client.releaseIdleLocalSessions();
      const replacement = nextSocket();
      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await owner;
      expect(outcome).toBeInstanceOf(RetryableTransportError);
      if (!(outcome instanceof Error)) {
        throw new Error("expected the ack timeout");
      }
      expect(outcome.message).toContain("WebSocket frame timed out");
      await completeReplacementOnFakeClock(sockets, waiter, replacement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries a dial release onto the socket opened after a downgrade compatibility failure", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClientFor(statusNoBridgeRegistry, factory);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const owner = captureRejection(
      client.request(
        "host.status",
        {},
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const waiter = client.request(
      "host.status",
      {},
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = await openDiscoveringSocket(sockets);
    client.releaseIdleLocalSessions();
    discovering.socket.fireMessage(statusAck(1));
    const error = await owner;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the downgrade failure");
    }
    expect(error.code).toBe("DOWNGRADE_UNSUPPORTED");
    expect(error.fatalDetails).toBeNull();
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the replacement dial");
    }
    await classify(retried, statusAck(2));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the waiter request on the replacement");
    }
    expect(frame.method).toBe("host.status");
    respondStatus(retried.socket, frame, true);
    await expect(waiter).resolves.toEqual({ ready: true });
    expect(retried.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("does not arm a later call when a released dial retries with nobody waiting", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const owner = captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = await releaseOutstandingHandshake(client, sockets);
    discovering.socket.fireClose(1006, "peer-dropped", false);
    await owner;
    expect(sockets).toHaveLength(1);
    const later = client.request(
      "host.echo",
      { message: "later" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the later dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the later request");
    }
    respondEcho(retried.socket, frame, "later");
    await expect(later).resolves.toEqual({ echoed: "later" });
    expect(retried.socket.closed).toBeNull();
  });

  it("closes the published session when the admitted waiter's abort releases the last hold", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const waiterController = new AbortController();
    const owner = captureRejection(
      client.request(
        "host.echo",
        { message: "owner" },
        versionFloorOptions(bearer),
      ),
    );
    const waiter = captureRejection(
      client.request(
        "host.echo",
        { message: "waiter" },
        optionsFor(bearer, waiterController.signal, null, false, null),
      ),
    );
    const discovering = await releaseOutstandingHandshake(client, sockets);
    const waiterSent = discovering.socket.nextSend();
    discovering.socket.fireMessage(sessionAck(true));
    await waiterSent;
    expect(discovering.socket.closed).toBeNull();
    waiterController.abort();
    const waiterError = await waiter;
    expect(waiterError).toBeInstanceOf(HostRequestAbortedError);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
    const ownerError = await owner;
    expect(ownerError).toBeInstanceOf(HostMethodVersionUnsatisfiedError);
    expect(sockets).toHaveLength(1);
  });

  it("does not retire a published session when a dial hold from before the retry releases", async () => {
    const directory = new LocalUnarySessionDirectory<typeof testRegistry>();
    const key = localUnarySessionKey(HOST_ID, USER_A, SOCKET_URL);
    const first = directory.claim(key, null);
    if (first.kind !== "owner") {
      throw new Error("expected the discovering dial");
    }
    const waiting = directory.claim(key, null);
    if (waiting.kind !== "wait") {
      throw new Error("expected a waiter");
    }
    const hold = directory.acquireDialHold(key);
    const handed = waiting.settled.then((result) => {
      if (result.kind !== "retry") {
        throw new Error("expected the handed retry");
      }
      return result.handoff;
    });
    first.publish.retry();
    const next = directory.claim(key, await handed);
    if (next.kind !== "owner") {
      throw new Error("expected the handed retry");
    }
    const session = new LocalUnarySession<typeof testRegistry>({
      key,
      registry: testRegistry,
      hostId: HOST_ID,
      directory,
    });
    const socket = new RecordingSocket();
    session.attach({
      socket,
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
      idempotency: true,
    });
    next.publish.ready(session);
    hold.release();
    expect(session.isRetired).toBe(false);
    expect(socket.closed).toBeNull();
  });

  it("drops a leftover retry without copying its release onto the next dial", () => {
    const directory = new LocalUnarySessionDirectory<typeof testRegistry>();
    const key = localUnarySessionKey(HOST_ID, USER_A, SOCKET_URL);
    const first = directory.claim(key, null);
    if (first.kind !== "owner") {
      throw new Error("expected the discovering dial");
    }
    const waiting = directory.claim(key, null);
    if (waiting.kind !== "wait") {
      throw new Error("expected a waiter");
    }
    directory.releaseIdle();
    first.publish.retry();
    waiting.relinquish();
    const fresh = directory.claim(key, null);
    if (fresh.kind !== "owner") {
      throw new Error("expected a fresh dial");
    }
    const session = new LocalUnarySession<typeof testRegistry>({
      key,
      registry: testRegistry,
      hostId: HOST_ID,
      directory,
    });
    const socket = new RecordingSocket();
    session.attach({
      socket,
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
      idempotency: true,
    });
    fresh.publish.ready(session);
    expect(directory.consumeReleaseBeforeReady(key, session)).toBe(false);
    expect(session.isRetired).toBe(false);
    expect(socket.closed).toBeNull();
  });

  it("does not carry a dial release that arrives after a connection-wide failure", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const { owner, waiter } = admittedPair(client);
    const waiterError = captureRejection(waiter);
    const discovering = await openDiscoveringSocket(sockets);
    discovering.socket.fireMessage({
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "host build is incompatible",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    queueMicrotask(() => {
      client.releaseIdleLocalSessions();
    });
    await owner;
    await waiterError;
    expect(sockets).toHaveLength(1);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const later = client.request(
      "host.echo",
      { message: "later" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    expect(sockets).toHaveLength(2);
    const retried = sockets[1];
    if (retried === undefined) {
      throw new Error("expected the later dial");
    }
    await classify(retried, sessionAck(true));
    const frame = requestFrames(retried)[0];
    if (frame === undefined) {
      throw new Error("expected the later request");
    }
    respondEcho(retried.socket, frame, "later");
    await expect(later).resolves.toEqual({ echoed: "later" });
    expect(retried.socket.closed).toBeNull();
  });

  it("closes a released session when sending the request throws", async () => {
    const { session, socket } = directEchoSession({
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
    });
    session.retainDialRelease();
    socket.failSend = "request";
    const error = await captureRejection(
      echoCall(session, "req-send", new AbortController().signal),
    );
    expect(error).toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof Error)) {
      throw new Error("expected the send failure");
    }
    expect(error.message).toContain("send request failed");
    expect(socket.sent.map((frame) => frame.kind)).toEqual(["request"]);
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
  });

  it("closes a released session when the response method does not match", async () => {
    const { session, socket } = directEchoSession({
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
    });
    session.retainDialRelease();
    const pending = captureRejection(
      echoCall(session, "req-mismatch", new AbortController().signal),
    );
    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toBeNull();
    session.handlers.onFrame({
      kind: "response",
      requestId: "req-mismatch",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      result: null,
      error: null,
    });
    const error = await pending;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the method mismatch");
    }
    expect(error.message).toBe(
      "Response method 'host.status' does not match request method 'host.echo'",
    );
    expect(mayHaveReachedHost(error)).toBe(true);
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
  });

  it("closes a released session when upgrading the response throws", async () => {
    const { session, socket } = directSession(decodeThrowRegistry, {
      clientManifest: { "host.echo": { major: 1, minor: 1 } },
      hostManifest: { "host.echo": { major: 1, minor: 0 } },
    });
    session.retainDialRelease();
    const bearer = new MutableBearerLease("token-a", USER_A);
    const pending = captureRejection(
      session.call({
        requestId: "req-decode",
        method: "host.echo",
        params: { message: "hi" },
        responseTimeoutMs: 5_000,
        options: optionsFor(
          bearer,
          new AbortController().signal,
          null,
          false,
          null,
        ),
        boundToDialRelease: true,
      }),
    );
    expect(socket.sent).toHaveLength(1);
    expect(socket.closed).toBeNull();
    session.handlers.onFrame({
      kind: "response",
      requestId: "req-decode",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "hi" },
      error: null,
    });
    const error = await pending;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the response upgrade failure");
    }
    expect(error.message).toContain("response upgrade rejected");
    expect(mayHaveReachedHost(error)).toBe(true);
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
  });

  it("closes a released session when sending the cancel throws", async () => {
    const { session, socket } = directEchoSession({
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
    });
    session.retainDialRelease();
    const controller = new AbortController();
    const pending = captureRejection(
      echoCall(session, "req-cancel", controller.signal),
    );
    expect(socket.sent).toHaveLength(1);
    socket.failSend = "cancel";
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(HostRequestAbortedError);
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
  });

  it("closes a released session when a malformed frame arrives after adoption", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const pending = captureRejection(
      client.request(
        "host.echo",
        { message: "adopted" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = await openDiscoveringSocket(sockets);
    const requested = discovering.socket.nextSend();
    discovering.socket.fireMessage(sessionAck(true));
    await requested;
    client.releaseIdleLocalSessions();
    expect(discovering.socket.closed).toBeNull();
    discovering.socket.onmessage?.({ data: "not-json" });
    const error = await pending;
    expect(error).toBeInstanceOf(HostTransportFailureError);
    if (!(error instanceof Error)) {
      throw new Error("expected the malformed frame");
    }
    expect(error.message).toContain("Malformed host frame");
    expect(mayHaveReachedHost(error)).toBe(true);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when an unexpected frame arrives after adoption", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const pending = captureRejection(
      client.request(
        "host.echo",
        { message: "adopted" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = await openDiscoveringSocket(sockets);
    const requested = discovering.socket.nextSend();
    discovering.socket.fireMessage(sessionAck(true));
    await requested;
    client.releaseIdleLocalSessions();
    expect(discovering.socket.closed).toBeNull();
    discovering.socket.fireMessage(sessionAck(true));
    const error = await pending;
    expect(error).toBeInstanceOf(HostTransportFailureError);
    if (!(error instanceof Error)) {
      throw new Error("expected the unexpected frame");
    }
    expect(error.message).toContain("Unexpected host frame 'openAck'");
    expect(mayHaveReachedHost(error)).toBe(true);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when fallback adaptResponse throws", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClientFor(degradeRegistry, factory);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const refused = captureRejection(
      client.request(
        "host.adapt",
        { message: "adapt" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    client.releaseIdleLocalSessions();
    const requested = discovering.socket.nextSend();
    discovering.socket.fireMessage({
      kind: "openAck",
      manifest: { "host.status": { major: 1, minor: 0 } },
      optionalManifest: {},
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    await requested;
    const frame = requestFrames(discovering)[0];
    if (frame === undefined) {
      throw new Error("expected the fallback request");
    }
    expect(frame.method).toBe("host.status");
    expect(discovering.socket.closed).toBeNull();
    respondStatus(discovering.socket, frame, true);
    const error = await refused;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected the adapt response rejection");
    }
    expect(error.message).toBe("adapt response rejected");
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when the fallback target is not in the registry", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClientFor(unknownTargetRegistry, factory);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const refused = captureRejection(
      client.request(
        "host.gap",
        { message: "gap" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    const opened = discovering.socket.nextSend();
    discovering.socket.fireOpen();
    await opened;
    client.releaseIdleLocalSessions();
    discovering.socket.fireMessage({
      kind: "openAck",
      manifest: { "host.status": { major: 1, minor: 0 } },
      optionalManifest: {},
      capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
    });
    const error = await refused;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the unknown fallback target");
    }
    expect(error.message).toBe(
      "Fallback for method 'host.gap' targets unknown method 'host.spare'",
    );
    expect(requestFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when the last response is a retryable error", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const pending = captureRejection(
      client.request(
        "host.echo",
        { message: "transient" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    client.releaseIdleLocalSessions();
    const frame = requestFrames(discovering)[0];
    if (frame === undefined) {
      throw new Error("expected the in-flight request");
    }
    discovering.socket.fireMessage({
      kind: "response",
      requestId: frame.requestId,
      method: frame.method,
      schemaVersion: frame.schemaVersion,
      result: null,
      error: {
        code: "UNAUTHORIZED",
        message: "verifier unreachable",
        retryable: true,
      },
    });
    const error = await pending;
    expect(error).toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof RetryableTransportError)) {
      throw new Error("expected the retryable response");
    }
    expect(error.replaySafetyFromKey).toBe(false);
    expect(mayHaveReachedHost(error)).toBe(false);
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when the last response is a wire error", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const pending = captureRejection(
      client.request(
        "host.echo",
        { message: "permanent" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    client.releaseIdleLocalSessions();
    const frame = requestFrames(discovering)[0];
    if (frame === undefined) {
      throw new Error("expected the in-flight request");
    }
    discovering.socket.fireMessage({
      kind: "response",
      requestId: frame.requestId,
      method: frame.method,
      schemaVersion: frame.schemaVersion,
      result: null,
      error: { code: "UNAUTHORIZED", message: "Invalid or expired token" },
    });
    const error = await pending;
    expect(error).toBeInstanceOf(HostRpcError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the wire error");
    }
    expect(error.code).toBe("UNAUTHORIZED");
    expect(discovering.socket.closed).toEqual({
      code: 1000,
      reason: "session-closed",
    });
  });

  it("closes a released session when the response times out and the cancel write throws", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const { session, socket } = directEchoSession({
        clientManifest: BOTH_MANIFESTS,
        hostManifest: BOTH_MANIFESTS,
      });
      session.retainDialRelease();
      const pending = captureRejection(
        echoCall(session, "req-timeout", new AbortController().signal),
      );
      expect(socket.sent).toHaveLength(1);
      socket.failSend = "cancel";
      await vi.advanceTimersByTimeAsync(5_000);
      const error = await pending;
      expect(error).toBeInstanceOf(HostTransportFailureError);
      if (!(error instanceof HostTransportFailureError)) {
        throw new Error("expected the response timeout");
      }
      expect(error.message).toBe("WebSocket frame timed out after 5000ms");
      expect(mayHaveReachedHost(error)).toBe(true);
      expect(
        socket.sent.filter((frame) => frame.kind === "cancel"),
      ).toHaveLength(1);
      expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a call still queued when the peer drops during the write", async () => {
    const { session, socket } = directEchoSession({
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
    });
    session.retainDialRelease();
    const signal = new AbortController().signal;
    const queuedCalls: Promise<unknown>[] = [];
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.kind !== "request" || queuedCalls.length > 0) {
        return;
      }
      queuedCalls.push(
        captureRejection(echoCall(session, "req-queued", signal)),
      );
      session.handlers.onTransportClosed("peer dropped", false);
    };
    const sent: unknown = await captureRejection(
      echoCall(session, "req-sent", signal),
    );
    const waiting = queuedCalls[0];
    if (waiting === undefined) {
      throw new Error("expected the queued call");
    }
    const queuedError: unknown = await waiting;
    expect(sent).toBeInstanceOf(HostTransportFailureError);
    if (!(sent instanceof HostTransportFailureError)) {
      throw new Error("expected the sent call to be uncertain");
    }
    expect(sent.message).toBe("peer dropped");
    expect(mayHaveReachedHost(sent)).toBe(true);
    expect(queuedError).toBeInstanceOf(RetryableTransportError);
    if (!(queuedError instanceof RetryableTransportError)) {
      throw new Error("expected the queued call to fail before send");
    }
    expect(queuedError.message).toBe(
      "Persistent session closed before the request was sent",
    );
    expect(queuedError.replaySafetyFromKey).toBe(false);
    expect(mayHaveReachedHost(queuedError)).toBe(false);
    expect(
      socket.sent.filter((frame) => frame.kind === "request"),
    ).toHaveLength(1);
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
    expect(session.isRetired).toBe(true);
  });

  it("fails a call still queued as incompatible when the host fatal arrives during the write", async () => {
    const { session, socket } = directEchoSession({
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
    });
    session.retainDialRelease();
    const signal = new AbortController().signal;
    const queuedCalls: Promise<unknown>[] = [];
    const send = socket.send.bind(socket);
    socket.send = (frame) => {
      send(frame);
      if (frame.kind !== "request" || queuedCalls.length > 0) {
        return;
      }
      queuedCalls.push(
        captureRejection(echoCall(session, "req-queued", signal)),
      );
      session.handlers.onFrame({
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "host build is incompatible",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      });
    };
    const sent: unknown = await captureRejection(
      echoCall(session, "req-sent", signal),
    );
    const waiting = queuedCalls[0];
    if (waiting === undefined) {
      throw new Error("expected the queued call");
    }
    const queuedError: unknown = await waiting;
    expect(sent).toBeInstanceOf(HostRpcError);
    expect(queuedError).toBeInstanceOf(HostRpcError);
    if (
      !(sent instanceof HostRpcError) ||
      !(queuedError instanceof HostRpcError)
    ) {
      throw new Error("expected both calls to take the incompatible fatal");
    }
    expect(sent.code).toBe("INCOMPATIBLE");
    expect(queuedError.code).toBe("INCOMPATIBLE");
    expect(sent.requestId).toBe("req-sent");
    expect(queuedError.requestId).toBe("req-queued");
    expect(mayHaveReachedHost(sent)).toBe(true);
    expect(mayHaveReachedHost(queuedError)).toBe(false);
    expect(queuedError.fatalDetails).not.toBeNull();
    expect(
      socket.sent.filter((frame) => frame.kind === "request"),
    ).toHaveLength(1);
    expect(socket.closed).toEqual({ code: 1000, reason: "session-closed" });
    expect(session.isRetired).toBe(true);
  });

  it("removes a failed dial when the only caller receives an incompatible handshake", () => {
    const directory = new LocalUnarySessionDirectory<typeof testRegistry>();
    const key = localUnarySessionKey(HOST_ID, USER_A, SOCKET_URL);
    const owner = directory.claim(key, null);
    if (owner.kind !== "owner") {
      throw new Error("expected the discovering dial");
    }
    owner.publish.failed(incompatibleHandshake());
    expectDirectoryEmpty(directory, key);
  });

  it("removes the dial when the waiting caller leaves before discovery fails", () => {
    const directory = new LocalUnarySessionDirectory<typeof testRegistry>();
    const key = localUnarySessionKey(HOST_ID, USER_A, SOCKET_URL);
    const owner = directory.claim(key, null);
    if (owner.kind !== "owner") {
      throw new Error("expected the discovering dial");
    }
    const waiting = directory.claim(key, null);
    if (waiting.kind !== "wait") {
      throw new Error("expected a waiter");
    }
    const hold = directory.acquireDialHold(key);
    waiting.leave();
    hold.release();
    owner.publish.retry();
    expectDirectoryEmpty(directory, key);
  });

  it("converts only the slot that handed the retry", async () => {
    const directory = new LocalUnarySessionDirectory<typeof testRegistry>();
    const key = localUnarySessionKey(HOST_ID, USER_A, SOCKET_URL);
    const first = directory.claim(key, null);
    if (first.kind !== "owner") {
      throw new Error("expected the discovering dial");
    }
    const firstWaiting = directory.claim(key, null);
    if (firstWaiting.kind !== "wait") {
      throw new Error("expected a waiter");
    }
    const firstHanded = firstWaiting.settled.then((result) => {
      if (result.kind !== "retry") {
        throw new Error("expected the first retry");
      }
      return result.handoff;
    });
    first.publish.retry();
    const firstHandoff = await firstHanded;
    firstWaiting.relinquish();

    const second = directory.claim(key, null);
    if (second.kind !== "owner") {
      throw new Error("expected the replacement dial");
    }
    const secondWaiting = directory.claim(key, null);
    if (secondWaiting.kind !== "wait") {
      throw new Error("expected the replacement waiter");
    }
    directory.releaseIdle();
    const secondHanded = secondWaiting.settled.then((result) => {
      if (result.kind !== "retry") {
        throw new Error("expected the second retry");
      }
      return result.handoff;
    });
    second.publish.retry();
    const secondHandoff = await secondHanded;

    const whileHeld = directory.claim(key, firstHandoff);
    if (whileHeld.kind !== "wait") {
      throw new Error("expected the occupied retry to wait");
    }
    whileHeld.leave();
    secondWaiting.relinquish();
    const stale = directory.claim(key, firstHandoff);
    if (stale.kind !== "owner") {
      throw new Error("expected the stale handoff to start a fresh dial");
    }
    const session = new LocalUnarySession<typeof testRegistry>({
      key,
      registry: testRegistry,
      hostId: HOST_ID,
      directory,
    });
    const socket = new RecordingSocket();
    session.attach({
      socket,
      clientManifest: BOTH_MANIFESTS,
      hostManifest: BOTH_MANIFESTS,
      idempotency: true,
    });
    stale.publish.ready(session);
    expect(directory.consumeReleaseBeforeReady(key, session)).toBe(false);
    expect(session.isRetired).toBe(false);
    expect(socket.closed).toBeNull();
    const followed = directory.claim(key, secondHandoff);
    if (followed.kind !== "ready") {
      throw new Error("expected the published session");
    }
    expect(followed.session).toBe(session);
  });
});
