/**
 * A persistent local `/rpc` session whose per-request answer carries
 * `doorReason`. The consumer is `WsRpcClient` (which raises the door from
 * `HostRpcError.doorRefusal`) wrapped by `createAuthAwareMessenger` with
 * `hostTokenUnaryRevalidator`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import {
  clientFrameSchema,
  type HostFatalErrorFrame,
  type HostOpenAckFrame,
  type HostResponseFrame,
} from "@traycer/protocol/framework/ws-protocol";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
  UNARY_CAPABILITY_PERSISTENT_SESSION,
} from "@traycer/protocol/framework/index";
import {
  HostRpcError,
  RetryableTransportError,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { RefusalAwareAuthRevalidator } from "@traycer-clients/shared/auth/bearer-revalidator";
import {
  createHostTokenSource,
  type HostTokenMint,
  type HostTokenMintOutcome,
  type HostTokenPersistence,
} from "@traycer-clients/shared/auth/host-token-source";
import {
  hostTokenBearerFor,
  hostTokenUnaryRevalidator,
} from "@traycer-clients/shared/auth/host-token-lease";
import type { HostTokenTable } from "@traycer-clients/shared/auth/host-token-store";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { createAuthAwareMessenger } from "../auth-aware-messenger";
import { createRetryingMessenger } from "../retrying-messenger";
import type { DialPriority } from "../dial-priority";
import { hostDoorStateOfRefusal, type HostDoorState } from "../host-door-state";
import type { HostRequestOptions } from "../host-messenger";
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

const HOST_ID = "rpc-door-host";
const SOCKET_URL = "ws://127.0.0.1/rpc";
const USER_ID = "user-a";
const SIGN_IN = "sign-in-secret";
const HELD_TOKEN = "host-token-1";

type ParsedFrame = z.infer<typeof clientFrameSchema>;
type ResponseError = NonNullable<HostResponseFrame["error"]>;

class StubWebSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sent: ParsedFrame[] = [];
  private readonly sendWaiters: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(clientFrameSchema.parse(JSON.parse(data)));
    const waiters = this.sendWaiters.splice(0, this.sendWaiters.length);
    for (const resolve of waiters) resolve();
  }

  nextSend(): Promise<void> {
    return new Promise((resolve) => {
      this.sendWaiters.push(resolve);
    });
  }

  close(code: number, reason: string): void {
    void code;
    void reason;
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireMessage(
    frame: HostFatalErrorFrame | HostOpenAckFrame | HostResponseFrame,
  ): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function memoryPersistence(): HostTokenPersistence {
  let table: HostTokenTable = new Map();
  return {
    load: () => Promise.resolve(table),
    update: (change) => {
      table = change(table);
      return Promise.resolve(table);
    },
  };
}

function sessionAck(): HostOpenAckFrame {
  return {
    kind: "openAck",
    manifest: { "host.status": { major: 1, minor: 0 } },
    optionalManifest: { "host.echo": { major: 1, minor: 0 } },
    capabilities: [UNARY_CAPABILITY_PERSISTENT_SESSION],
  };
}

function responseError(
  code: string,
  message: string,
  doorReason: string | undefined,
  retryable: boolean,
): ResponseError {
  if (doorReason === undefined) {
    return retryable ? { code, message, retryable: true } : { code, message };
  }
  return retryable
    ? { code, message, retryable: true, doorReason }
    : { code, message, doorReason };
}

function refusalFrame(
  request: Extract<ParsedFrame, { kind: "request" }>,
  error: ResponseError,
): HostResponseFrame {
  return {
    kind: "response",
    requestId: request.requestId,
    method: request.method,
    schemaVersion: request.schemaVersion,
    result: null,
    error,
  };
}

function echoFrame(
  request: Extract<ParsedFrame, { kind: "request" }>,
  echoed: string,
): HostResponseFrame {
  return {
    kind: "response",
    requestId: request.requestId,
    method: request.method,
    schemaVersion: request.schemaVersion,
    result: { echoed },
    error: null,
  };
}

function requestFrames(
  frames: readonly ParsedFrame[],
): Extract<ParsedFrame, { kind: "request" }>[] {
  return frames.filter(
    (frame): frame is Extract<ParsedFrame, { kind: "request" }> =>
      frame.kind === "request",
  );
}

function credentialTokens(frames: readonly ParsedFrame[]): string[] {
  const tokens: string[] = [];
  for (const frame of frames) {
    if (frame.kind === "open") tokens.push(frame.token);
    if (frame.kind === "request" && frame.token !== undefined) {
      tokens.push(frame.token);
    }
  }
  return tokens;
}

function captureRejection(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => null,
    (cause: unknown) => cause,
  );
}

interface DoorHarness {
  readonly call: (message: string) => Promise<{ readonly echoed: string }>;
  readonly retryingCall: (
    message: string,
  ) => Promise<{ readonly echoed: string }>;
  readonly rawCall: (message: string) => Promise<{ readonly echoed: string }>;
  readonly nextSocket: () => Promise<StubWebSocket>;
  readonly socketAt: (index: number) => StubWebSocket | undefined;
  readonly socketCount: () => number;
  readonly ready: Promise<void>;
  readonly states: HostDoorState[];
  readonly refusals: FatalErrorDetails[];
  readonly minted: string[];
  readonly mintSignIns: string[];
  readonly refusedBearer: RefusalAwareAuthRevalidator["revalidateRefusedBearer"];
}

function doorHarness(): DoorHarness {
  const states: HostDoorState[] = [];
  const refusals: FatalErrorDetails[] = [];
  const minted: string[] = [];
  const mintSignIns: string[] = [];
  const mint: HostTokenMint = (_hostId, signInToken) => {
    mintSignIns.push(signInToken);
    const token = `host-token-${minted.length + 2}`;
    minted.push(token);
    const outcome: HostTokenMintOutcome = {
      kind: "ok",
      token: { token, expiresAtMs: Date.now() + 3_600_000 },
    };
    return Promise.resolve(outcome);
  };
  const tokens = createHostTokenSource({
    persistence: memoryPersistence(),
    mint,
    signIn: (userId) => (userId === USER_ID ? SIGN_IN : null),
    now: () => Date.now(),
  });
  const sockets: StubWebSocket[] = [];
  const socketWaiters: Array<() => void> = [];
  const factory: IWebSocketFactory = {
    create(url: string, priority: DialPriority): WebSocketLike {
      void url;
      void priority;
      const socket = new StubWebSocket();
      sockets.push(socket);
      const waiters = socketWaiters.splice(0, socketWaiters.length);
      for (const resolve of waiters) resolve();
      return socket;
    },
  };
  let issued = 0;
  const client = new WsRpcClient<typeof testRegistry>({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: testRegistry,
    requestId: () => {
      issued += 1;
      return `req-${issued}`;
    },
    webSocketFactory: factory,
    dialTimeoutMs: 5_000,
    frameTimeoutMs: 5_000,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
    hostBearerFor: hostTokenBearerFor(tokens, (hostId, kind) => {
      states.push({ hostId, kind, detail: null });
    }),
    doorFor: (hostId) => ({
      refused: (details) => {
        refusals.push(details);
        const kind = hostDoorStateOfRefusal(details);
        if (kind === null) return;
        states.push({
          hostId,
          kind,
          detail: {
            code: details.code,
            doorReason: details.doorReason ?? null,
          },
        });
      },
      admitted: () => undefined,
    }),
  });
  const recovery = hostTokenUnaryRevalidator({
    tokens,
    currentUserId: () => USER_ID,
    signInRecovery: null,
    onState: (hostId, kind) => {
      states.push({ hostId, kind, detail: null });
    },
    now: () => Date.now(),
  });
  const refusedBearer = vi.spyOn(recovery, "revalidateRefusedBearer");
  const auth: RefusalAwareAuthRevalidator = {
    revalidateExpectedBearer: () => Promise.resolve("rejected"),
    revalidateRefusedBearer: (expected, hostId, refusal) =>
      recovery.revalidateRefusedBearer(expected, hostId, refusal),
  };
  const wrapped = createAuthAwareMessenger<typeof testRegistry>(
    client,
    auth,
    "always",
  );
  const retrying = createRetryingMessenger(wrapped, {
    maxRetries: 1,
    initialDelayMs: 0,
    maxDelayMs: 0,
    sleep: async () => undefined,
    random: () => 0,
  });
  return {
    states,
    refusals,
    minted,
    mintSignIns,
    refusedBearer,
    call: (message) =>
      wrapped.request(
        "host.echo",
        { message },
        optionsFor(new MutableBearerLease(SIGN_IN, USER_ID)),
      ),
    retryingCall: (message) =>
      retrying.request(
        "host.echo",
        { message },
        optionsFor(new MutableBearerLease(SIGN_IN, USER_ID)),
      ),
    rawCall: (message) =>
      client.request(
        "host.echo",
        { message },
        optionsFor(new MutableBearerLease(SIGN_IN, USER_ID)),
      ),
    socketAt: (index) => sockets[index],
    socketCount: () => sockets.length,
    nextSocket: () =>
      new Promise((resolve) => {
        const existing = sockets[0];
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        socketWaiters.push(() => {
          const created = sockets[0];
          if (created === undefined) {
            throw new Error("expected the persistent socket");
          }
          resolve(created);
        });
      }),
    ready: tokens.adopt(
      USER_ID,
      HOST_ID,
      {
        token: HELD_TOKEN,
        expiresAtMs: Date.now() + 3_600_000,
      },
      tokens.era(USER_ID),
    ),
  };
}

function optionsFor(bearer: MutableBearerLease): HostRequestOptions {
  return {
    idempotencyKey: null,
    replayMustBeKeyed: false,
    requiredHostMethodVersion: null,
    authority: {
      endpoint: { hostId: HOST_ID, websocketUrl: SOCKET_URL },
      bearer,
      abortSignal: new AbortController().signal,
    },
  };
}

async function firstRequest(
  socket: StubWebSocket,
): Promise<Extract<ParsedFrame, { kind: "request" }>> {
  const opened = socket.nextSend();
  socket.fireOpen();
  await opened;
  const requested = socket.nextSend();
  socket.fireMessage(sessionAck());
  await requested;
  const request = requestFrames(socket.sent)[0];
  if (request === undefined) throw new Error("expected the first request");
  return request;
}

async function firstOpen(socket: StubWebSocket): Promise<void> {
  const opened = socket.nextSend();
  socket.fireOpen();
  await opened;
}

function fatalDetails(
  code: string,
  doorReason: string | undefined,
  retryable: boolean,
): FatalErrorDetails {
  return {
    code,
    reason: "refused at the host door",
    incompatibleMethods: null,
    upgradeGuidance: null,
    ...(doorReason === undefined ? {} : { doorReason }),
    ...(retryable ? { retryable: true } : {}),
  };
}

describe("persistent /rpc door refusals through the host-only token", () => {
  afterEach(() => {
    resetNegotiatedManifests();
  });

  it("mints a fresh token once when a persistent answer says token_expired, and the retry succeeds", async () => {
    const harness = doorHarness();
    await harness.ready;
    const pending = harness.call("again");
    const socket = await harness.nextSocket();
    const first = await firstRequest(socket);
    const retried = socket.nextSend();
    socket.fireMessage(
      refusalFrame(
        first,
        responseError("UNAUTHORIZED", "token expired", "token_expired", false),
      ),
    );
    await retried;
    const second = requestFrames(socket.sent)[1];
    if (second === undefined) throw new Error("expected the retried request");
    socket.fireMessage(echoFrame(second, "again"));
    await expect(pending).resolves.toEqual({ echoed: "again" });
    expect(harness.minted).toEqual(["host-token-2"]);
    expect(harness.mintSignIns).toEqual([SIGN_IN]);
    expect(credentialTokens(socket.sent)).toEqual([
      HELD_TOKEN,
      HELD_TOKEN,
      "host-token-2",
    ]);
    expect(JSON.stringify(socket.sent)).not.toContain(SIGN_IN);
    expect(harness.refusals.map((details) => details.doorReason)).toEqual([
      "token_expired",
    ]);
    expect(harness.states).toEqual([]);
  });

  it("takes one fresh token for not_admitted and raises not-admitted on the second refusal", async () => {
    const harness = doorHarness();
    await harness.ready;
    const firstCall = harness.call("join");
    const socket = await harness.nextSocket();
    const first = await firstRequest(socket);
    const retried = socket.nextSend();
    socket.fireMessage(
      refusalFrame(
        first,
        responseError("UNAUTHORIZED", "not admitted", "not_admitted", false),
      ),
    );
    await retried;
    const admitted = requestFrames(socket.sent)[1];
    if (admitted === undefined) throw new Error("expected the one fresh token");
    socket.fireMessage(echoFrame(admitted, "join"));
    await expect(firstCall).resolves.toEqual({ echoed: "join" });
    expect(harness.minted).toEqual(["host-token-2"]);
    expect(harness.states).toEqual([]);

    const secondCall = captureRejection(harness.call("again"));
    const wrote = socket.nextSend();
    await wrote;
    const second = requestFrames(socket.sent)[2];
    if (second === undefined) throw new Error("expected the second call");
    socket.fireMessage(
      refusalFrame(
        second,
        responseError(
          "UNAUTHORIZED",
          "still not admitted",
          "not_admitted",
          false,
        ),
      ),
    );
    const error = await secondCall;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the second refusal");
    }
    expect(error.fatalDetails).toBeNull();
    expect(error.doorRefusal?.doorReason).toBe("not_admitted");
    expect(harness.minted).toEqual(["host-token-2"]);
    expect(credentialTokens(socket.sent)).toEqual([
      HELD_TOKEN,
      HELD_TOKEN,
      "host-token-2",
      "host-token-2",
    ]);
    expect(requestFrames(socket.sent)).toHaveLength(3);
    expect(harness.states).toEqual([
      { hostId: HOST_ID, kind: "not-admitted", detail: null },
    ]);
  });

  it("keeps keys_unavailable state on a retryable reply without minting", async () => {
    const harness = doorHarness();
    await harness.ready;
    const pending = captureRejection(harness.call("transient"));
    const socket = await harness.nextSocket();
    const first = await firstRequest(socket);
    socket.fireMessage(
      refusalFrame(
        first,
        responseError(
          "NETWORK_ERROR",
          "verifier unreachable",
          "keys_unavailable",
          true,
        ),
      ),
    );
    const error = await pending;
    expect(error).toBeInstanceOf(RetryableTransportError);
    expect(error).toMatchObject({
      fatalDetails: {
        code: "NETWORK_ERROR",
        doorReason: "keys_unavailable",
        retryable: true,
      },
      doorRefusal: {
        code: "NETWORK_ERROR",
        doorReason: "keys_unavailable",
        retryable: true,
      },
    });
    expect(harness.minted).toEqual([]);
    expect(harness.states).toEqual([
      {
        hostId: HOST_ID,
        kind: "keys-unavailable",
        detail: { code: "NETWORK_ERROR", doorReason: "keys_unavailable" },
      },
    ]);
    expect(harness.refusals.map(({ doorReason }) => doorReason)).toEqual([
      "keys_unavailable",
    ]);
    expect(credentialTokens(socket.sent)).toEqual([HELD_TOKEN, HELD_TOKEN]);
  });

  it.each([
    "UNAUTHORIZED",
    "TEAM_MEMBERSHIP_REQUIRED",
    "TEAM_MEMBERSHIP_UNAVAILABLE",
  ])(
    "retries a reasonless retryable /rpc OPEN refusal for %s without door state",
    async (code) => {
      const harness = doorHarness();
      await harness.ready;
      const pending = harness.retryingCall("retry the open");
      const firstSocket = await harness.nextSocket();
      await firstOpen(firstSocket);
      firstSocket.fireMessage({
        kind: "fatalError",
        details: fatalDetails(code, undefined, true),
      });

      await vi.waitFor(() => expect(harness.socketCount()).toBe(2));
      const secondSocket = harness.socketAt(1);
      if (secondSocket === undefined)
        throw new Error("expected the retry socket");
      const request = await firstRequest(secondSocket);
      secondSocket.fireMessage(echoFrame(request, "retry the open"));

      await expect(pending).resolves.toEqual({ echoed: "retry the open" });
      expect(harness.states).toEqual([]);
      expect(harness.refusals).toHaveLength(1);
      expect(harness.refusals[0]).toMatchObject({ code, retryable: true });
      expect(harness.refusals[0]?.doorReason).toBeUndefined();
    },
  );

  it.each([
    {
      name: "host-wide enrolment_broken",
      code: "UNAUTHORIZED",
      reason: "enrolment_broken",
      sockets: 1,
    },
    {
      name: "caller-specific not_admitted",
      code: "TEAM_MEMBERSHIP_REQUIRED",
      reason: "not_admitted",
      sockets: 2,
    },
  ])("separates concurrent /rpc opens for $name", async (testCase) => {
    const harness = doorHarness();
    await harness.ready;
    const first = captureRejection(harness.rawCall("first"));
    const waiting = captureRejection(harness.rawCall("waiting"));
    const socket = await harness.nextSocket();
    await firstOpen(socket);
    const refusal = fatalDetails(testCase.code, testCase.reason, false);
    socket.fireMessage({ kind: "fatalError", details: refusal });
    await first;

    await vi.waitFor(() =>
      expect(harness.socketCount()).toBe(testCase.sockets),
    );
    if (testCase.sockets === 1) {
      await waiting;
    } else {
      const ownSocket = harness.socketAt(1);
      if (ownSocket === undefined)
        throw new Error("expected the waiter's socket");
      await firstOpen(ownSocket);
      ownSocket.fireMessage({ kind: "fatalError", details: refusal });
      await waiting;
    }
    expect(harness.socketCount()).toBe(testCase.sockets);
  });

  it.each([
    { code: "FORBIDDEN", expected: [] },
    { code: "TEAM_MEMBERSHIP_REQUIRED", expected: ["older-host"] },
    { code: "TEAM_MEMBERSHIP_UNAVAILABLE", expected: [] },
    { code: "INCOMPATIBLE", expected: [] },
    { code: "REMOTE_ACCESS_OFF", expected: [] },
    { code: "HOST_RESTARTING", expected: [] },
  ])(
    "records only the right state for reasonless /rpc open code $code",
    async ({ code, expected }) => {
      const harness = doorHarness();
      await harness.ready;
      const pending = captureRejection(harness.rawCall("refused"));
      const socket = await harness.nextSocket();
      await firstOpen(socket);
      socket.fireMessage({
        kind: "fatalError",
        details: fatalDetails(code, undefined, false),
      });
      await pending;
      expect(harness.states.map(({ kind }) => kind)).toEqual(expected);
    },
  );

  it("does not refresh a host-token request for enrolment_broken", async () => {
    const harness = doorHarness();
    await harness.ready;
    const pending = captureRejection(harness.call("host-wide refusal"));
    const socket = await harness.nextSocket();
    const request = await firstRequest(socket);
    socket.fireMessage(
      refusalFrame(
        request,
        responseError(
          "UNAUTHORIZED",
          "host enrolment is broken",
          "enrolment_broken",
          false,
        ),
      ),
    );
    const error = await pending;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError))
      throw new Error("expected the host refusal");
    expect(error.doorRefusal?.doorReason).toBe("enrolment_broken");
    expect(harness.refusedBearer).not.toHaveBeenCalled();
    expect(harness.minted).toEqual([]);
  });

  it("recovers nothing from an envelope with no doorReason", async () => {
    const harness = doorHarness();
    await harness.ready;
    const pending = captureRejection(harness.call("older"));
    const socket = await harness.nextSocket();
    const first = await firstRequest(socket);
    socket.fireMessage(
      refusalFrame(
        first,
        responseError(
          "UNAUTHORIZED",
          "Invalid or expired token",
          undefined,
          false,
        ),
      ),
    );
    const error = await pending;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the undirected refusal");
    }
    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.doorRefusal).toBeNull();
    expect(harness.minted).toEqual([]);
    expect(harness.states).toEqual([]);
    expect(requestFrames(socket.sent)).toHaveLength(1);
  });

  it("raises the door state from a persistent answer's doorReason", async () => {
    const harness = doorHarness();
    await harness.ready;
    const pending = captureRejection(harness.call("removed"));
    const socket = await harness.nextSocket();
    const first = await firstRequest(socket);
    socket.fireMessage(
      refusalFrame(
        first,
        responseError(
          "TEAM_MEMBERSHIP_REQUIRED",
          "membership removed",
          "membership_removed",
          false,
        ),
      ),
    );
    const error = await pending;
    expect(error).toBeInstanceOf(HostRpcError);
    expect(harness.minted).toEqual([]);
    expect(harness.states.map(({ kind }) => kind)).toEqual([
      "membership-removed",
    ]);
    expect(JSON.stringify(socket.sent)).not.toContain(SIGN_IN);
  });
});
