import {
  NO_TRANSPORT_EVIDENCE,
  type TransportEvidenceReporter,
} from "@traycer-clients/shared/host-selection/transport-evidence";
import type {
  SelectionIncompatibility,
  SelectionTransportKind,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineFallbackMethodDegrade,
  defineFloorAwareVersionedRpcRegistry,
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
  defineVersionedRpcRegistry,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  HostRequestAbortedError,
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
  type HostRequestAuthority,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "../host-messenger";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import {
  HOST_POST_OPEN_ATTESTATION_WINDOW_MS,
  WsRpcClient,
} from "../ws-rpc-client";
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "../negotiated-manifest-registry";
import { createAuthAwareMessenger } from "../auth-aware-messenger";
import { createRetryingMessenger } from "../retrying-messenger";
import type {
  ClientFrame,
  ClientOpenFrame,
  ClientRequestFrame,
  ClientFatalErrorFrame,
  HostFrame,
} from "@traycer/protocol/framework/ws-protocol";

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

type RecordedSocket = {
  readonly url: string;
  readonly socket: StubWebSocket;
  readonly sent: ClientFrame[];
};

class StubWebSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  readonly sentFrames: ClientFrame[] = [];

  send(data: string): void {
    this.sent.push(data);
    this.sentFrames.push(JSON.parse(data) as ClientFrame);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    if (this.onopen !== null) {
      this.onopen({ type: "open" });
    }
  }

  fireMessage(frame: HostFrame): void {
    if (this.onmessage !== null) {
      this.onmessage({ data: JSON.stringify(frame) });
    }
  }

  fireRawMessage(raw: string): void {
    if (this.onmessage !== null) {
      this.onmessage({ data: raw });
    }
  }

  fireError(message: string): void {
    if (this.onerror !== null) {
      this.onerror({ message });
    }
  }

  fireClose(code: number, reason: string, wasClean: boolean): void {
    if (this.onclose !== null) {
      this.onclose({ code, reason, wasClean });
    }
  }
}

function makeFactory(): {
  readonly factory: IWebSocketFactory;
  readonly sockets: RecordedSocket[];
} {
  const sockets: RecordedSocket[] = [];
  const factory: IWebSocketFactory = {
    create(url: string): WebSocketLike {
      const socket = new StubWebSocket();
      sockets.push({ url, socket, sent: socket.sentFrames });
      return socket;
    },
  };
  return { factory, sockets };
}

function authorityForToken(token: string | null): HostRequestAuthority {
  return authorityForBearer(new MutableBearerLease(token ?? "", "test-user"));
}

function authorityForBearer(
  bearer: HostRequestAuthority["bearer"],
): HostRequestAuthority {
  return {
    endpoint: {
      hostId: mockLocalHostEntry.hostId,
      websocketUrl: mockLocalHostEntry.websocketUrl,
    },
    bearer,
    abortSignal: new AbortController().signal,
  };
}

class BoundWsRpcClient<Registry extends VersionedRpcRegistry> {
  constructor(
    private readonly inner: WsRpcClient<Registry>,
    private readonly authority: HostRequestAuthority,
  ) {}

  request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.inner.request(method, params, this.authority);
  }

  requestWithResponseTimeout<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    responseTimeoutMs: number,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    return this.inner.requestWithResponseTimeout(
      method,
      params,
      responseTimeoutMs,
      this.authority,
    );
  }
}

function makeClient(options: {
  readonly factory: IWebSocketFactory;
  readonly authToken: string | null;
  readonly requestId: string;
  readonly dialTimeoutMs: number;
  readonly frameTimeoutMs: number;
  /**
   * `undefined` means `0` - no post-send attestation grace, so a response-wait
   * timeout fails the call the moment the caller's deadline expires. Tests that
   * exercise the grace pass a window explicitly.
   */
  readonly hostAttestationWindowMs: number | undefined;
}): BoundWsRpcClient<typeof testRegistry> {
  const inner = new WsRpcClient<typeof testRegistry>({
    registry: testRegistry,
    requestId: () => options.requestId,
    webSocketFactory: options.factory,
    dialTimeoutMs: options.dialTimeoutMs,
    frameTimeoutMs: options.frameTimeoutMs,
    hostAttestationWindowMs: options.hostAttestationWindowMs ?? 0,
    evidence: NO_TRANSPORT_EVIDENCE,
  });
  return new BoundWsRpcClient(inner, authorityForToken(options.authToken));
}

async function expectPostOpenTimeoutRecovery(fatal: HostFrame): Promise<void> {
  const { factory, sockets } = makeFactory();
  let requestNumber = 0;
  const raw = new WsRpcClient<typeof testRegistry>({
    registry: testRegistry,
    requestId: () => {
      requestNumber += 1;
      return `req-post-open-${requestNumber}`;
    },
    webSocketFactory: factory,
    dialTimeoutMs: 1_000,
    frameTimeoutMs: 1_000,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
  });
  const authCalls = { count: 0 };
  const authAware = createAuthAwareMessenger<typeof testRegistry>(raw, {
    revalidateExpectedBearer: async () => {
      authCalls.count += 1;
      return "rotated";
    },
  });
  const client = createRetryingMessenger<typeof testRegistry>(authAware, {
    maxRetries: 1,
    initialDelayMs: 0,
    maxDelayMs: 0,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  const authority = authorityForToken("token-abc");

  const pending = client.request("host.echo", { message: "hi" }, authority);
  await flush();
  sockets[0].socket.fireOpen();
  await flush();
  sockets[0].socket.fireMessage(
    openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
  );
  await flush();
  expect(expectRequestFrame(sockets[0].sent[1])).toBeDefined();

  // The client locally sent its request after receiving the buffered openAck,
  // but this fatal is host attestation that the host timed out first and never
  // dispatched it. That makes a fresh attempt safe even for non-idempotent RPCs.
  sockets[0].socket.fireMessage(fatal);
  for (let attempt = 0; attempt < 10 && sockets.length < 2; attempt += 1) {
    await flush();
  }
  expect(sockets).toHaveLength(2);
  expect(authCalls.count).toBe(0);

  sockets[1].socket.fireOpen();
  await flush();
  sockets[1].socket.fireMessage(
    openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
  );
  await flush();
  const replacementRequest = expectRequestFrame(sockets[1].sent[1]);
  sockets[1].socket.fireMessage({
    kind: "response",
    requestId: replacementRequest.requestId,
    method: replacementRequest.method,
    schemaVersion: replacementRequest.schemaVersion,
    result: { echoed: "HI" },
    error: null,
  });

  await expect(pending).resolves.toEqual({ echoed: "HI" });
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

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function expectOpenFrame(frame: ClientFrame): ClientOpenFrame {
  if (frame.kind !== "open") {
    throw new Error(`Expected open frame, got '${frame.kind}'`);
  }
  return frame;
}

function expectRequestFrame(frame: ClientFrame): ClientRequestFrame {
  if (frame.kind !== "request") {
    throw new Error(`Expected request frame, got '${frame.kind}'`);
  }
  return frame;
}

function expectTerminalFrame(frame: ClientFrame): ClientFatalErrorFrame {
  if (frame.kind !== "fatalError") {
    throw new Error(`Expected fatalError frame, got '${frame.kind}'`);
  }
  return frame;
}

function openAckWithOptionalHostEcho(version: {
  readonly major: number;
  readonly minor: number;
}): HostFrame {
  return {
    kind: "openAck",
    manifest: {
      "host.status": { major: 1, minor: 0 },
    },
    optionalManifest: {
      "host.echo": version,
    },
  };
}

function openAckWithOnlyOptionalHostEcho(version: {
  readonly major: number;
  readonly minor: number;
}): HostFrame {
  return {
    kind: "openAck",
    manifest: {},
    optionalManifest: {
      "host.echo": version,
    },
  };
}

/** One recorded call to a `TransportEvidenceReporter` method, keyed by name. */
type RecordedEvidenceCall =
  | {
      readonly method: "sessionEstablished";
      readonly hostId: string;
      readonly sessionId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly method: "sessionLost";
      readonly hostId: string;
      readonly sessionId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly method: "reportDialSuccess";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly method: "reportDialRefusal";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
      readonly refusalDetail: "plan-restricted" | null;
    }
  | {
      readonly method: "reportDialTimeout";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly method: "reportDialIndeterminate";
      readonly hostId: string;
      readonly attemptId: string;
      readonly transportKind: SelectionTransportKind;
    }
  | {
      readonly method: "reportCompatVerdict";
      readonly input: {
        readonly hostId: string;
        readonly probedOnSessionId: string | null;
        readonly hostVersion: string | null;
        readonly incompatibility: SelectionIncompatibility | null;
      };
    }
  | {
      readonly method: "reportRestartIntent";
      readonly hostId: string;
      readonly tombstoneId: string;
      readonly expiresAt: number | null;
    };

/**
 * Records every call a transport makes into a `TransportEvidenceReporter`, in
 * arrival order, so a test can assert on sequences and per-method counts
 * rather than only on the latest call (the shape a plain `vi.fn` gives).
 */
class RecordingEvidence implements TransportEvidenceReporter {
  readonly calls: RecordedEvidenceCall[] = [];

  sessionEstablished(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.calls.push({
      method: "sessionEstablished",
      hostId,
      sessionId,
      transportKind,
    });
  }

  sessionLost(
    hostId: string,
    sessionId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.calls.push({
      method: "sessionLost",
      hostId,
      sessionId,
      transportKind,
    });
  }

  reportDialSuccess(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.calls.push({
      method: "reportDialSuccess",
      hostId,
      attemptId,
      transportKind,
    });
  }

  reportDialRefusal(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
    refusalDetail: "plan-restricted" | null,
  ): void {
    this.calls.push({
      method: "reportDialRefusal",
      hostId,
      attemptId,
      transportKind,
      refusalDetail,
    });
  }

  reportDialTimeout(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.calls.push({
      method: "reportDialTimeout",
      hostId,
      attemptId,
      transportKind,
    });
  }

  reportDialIndeterminate(
    hostId: string,
    attemptId: string,
    transportKind: SelectionTransportKind,
  ): void {
    this.calls.push({
      method: "reportDialIndeterminate",
      hostId,
      attemptId,
      transportKind,
    });
  }

  reportCompatVerdict(input: {
    readonly hostId: string;
    readonly probedOnSessionId: string | null;
    readonly hostVersion: string | null;
    readonly incompatibility: SelectionIncompatibility | null;
  }): void {
    this.calls.push({ method: "reportCompatVerdict", input });
  }

  /** Every recorded call for one method name, narrowed to its own shape. */
  callsNamed<Method extends RecordedEvidenceCall["method"]>(
    method: Method,
  ): (RecordedEvidenceCall & { readonly method: Method })[] {
    return this.calls.filter(
      (call): call is RecordedEvidenceCall & { readonly method: Method } =>
        call.method === method,
    );
  }

  reportRestartIntent(
    hostId: string,
    tombstoneId: string,
    expiresAt: number | null,
  ): void {
    this.calls.push({
      method: "reportRestartIntent",
      hostId,
      tombstoneId,
      expiresAt,
    });
  }
}

describe("WsRpcClient", () => {
  it("walks dial → open → openAck → request → response → close on the happy path", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      requestId: "req-1",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "hi" });
    await flush();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe(mockLocalHostEntry.websocketUrl);

    const stub = sockets[0].socket;
    stub.fireOpen();
    await flush();

    expect(sockets[0].sent).toHaveLength(1);
    const openFrame = expectOpenFrame(sockets[0].sent[0]);
    expect(openFrame.token).toBe("token-abc");
    expect(openFrame.manifest).toEqual({
      "host.status": { major: 1, minor: 0 },
    });
    expect(openFrame.optionalManifest).toEqual({
      "host.echo": { major: 1, minor: 0 },
    });

    stub.fireMessage(openAckWithOptionalHostEcho({ major: 1, minor: 0 }));
    await flush();

    expect(sockets[0].sent).toHaveLength(2);
    const requestFrame = expectRequestFrame(sockets[0].sent[1]);
    expect(requestFrame).toEqual({
      kind: "request",
      requestId: "req-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      params: { message: "hi" },
    });
    expect(stub.closed).toBeNull();

    stub.fireMessage({
      kind: "response",
      requestId: "req-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "HI" },
      error: null,
    });

    await expect(pending).resolves.toEqual({ echoed: "HI" });
    expect(stub.closed).toEqual({ code: 1000, reason: "ok" });
  });

  it("aborting the captured authority closes and settles the in-flight socket", async () => {
    const { factory, sockets } = makeFactory();
    const client = new WsRpcClient<typeof testRegistry>({
      registry: testRegistry,
      requestId: () => "req-abort",
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: 0,
      evidence: NO_TRANSPORT_EVIDENCE,
    });
    const lifetime = new AbortController();
    const pending = client.request(
      "host.echo",
      { message: "hi" },
      {
        endpoint: {
          hostId: mockLocalHostEntry.hostId,
          websocketUrl: mockLocalHostEntry.websocketUrl,
        },
        bearer: new MutableBearerLease("token-abc", "test-user"),
        abortSignal: lifetime.signal,
      },
    );
    await flush();
    expect(sockets).toHaveLength(1);

    lifetime.abort("host-replaced");

    await expect(pending).rejects.toBeInstanceOf(HostRequestAbortedError);
    expect(sockets[0].socket.closed).toEqual({
      code: 1000,
      reason: "authority-aborted",
    });
  });

  /**
   * C5. A socket that never opened reports a dial REFUSAL on close, which is
   * correct only when the host is the one that closed it. Every teardown we
   * initiate - an authority abort, or the `finally` close - also produces a
   * close event, and reporting those attributes our own decision to the host.
   *
   * The consequence is not cosmetic: refusals feed the selection authority's
   * death detection, and a healthy host was measured accumulating three
   * suppressed refusals - exactly the death threshold - so there is no
   * headroom for manufactured ones.
   */
  describe("self-closed sockets are not host refusals (C5)", () => {
    function makeDialScenario(requestId: string): {
      readonly sockets: RecordedSocket[];
      readonly recorder: RecordingEvidence;
      readonly client: WsRpcClient<typeof testRegistry>;
    } {
      const { factory, sockets } = makeFactory();
      const recorder = new RecordingEvidence();
      const client = new WsRpcClient<typeof testRegistry>({
        registry: testRegistry,
        requestId: () => requestId,
        webSocketFactory: factory,
        dialTimeoutMs: 1000,
        frameTimeoutMs: 1000,
        hostAttestationWindowMs: 0,
        evidence: recorder,
      });
      return { sockets, recorder, client };
    }

    /**
     * Every dial verdict, in order. Asserting on the whole outcome list rather
     * than on the absence of one method keeps a fix that merely swaps refusal
     * for a different manufactured verdict from passing.
     */
    function dialOutcomes(recorder: RecordingEvidence): string[] {
      return recorder.calls
        .map((call) => call.method)
        .filter(
          (method) =>
            method === "reportDialSuccess" ||
            method === "reportDialRefusal" ||
            method === "reportDialTimeout" ||
            method === "reportDialIndeterminate",
        );
    }

    function requestWithSignal(
      client: WsRpcClient<typeof testRegistry>,
      signal: AbortSignal,
    ): Promise<ResponseOfMethod<typeof testRegistry, "host.echo">> {
      return client.request(
        "host.echo",
        { message: "hi" },
        {
          endpoint: {
            hostId: mockLocalHostEntry.hostId,
            websocketUrl: mockLocalHostEntry.websocketUrl,
          },
          bearer: new MutableBearerLease("token-abc", "test-user"),
          abortSignal: signal,
        },
      );
    }

    it("an authority abort before open reports no dial outcome - the close event is ours", async () => {
      const { sockets, recorder, client } = makeDialScenario("req-abort-dial");
      const lifetime = new AbortController();
      const pending = requestWithSignal(client, lifetime.signal);
      await flush();
      expect(sockets).toHaveLength(1);

      lifetime.abort("host-replaced");
      await expect(pending).rejects.toBeInstanceOf(HostRequestAbortedError);
      // A socket we tore down still delivers a close event, exactly as a real
      // one does. Nothing about it is evidence concerning the host.
      sockets[0].socket.fireClose(1000, "authority-aborted", true);

      // Indeterminate, not silence: the attempt happened and owes one
      // outcome, and the kernel documents this verdict as inert - it advances
      // no counter - so it is diagnostics without death-detection weight.
      expect(dialOutcomes(recorder)).toEqual(["reportDialIndeterminate"]);
    });

    // Boundary pin, not a defect repro: this one passes on the unfixed tree.
    // It records WHY C5 is reachable only mid-dial, so a refactor that moves
    // the early abort check reddens here instead of silently widening C5.
    it("an already-aborted authority never dials, so it cannot report against a host", async () => {
      const { sockets, recorder, client } = makeDialScenario("req-abort-early");
      const lifetime = new AbortController();
      lifetime.abort("host-replaced");

      const pending = requestWithSignal(client, lifetime.signal);
      await expect(pending).rejects.toBeInstanceOf(HostRequestAbortedError);

      // `throwIfAuthorityAborted` runs before the socket is built, so the
      // synchronous `onAbort()` at session construction covers only the race
      // between that check and the listener registration - never a fresh dial.
      expect(sockets).toEqual([]);
      expect(dialOutcomes(recorder)).toEqual([]);
    });

    it("a host-initiated close before open is still reported as a refusal", async () => {
      const { sockets, recorder, client } = makeDialScenario("req-refused");
      const pending = requestWithSignal(client, new AbortController().signal);
      await flush();
      expect(sockets).toHaveLength(1);

      // Nobody on this side asked for this: the connection was refused, or
      // something answered and hung up before the handshake.
      sockets[0].socket.fireClose(1006, "connection refused", false);

      await expect(pending).rejects.toBeInstanceOf(RetryableTransportError);
      expect(dialOutcomes(recorder)).toEqual(["reportDialRefusal"]);
    });

    // Blink race, not a hypothetical: a pre-open `error` event fires, the
    // rejection it produces is awaited by `request()`'s own `finally` (see
    // `session.close(1000, "ok")` in `ws-rpc-client.ts`), and only THEN does
    // `close` arrive for the same failed dial. `selfInitiated` reads as true
    // at that point - our own `close()` ran first - so without
    // `erroredBeforeOpen` this refusal is misreported as `indeterminate` and
    // silently dropped from death detection.
    it("a pre-open error, followed by our own close() reacting to it, is still reported as a refusal", async () => {
      const { sockets, recorder, client } = makeDialScenario(
        "req-error-then-own-close",
      );
      const pending = requestWithSignal(client, new AbortController().signal);
      await flush();
      expect(sockets).toHaveLength(1);

      sockets[0].socket.fireError("connection refused");
      // Awaiting the rejection lets `request()`'s `finally` run to completion,
      // which calls `session.close()` and sets `closed = true` before the
      // socket's own `close` event below ever fires.
      await expect(pending).rejects.toBeInstanceOf(RetryableTransportError);

      sockets[0].socket.fireClose(1006, "connection refused", false);

      expect(dialOutcomes(recorder)).toEqual(["reportDialRefusal"]);
    });
  });

  it("refcounts the local logical session to one host: overlapping RPCs announce and retract exactly once, on the 0->1 and 1->0 edges only", async () => {
    const { factory, sockets } = makeFactory();
    const recorder = new RecordingEvidence();
    let nextRequestId = 0;
    const client = new WsRpcClient<typeof testRegistry>({
      registry: testRegistry,
      requestId: () => `req-${(nextRequestId += 1)}`,
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: 0,
      evidence: recorder,
    });
    const authority = authorityForToken("token-abc");

    // Fire two overlapping RPCs to the SAME host - neither awaited before the
    // next is started, so both sockets are open at once.
    const pending1 = client.request("host.echo", { message: "one" }, authority);
    await flush();
    const pending2 = client.request("host.echo", { message: "two" }, authority);
    await flush();
    expect(sockets).toHaveLength(2);

    sockets[0].socket.fireOpen();
    await flush();
    sockets[1].socket.fireOpen();
    await flush();

    // Only the 0 -> 1 refcount edge (the first socket's open) announces - the
    // second socket opening while one is already live must NOT re-announce.
    expect(recorder.callsNamed("sessionEstablished")).toHaveLength(1);
    expect(recorder.callsNamed("sessionLost")).toHaveLength(0);

    sockets[0].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();
    const req0 = expectRequestFrame(sockets[0].sent[1]);
    sockets[0].socket.fireMessage({
      kind: "response",
      requestId: req0.requestId,
      method: req0.method,
      schemaVersion: req0.schemaVersion,
      result: { echoed: "ONE" },
      error: null,
    });
    await expect(pending1).resolves.toEqual({ echoed: "ONE" });

    // The other socket is still open (refcount 1 -> 0 has not happened yet) -
    // no retraction on the first completion.
    expect(recorder.callsNamed("sessionLost")).toHaveLength(0);

    sockets[1].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();
    const req1 = expectRequestFrame(sockets[1].sent[1]);
    sockets[1].socket.fireMessage({
      kind: "response",
      requestId: req1.requestId,
      method: req1.method,
      schemaVersion: req1.schemaVersion,
      result: { echoed: "TWO" },
      error: null,
    });
    await expect(pending2).resolves.toEqual({ echoed: "TWO" });

    // Only the 1 -> 0 edge (the LAST open socket closing) retracts - one pair
    // total across both RPCs, not one pair per RPC.
    expect(recorder.callsNamed("sessionEstablished")).toHaveLength(1);
    expect(recorder.callsNamed("sessionLost")).toHaveLength(1);
  });

  it("two client INSTANCES never announce the same local session id - a rebuilt runtime's socket is not retracted by the old socket's close", async () => {
    // Codex #1243: the evidence kernel is renderer-lifetime and keys sessions
    // by id. A per-instance counter restarting at zero made a replacement
    // client announce the same `local-ws:s1` the old one held; the authority
    // deduplicated it, and the old socket's `lost` then tombstoned the shared
    // id - retracting the NEW socket's live evidence.
    const { factory, sockets } = makeFactory();
    const recorder = new RecordingEvidence();
    let nextRequestId = 0;
    const makeClient = () =>
      new WsRpcClient<typeof testRegistry>({
        registry: testRegistry,
        requestId: () => `req-${(nextRequestId += 1)}`,
        webSocketFactory: factory,
        dialTimeoutMs: 1000,
        frameTimeoutMs: 1000,
        hostAttestationWindowMs: 0,
        evidence: recorder,
      });
    const authority = authorityForToken("token-abc");

    // Old instance: one socket open, session announced.
    const oldClient = makeClient();
    const pendingOld = oldClient.request(
      "host.echo",
      { message: "old" },
      authority,
    );
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    // Runtime rebuilt: a NEW instance opens its own socket to the same host
    // while the old one is still open.
    const newClient = makeClient();
    const pendingNew = newClient.request(
      "host.echo",
      { message: "new" },
      authority,
    );
    await flush();
    sockets[1].socket.fireOpen();
    await flush();

    const established = recorder.calls.filter(
      (call) => call.method === "sessionEstablished",
    );
    expect(established).toHaveLength(2);
    const [oldSession, newSession] = established;
    if (oldSession === undefined || newSession === undefined) {
      throw new Error("expected two announcements");
    }
    // The load-bearing claim: distinct ids across instances.
    expect(newSession.sessionId).not.toBe(oldSession.sessionId);

    // The old socket closes: only ITS id is retracted.
    sockets[0].socket.fireClose(1006, "old socket gone", false);
    await expect(pendingOld).rejects.toBeInstanceOf(RetryableTransportError);
    const lost = recorder.calls.filter((call) => call.method === "sessionLost");
    expect(lost).toHaveLength(1);
    expect(lost[0]?.sessionId).toBe(oldSession.sessionId);
    expect(lost[0]?.sessionId).not.toBe(newSession.sessionId);

    // Leave the new socket's request settled so nothing dangles.
    sockets[1].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();
    const req = expectRequestFrame(sockets[1].sent[1]);
    sockets[1].socket.fireMessage({
      kind: "response",
      requestId: req.requestId,
      method: req.method,
      schemaVersion: req.schemaVersion,
      result: { echoed: "NEW" },
      error: null,
    });
    await expect(pendingNew).resolves.toEqual({ echoed: "NEW" });
  });

  it("a socket aborted after opening decrements the refcount without leaking it - the next RPC to the same host still gets a fresh 0->1 announcement", async () => {
    const { factory, sockets } = makeFactory();
    const recorder = new RecordingEvidence();
    let nextRequestId = 0;
    const client = new WsRpcClient<typeof testRegistry>({
      registry: testRegistry,
      requestId: () => `req-${(nextRequestId += 1)}`,
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: 0,
      evidence: recorder,
    });
    const lifetime = new AbortController();
    const pending = client.request(
      "host.echo",
      { message: "hi" },
      {
        endpoint: {
          hostId: mockLocalHostEntry.hostId,
          websocketUrl: mockLocalHostEntry.websocketUrl,
        },
        bearer: new MutableBearerLease("token-abc", "test-user"),
        abortSignal: lifetime.signal,
      },
    );
    await flush();
    expect(sockets).toHaveLength(1);
    sockets[0].socket.fireOpen();
    await flush();
    expect(recorder.callsNamed("sessionEstablished")).toHaveLength(1);

    lifetime.abort("host-replaced");
    await expect(pending).rejects.toBeInstanceOf(HostRequestAbortedError);

    // The socket had genuinely opened (raised the refcount) before the abort
    // closed it - the abort path must still decrement it, or the count would
    // stay stuck at 1 and no later RPC would ever re-announce.
    expect(recorder.callsNamed("sessionLost")).toHaveLength(1);

    const pending2 = client.request(
      "host.echo",
      { message: "hi again" },
      authorityForToken("token-abc"),
    );
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1].socket.fireOpen();
    await flush();

    // A fresh 0 -> 1 edge, not a no-op on an already-nonzero count.
    expect(recorder.callsNamed("sessionEstablished")).toHaveLength(2);

    sockets[1].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();
    const req1 = expectRequestFrame(sockets[1].sent[1]);
    sockets[1].socket.fireMessage({
      kind: "response",
      requestId: req1.requestId,
      method: req1.method,
      schemaVersion: req1.schemaVersion,
      result: { echoed: "HI AGAIN" },
      error: null,
    });
    await expect(pending2).resolves.toEqual({ echoed: "HI AGAIN" });
    expect(recorder.callsNamed("sessionLost")).toHaveLength(2);
  });

  it("rejects before dialing when no authenticated request context is available", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: null,
      requestId: "req-no-auth",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    await expect(
      client.request("host.echo", { message: "hi" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.requestId === "req-no-auth" &&
        error.message.includes("No bearer available for user 'test-user'"),
    );
    expect(sockets).toHaveLength(0);
  });

  it("rejects before dialing when the request-context credential lease is released", async () => {
    const { factory, sockets } = makeFactory();
    const ctx = makeRequestContext("token-abc");
    ctx.release();
    const client = new BoundWsRpcClient(
      new WsRpcClient<typeof testRegistry>({
        registry: testRegistry,
        requestId: () => "req-released",
        webSocketFactory: factory,
        dialTimeoutMs: 1000,
        frameTimeoutMs: 1000,
        hostAttestationWindowMs: 0,
        evidence: NO_TRANSPORT_EVIDENCE,
      }),
      authorityForBearer(ctx.credentials),
    );

    await expect(
      client.request("host.echo", { message: "hi" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.requestId === "req-released" &&
        error.message.includes("Credential lease"),
    );
    expect(sockets).toHaveLength(0);
  });

  it("decodes a host INCOMPATIBLE fatalError frame into HostRpcError", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-incompat",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    sockets[0].socket.fireMessage({
      kind: "fatalError",
      details: {
        code: "INCOMPATIBLE",
        reason: "Incompatible methods: host.echo",
        incompatibleMethods: [
          {
            method: "host.echo",
            clientCanonical: { major: 1, minor: 0 },
            hostCanonical: { major: 2, minor: 0 },
            blocking: "no-bridge",
          },
        ],
        upgradeGuidance: {
          clientShouldUpgrade: true,
          hostShouldUpgrade: false,
        },
      },
    });
    sockets[0].socket.fireClose(4001, "incompatible", true);

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof HostRpcError)) {
        return false;
      }
      return (
        error.code === "INCOMPATIBLE" &&
        error.requestId === "req-incompat" &&
        error.method === "host.echo" &&
        error.fatalDetails !== null &&
        error.fatalDetails.code === "INCOMPATIBLE" &&
        Array.isArray(error.fatalDetails.incompatibleMethods)
      );
    });
  });

  it("decodes a host UNAUTHORIZED fatalError frame", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "bad-token",
      requestId: "req-unauth",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.status", {});
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    sockets[0].socket.fireMessage({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "Bearer token rejected",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    sockets[0].socket.fireClose(4401, "unauthorized", true);

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "UNAUTHORIZED" &&
        error.fatalDetails !== null &&
        error.fatalDetails.code === "UNAUTHORIZED"
      );
    });
  });

  it("emits a client fatalError frame when its mirror compatibility check fails", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-mirror",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    sockets[0].socket.fireMessage({
      kind: "openAck",
      manifest: {},
      optionalManifest: {
        "host.echo": { major: 1, minor: 0 },
      },
    });

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "INCOMPATIBLE" &&
        error.fatalDetails !== null
      );
    });

    expect(sockets[0].sent).toHaveLength(2);
    const terminal = expectTerminalFrame(sockets[0].sent[1]);
    expect(terminal.details.code).toBe("INCOMPATIBLE");
    expect(sockets[0].socket.closed).toEqual({ code: 1000, reason: "ok" });
  });

  it("rejects with RPC_ERROR when a response carries a mismatched requestId", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-correlated",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();

    sockets[0].socket.fireMessage({
      kind: "response",
      requestId: "different",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "X" },
      error: null,
    });

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.requestId === "req-correlated"
      );
    });
  });

  it("maps a dial failure (transport unreachable) to RPC_ERROR", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-dial-fail",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireError("ECONNREFUSED");
    sockets[0].socket.fireClose(1006, "abnormal", false);

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.method === "host.echo" &&
        error.requestId === "req-dial-fail"
      );
    });
    expect(sockets[0].socket.sent).toHaveLength(0);
  });

  it("maps a dial timeout to RPC_ERROR", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-dial-timeout",
      dialTimeoutMs: 25,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    expect(sockets).toHaveLength(1);

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.message.includes("dial timed out")
      );
    });
  });

  it("maps a frame timeout (no openAck) to RPC_ERROR", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-frame-timeout",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 25,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.message.includes("frame timed out")
      );
    });
  });

  it("maps a malformed host frame to RPC_ERROR", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-malformed",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    sockets[0].socket.fireRawMessage(
      JSON.stringify({
        kind: "fatalError",
        details: {
          code: "INCOMPATIBLE",
          reason: "broken payload",
          incompatibleMethods: [],
          upgradeGuidance: {
            clientShouldUpgrade: "yes",
            hostShouldUpgrade: false,
          },
        },
      }),
    );

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.requestId === "req-malformed" &&
        error.method === "host.echo" &&
        error.message.includes("Malformed host frame:")
      );
    });
  });

  it("classifies a dial timeout as a retryable transport error", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-dial-retryable",
      dialTimeoutMs: 25,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    expect(sockets).toHaveLength(1);

    await expect(pending).rejects.toBeInstanceOf(RetryableTransportError);
  });

  it("classifies a close-before-open as a retryable transport error", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-close-retryable",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireClose(1006, "abnormal", false);

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetryableTransportError &&
        error.code === "RPC_ERROR" &&
        error.message.includes("closed before open"),
    );
  });

  it("classifies a handshake (pre-openAck) frame timeout as retryable", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-handshake-retryable",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 25,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    await expect(pending).rejects.toBeInstanceOf(RetryableTransportError);
  });

  it("retries the new host's typed post-open request timeout", async () => {
    await expectPostOpenTimeoutRecovery({
      kind: "fatalError",
      details: {
        code: "RPC_REQUEST_TIMEOUT",
        reason: "Timed out waiting for 'request' frame after openAck (30000ms)",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      },
    });
  });

  it("recovers the legacy UNAUTHORIZED post-open timeout without revalidating auth", async () => {
    await expectPostOpenTimeoutRecovery({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "Timed out waiting for 'request' frame after openAck (30000ms)",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
  });

  /**
   * Issue #726: when the client's response timer fires before the host's
   * post-open no-dispatch attestation, the socket is held open for a bounded
   * remainder of the host attestation window rather than closing over an
   * ambiguous in-flight request. These cases pin the production CLI/GUI timer
   * orderings and the safety boundary around the grace.
   *
   * The behaviour cases inject the window as a literal rather than importing
   * HOST_POST_OPEN_ATTESTATION_WINDOW_MS, so they pin the contract instead of
   * restating whatever production currently ships. The first case below is the
   * one exception - it exists precisely to tie the shipped constant to the stall
   * class the rest of the block models.
   */
  describe("post-open attestation grace (production ordering)", () => {
    const HOST_ATTESTATION_WINDOW_MS = 50_000;
    const HOST_POST_OPEN_DEADLINE_MS = 30_000;
    const CLI_FRAME_TIMEOUT_MS = 15_000;
    const GUI_FRAME_TIMEOUT_MS = 30_000;
    /** Stalled-host attestation wall time modelled by issue #726 (~45s awake). */
    const STALLED_HOST_ATTESTATION_AT_MS = 45_000;
    const LONG_POLL_RESPONSE_TIMEOUT_MS = 16 * 60 * 1_000;
    /** Floor delivery leg after any post-send timeout (matches production slack). */
    const ATTESTATION_DELIVERY_SLACK_MS = 5_000;
    /** Overshoot past a delivery leg that counts as suspension, not mere jitter. */
    const SUSPENSION_OVERSHOOT_TOLERANCE_MS = 1_000;
    /** Wall-clock jump used to model suspend while a delivery timer is pending. */
    const SUSPEND_JUMP_MS = 10 * 60 * 1_000;
    /**
     * Late delivery re-arms have no count cap. Crossing the former limit of 3
     * decisively (5+) pins that removal while still ending on active time.
     */
    const REPEATED_SUSPENSION_CYCLES = 5;

    const typedPostOpenTimeoutFatal: HostFrame = {
      kind: "fatalError",
      details: {
        code: "RPC_REQUEST_TIMEOUT",
        reason: "Timed out waiting for 'request' frame after openAck (30000ms)",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      },
    };

    const legacyPostOpenTimeoutFatal: HostFrame = {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "Timed out waiting for 'request' frame after openAck (30000ms)",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    };

    async function flushFake(): Promise<void> {
      await vi.advanceTimersByTimeAsync(0);
    }

    async function driveUntilRequestSent(
      sockets: RecordedSocket[],
    ): Promise<void> {
      await flushFake();
      expect(sockets).toHaveLength(1);
      sockets[0].socket.fireOpen();
      await flushFake();
      sockets[0].socket.fireMessage(
        openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
      );
      await flushFake();
      expect(expectRequestFrame(sockets[0].sent[1])).toBeDefined();
    }

    async function completeRetriedSocket(
      sockets: RecordedSocket[],
      socketIndex: number,
    ): Promise<void> {
      sockets[socketIndex].socket.fireOpen();
      await flushFake();
      sockets[socketIndex].socket.fireMessage(
        openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
      );
      await flushFake();
      const replacementRequest = expectRequestFrame(
        sockets[socketIndex].sent[1],
      );
      sockets[socketIndex].socket.fireMessage({
        kind: "response",
        requestId: replacementRequest.requestId,
        method: replacementRequest.method,
        schemaVersion: replacementRequest.schemaVersion,
        result: { echoed: "HI" },
        error: null,
      });
      await flushFake();
    }

    function makeGraceRecoveryStack(options: {
      readonly factory: IWebSocketFactory;
      readonly frameTimeoutMs: number;
      readonly hostAttestationWindowMs: number;
    }): {
      readonly client: IHostMessenger<typeof testRegistry>;
      readonly authCalls: { count: number };
      readonly authority: HostRequestAuthority;
    } {
      let requestNumber = 0;
      const raw = new WsRpcClient<typeof testRegistry>({
        registry: testRegistry,
        requestId: () => {
          requestNumber += 1;
          return `req-grace-${requestNumber}`;
        },
        webSocketFactory: options.factory,
        dialTimeoutMs: 1_000,
        frameTimeoutMs: options.frameTimeoutMs,
        hostAttestationWindowMs: options.hostAttestationWindowMs,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      const authCalls = { count: 0 };
      const authAware = createAuthAwareMessenger<typeof testRegistry>(raw, {
        revalidateExpectedBearer: async () => {
          authCalls.count += 1;
          return "rotated";
        },
      });
      const client: IHostMessenger<typeof testRegistry> =
        createRetryingMessenger<typeof testRegistry>(authAware, {
          maxRetries: 1,
          initialDelayMs: 0,
          maxDelayMs: 0,
          sleep: () => Promise.resolve(),
          random: () => 0,
        });
      return {
        client,
        authCalls,
        authority: authorityForToken("token-abc"),
      };
    }

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("ships a window that outlasts the stall class the recovery cases model", () => {
      // Every other case here injects its own window, so nothing else in this
      // suite fails if the shipped constant is lowered - only the CLI's
      // composition-root test would, and the GUI has no equivalent. A host that
      // stalls past this window never gets to attest, and the call stays
      // ambiguous: the value is a safety decision, not a tuning knob.
      expect(HOST_POST_OPEN_ATTESTATION_WINDOW_MS).toBeGreaterThan(
        STALLED_HOST_ATTESTATION_AT_MS,
      );
      // Below the largest production response deadline there would be no grace
      // at all, since the grace is the window minus the caller's own wait.
      expect(HOST_POST_OPEN_ATTESTATION_WINDOW_MS).toBeGreaterThan(
        GUI_FRAME_TIMEOUT_MS,
      );
    });

    it("CLI ordering: client 15s timeout then host typed attestation at 30s recovers on a fresh socket", async () => {
      const { factory, sockets } = makeFactory();
      const { client, authCalls, authority } = makeGraceRecoveryStack({
        factory,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "hi" }, authority);
      await driveUntilRequestSent(sockets);

      // Client response deadline fires first at 15s; grace = 50_000 - 15_000.
      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      expect(sockets).toHaveLength(1);
      expect(sockets[0].socket.closed).toBeNull();

      // Host post-open deadline at 30s lands during grace.
      await vi.advanceTimersByTimeAsync(
        HOST_POST_OPEN_DEADLINE_MS - CLI_FRAME_TIMEOUT_MS,
      );
      sockets[0].socket.fireMessage(typedPostOpenTimeoutFatal);
      await flushFake();

      for (let attempt = 0; attempt < 10 && sockets.length < 2; attempt += 1) {
        await flushFake();
      }
      expect(sockets).toHaveLength(2);
      expect(authCalls.count).toBe(0);

      await completeRetriedSocket(sockets, 1);
      await expect(pending).resolves.toEqual({ echoed: "HI" });
    });

    it("GUI ordering: client 30s timeout then legacy attestation inside 20s grace recovers without auth revalidation", async () => {
      const { factory, sockets } = makeFactory();
      const { client, authCalls, authority } = makeGraceRecoveryStack({
        factory,
        frameTimeoutMs: GUI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "hi" }, authority);
      await driveUntilRequestSent(sockets);

      // Client deadline equals the host's 30s post-open timer; grace = 20s.
      await vi.advanceTimersByTimeAsync(GUI_FRAME_TIMEOUT_MS);
      expect(sockets).toHaveLength(1);
      expect(sockets[0].socket.closed).toBeNull();

      // Host fatal arrives a moment later, still inside the remaining 20s grace.
      await vi.advanceTimersByTimeAsync(1);
      sockets[0].socket.fireMessage(legacyPostOpenTimeoutFatal);
      await flushFake();

      for (let attempt = 0; attempt < 10 && sockets.length < 2; attempt += 1) {
        await flushFake();
      }
      expect(sockets).toHaveLength(2);
      // Legacy UNAUTHORIZED spelling must not trigger auth revalidation.
      expect(authCalls.count).toBe(0);

      await completeRetriedSocket(sockets, 1);
      await expect(pending).resolves.toEqual({ echoed: "HI" });
    });

    it("GUI delayed equal-deadline: stalled-host attestation at 45s still recovers within the 50s window", async () => {
      const { factory, sockets } = makeFactory();
      const { client, authCalls, authority } = makeGraceRecoveryStack({
        factory,
        frameTimeoutMs: GUI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "hi" }, authority);
      await driveUntilRequestSent(sockets);

      // Client fires first at 30s; grace = 50_000 - 30_000 = 20s (expires at 50s).
      await vi.advanceTimersByTimeAsync(GUI_FRAME_TIMEOUT_MS);
      expect(sockets).toHaveLength(1);
      expect(sockets[0].socket.closed).toBeNull();

      // Stalled host: overdue post-open timer only runs on resume ~45s total
      // (~15s into the 20s grace). Discriminates the 50s window from the old 35s
      // window, under which grace would already have expired at 35s.
      await vi.advanceTimersByTimeAsync(
        STALLED_HOST_ATTESTATION_AT_MS - GUI_FRAME_TIMEOUT_MS,
      );
      expect(sockets[0].socket.closed).toBeNull();
      sockets[0].socket.fireMessage(typedPostOpenTimeoutFatal);
      await flushFake();

      for (let attempt = 0; attempt < 10 && sockets.length < 2; attempt += 1) {
        await flushFake();
      }
      expect(sockets).toHaveLength(2);
      expect(authCalls.count).toBe(0);

      await completeRetriedSocket(sockets, 1);
      await expect(pending).resolves.toEqual({ echoed: "HI" });
    });

    it("grace expiry with no attestation rejects as non-retryable HostTransportFailureError without a second dial", async () => {
      const { factory, sockets } = makeFactory();
      const { client, authority } = makeGraceRecoveryStack({
        factory,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "hi" }, authority);
      // Attach before timers fire so the rejection is not unhandled under fake timers.
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
          ),
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      expect(sockets[0].socket.closed).toBeNull();

      // Exhaust the remainder of the 50s window (grace = 35s). No attestation.
      await vi.advanceTimersByTimeAsync(
        HOST_ATTESTATION_WINDOW_MS - CLI_FRAME_TIMEOUT_MS,
      );
      await rejection;
      expect(sockets).toHaveLength(1);
    });

    it("a late response frame during grace does not resolve the call", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeClient({
        factory,
        authToken: "t",
        requestId: "req-grace-late-response",
        dialTimeoutMs: 1_000,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "x" });
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
          ),
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      expect(sockets[0].socket.closed).toBeNull();

      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: requestFrame.requestId,
        method: requestFrame.method,
        schemaVersion: requestFrame.schemaVersion,
        result: { echoed: "LATE" },
        error: null,
      });
      await rejection;
    });

    it("an unrelated retryable-marked fatal during grace does not become retryable", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeClient({
        factory,
        authToken: "t",
        requestId: "req-grace-unrelated-fatal",
        dialTimeoutMs: 1_000,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "x" });
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
          ),
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      // Without this the fatal would land on an already-closed socket and the
      // assertion below would hold for the wrong reason.
      expect(sockets[0].socket.closed).toBeNull();

      sockets[0].socket.fireMessage({
        kind: "fatalError",
        details: {
          code: "HOST_BUSY_AFTER_DISPATCH",
          reason: "host became busy after dispatch",
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
        },
      });
      await rejection;
    });

    /**
     * The exact-legacy no-dispatch matcher requires all three guards:
     * code === "UNAUTHORIZED", reason start-anchor, and reason end-anchor.
     * Promoting a near-miss into RetryableTransportError would redial a
     * non-idempotent method. Each row kills one guard if removed.
     */
    const EXACT_LEGACY_TIMEOUT_REASON =
      "Timed out waiting for 'request' frame after openAck (30000ms)";

    it.each([
      {
        name: "trailing text under UNAUTHORIZED",
        code: "UNAUTHORIZED",
        reason: `${EXACT_LEGACY_TIMEOUT_REASON} — token expired mid-flight`,
      },
      {
        name: "leading text under UNAUTHORIZED",
        code: "UNAUTHORIZED",
        reason: `Session rejected: ${EXACT_LEGACY_TIMEOUT_REASON}`,
      },
      {
        name: "exact historical reason under FORBIDDEN",
        code: "FORBIDDEN",
        reason: EXACT_LEGACY_TIMEOUT_REASON,
      },
    ] as const)(
      "near-miss legacy attestation ($name) during grace stays non-retryable without a second dial",
      async ({ code, reason }) => {
        const { factory, sockets } = makeFactory();
        const { client, authCalls, authority } = makeGraceRecoveryStack({
          factory,
          frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
          hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
        });

        const pending = client.request(
          "host.echo",
          { message: "hi" },
          authority,
        );
        const rejection = expect(pending).rejects.toSatisfy(
          (error: unknown) =>
            error instanceof HostTransportFailureError &&
            !(error instanceof RetryableTransportError) &&
            error.message.includes(
              `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
            ),
        );
        await driveUntilRequestSent(sockets);

        await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
        expect(sockets[0].socket.closed).toBeNull();

        sockets[0].socket.fireMessage({
          kind: "fatalError",
          details: {
            code,
            reason,
            incompatibleMethods: null,
            upgradeGuidance: null,
          },
        });
        await rejection;
        expect(sockets).toHaveLength(1);
        expect(authCalls.count).toBe(0);
      },
    );

    /**
     * Models suspend after the response deadline has already armed grace, then
     * a wake batch that runs the overdue *window* leg first. Before the
     * two-leg fix that callback closed the socket immediately; now it only
     * arms the delivery leg, so the host's equally overdue attestation can
     * still land.
     *
     * CLI 15s wait / 50s window: window leg is 30s (fires at t=45s), delivery
     * leg is 5s (would fail at t=50s). Advancing to the window-leg fire is the
     * discriminator - the socket must still be open.
     */
    it("suspend after grace armed: window-leg callback on wake keeps the socket open for typed attestation recovery", async () => {
      const { factory, sockets } = makeFactory();
      const { client, authCalls, authority } = makeGraceRecoveryStack({
        factory,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "hi" }, authority);
      await driveUntilRequestSent(sockets);

      // Response deadline → grace armed (window 30s + delivery 5s).
      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      expect(sockets).toHaveLength(1);
      expect(sockets[0].socket.closed).toBeNull();

      // Window leg fires (t=45s). Models the wake batch running the overdue
      // client callback first; the socket must still be open so the host's
      // equally overdue attestation can still arrive on this connection.
      await vi.advanceTimersByTimeAsync(
        HOST_ATTESTATION_WINDOW_MS -
          CLI_FRAME_TIMEOUT_MS -
          ATTESTATION_DELIVERY_SLACK_MS,
      );
      expect(sockets[0].socket.closed).toBeNull();

      sockets[0].socket.fireMessage(typedPostOpenTimeoutFatal);
      await flushFake();

      for (let attempt = 0; attempt < 10 && sockets.length < 2; attempt += 1) {
        await flushFake();
      }
      expect(sockets).toHaveLength(2);
      expect(authCalls.count).toBe(0);

      await completeRetriedSocket(sockets, 1);
      await expect(pending).resolves.toEqual({ echoed: "HI" });
    });

    /**
     * Models suspend *inside* the delivery leg. Jumping the fake wall clock
     * with `setSystemTime` before advancing the 5s delivery timer makes the
     * callback observe a large overshoot (suspension), so production re-arms a
     * fresh awake delivery leg instead of ending the call.
     */
    it("suspend during delivery leg: overdue expiry on wake keeps the socket open for typed attestation recovery", async () => {
      const { factory, sockets } = makeFactory();
      const { client, authCalls, authority } = makeGraceRecoveryStack({
        factory,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "hi" }, authority);
      await driveUntilRequestSent(sockets);

      // Response deadline → grace armed; window leg → delivery leg armed (t=45s).
      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(
        HOST_ATTESTATION_WINDOW_MS -
          CLI_FRAME_TIMEOUT_MS -
          ATTESTATION_DELIVERY_SLACK_MS,
      );
      expect(sockets[0].socket.closed).toBeNull();

      // Suspend while the delivery timer is pending, then let it fire overdue.
      vi.setSystemTime(Date.now() + SUSPEND_JUMP_MS);
      await vi.advanceTimersByTimeAsync(ATTESTATION_DELIVERY_SLACK_MS);
      // Discriminator: late-fire forgiveness re-armed the delivery leg.
      expect(sockets[0].socket.closed).toBeNull();

      sockets[0].socket.fireMessage(typedPostOpenTimeoutFatal);
      await flushFake();

      for (let attempt = 0; attempt < 10 && sockets.length < 2; attempt += 1) {
        await flushFake();
      }
      expect(sockets).toHaveLength(2);
      expect(authCalls.count).toBe(0);

      await completeRetriedSocket(sockets, 1);
      await expect(pending).resolves.toEqual({ echoed: "HI" });
    });

    /**
     * The bound is active time, not suspension count: every late delivery
     * re-arms, and the grace ends only when a delivery leg gets its full
     * awake slack with no wall-clock jump.
     */
    it("repeated delivery-leg suspensions re-arm past any count cap; an uninterrupted leg ends the grace", async () => {
      const { factory, sockets } = makeFactory();
      const { client, authority } = makeGraceRecoveryStack({
        factory,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "hi" }, authority);
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
          ),
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(
        HOST_ATTESTATION_WINDOW_MS -
          CLI_FRAME_TIMEOUT_MS -
          ATTESTATION_DELIVERY_SLACK_MS,
      );
      expect(sockets[0].socket.closed).toBeNull();

      // Cross the former count cap (3) decisively — no suspension count limit.
      for (let i = 0; i < REPEATED_SUSPENSION_CYCLES; i += 1) {
        vi.setSystemTime(Date.now() + SUSPEND_JUMP_MS);
        await vi.advanceTimersByTimeAsync(ATTESTATION_DELIVERY_SLACK_MS);
        expect(sockets[0].socket.closed).toBeNull();
      }

      // Finite in active time: one uninterrupted delivery leg settles.
      await vi.advanceTimersByTimeAsync(ATTESTATION_DELIVERY_SLACK_MS);
      await rejection;
      expect(sockets).toHaveLength(1);
    });

    it("ordinary delivery-leg jitter below suspension tolerance ends grace without re-arming", async () => {
      const { factory, sockets } = makeFactory();
      const { client, authority } = makeGraceRecoveryStack({
        factory,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "hi" }, authority);
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
          ),
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(
        HOST_ATTESTATION_WINDOW_MS -
          CLI_FRAME_TIMEOUT_MS -
          ATTESTATION_DELIVERY_SLACK_MS,
      );
      expect(sockets[0].socket.closed).toBeNull();

      // Overshoot of 500ms is below the 1s suspension tolerance → not forgiven.
      vi.setSystemTime(
        Date.now() + Math.floor(SUSPENSION_OVERSHOOT_TOLERANCE_MS / 2),
      );
      await vi.advanceTimersByTimeAsync(ATTESTATION_DELIVERY_SLACK_MS);
      await rejection;
      expect(sockets).toHaveLength(1);
    });

    /**
     * Long-poll budgets (e.g. providers.awaitLogin at 16 min) outlast the 50s
     * window. They no longer get zero grace: the response-timeout callback
     * still arms a finite delivery floor so a late-firing host attestation can
     * recover on a fresh socket when the client callback wins on wake.
     */
    it("long-poll deadline overdue on wake keeps a delivery floor and recovers on typed attestation", async () => {
      const { factory, sockets } = makeFactory();
      const { client, authCalls, authority } = makeGraceRecoveryStack({
        factory,
        frameTimeoutMs: 1_000,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.requestWithResponseTimeout(
        "host.echo",
        { message: "slow" },
        LONG_POLL_RESPONSE_TIMEOUT_MS,
        authority,
      );
      await driveUntilRequestSent(sockets);

      // Advance the full long-poll budget so the response-timeout callback wins
      // on wake. Discriminator: socket stays open (delivery floor armed).
      await vi.advanceTimersByTimeAsync(LONG_POLL_RESPONSE_TIMEOUT_MS);
      expect(sockets[0].socket.closed).toBeNull();

      sockets[0].socket.fireMessage(typedPostOpenTimeoutFatal);
      await flushFake();

      for (let attempt = 0; attempt < 10 && sockets.length < 2; attempt += 1) {
        await flushFake();
      }
      expect(sockets).toHaveLength(2);
      expect(authCalls.count).toBe(0);

      await completeRetriedSocket(sockets, 1);
      await expect(pending).resolves.toEqual({ echoed: "HI" });
    });

    it("long-poll delivery-floor grace is finite: expires as original non-retryable timeout without a second dial", async () => {
      const { factory, sockets } = makeFactory();
      const { client, authority } = makeGraceRecoveryStack({
        factory,
        frameTimeoutMs: 1_000,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.requestWithResponseTimeout(
        "host.echo",
        { message: "slow" },
        LONG_POLL_RESPONSE_TIMEOUT_MS,
        authority,
      );
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${LONG_POLL_RESPONSE_TIMEOUT_MS}ms`,
          ),
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(LONG_POLL_RESPONSE_TIMEOUT_MS);
      expect(sockets[0].socket.closed).toBeNull();

      // Delivery floor only; nothing arrives → original ambiguous timeout.
      await vi.advanceTimersByTimeAsync(ATTESTATION_DELIVERY_SLACK_MS);
      await rejection;
      expect(sockets).toHaveLength(1);
    });

    it("close during grace keeps the original ambiguous response timeout without a second dial", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeClient({
        factory,
        authToken: "t",
        requestId: "req-grace-sticky-close",
        dialTimeoutMs: 1_000,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "x" });
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
          ) &&
          !error.message.includes("WebSocket closed before next frame") &&
          !error.message.includes("WebSocket transport error:") &&
          !error.message.includes("Malformed host frame:"),
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      expect(sockets[0].socket.closed).toBeNull();

      sockets[0].socket.fireClose(1006, "abnormal", false);
      await rejection;
      expect(sockets).toHaveLength(1);
      // failAll must dispose the armed grace timer (window/delivery leg).
      expect(vi.getTimerCount()).toBe(0);
    });

    it("transport error during grace keeps the original ambiguous response timeout without a second dial", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeClient({
        factory,
        authToken: "t",
        requestId: "req-grace-sticky-error",
        dialTimeoutMs: 1_000,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "x" });
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
          ) &&
          !error.message.includes("WebSocket closed before next frame") &&
          !error.message.includes("WebSocket transport error:") &&
          !error.message.includes("Malformed host frame:"),
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      expect(sockets[0].socket.closed).toBeNull();

      sockets[0].socket.fireError("ECONNRESET");
      await rejection;
      expect(sockets).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("malformed JSON during grace keeps the original ambiguous response timeout without a second dial", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeClient({
        factory,
        authToken: "t",
        requestId: "req-grace-sticky-raw",
        dialTimeoutMs: 1_000,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "x" });
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
          ) &&
          !error.message.includes("WebSocket closed before next frame") &&
          !error.message.includes("WebSocket transport error:") &&
          !error.message.includes("Malformed host frame:"),
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      expect(sockets[0].socket.closed).toBeNull();

      sockets[0].socket.fireRawMessage("not json");
      await rejection;
      expect(sockets).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("invalid frame shape during grace keeps the original ambiguous response timeout without a second dial", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeClient({
        factory,
        authToken: "t",
        requestId: "req-grace-sticky-shape",
        dialTimeoutMs: 1_000,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
      });

      const pending = client.request("host.echo", { message: "x" });
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
          ) &&
          !error.message.includes("WebSocket closed before next frame") &&
          !error.message.includes("WebSocket transport error:") &&
          !error.message.includes("Malformed host frame:"),
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      expect(sockets[0].socket.closed).toBeNull();

      // Valid JSON that fails hostFrameSchema (missing required response fields).
      sockets[0].socket.fireRawMessage(
        JSON.stringify({ kind: "response", requestId: "x" }),
      );
      await rejection;
      expect(sockets).toHaveLength(1);
    });

    it("zero attestation window settles a post-send response timeout at the caller deadline with no delivery tail", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeClient({
        factory,
        authToken: "t",
        requestId: "req-grace-zero-window",
        dialTimeoutMs: 1_000,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: 0,
      });

      const pending = client.request("host.echo", { message: "x" });
      const rejection = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof HostTransportFailureError &&
          !(error instanceof RetryableTransportError) &&
          error.message.includes(
            `frame timed out after ${CLI_FRAME_TIMEOUT_MS}ms`,
          ),
      );
      await driveUntilRequestSent(sockets);

      // Shared-transport half of the fast-fail guarantee: with window 0 the
      // rejection settles at exactly the caller's deadline (no delivery floor).
      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      await rejection;
      expect(sockets).toHaveLength(1);
    });

    it("aborting the authority during grace settles with HostRequestAbortedError and closes the socket", async () => {
      const { factory, sockets } = makeFactory();
      const lifetime = new AbortController();
      const client = new WsRpcClient<typeof testRegistry>({
        registry: testRegistry,
        requestId: () => "req-grace-abort",
        webSocketFactory: factory,
        dialTimeoutMs: 1_000,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      const pending = client.request(
        "host.echo",
        { message: "hi" },
        {
          endpoint: {
            hostId: mockLocalHostEntry.hostId,
            websocketUrl: mockLocalHostEntry.websocketUrl,
          },
          bearer: new MutableBearerLease("token-abc", "test-user"),
          abortSignal: lifetime.signal,
        },
      );
      const rejection = expect(pending).rejects.toBeInstanceOf(
        HostRequestAbortedError,
      );
      await driveUntilRequestSent(sockets);

      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      expect(sockets[0].socket.closed).toBeNull();

      lifetime.abort("host-replaced");
      await rejection;
      expect(sockets[0].socket.closed).toEqual({
        code: 1000,
        reason: "authority-aborted",
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("aborting after a re-armed delivery leg clears timers and settles with HostRequestAbortedError", async () => {
      const { factory, sockets } = makeFactory();
      const lifetime = new AbortController();
      const client = new WsRpcClient<typeof testRegistry>({
        registry: testRegistry,
        requestId: () => "req-grace-abort-rearmed",
        webSocketFactory: factory,
        dialTimeoutMs: 1_000,
        frameTimeoutMs: CLI_FRAME_TIMEOUT_MS,
        hostAttestationWindowMs: HOST_ATTESTATION_WINDOW_MS,
        evidence: NO_TRANSPORT_EVIDENCE,
      });
      const pending = client.request(
        "host.echo",
        { message: "hi" },
        {
          endpoint: {
            hostId: mockLocalHostEntry.hostId,
            websocketUrl: mockLocalHostEntry.websocketUrl,
          },
          bearer: new MutableBearerLease("token-abc", "test-user"),
          abortSignal: lifetime.signal,
        },
      );
      const rejection = expect(pending).rejects.toBeInstanceOf(
        HostRequestAbortedError,
      );
      await driveUntilRequestSent(sockets);

      // Arm grace, fire the window leg, then suspend so delivery re-arms.
      await vi.advanceTimersByTimeAsync(CLI_FRAME_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(
        HOST_ATTESTATION_WINDOW_MS -
          CLI_FRAME_TIMEOUT_MS -
          ATTESTATION_DELIVERY_SLACK_MS,
      );
      vi.setSystemTime(Date.now() + SUSPEND_JUMP_MS);
      await vi.advanceTimersByTimeAsync(ATTESTATION_DELIVERY_SLACK_MS);
      expect(sockets[0].socket.closed).toBeNull();

      lifetime.abort("host-replaced");
      await rejection;
      expect(sockets[0].socket.closed).toEqual({
        code: 1000,
        reason: "authority-aborted",
      });
      // Disposal must cover the re-armed delivery timer, not only the first leg.
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("does NOT classify a post-send response timeout as retryable", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-postsend",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 25,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();
    // The request frame is now on the wire; the response never arrives.
    expect(expectRequestFrame(sockets[0].sent[1])).toBeDefined();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostTransportFailureError &&
        !(error instanceof RetryableTransportError) &&
        error.message.includes("frame timed out"),
    );
  });

  it("does NOT retry an arbitrary host-marked fatal after request dispatch", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-postsend-fatal",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();
    expect(expectRequestFrame(sockets[0].sent[1])).toBeDefined();

    sockets[0].socket.fireMessage({
      kind: "fatalError",
      details: {
        code: "HOST_BUSY_AFTER_DISPATCH",
        reason: "host became busy after dispatch",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      },
    });

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        !(error instanceof RetryableTransportError) &&
        error.fatalDetails?.code === "HOST_BUSY_AFTER_DISPATCH",
    );
  });

  it("requestWithResponseTimeout waits past the default frame timeout for a long-poll response", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-longpoll",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 25,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.requestWithResponseTimeout(
      "host.echo",
      { message: "slow" },
      5_000,
    );
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();
    expect(expectRequestFrame(sockets[0].sent[1])).toBeDefined();

    // Stay silent well past the 25ms transport default - a long-poll
    // response legitimately arrives later than the frame timeout.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    sockets[0].socket.fireMessage({
      kind: "response",
      requestId: "req-longpoll",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "SLOW" },
      error: null,
    });

    await expect(pending).resolves.toEqual({ echoed: "SLOW" });
  });

  it("requestWithResponseTimeout keeps the default frame timeout for the handshake", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-longpoll-handshake",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 25,
      hostAttestationWindowMs: undefined,
    });

    // The extended budget covers ONLY the response wait - a host that never
    // answers `openAck` is unreachable and must still fail at the default.
    const pending = client.requestWithResponseTimeout(
      "host.echo",
      { message: "x" },
      60_000,
    );
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        error.message.includes("frame timed out after 25ms"),
    );
  });

  it("requestWithResponseTimeout still times out once the extended budget elapses", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-longpoll-elapsed",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 25,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.requestWithResponseTimeout(
      "host.echo",
      { message: "x" },
      50,
    );
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        !(error instanceof RetryableTransportError) &&
        error.message.includes("frame timed out after 50ms"),
    );
  });

  it("does NOT classify a malformed frame as retryable", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-malformed-nonretry",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireRawMessage("{ not json");

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        !(error instanceof HostTransportFailureError) &&
        error.message.includes("Malformed host frame:"),
    );
  });

  it("propagates a host error envelope on the response frame", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "t",
      requestId: "req-error-env",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const pending = client.request("host.echo", { message: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage(
      openAckWithOptionalHostEcho({ major: 1, minor: 0 }),
    );
    await flush();

    sockets[0].socket.fireMessage({
      kind: "response",
      requestId: "req-error-env",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: null,
      error: { code: "DOWNGRADE_UNSUPPORTED", message: "no bridge" },
    });

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "DOWNGRADE_UNSUPPORTED" &&
        error.message === "no bridge"
      );
    });
  });

  it("falls back to a floor method when an optional method is absent", async () => {
    const fallbackV10 = defineRpcContract({
      method: "host.syntheticFallback",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ label: z.string() }),
      responseSchema: z.object({ summary: z.string() }),
    });
    const fallbackRegistry = defineFloorAwareVersionedRpcRegistry(
      ["host.status"] as const,
      {
        "host.status": {
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: statusV10, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
        "host.syntheticFallback": {
          degrade: defineFallbackMethodDegrade<
            typeof fallbackV10,
            typeof statusV10,
            "host.status"
          >({
            kind: "fallback",
            to: { method: "host.status", major: 1, minor: 0 },
            adaptRequest: () => ({}),
            adaptResponse: (response) => ({
              summary: response.ready ? "ready" : "not-ready",
            }),
          }),
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: fallbackV10, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
      },
    );
    const { factory, sockets } = makeFactory();
    const ctx = makeRequestContext("t");
    const client = new BoundWsRpcClient(
      new WsRpcClient<typeof fallbackRegistry>({
        registry: fallbackRegistry,
        requestId: () => "req-fallback",
        webSocketFactory: factory,
        dialTimeoutMs: 1000,
        frameTimeoutMs: 1000,
        hostAttestationWindowMs: 0,
        evidence: NO_TRANSPORT_EVIDENCE,
      }),
      authorityForBearer(ctx.credentials),
    );

    const pending = client.request("host.syntheticFallback", { label: "x" });
    await flush();
    sockets[0].socket.fireOpen();
    await flush();

    const openFrame = expectOpenFrame(sockets[0].sent[0]);
    expect(openFrame.manifest).toEqual({
      "host.status": { major: 1, minor: 0 },
    });
    expect(openFrame.optionalManifest).toEqual({
      "host.syntheticFallback": { major: 1, minor: 0 },
    });

    sockets[0].socket.fireMessage({
      kind: "openAck",
      manifest: {
        "host.status": { major: 1, minor: 0 },
      },
    });
    await flush();

    const requestFrame = expectRequestFrame(sockets[0].sent[1]);
    expect(requestFrame).toEqual({
      kind: "request",
      requestId: "req-fallback",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
    expect(sockets[0].socket.closed).toBeNull();

    sockets[0].socket.fireMessage({
      kind: "response",
      requestId: "req-fallback",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      result: { ready: true },
      error: null,
    });

    await expect(pending).resolves.toEqual({ summary: "ready" });
    expect(sockets[0].socket.closed).toEqual({ code: 1000, reason: "ok" });
  });

  it("throws E_HOST_UNSUPPORTED when an absent optional method declares unsupported", async () => {
    const unsupportedV10 = defineRpcContract({
      method: "host.syntheticUnsupported",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({}),
      responseSchema: z.object({ ok: z.boolean() }),
    });
    const unsupportedRegistry = defineFloorAwareVersionedRpcRegistry(
      ["host.status"] as const,
      {
        "host.status": {
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: statusV10, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
        "host.syntheticUnsupported": {
          degrade: { kind: "unsupported" },
          1: {
            latestMinor: 0,
            versions: {
              0: { contract: unsupportedV10, upgradeFromPreviousVersion: null },
            },
            downgradePathsFromLatest: {},
          },
        },
      },
    );
    const { factory, sockets } = makeFactory();
    const ctx = makeRequestContext("t");
    const client = new BoundWsRpcClient(
      new WsRpcClient<typeof unsupportedRegistry>({
        registry: unsupportedRegistry,
        requestId: () => "req-unsupported",
        webSocketFactory: factory,
        dialTimeoutMs: 1000,
        frameTimeoutMs: 1000,
        hostAttestationWindowMs: 0,
        evidence: NO_TRANSPORT_EVIDENCE,
      }),
      authorityForBearer(ctx.credentials),
    );

    const pending = client.request("host.syntheticUnsupported", {});
    await flush();
    sockets[0].socket.fireOpen();
    await flush();
    sockets[0].socket.fireMessage({
      kind: "openAck",
      manifest: {
        "host.status": { major: 1, minor: 0 },
      },
    });

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof HostRpcError &&
        error.code === "E_HOST_UNSUPPORTED" &&
        error.fatalDetails?.upgradeGuidance?.hostShouldUpgrade === true
      );
    });
    expect(sockets[0].sent.map((frame) => frame.kind)).not.toContain("request");
  });

  describe("fallback degrade version anchoring", () => {
    const statusSkewV11 = defineRpcContract({
      method: "host.status",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ verbose: z.boolean() }),
      responseSchema: z.object({ ready: z.boolean(), detail: z.string() }),
    });

    const fallbackSkewV10 = defineRpcContract({
      method: "host.syntheticSkewFallback",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ label: z.string() }),
      responseSchema: z.object({
        summary: z.string(),
        detailSeen: z.boolean(),
      }),
    });

    const upgradeStatusV10ToV11 = defineUpgradePath<
      typeof statusV10,
      typeof statusSkewV11
    >({
      from: statusV10.schemaVersion,
      to: statusSkewV11.schemaVersion,
      upgradeRequest: () => ({ verbose: false }),
      upgradeResponse: (response) => ({
        ready: response.ready,
        detail: "upgraded",
      }),
    });

    const fallbackSkewRegistry = defineFloorAwareVersionedRpcRegistry(
      ["host.status"] as const,
      {
        "host.status": {
          1: {
            latestMinor: 1,
            versions: {
              0: { contract: statusV10, upgradeFromPreviousVersion: null },
              1: {
                contract: statusSkewV11,
                upgradeFromPreviousVersion: upgradeStatusV10ToV11,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
        "host.syntheticSkewFallback": {
          degrade: defineFallbackMethodDegrade<
            typeof fallbackSkewV10,
            typeof statusV10,
            "host.status"
          >({
            kind: "fallback",
            to: { method: "host.status", major: 1, minor: 0 },
            adaptRequest: () => ({}),
            adaptResponse: (response) => ({
              summary: response.ready ? "ready" : "not-ready",
              detailSeen: Object.prototype.hasOwnProperty.call(
                response,
                "detail",
              ),
            }),
          }),
          1: {
            latestMinor: 0,
            versions: {
              0: {
                contract: fallbackSkewV10,
                upgradeFromPreviousVersion: null,
              },
            },
            downgradePathsFromLatest: {},
          },
        },
      },
    );

    function makeFallbackSkewClient(options: {
      readonly factory: IWebSocketFactory;
      readonly requestId: string;
    }): BoundWsRpcClient<typeof fallbackSkewRegistry> {
      const ctx = makeRequestContext("t");
      return new BoundWsRpcClient(
        new WsRpcClient<typeof fallbackSkewRegistry>({
          registry: fallbackSkewRegistry,
          requestId: () => options.requestId,
          webSocketFactory: options.factory,
          dialTimeoutMs: 1000,
          frameTimeoutMs: 1000,
          hostAttestationWindowMs: 0,
          evidence: NO_TRANSPORT_EVIDENCE,
        }),
        authorityForBearer(ctx.credentials),
      );
    }

    it("anchors fallback at degrade.to when the host has the older target minor", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeFallbackSkewClient({
        factory,
        requestId: "req-fallback-skew-old-host",
      });

      const pending = client.request("host.syntheticSkewFallback", {
        label: "x",
      });
      await flush();
      sockets[0].socket.fireOpen();
      await flush();

      const openFrame = expectOpenFrame(sockets[0].sent[0]);
      expect(openFrame.manifest).toEqual({
        "host.status": { major: 1, minor: 1 },
      });
      expect(openFrame.optionalManifest).toEqual({
        "host.syntheticSkewFallback": { major: 1, minor: 0 },
      });

      sockets[0].socket.fireMessage({
        kind: "openAck",
        manifest: {
          "host.status": { major: 1, minor: 0 },
        },
      });
      await flush();

      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame).toEqual({
        kind: "request",
        requestId: "req-fallback-skew-old-host",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        params: {},
      });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-fallback-skew-old-host",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        result: { ready: true },
        error: null,
      });

      await expect(pending).resolves.toEqual({
        summary: "ready",
        detailSeen: false,
      });
    });

    it("anchors fallback at degrade.to when the host has the newer floor minor", async () => {
      const { factory, sockets } = makeFactory();
      const client = makeFallbackSkewClient({
        factory,
        requestId: "req-fallback-skew-new-host",
      });

      const pending = client.request("host.syntheticSkewFallback", {
        label: "x",
      });
      await flush();
      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage({
        kind: "openAck",
        manifest: {
          "host.status": { major: 1, minor: 1 },
        },
      });
      await flush();

      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame).toEqual({
        kind: "request",
        requestId: "req-fallback-skew-new-host",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        params: {},
      });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-fallback-skew-new-host",
        method: "host.status",
        schemaVersion: { major: 1, minor: 0 },
        result: { ready: true },
        error: null,
      });

      await expect(pending).resolves.toEqual({
        summary: "ready",
        detailSeen: false,
      });
    });
  });

  // ---- Asymmetric per-method version-on-wire ---------------------------- //

  describe("asymmetric per-method version-on-wire", () => {
    const echoReqV10 = defineRpcContract({
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ message: z.string() }),
      responseSchema: z.object({ echoed: z.string() }),
    });

    const echoReqV11 = defineRpcContract({
      method: "host.echo",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ message: z.string(), loud: z.boolean() }),
      responseSchema: z.object({ echoed: z.string(), volume: z.number() }),
    });

    const echoReqV20 = defineRpcContract({
      method: "host.echo",
      schemaVersion: { major: 2, minor: 0 } as const,
      requestSchema: z.object({ text: z.string(), shout: z.boolean() }),
      responseSchema: z.object({ reply: z.string(), level: z.number() }),
    });

    const upgradeEchoV10ToV11 = defineUpgradePath<
      typeof echoReqV10,
      typeof echoReqV11
    >({
      from: echoReqV10.schemaVersion,
      to: echoReqV11.schemaVersion,
      upgradeRequest: (request) => ({ message: request.message, loud: false }),
      upgradeResponse: (response) => ({ echoed: response.echoed, volume: 0 }),
    });

    const upgradeEchoV11ToV20 = defineUpgradePath<
      typeof echoReqV11,
      typeof echoReqV20
    >({
      from: echoReqV11.schemaVersion,
      to: echoReqV20.schemaVersion,
      upgradeRequest: (request) => ({
        text: request.message,
        shout: request.loud,
      }),
      upgradeResponse: (response) => ({
        reply: response.echoed,
        level: response.volume,
      }),
    });

    const downgradeEchoV20ToV11 = defineDowngradePath<
      typeof echoReqV20,
      typeof echoReqV11
    >({
      from: echoReqV20.schemaVersion,
      to: echoReqV11.schemaVersion,
      downgradeRequest: (request) => ({
        ok: true,
        value: { message: request.text, loud: request.shout },
      }),
      downgradeResponse: (response) => ({
        ok: true,
        value: { echoed: response.reply, volume: response.level },
      }),
    });

    const registryV1Line = defineVersionedRpcRegistry({
      "host.echo": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: echoReqV10, upgradeFromPreviousVersion: null },
            1: {
              contract: echoReqV11,
              upgradeFromPreviousVersion: upgradeEchoV10ToV11,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    const registryV10Only = defineVersionedRpcRegistry({
      "host.echo": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: echoReqV10, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    // A same-major minor whose new capability genuinely can't project onto
    // the older schema - the pattern `workspace.prepareFolders` v1.1 uses to
    // fail closed against a v1.0 host instead of silently stripping to a
    // misleading empty request (see the RPC backward-compat decision log).
    const pingReqV10 = defineRpcContract({
      method: "host.ping",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ note: z.string() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });

    const pingReqV11 = defineRpcContract({
      method: "host.ping",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ note: z.string().nullable() }),
      responseSchema: z.object({ ok: z.boolean() }),
    });

    const upgradePingV10ToV11 = defineUpgradePath<
      typeof pingReqV10,
      typeof pingReqV11
    >({
      from: pingReqV10.schemaVersion,
      to: pingReqV11.schemaVersion,
      upgradeRequest: (request) => ({ note: request.note }),
      upgradeResponse: (response) => response,
    });

    const registryPingV1Line = defineVersionedRpcRegistry({
      "host.ping": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: pingReqV10, upgradeFromPreviousVersion: null },
            1: {
              contract: pingReqV11,
              upgradeFromPreviousVersion: upgradePingV10ToV11,
            },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    const registryV2WithBridge = defineVersionedRpcRegistry({
      "host.echo": {
        1: {
          latestMinor: 1,
          versions: {
            0: { contract: echoReqV10, upgradeFromPreviousVersion: null },
            1: {
              contract: echoReqV11,
              upgradeFromPreviousVersion: upgradeEchoV10ToV11,
            },
          },
          downgradePathsFromLatest: {},
        },
        2: {
          latestMinor: 0,
          versions: {
            0: {
              contract: echoReqV20,
              upgradeFromPreviousVersion: upgradeEchoV11ToV20,
            },
          },
          downgradePathsFromLatest: { 1: downgradeEchoV20ToV11 },
        },
      },
    });

    const registryV2NoBridge = defineVersionedRpcRegistry({
      "host.echo": {
        2: {
          latestMinor: 0,
          versions: {
            0: { contract: echoReqV20, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    });

    function buildClient<Registry extends VersionedRpcRegistry>(
      registry: Registry,
      options: {
        readonly factory: IWebSocketFactory;
        readonly requestId: string;
      },
    ): BoundWsRpcClient<Registry> {
      const ctx = makeRequestContext("t");
      return new BoundWsRpcClient(
        new WsRpcClient<Registry>({
          registry,
          requestId: () => options.requestId,
          webSocketFactory: options.factory,
          dialTimeoutMs: 1000,
          frameTimeoutMs: 1000,
          hostAttestationWindowMs: 0,
          evidence: NO_TRANSPORT_EVIDENCE,
        }),
        authorityForBearer(ctx.credentials),
      );
    }

    it("same major, client newer minor: strips request to older minor and upgrades response", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryV1Line, {
        factory,
        requestId: "req-same-newer",
      });

      const pending = client.request("host.echo", {
        message: "hi",
        loud: true,
      });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage(
        openAckWithOnlyOptionalHostEcho({ major: 1, minor: 0 }),
      );
      await flush();

      expect(sockets[0].sent).toHaveLength(2);
      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame.schemaVersion).toEqual({ major: 1, minor: 0 });
      expect(requestFrame.params).toEqual({ message: "hi" });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-same-newer",
        method: "host.echo",
        schemaVersion: { major: 1, minor: 0 },
        result: { echoed: "HI" },
        error: null,
      });

      await expect(pending).resolves.toEqual({ echoed: "HI", volume: 0 });
    });

    it("same major, client newer minor: a request that doesn't project onto the older schema throws DOWNGRADE_UNSUPPORTED without sending the request frame", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryPingV1Line, {
        factory,
        requestId: "req-same-newer-no-project",
      });

      const pending = client.request("host.ping", { note: null });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage({
        kind: "openAck",
        manifest: {},
        optionalManifest: { "host.ping": { major: 1, minor: 0 } },
      });

      await expect(pending).rejects.toSatisfy((error: unknown) => {
        return (
          error instanceof HostRpcError &&
          error.code === "DOWNGRADE_UNSUPPORTED" &&
          error.method === "host.ping" &&
          error.requestId === "req-same-newer-no-project" &&
          error.fatalDetails === null
        );
      });

      const kinds = sockets[0].sent.map((frame) => frame.kind);
      expect(kinds).not.toContain("request");
      expect(kinds).not.toContain("fatalError");
    });

    it("same major, client older minor: sends caller canonical unchanged and returns response unchanged", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryV10Only, {
        factory,
        requestId: "req-same-older",
      });

      const pending = client.request("host.echo", { message: "hi" });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage(
        openAckWithOnlyOptionalHostEcho({ major: 1, minor: 1 }),
      );
      await flush();

      expect(sockets[0].sent).toHaveLength(2);
      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame.schemaVersion).toEqual({ major: 1, minor: 0 });
      expect(requestFrame.params).toEqual({ message: "hi" });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-same-older",
        method: "host.echo",
        schemaVersion: { major: 1, minor: 0 },
        result: { echoed: "HI" },
        error: null,
      });

      await expect(pending).resolves.toEqual({ echoed: "HI" });
    });

    it("cross major, client newer with bridge: downgrades request and upgrades response", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryV2WithBridge, {
        factory,
        requestId: "req-cross-bridge",
      });

      const pending = client.request("host.echo", {
        text: "hi",
        shout: true,
      });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage(
        openAckWithOnlyOptionalHostEcho({ major: 1, minor: 1 }),
      );
      await flush();

      expect(sockets[0].sent).toHaveLength(2);
      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame.schemaVersion).toEqual({ major: 1, minor: 1 });
      expect(requestFrame.params).toEqual({ message: "hi", loud: true });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-cross-bridge",
        method: "host.echo",
        schemaVersion: { major: 1, minor: 1 },
        result: { echoed: "HI", volume: 9 },
        error: null,
      });

      await expect(pending).resolves.toEqual({ reply: "HI", level: 9 });
    });

    it("cross major, client newer without bridge: throws DOWNGRADE_UNSUPPORTED without sending request or fatalError", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryV2NoBridge, {
        factory,
        requestId: "req-cross-no-bridge",
      });

      const pending = client.request("host.echo", {
        text: "hi",
        shout: true,
      });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage(
        openAckWithOnlyOptionalHostEcho({ major: 1, minor: 1 }),
      );

      await expect(pending).rejects.toSatisfy((error: unknown) => {
        return (
          error instanceof HostRpcError &&
          error.code === "DOWNGRADE_UNSUPPORTED" &&
          error.method === "host.echo" &&
          error.requestId === "req-cross-no-bridge" &&
          error.fatalDetails === null
        );
      });

      const kinds = sockets[0].sent.map((frame) => frame.kind);
      expect(kinds).not.toContain("request");
      expect(kinds).not.toContain("fatalError");
    });

    it("cross major, client older: sends caller canonical unchanged and returns response unchanged", async () => {
      const { factory, sockets } = makeFactory();
      const client = buildClient(registryV1Line, {
        factory,
        requestId: "req-cross-older",
      });

      const pending = client.request("host.echo", {
        message: "hi",
        loud: true,
      });
      await flush();

      sockets[0].socket.fireOpen();
      await flush();

      sockets[0].socket.fireMessage(
        openAckWithOnlyOptionalHostEcho({ major: 2, minor: 0 }),
      );
      await flush();

      expect(sockets[0].sent).toHaveLength(2);
      const requestFrame = expectRequestFrame(sockets[0].sent[1]);
      expect(requestFrame.schemaVersion).toEqual({ major: 1, minor: 1 });
      expect(requestFrame.params).toEqual({ message: "hi", loud: true });

      sockets[0].socket.fireMessage({
        kind: "response",
        requestId: "req-cross-older",
        method: "host.echo",
        schemaVersion: { major: 1, minor: 1 },
        result: { echoed: "HI", volume: 4 },
        error: null,
      });

      await expect(pending).resolves.toEqual({ echoed: "HI", volume: 4 });
    });

    // Regression coverage for the pre-profiles `providers.list@3.0` crash:
    // fields added mid-line to an old major carry `.catch(...)` tolerances in
    // that line's frozen contract, but they only take effect if the client
    // actually parses the old host's wire payload before upgrading it.
    describe("old-host response parsing on the upgrade path", () => {
      const echoWithTagsV10 = defineRpcContract({
        method: "host.echo",
        schemaVersion: { major: 1, minor: 0 } as const,
        requestSchema: z.object({ message: z.string() }),
        // `tags` was added mid-line: old 1.0 host builds omit it entirely and
        // the frozen contract tolerates that with `.catch([])`.
        responseSchema: z.object({
          echoed: z.string(),
          tags: z.array(z.string()).catch([]),
        }),
      });

      const echoWithTagsV20 = defineRpcContract({
        method: "host.echo",
        schemaVersion: { major: 2, minor: 0 } as const,
        requestSchema: z.object({ message: z.string() }),
        responseSchema: z.object({
          echoed: z.string(),
          tags: z.array(z.string()),
        }),
      });

      const upgradeEchoWithTagsV10ToV20 = defineUpgradePath<
        typeof echoWithTagsV10,
        typeof echoWithTagsV20
      >({
        from: echoWithTagsV10.schemaVersion,
        to: echoWithTagsV20.schemaVersion,
        upgradeRequest: (request) => request,
        upgradeResponse: (response) => response,
      });

      const downgradeEchoWithTagsV20ToV10 = defineDowngradePath<
        typeof echoWithTagsV20,
        typeof echoWithTagsV10
      >({
        from: echoWithTagsV20.schemaVersion,
        to: echoWithTagsV10.schemaVersion,
        downgradeRequest: (request) => ({ ok: true, value: request }),
        downgradeResponse: (response) => ({ ok: true, value: response }),
      });

      const registryWithTags = defineVersionedRpcRegistry({
        "host.echo": {
          1: {
            latestMinor: 0,
            versions: {
              0: {
                contract: echoWithTagsV10,
                upgradeFromPreviousVersion: null,
              },
            },
            downgradePathsFromLatest: {},
          },
          2: {
            latestMinor: 0,
            versions: {
              0: {
                contract: echoWithTagsV20,
                upgradeFromPreviousVersion: upgradeEchoWithTagsV10ToV20,
              },
            },
            downgradePathsFromLatest: { 1: downgradeEchoWithTagsV20ToV10 },
          },
        },
      });

      it("applies the older contract's catch-tolerances to an old host's response before upgrading", async () => {
        const { factory, sockets } = makeFactory();
        const client = buildClient(registryWithTags, {
          factory,
          requestId: "req-old-host-catch",
        });

        const pending = client.request("host.echo", { message: "hi" });
        await flush();

        sockets[0].socket.fireOpen();
        await flush();

        sockets[0].socket.fireMessage(
          openAckWithOnlyOptionalHostEcho({ major: 1, minor: 0 }),
        );
        await flush();

        sockets[0].socket.fireMessage({
          kind: "response",
          requestId: "req-old-host-catch",
          method: "host.echo",
          schemaVersion: { major: 1, minor: 0 },
          // Old 1.0 host build from before `tags` existed - no `tags` key on
          // the wire. The identity 1.0→2.0 upgrade must still hand the caller
          // a response matching the 2.0 contract (`tags: []`).
          result: { echoed: "HI" },
          error: null,
        });

        await expect(pending).resolves.toEqual({ echoed: "HI", tags: [] });
      });

      it("rejects with RPC_ERROR when an old host's response fails its own contract", async () => {
        const { factory, sockets } = makeFactory();
        const client = buildClient(registryWithTags, {
          factory,
          requestId: "req-old-host-invalid",
        });

        const pending = client.request("host.echo", { message: "hi" });
        await flush();

        sockets[0].socket.fireOpen();
        await flush();

        sockets[0].socket.fireMessage(
          openAckWithOnlyOptionalHostEcho({ major: 1, minor: 0 }),
        );
        await flush();

        sockets[0].socket.fireMessage({
          kind: "response",
          requestId: "req-old-host-invalid",
          method: "host.echo",
          schemaVersion: { major: 1, minor: 0 },
          result: { echoed: 42 },
          error: null,
        });

        await expect(pending).rejects.toSatisfy((error: unknown) => {
          return (
            error instanceof HostRpcError &&
            error.code === "RPC_ERROR" &&
            error.method === "host.echo" &&
            error.message ===
              "Failed to upgrade response from 1.0 to 2.0: response does not match the 1.0 response schema"
          );
        });
      });
    });
  });
});

describe("WsRpcClient negotiated-manifest publication", () => {
  // The registry is module-level state shared by every consumer, so a stale
  // entry from another suite would make these assertions meaningless.
  beforeEach(() => {
    resetNegotiatedManifests();
  });
  afterEach(() => {
    resetNegotiatedManifests();
  });

  /**
   * The LOCAL half of the capability gate, which had no pin of its own.
   *
   * `useHostSupportsMethod` fails closed: with nothing recorded it answers
   * `null` ("not known"), and every UI gate built on it treats that as "keep
   * trying the RPC". So deleting this publication does not break a gate
   * loudly - it silently downgrades every local host to "unknown forever",
   * and each consumer then attempts methods an old host does not have instead
   * of taking its documented fallback. The remote transport is pinned in
   * `remote/__tests__/remote-session.test.ts`; this is its local twin.
   */
  it("publishes the MERGED floor + optional manifest for the dialled host", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      requestId: "req-1",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    expect(getNegotiatedHostMethods(mockLocalHostEntry.hostId)).toBeNull();

    const pending = client.request("host.echo", { message: "hi" });
    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();
    await flush();
    stub.fireMessage(openAckWithOptionalHostEcho({ major: 1, minor: 0 }));
    await flush();

    // `host.status` is floor, `host.echo` is optional: the gate needs BOTH, so
    // publishing only one manifest would hide half the host's surface.
    const methods = getNegotiatedHostMethods(mockLocalHostEntry.hostId);
    expect(methods).not.toBeNull();
    expect([...(methods ?? [])].sort()).toEqual(["host.echo", "host.status"]);

    stub.fireMessage({
      kind: "response",
      requestId: "req-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "HI" },
      error: null,
    });
    await expect(pending).resolves.toEqual({ echoed: "HI" });
  });

  /**
   * The refresh leg. A host upgraded in place keeps its id and re-handshakes
   * on the next unary call, so a LATER ack must overwrite the earlier record -
   * otherwise a capability answer taken once would outlive the host that gave
   * it, and a gate that latched "absent" could never recover.
   */
  it("overwrites an earlier record when the same host re-handshakes", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      requestId: "req-1",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    const first = client.request("host.status", {});
    await flush();
    const firstStub = sockets[0].socket;
    firstStub.fireOpen();
    await flush();
    // An OLD host: floor only, no optional surface at all.
    firstStub.fireMessage({
      kind: "openAck",
      manifest: { "host.status": { major: 1, minor: 0 } },
      optionalManifest: {},
    });
    await flush();
    firstStub.fireMessage({
      kind: "response",
      requestId: "req-1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      result: { ok: true },
      error: null,
    });
    await first;

    expect([
      ...(getNegotiatedHostMethods(mockLocalHostEntry.hostId) ?? []),
    ]).toEqual(["host.status"]);

    // The host updates under the same id; the next call re-dials and re-acks.
    const second = client.request("host.echo", { message: "hi" });
    await flush();
    const secondStub = sockets[1].socket;
    secondStub.fireOpen();
    await flush();
    secondStub.fireMessage(openAckWithOptionalHostEcho({ major: 1, minor: 0 }));
    await flush();
    secondStub.fireMessage({
      kind: "response",
      requestId: "req-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "HI" },
      error: null,
    });
    await second;

    expect(
      [...(getNegotiatedHostMethods(mockLocalHostEntry.hostId) ?? [])].sort(),
    ).toEqual(["host.echo", "host.status"]);
  });

  /**
   * The version half of the same publish. A2/critique finding 5: a V12
   * request to a V11 host Zod-strips `sourceOwnerUserId` silently, so a
   * caller needs the EXACT negotiated `{major, minor}` per method, not just
   * presence, to gate on same-major feature support.
   */
  it("records the exact negotiated version from the openAck manifest", async () => {
    const { factory, sockets } = makeFactory();
    const client = makeClient({
      factory,
      authToken: "token-abc",
      requestId: "req-1",
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: undefined,
    });

    expect(
      getNegotiatedHostMethodVersion(mockLocalHostEntry.hostId, "host.echo"),
    ).toBeNull();

    const pending = client.request("host.echo", { message: "hi" });
    await flush();
    const stub = sockets[0].socket;
    stub.fireOpen();
    await flush();
    stub.fireMessage(openAckWithOptionalHostEcho({ major: 2, minor: 3 }));
    await flush();

    expect(
      getNegotiatedHostMethodVersion(mockLocalHostEntry.hostId, "host.echo"),
    ).toEqual({ major: 2, minor: 3 });
    expect(
      getNegotiatedHostMethodVersion(mockLocalHostEntry.hostId, "host.status"),
    ).toEqual({ major: 1, minor: 0 });

    stub.fireMessage({
      kind: "response",
      requestId: "req-1",
      method: "host.echo",
      schemaVersion: { major: 1, minor: 0 },
      result: { echoed: "HI" },
      error: null,
    });
    await expect(pending).resolves.toEqual({ echoed: "HI" });
  });
});
