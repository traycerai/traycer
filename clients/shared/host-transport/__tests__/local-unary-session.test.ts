import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineVersionedRpcRegistry,
  defineRpcContract,
  RPC_REQUEST_TIMEOUT_FATAL_CODE,
  UNARY_CAPABILITY_IDEMPOTENCY_KEY,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
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
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type HostRequestAuthority,
  type HostRequestOptions,
  type HostTransportEndpoint,
} from "../host-messenger";
import { createAuthAwareMessenger } from "../auth-aware-messenger";
import { localUnarySessionKey } from "../local-unary-session";
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
} {
  const sockets: RecordedSocket[] = [];
  const factory: IWebSocketFactory = {
    create(url: string, priority: DialPriority): WebSocketLike {
      void url;
      void priority;
      const socket = new StubWebSocket();
      sockets.push({ socket, sent: socket.sentFrames });
      return socket;
    },
  };
  return { factory, sockets };
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

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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
    const endpoint: HostTransportEndpoint = {
      hostId: HOST_ID,
      websocketUrl: SOCKET_URL,
    };
    expect(endpoint).not.toHaveProperty("status");
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

  it("aborts a queued call before send with no cancel frame", async () => {
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

    expect(outcome).not.toBe("still-waiting");
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
    expect(error.message).toBe("Malformed host frame: not-json");
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
      `Malformed host frame: ${JSON.stringify({ kind: "nope" })}`,
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
    await nextTurn();
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
    await nextTurn();
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

  it("keeps the socket when a call starts after a dial-time release", async () => {
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
    await nextTurn();
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

  it("lets a waiter with a valid bearer dial after the owner's open credential is refused", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const ownerBearer = new MutableBearerLease("stale-token", USER_A);
    const waiterBearer = new MutableBearerLease("fresh-token", USER_A);
    const revalidated: MutableBearerLease[] = [];
    const wrapped = createAuthAwareMessenger(
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
        optionsFor(ownerBearer, new AbortController().signal, null, false, null),
      ),
    );
    const waiter = wrapped.request(
      "host.echo",
      { message: "waiter" },
      optionsFor(
        waiterBearer,
        new AbortController().signal,
        null,
        false,
        null,
      ),
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
    const wrapped = createAuthAwareMessenger(
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
});
