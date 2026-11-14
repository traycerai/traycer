/**
 * A persistent local `/rpc` session whose per-request answer carries
 * `doorReason`. The consumer is `WsRpcClient` (which raises the door from
 * `HostRpcError.doorRefusal`) wrapped by `createAuthAwareMessenger` with
 * `hostTokenUnaryRevalidator`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import {
  clientFrameSchema,
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

  fireMessage(frame: HostOpenAckFrame | HostResponseFrame): void {
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
  readonly nextSocket: () => Promise<StubWebSocket>;
  readonly ready: Promise<void>;
  readonly states: HostDoorState[];
  readonly refusals: FatalErrorDetails[];
  readonly minted: string[];
  readonly mintSignIns: string[];
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
  return {
    states,
    refusals,
    minted,
    mintSignIns,
    call: (message) =>
      wrapped.request(
        "host.echo",
        { message },
        optionsFor(new MutableBearerLease(SIGN_IN, USER_ID)),
      ),
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
    ready: tokens.adopt(USER_ID, HOST_ID, {
      token: HELD_TOKEN,
      expiresAtMs: Date.now() + 3_600_000,
    }),
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

  it("takes one fresh token for a FORBIDDEN not_admitted and raises not-admitted on the second refusal", async () => {
    const harness = doorHarness();
    await harness.ready;
    const firstCall = harness.call("join");
    const socket = await harness.nextSocket();
    const first = await firstRequest(socket);
    const retried = socket.nextSend();
    socket.fireMessage(
      refusalFrame(
        first,
        responseError("FORBIDDEN", "not admitted", "not_admitted", false),
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
        responseError("FORBIDDEN", "still not admitted", "not_admitted", false),
      ),
    );
    const error = await secondCall;
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected the second refusal");
    }
    expect(error.code).toBe("FORBIDDEN");
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

  it("rethrows a retryable unauthorized without minting", async () => {
    const harness = doorHarness();
    await harness.ready;
    const pending = captureRejection(harness.call("transient"));
    const socket = await harness.nextSocket();
    const first = await firstRequest(socket);
    socket.fireMessage(
      refusalFrame(
        first,
        responseError(
          "UNAUTHORIZED",
          "verifier unreachable",
          "keys_unavailable",
          true,
        ),
      ),
    );
    const error = await pending;
    expect(error).toBeInstanceOf(RetryableTransportError);
    expect(harness.minted).toEqual([]);
    expect(harness.states).toEqual([]);
    expect(harness.refusals).toEqual([]);
    expect(credentialTokens(socket.sent)).toEqual([HELD_TOKEN, HELD_TOKEN]);
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
          "FORBIDDEN",
          "membership removed",
          "membership_removed",
          false,
        ),
      ),
    );
    const error = await pending;
    expect(error).toBeInstanceOf(HostRpcError);
    expect(harness.minted).toEqual([]);
    expect(harness.states).toEqual([
      {
        hostId: HOST_ID,
        kind: "membership-removed",
        detail: { code: "FORBIDDEN", doorReason: "membership_removed" },
      },
    ]);
    expect(JSON.stringify(socket.sent)).not.toContain(SIGN_IN);
  });
});
