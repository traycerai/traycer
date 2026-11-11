import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
} from "@traycer/protocol/auth/request-context";
import {
  RelaySocket,
  type RelaySocketHandlers,
} from "@traycer/protocol/host-transport/remote/relay-socket";
import { RELAY_DIAL_TIMEOUT_MS } from "@traycer/protocol/host-transport/remote/config";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import { HostRequestAbortedError } from "../host-messenger";
import type { StreamConnectionStatus } from "../i-stream-session";
import { createWhatwgStreamWebSocketFactory } from "../whatwg-stream-ws-factory";
import { createWhatwgWebSocketFactory } from "../whatwg-ws-factory";
import { hostDialGate } from "../ws-dial-gate";
import { WsRpcClient } from "../ws-rpc-client";
import { WsStreamClient } from "../ws-stream-client";

const DIAL_TIMEOUT_MS = 10_000;
const QUEUED_FOR_MS = 15_000;
const GATE_SLOTS = 6;
const HOLDER_URL = "wss://holder.example.test/dial";
const RELAY_URL = "wss://peer.example.test/attach";
// Long enough that no liveness, backoff or ack timer fires inside a test.
const NEVER_MS = 600_000;

interface FakeEvent {
  readonly data: string;
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

class FakeNativeWebSocket {
  static readonly instances: FakeNativeWebSocket[] = [];

  binaryType = "blob";
  readonly sent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  private readonly listeners = new Map<
    string,
    Array<(event: FakeEvent) => void>
  >();

  constructor(readonly url: string) {
    FakeNativeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const existing = this.listeners.get(type);
    if (existing === undefined) {
      this.listeners.set(type, [listener]);
    } else {
      existing.push(listener);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.fire("open", { data: "", code: 0, reason: "", wasClean: true });
  }

  fireMessage(data: string): void {
    this.fire("message", { data, code: 0, reason: "", wasClean: true });
  }

  fireClose(code: number, reason: string): void {
    this.fire("close", { data: "", code, reason, wasClean: false });
  }

  private fire(type: string, event: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const echoRegistry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

const REQUEST_ID = "req-dial-gate";

function instances(): FakeNativeWebSocket[] {
  return FakeNativeWebSocket.instances;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Six dials through the real factory with no client attached, so nothing
 * times a holder out and every slot stays taken until a test opens one.
 */
async function holdEveryGateSlot(): Promise<FakeNativeWebSocket[]> {
  const factory = createWhatwgWebSocketFactory();
  for (let slot = 0; slot < GATE_SLOTS; slot += 1) {
    factory.create(HOLDER_URL, "interactive");
  }
  await settle();
  expect(hostDialGate.stats().connecting).toBe(GATE_SLOTS);
  return instances().slice(0, GATE_SLOTS);
}

async function queueFor15sThenFreeASlot(
  holders: readonly FakeNativeWebSocket[],
): Promise<FakeNativeWebSocket> {
  const before = instances().length;
  await vi.advanceTimersByTimeAsync(QUEUED_FOR_MS);
  expect(instances()).toHaveLength(before);
  holders[0].fireOpen();
  await settle();
  expect(instances()).toHaveLength(before + 1);
  return instances()[before];
}

function newRpcClient(): WsRpcClient<typeof echoRegistry> {
  return new WsRpcClient<typeof echoRegistry>({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: echoRegistry,
    requestId: () => REQUEST_ID,
    webSocketFactory: createWhatwgWebSocketFactory(),
    dialTimeoutMs: DIAL_TIMEOUT_MS,
    frameTimeoutMs: NEVER_MS,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
  });
}

interface RpcCall {
  readonly outcome: Promise<
    | { readonly ok: true; readonly value: { readonly echoed: string } }
    | { readonly ok: false; readonly error: unknown }
  >;
  readonly isSettled: () => boolean;
}

function startEcho(signal: AbortSignal): RpcCall {
  let settled = false;
  const outcome = newRpcClient()
    .request(
      "host.echo",
      { message: "hi" },
      {
        replayMustBeKeyed: false,
        requiredHostMethodVersion: null,
        idempotencyKey: null,
        authority: {
          endpoint: {
            hostId: mockLocalHostEntry.hostId,
            websocketUrl: mockLocalHostEntry.websocketUrl,
          },
          bearer: new MutableBearerLease("token-abc", "test-user"),
          abortSignal: signal,
        },
      },
    )
    .then(
      (value) => {
        settled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      },
    );
  return { outcome, isSettled: () => settled };
}

function newStreamClient(): WsStreamClient<typeof hostStreamRpcRegistry> {
  const ctx = createRequestContext({
    identity: identityFromAuthenticatedUser(
      createAuthenticatedUserFixture(undefined),
    ),
    bearerToken: "token-abc",
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
    cloudAuthorized: true,
  });
  return new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    hostId: mockLocalHostEntry.hostId,
    bearer: () => ctx.credentials,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: createWhatwgStreamWebSocketFactory(),
    dialTimeoutMs: DIAL_TIMEOUT_MS,
    openAckTimeoutMs: NEVER_MS,
    pingIntervalMs: NEVER_MS,
    pongTimeoutMs: NEVER_MS,
    initialBackoffMs: NEVER_MS,
    maxBackoffMs: NEVER_MS,
  });
}

interface RecordedRelayHandlers {
  readonly handlers: RelaySocketHandlers;
  readonly onAttachAck: Mock<RelaySocketHandlers["onAttachAck"]>;
  readonly onClose: Mock<RelaySocketHandlers["onClose"]>;
}

function newRelayHandlers(): RecordedRelayHandlers {
  const onAttachAck = vi.fn<RelaySocketHandlers["onAttachAck"]>();
  const onClose = vi.fn<RelaySocketHandlers["onClose"]>();
  return {
    onAttachAck,
    onClose,
    handlers: {
      onAttachAck,
      onData: vi.fn(),
      onHostDetached: vi.fn(),
      onHostAttached: vi.fn(),
      onReauthAck: vi.fn(),
      onPeerGone: vi.fn(),
      onError: vi.fn(),
      onClose,
    },
  };
}

describe("dial timers start when the dial gate grants a slot", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeNativeWebSocket);
    FakeNativeWebSocket.instances.length = 0;
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    // A real socket reports its close after close() is called; the fake does
    // not, so every slot still held is handed back here.
    for (const native of instances()) {
      native.fireClose(1006, "test-cleanup");
    }
    await settle();
    expect(hostDialGate.stats()).toMatchObject({ connecting: 0, queued: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("unary", () => {
    it("answers a dial that sat queued longer than the dial timeout", async () => {
      const holders = await holdEveryGateSlot();
      const call = startEcho(new AbortController().signal);
      await settle();

      const native = await queueFor15sThenFreeASlot(holders);
      expect(call.isSettled()).toBe(false);

      native.fireOpen();
      await settle();
      native.fireMessage(
        JSON.stringify({
          kind: "openAck",
          manifest: {},
          optionalManifest: { "host.echo": { major: 1, minor: 0 } },
        }),
      );
      await settle();
      native.fireMessage(
        JSON.stringify({
          kind: "response",
          requestId: REQUEST_ID,
          method: "host.echo",
          schemaVersion: { major: 1, minor: 0 },
          result: { echoed: "HI" },
          error: null,
        }),
      );

      await expect(call.outcome).resolves.toEqual({
        ok: true,
        value: { echoed: "HI" },
      });
    });

    it("times out exactly the dial timeout after the grant", async () => {
      const holders = await holdEveryGateSlot();
      const call = startEcho(new AbortController().signal);
      await settle();
      await queueFor15sThenFreeASlot(holders);

      await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS - 1);
      expect(call.isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(call.isSettled()).toBe(true);

      const result = await call.outcome;
      expect(result.ok).toBe(false);
      if (result.ok || !(result.error instanceof Error)) {
        throw new Error("Expected the dial to fail with an Error");
      }
      expect(result.error.message).toBe(
        `WebSocket dial timed out after ${DIAL_TIMEOUT_MS}ms`,
      );
    });

    it("arms no dial timer when the request is aborted in the gap between grant and arming", async () => {
      const holders = await holdEveryGateSlot();
      const lifetime = new AbortController();
      const call = startEcho(lifetime.signal);
      await settle();
      const timersBefore = vi.getTimerCount();

      holders[0].fireOpen();
      lifetime.abort("host-replaced");
      const result = await call.outcome;
      await settle();

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected the aborted request to fail");
      }
      expect(result.error).toBeInstanceOf(HostRequestAbortedError);
      expect(vi.getTimerCount()).toBe(timersBefore);
    });

    it("leaves no dial timer behind when the request is aborted while queued", async () => {
      const holders = await holdEveryGateSlot();
      const lifetime = new AbortController();
      const call = startEcho(lifetime.signal);
      await settle();
      expect(hostDialGate.stats().queued).toBe(1);

      lifetime.abort("host-replaced");
      const result = await call.outcome;
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected the aborted request to fail");
      }
      expect(result.error).toBeInstanceOf(HostRequestAbortedError);

      holders[0].fireOpen();
      await settle();
      expect(instances()).toHaveLength(GATE_SLOTS);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("stream", () => {
    function subscribe(): {
      readonly statuses: StreamConnectionStatus[];
      readonly close: () => void;
    } {
      const session = newStreamClient().subscribe("epic.subscribe", {
        epicId: "epic-1",
      });
      cleanups.push(() => {
        session.close();
      });
      const statuses: StreamConnectionStatus[] = [];
      session.onStatusChange((status) => {
        statuses.push(status);
      });
      return {
        statuses,
        close: () => {
          session.close();
        },
      };
    }

    it("subscribes on a dial that sat queued longer than the dial timeout", async () => {
      const holders = await holdEveryGateSlot();
      const { statuses } = subscribe();
      await settle();

      const native = await queueFor15sThenFreeASlot(holders);
      expect(statuses).not.toContain("reconnecting");

      native.fireOpen();
      await settle();
      native.fireMessage(
        JSON.stringify({
          kind: "openAck",
          manifest: buildStreamManifest(
            hostStreamRpcRegistry,
            SERVES_EVERY_INSTALLED_MAJOR,
          ),
        }),
      );
      await settle();

      expect(statuses).toContain("open");
      expect(statuses).not.toContain("reconnecting");
    });

    it("arms no dial timer when the session is closed in the gap between grant and arming", async () => {
      const holders = await holdEveryGateSlot();
      const { close } = subscribe();
      await settle();
      const timersBefore = vi.getTimerCount();

      holders[0].fireOpen();
      close();
      await settle();

      expect(vi.getTimerCount()).toBe(timersBefore);
    });

    it("tears down exactly the dial timeout after the grant", async () => {
      const holders = await holdEveryGateSlot();
      const { statuses } = subscribe();
      await settle();
      const native = await queueFor15sThenFreeASlot(holders);

      await vi.advanceTimersByTimeAsync(DIAL_TIMEOUT_MS - 1);
      expect(native.closed).toBeNull();
      expect(statuses).not.toContain("reconnecting");
      await vi.advanceTimersByTimeAsync(1);

      expect(native.closed).toEqual({ code: 4000, reason: "dial-timeout" });
      expect(statuses).toContain("reconnecting");
    });
  });

  describe("relay", () => {
    function attachRelay(): RecordedRelayHandlers & {
      readonly relay: RelaySocket;
    } {
      const recorded = newRelayHandlers();
      const relay = new RelaySocket({
        directUrl: RELAY_URL,
        webSocketFactory: createWhatwgStreamWebSocketFactory(),
        handlers: recorded.handlers,
      });
      cleanups.push(() => {
        relay.close(1000, "test-done");
      });
      return { ...recorded, relay };
    }

    it("attaches on a dial that sat queued longer than the dial timeout", async () => {
      const holders = await holdEveryGateSlot();
      const { onAttachAck, onClose } = attachRelay();
      await settle();

      const native = await queueFor15sThenFreeASlot(holders);
      expect(onClose).not.toHaveBeenCalled();

      native.fireOpen();
      await settle();

      expect(onAttachAck).toHaveBeenCalledWith(0, null);
      await vi.advanceTimersByTimeAsync(RELAY_DIAL_TIMEOUT_MS);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("arms no dial timer when the relay is closed in the gap between grant and arming", async () => {
      const holders = await holdEveryGateSlot();
      const { relay } = attachRelay();
      await settle();
      const timersBefore = vi.getTimerCount();

      holders[0].fireOpen();
      relay.close(1000, "test-done");
      await settle();

      expect(vi.getTimerCount()).toBe(timersBefore);
    });

    it("closes exactly the relay dial timeout after the grant", async () => {
      const holders = await holdEveryGateSlot();
      const { onClose } = attachRelay();
      await settle();
      await queueFor15sThenFreeASlot(holders);

      await vi.advanceTimersByTimeAsync(RELAY_DIAL_TIMEOUT_MS - 1);
      expect(onClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(onClose).toHaveBeenCalledWith({
        code: 4000,
        reason: "relay-dial-timeout",
      });
    });
  });
});
