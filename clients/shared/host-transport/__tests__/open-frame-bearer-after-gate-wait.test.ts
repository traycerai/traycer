import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { HostRpcError } from "../host-messenger";
import type { StreamConnectionStatus } from "../i-stream-session";
import { createWhatwgStreamWebSocketFactory } from "../whatwg-stream-ws-factory";
import { createWhatwgWebSocketFactory } from "../whatwg-ws-factory";
import { hostDialGate } from "../ws-dial-gate";
import { WsRpcClient } from "../ws-rpc-client";
import { WsStreamClient } from "../ws-stream-client";

const QUEUED_FOR_MS = 15_000;
const GATE_SLOTS = 6;
const HOLDER_URL = "wss://holder.example.test/dial";
// Long enough that no redial, ping, ack or frame timer fires inside a test.
const NEVER_MS = 600_000;
const REQUEST_ID = "req-open-frame-bearer";

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
    this.fire("open");
  }

  fireClose(): void {
    this.fire("close");
  }

  private fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: "", code: 1006, reason: "test", wasClean: false });
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

function instances(): FakeNativeWebSocket[] {
  return FakeNativeWebSocket.instances;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Six real dials with no client attached: every slot stays taken. */
async function holdEveryGateSlot(): Promise<FakeNativeWebSocket[]> {
  const factory = createWhatwgWebSocketFactory();
  for (let slot = 0; slot < GATE_SLOTS; slot += 1) {
    factory.create(HOLDER_URL, "interactive");
  }
  await settle();
  expect(hostDialGate.stats().connecting).toBe(GATE_SLOTS);
  return instances().slice(0, GATE_SLOTS);
}

/**
 * Waits behind the held slots for 15 s, then frees one: the native of the
 * queued dial is built, and the socket opens.
 */
async function waitQueuedThenGrantAndOpen(
  holders: readonly FakeNativeWebSocket[],
  rotateTo: string,
  lease: MutableBearerLease,
): Promise<FakeNativeWebSocket> {
  expect(hostDialGate.stats().queued).toBe(1);
  lease.rotate(rotateTo);
  await vi.advanceTimersByTimeAsync(QUEUED_FOR_MS);
  expect(instances()).toHaveLength(GATE_SLOTS);
  holders[0].fireOpen();
  await settle();
  expect(instances()).toHaveLength(GATE_SLOTS + 1);
  const native = instances()[GATE_SLOTS];
  native.fireOpen();
  await settle();
  return native;
}

function tokenOfOpenFrame(native: FakeNativeWebSocket): unknown {
  const frame: unknown = JSON.parse(native.sent[0]);
  if (typeof frame !== "object" || frame === null || !("token" in frame)) {
    throw new Error("Expected the first frame sent to carry a token");
  }
  return frame.token;
}

interface RpcCall {
  readonly outcome: Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: unknown }
  >;
  readonly isSettled: () => boolean;
}

function startEcho(lease: MutableBearerLease): RpcCall {
  let settled = false;
  const client = new WsRpcClient<typeof echoRegistry>({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: echoRegistry,
    requestId: () => REQUEST_ID,
    webSocketFactory: createWhatwgWebSocketFactory(),
    dialTimeoutMs: NEVER_MS,
    frameTimeoutMs: NEVER_MS,
    hostAttestationWindowMs: 0,
    evidence: NO_TRANSPORT_EVIDENCE,
  });
  const outcome = client
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
          bearer: lease,
          abortSignal: new AbortController().signal,
        },
      },
    )
    .then(
      () => {
        settled = true;
        return { ok: true as const };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      },
    );
  return { outcome, isSettled: () => settled };
}

describe("open frame bearer after a wait for a dial slot", () => {
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
      native.fireClose();
    }
    await settle();
    expect(hostDialGate.stats()).toMatchObject({ connecting: 0, queued: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("stream", () => {
    function subscribe(lease: MutableBearerLease): StreamConnectionStatus[] {
      const client = new WsStreamClient({
        clientIdentity: TEST_CLIENT_IDENTITY,
        registry: hostStreamRpcRegistry,
        endpoint: () => mockLocalHostEntry,
        hostId: mockLocalHostEntry.hostId,
        bearer: () => lease,
        auth: null,
        clock: null,
        hostCredentialMint: null,
        onHostCredentialState: null,
        evidence: NO_TRANSPORT_EVIDENCE,
        webSocketFactory: createWhatwgStreamWebSocketFactory(),
        dialTimeoutMs: NEVER_MS,
        openAckTimeoutMs: NEVER_MS,
        pingIntervalMs: NEVER_MS,
        pongTimeoutMs: NEVER_MS,
        initialBackoffMs: NEVER_MS,
        maxBackoffMs: NEVER_MS,
      });
      const session = client.subscribe("epic.subscribe", { epicId: "epic-1" });
      cleanups.push(() => {
        session.close();
      });
      const statuses: StreamConnectionStatus[] = [];
      session.onStatusChange((status) => {
        statuses.push(status);
      });
      return statuses;
    }

    it("sends the bearer current at the grant, not the one read before the wait", async () => {
      const lease = new MutableBearerLease("token-a", "user-1");
      const holders = await holdEveryGateSlot();
      subscribe(lease);
      await settle();

      const native = await waitQueuedThenGrantAndOpen(
        holders,
        "token-b",
        lease,
      );

      expect(tokenOfOpenFrame(native)).toBe("token-b");
    });

    it("sends no open frame and redials when the bearer is gone at the grant", async () => {
      const lease = new MutableBearerLease("token-a", "user-1");
      const holders = await holdEveryGateSlot();
      const statuses = subscribe(lease);
      await settle();

      const native = await waitQueuedThenGrantAndOpen(holders, "", lease);

      expect(native.sent).toEqual([]);
      expect(native.closed).toEqual({
        code: 4000,
        reason: "missing-open-token",
      });
      expect(statuses).toContain("reconnecting");
      expect(statuses).not.toContain("closed");
    });
  });

  describe("unary", () => {
    it("sends the bearer current at the grant, not the one read before the wait", async () => {
      const lease = new MutableBearerLease("token-a", "user-1");
      const holders = await holdEveryGateSlot();
      startEcho(lease);
      await settle();

      const native = await waitQueuedThenGrantAndOpen(
        holders,
        "token-b",
        lease,
      );

      expect(tokenOfOpenFrame(native)).toBe("token-b");
    });

    it("sends no open frame and rejects naming the bearer when it is gone at the grant", async () => {
      const lease = new MutableBearerLease("token-a", "user-1");
      const holders = await holdEveryGateSlot();
      const call = startEcho(lease);
      await settle();

      const native = await waitQueuedThenGrantAndOpen(holders, "", lease);

      expect(native.sent).toEqual([]);
      expect(call.isSettled()).toBe(true);
      const result = await call.outcome;
      if (result.ok || !(result.error instanceof HostRpcError)) {
        throw new Error("Expected the call to fail with a HostRpcError");
      }
      expect(result.error.code).toBe("RPC_ERROR");
      expect(result.error.message).toMatch(/bearer/i);
      expect(native.closed).not.toBeNull();
    });
  });
});
