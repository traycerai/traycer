import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineVersionedRpcRegistry,
  defineRpcContract,
  LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES,
  LOCAL_UNARY_SESSION_MAX_IN_FLIGHT,
  LOCAL_UNARY_SESSION_MAX_QUEUED,
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

const textEncoder = new TextEncoder();

class StubWebSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sentFrames: ClientFrame[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;

  send(data: string): void {
    this.sentFrames.push(
      clientFrameSchema.parse(JSON.parse(data)) as ClientFrame,
    );
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

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
          } | null;
        },
  ): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
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

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function captureRejection(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => null,
    (cause: unknown) => cause,
  );
}

function payloadBytes(message: string): number {
  return textEncoder.encode(JSON.stringify({ message })).length;
}

function messageOfBytes(bytes: number): string {
  const envelope = payloadBytes("");
  if (bytes < envelope) {
    throw new Error(`payload of ${bytes} bytes is below the echo envelope`);
  }
  return "x".repeat(bytes - envelope);
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
  recorded.socket.fireOpen();
  await flush();
  recorded.socket.fireMessage(ack);
  await flush();
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
    const rotated = client.request(
      "host.echo",
      { message: "rotated" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await flush();
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
    await flush();
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

    const notReady = client.request(
      "host.status",
      {},
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await flush();
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
    expect(openFrames(secondSocket)).toHaveLength(1);
    expect(requestFrames(firstSocket)).toHaveLength(1);
    expect(requestFrames(secondSocket)).toHaveLength(1);
  });

  it("reads the bearer and cloud verdict at send time on a session request", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const verdict = { cloudAuthorized: true };
    const readVerdict = (): boolean => verdict.cloudAuthorized;
    const held = client.request(
      "host.echo",
      { message: messageOfBytes(LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES - 10) },
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
    await classify(discovering, sessionAck(true));
    const heldRequest = requestFrames(discovering)[0];
    if (heldRequest === undefined) {
      throw new Error("expected the in-flight request");
    }
    expect(heldRequest.token).toBe("token-a");
    expect(heldRequest.cloudAuthorized).toBe(true);

    const queued = client.request(
      "host.echo",
      { message: "next" },
      optionsFor(
        bearer,
        new AbortController().signal,
        null,
        false,
        readVerdict,
      ),
    );
    await flush();
    expect(requestFrames(discovering)).toHaveLength(1);

    bearer.rotate("token-at-send");
    verdict.cloudAuthorized = false;
    respondEcho(discovering.socket, heldRequest, "held");
    await flush();
    const sentLater = requestFrames(discovering)[1];
    if (sentLater === undefined) {
      throw new Error(
        "expected the queued request to send after the slot freed",
      );
    }
    expect(sentLater.token).toBe("token-at-send");
    expect(sentLater.cloudAuthorized).toBe(false);
    expect(sockets).toHaveLength(1);
    respondEcho(discovering.socket, sentLater, "next");
    await expect(held).resolves.toEqual({ echoed: "held" });
    await expect(queued).resolves.toEqual({ echoed: "next" });
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
    await flush();
    await flush();

    const error = await pending;
    expect(error).toBeInstanceOf(HostTransportFailureError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
    expect(mayHaveReachedHost(error)).toBe(true);
    expect(requestFrames(discovering)).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });

  it("fails an unsent unkeyed request without writing it", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const sent = captureRejection(
      client.request(
        "host.echo",
        {
          message: messageOfBytes(LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES - 10),
        },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const queued = captureRejection(
      client.request(
        "host.echo",
        { message: "waiting" },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    await flush();
    expect(requestFrames(discovering)).toHaveLength(1);

    discovering.socket.fireClose(1006, "peer-dropped", false);
    await flush();
    await flush();

    const sentError = await sent;
    const queuedError = await queued;
    expect(sentError).toBeInstanceOf(HostTransportFailureError);
    expect(sentError).not.toBeInstanceOf(RetryableTransportError);
    expect(mayHaveReachedHost(sentError)).toBe(true);
    expect(queuedError).toBeInstanceOf(RetryableTransportError);
    if (!(queuedError instanceof RetryableTransportError)) {
      throw new Error("expected the unsent call to be retryable");
    }
    expect(queuedError.replaySafetyFromKey).toBe(false);
    expect(mayHaveReachedHost(queuedError)).toBe(false);
    expect(requestFrames(discovering).map((frame) => frame.requestId)).toEqual([
      "req-1",
    ]);
    expect(sockets).toHaveLength(1);
  });

  it("writes an unsent keyed request once on the replacement socket", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const sent = captureRejection(
      client.request(
        "host.echo",
        {
          message: messageOfBytes(LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES - 10),
        },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const queued = client.request(
      "host.echo",
      { message: "replay" },
      optionsFor(
        bearer,
        new AbortController().signal,
        "replay-key",
        false,
        null,
      ),
    );
    await flush();
    expect(requestFrames(discovering).map((frame) => frame.requestId)).toEqual([
      "req-1",
    ]);

    discovering.socket.fireClose(1006, "peer-dropped", false);
    const replacement = sockets[1];
    if (replacement === undefined) {
      throw new Error("expected the keyed call to dial a replacement");
    }
    await classify(replacement, sessionAck(true));

    const replayed = requestFrames(replacement);
    expect(replayed.map((frame) => frame.requestId)).toEqual(["req-2"]);
    expect(replayed[0]?.idempotencyKey).toBe("replay-key");
    expect(requestFrames(discovering).map((frame) => frame.requestId)).toEqual([
      "req-1",
    ]);
    const replayedFrame = replayed[0];
    if (replayedFrame === undefined) {
      throw new Error("expected the replayed request");
    }
    respondEcho(replacement.socket, replayedFrame, "replay");
    const sentError = await sent;
    expect(mayHaveReachedHost(sentError)).toBe(true);
    expect(sentError).not.toBeInstanceOf(RetryableTransportError);
    await expect(queued).resolves.toEqual({ echoed: "replay" });
    expect(sockets).toHaveLength(2);
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
    await classify(discovering, sessionAck(false));

    const error = await replay;
    expect(error).toBeInstanceOf(HostTransportFailureError);
    expect(error).not.toBeInstanceOf(RetryableTransportError);
    expect(requestFrames(discovering)).toHaveLength(0);

    const followUp = client.request(
      "host.echo",
      { message: "fresh" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await flush();
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
    await flush();
    await flush();

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
    await flush();
    await flush();

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
    const held = client.request(
      "host.echo",
      { message: messageOfBytes(LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES - 10) },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const controller = new AbortController();
    const queued = captureRejection(
      client.request(
        "host.echo",
        { message: "queued" },
        optionsFor(bearer, controller.signal, null, false, null),
      ),
    );
    await flush();
    expect(requestFrames(discovering)).toHaveLength(1);
    controller.abort();

    const error = await queued;
    expect(error).toBeInstanceOf(HostRequestAbortedError);
    if (!(error instanceof HostRequestAbortedError)) {
      throw new Error("expected the queued abort");
    }
    expect(error.mayHaveDispatched).toBe(false);
    expect(cancelFrames(discovering)).toHaveLength(0);

    const heldRequest = requestFrames(discovering)[0];
    if (heldRequest === undefined) {
      throw new Error("expected the in-flight request to stay on the socket");
    }
    respondEcho(discovering.socket, heldRequest, "held");
    await expect(held).resolves.toEqual({ echoed: "held" });
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
    controller.abort();
    await flush();

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

    const later = client.request(
      "host.echo",
      { message: "later" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await flush();
    const laterRequest = requestFrames(discovering)[2];
    if (laterRequest === undefined) {
      throw new Error("expected a later call on the same session");
    }
    respondEcho(discovering.socket, laterRequest, "later");
    await expect(later).resolves.toEqual({ echoed: "later" });
    expect(sockets).toHaveLength(1);
    expect(openFrames(discovering)).toHaveLength(1);
  });

  it("times out on the per-call timer without cancelling or closing the session", async () => {
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
    expect(cancelFrames(discovering)).toHaveLength(0);
    expect(discovering.socket.closed).toBeNull();

    const later = client.request(
      "host.echo",
      { message: "later" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await flush();
    const laterRequest = requestFrames(discovering)[1];
    if (laterRequest === undefined) {
      throw new Error("expected a later call on the same session");
    }
    respondEcho(discovering.socket, laterRequest, "later");
    await expect(later).resolves.toEqual({ echoed: "later" });
    expect(sockets).toHaveLength(1);
  });

  it("refuses one oversized payload and keeps the session", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const oversized = captureRejection(
      client.request(
        "host.echo",
        { message: messageOfBytes(LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES + 1) },
        optionsFor(bearer, new AbortController().signal, null, false, null),
      ),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const error = await oversized;
    expect(error).toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof RetryableTransportError)) {
      throw new Error("expected the oversized call to be refused before send");
    }
    expect(error.message).toBe(
      "Persistent session refused a call whose params exceed the byte cap",
    );
    expect(error.replaySafetyFromKey).toBe(false);
    expect(requestFrames(discovering)).toHaveLength(0);

    const followUp = client.request(
      "host.echo",
      { message: "after" },
      optionsFor(bearer, new AbortController().signal, null, false, null),
    );
    await flush();
    const sent = requestFrames(discovering)[0];
    if (sent === undefined) {
      throw new Error("expected the session to accept the next call");
    }
    respondEcho(discovering.socket, sent, "after");
    await expect(followUp).resolves.toEqual({ echoed: "after" });
    expect(sockets).toHaveLength(1);
  });

  it("caps queued bytes separately from in-flight bytes and refuses the call that crosses the queue cap", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const signal = new AbortController().signal;
    const held = client.request(
      "host.echo",
      { message: messageOfBytes(LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES - 10) },
      optionsFor(bearer, signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));
    const queued = client.request(
      "host.echo",
      { message: messageOfBytes(200) },
      optionsFor(bearer, signal, null, false, null),
    );
    await flush();
    expect(requestFrames(discovering)).toHaveLength(1);

    const refused = captureRejection(
      client.request(
        "host.echo",
        {
          message: messageOfBytes(LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES - 100),
        },
        optionsFor(bearer, signal, null, false, null),
      ),
    );
    const error = await refused;
    expect(error).toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof RetryableTransportError)) {
      throw new Error("expected the queue byte cap to refuse the call");
    }
    expect(error.replaySafetyFromKey).toBe(false);
    expect(requestFrames(discovering)).toHaveLength(1);
    expect(discovering.socket.closed).toBeNull();

    const heldRequest = requestFrames(discovering)[0];
    if (heldRequest === undefined) {
      throw new Error("expected the in-flight request");
    }
    respondEcho(discovering.socket, heldRequest, "held");
    await flush();
    const queuedRequest = requestFrames(discovering)[1];
    if (queuedRequest === undefined) {
      throw new Error(
        "expected the queued call to send once in-flight bytes freed",
      );
    }
    respondEcho(discovering.socket, queuedRequest, "queued");
    await expect(held).resolves.toEqual({ echoed: "held" });
    await expect(queued).resolves.toEqual({ echoed: "queued" });
    expect(sockets).toHaveLength(1);
  });

  it("refuses the call past the queue length cap and keeps the session", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const signal = new AbortController().signal;
    const held = client.request(
      "host.echo",
      { message: messageOfBytes(LOCAL_UNARY_SESSION_MAX_BUFFERED_BYTES - 10) },
      optionsFor(bearer, signal, null, false, null),
    );
    const discovering = sockets[0];
    if (discovering === undefined) {
      throw new Error("expected the discovering socket");
    }
    await classify(discovering, sessionAck(true));

    const queued: Promise<{ readonly echoed: string }>[] = [];
    for (let index = 0; index < LOCAL_UNARY_SESSION_MAX_QUEUED; index += 1) {
      queued.push(
        client.request(
          "host.echo",
          { message: `q-${index}` },
          optionsFor(bearer, signal, null, false, null),
        ),
      );
    }
    await flush();
    expect(requestFrames(discovering)).toHaveLength(1);

    const overflow = captureRejection(
      client.request(
        "host.echo",
        { message: "overflow" },
        optionsFor(bearer, signal, null, false, null),
      ),
    );
    const error = await overflow;
    expect(error).toBeInstanceOf(RetryableTransportError);
    if (!(error instanceof RetryableTransportError)) {
      throw new Error("expected the queue cap to refuse the call");
    }
    expect(error.replaySafetyFromKey).toBe(false);
    expect(error.message).toBe("Persistent session queue is full");
    expect(requestFrames(discovering)).toHaveLength(1);
    expect(discovering.socket.closed).toBeNull();

    const heldRequest = requestFrames(discovering)[0];
    if (heldRequest === undefined) {
      throw new Error("expected the byte-saturated request");
    }
    respondEcho(discovering.socket, heldRequest, "held");
    for (const frame of requestFrames(discovering).slice(1)) {
      respondEcho(discovering.socket, frame, "queued");
    }
    await expect(held).resolves.toEqual({ echoed: "held" });
    await Promise.all(queued);

    const followUp = client.request(
      "host.echo",
      { message: "after" },
      optionsFor(bearer, signal, null, false, null),
    );
    await flush();
    const followUpFrame = requestFrames(discovering).at(-1);
    const followUpParams = followUpFrame?.params;
    const followUpMessage =
      typeof followUpParams === "object" &&
      followUpParams !== null &&
      "message" in followUpParams &&
      typeof followUpParams.message === "string"
        ? followUpParams.message
        : null;
    if (followUpFrame === undefined || followUpMessage !== "after") {
      throw new Error(
        "expected the session to accept a call after the queue drained",
      );
    }
    respondEcho(discovering.socket, followUpFrame, "after");
    await expect(followUp).resolves.toEqual({ echoed: "after" });
    expect(sockets).toHaveLength(1);
    expect(discovering.socket.closed).toBeNull();
  });

  it("keeps the call past the in-flight cap queued until a slot frees", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient(factory, 0);
    const bearer = new MutableBearerLease("token-a", USER_A);
    const calls: Promise<{ readonly echoed: string }>[] = [];
    for (
      let index = 0;
      index < LOCAL_UNARY_SESSION_MAX_IN_FLIGHT + 1;
      index += 1
    ) {
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
    const extra = calls[LOCAL_UNARY_SESSION_MAX_IN_FLIGHT];
    if (extra === undefined) {
      throw new Error("expected the call past the in-flight cap");
    }
    let extraSettled = false;
    void extra.then(
      () => {
        extraSettled = true;
      },
      () => {
        extraSettled = true;
      },
    );

    await classify(discovering, sessionAck(true));
    expect(requestFrames(discovering)).toHaveLength(
      LOCAL_UNARY_SESSION_MAX_IN_FLIGHT,
    );
    expect(extraSettled).toBe(false);

    const first = requestFrames(discovering)[0];
    if (first === undefined) {
      throw new Error("expected the first in-flight request");
    }
    respondEcho(discovering.socket, first, "flight");
    await flush();
    expect(requestFrames(discovering)).toHaveLength(
      LOCAL_UNARY_SESSION_MAX_IN_FLIGHT + 1,
    );
    expect(extraSettled).toBe(false);
    expect(discovering.socket.closed).toBeNull();

    for (const frame of requestFrames(discovering).slice(1)) {
      respondEcho(discovering.socket, frame, "flight");
    }
    await Promise.all(calls);
    expect(extraSettled).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(discovering.socket.closed).toBeNull();
  });
});
