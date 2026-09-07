import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import {
  HOST_AVAILABILITY_SWEEP_WINDOW_MS,
  HostClient,
  type HostClientChangeEvent,
  type HostQueryInvalidationOptions,
  type IHostQueryInvalidator,
} from "../host-client";
import { MockHostMessenger } from "../mock/mock-host-messenger";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "../mock/mock-host-directory";
import type { HostDirectoryEntry } from "../host-directory";
import type { RemoteHostDirectoryEntry } from "../remote-fetcher";
import { WsRpcClient } from "../../host-transport/ws-rpc-client";
import { HostRpcError } from "../../host-transport/host-messenger";
import type {
  IWebSocketFactory,
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketLike,
  WebSocketMessageEvent,
  WebSocketOpenEvent,
} from "../../host-transport/ws-factory";
import type {
  ClientFrame,
  ClientRequestFrame,
  HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type { RpcSchedulingPolicy } from "../rpc-scheduling-policy";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

const pingV10 = defineRpcContract({
  method: "host.ping",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({ pong: z.literal(true) }),
});

const registry = defineVersionedRpcRegistry({
  "host.ping": {
    1: {
      latestMinor: 0,
      versions: { 0: { contract: pingV10, upgradeFromPreviousVersion: null } },
      downgradePathsFromLatest: {},
    },
  },
});

const schedulingPolicy: RpcSchedulingPolicy<typeof registry> = {
  modeFor: () => "latest",
  joinResponseTimeoutMs: () => null,
};

class RecordingInvalidator implements IHostQueryInvalidator {
  readonly calls: Array<string | null> = [];
  readonly options: HostQueryInvalidationOptions[] = [];
  invalidateHostScope(
    hostId: string | null,
    options: HostQueryInvalidationOptions,
  ): void {
    this.calls.push(hostId);
    this.options.push(options);
  }
}

function makeContext(userId: string, bearer: string): RequestContext {
  const fixture = createAuthenticatedUserFixture(undefined);
  const user = {
    ...fixture,
    user: { ...fixture.user, id: userId, providerHandle: userId },
  };
  return createRequestContext({
    identity: identityFromAuthenticatedUser(user),
    bearerToken: bearer,
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
}

/**
 * Host-scope sweeps are coalesced per host per microtask tick (see `HostClient.deliverHostScopeSweep`), so their invalidation/change event lands one microtask after the reporting call.
 */
async function flushAvailabilityCoalescing(): Promise<void> {
  await Promise.resolve();
}

/**
 * The spine addresses NO host (redesign D17 / P4.2), so anything that actually sends must go through a requester.
 */
function buildHostClientWithMock(): {
  client: HostClient<typeof registry>;
  requester: HostClient<typeof registry>;
  invalidator: RecordingInvalidator;
  messenger: MockHostMessenger<typeof registry>;
  events: HostClientChangeEvent[];
} {
  const invalidator = new RecordingInvalidator();
  const messenger = new MockHostMessenger<typeof registry>({
    registry,
    handlers: {
      "host.ping": () => ({ pong: true }),
    },
    requestId: () => "req-1",
  });
  const directory = new Map<string, HostDirectoryEntry>([
    [mockLocalHostEntry.hostId, mockLocalHostEntry],
    [mockRemoteHostEntry.hostId, mockRemoteHostEntry],
  ]);
  const client = new HostClient({
    registry,
    messenger,
    invalidator,
    schedulingPolicy,
    requestCoordinator: null,
    findHostById: (hostId) => directory.get(hostId) ?? null,
  });
  const events: HostClientChangeEvent[] = [];
  client.onChange((e) => events.push(e));
  return {
    client,
    requester: client.createRequesterForHostId(mockLocalHostEntry.hostId),
    invalidator,
    messenger,
    events,
  };
}

class StubWebSocket implements WebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: WebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;
  readonly sentFrames: ClientFrame[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;

  send(data: string): void {
    const frame = JSON.parse(data) as ClientFrame;
    this.sentFrames.push(frame);
    if (frame.kind === "open") {
      queueMicrotask(() => this.respondToOpen());
    } else if (frame.kind === "request") {
      queueMicrotask(() => this.respondToRequest(frame.requestId));
    }
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  private respondToOpen(): void {
    const openFrame = this.sentFrames.find((frame) => frame.kind === "open");
    if (openFrame === undefined || openFrame.kind !== "open") {
      throw new Error("Expected open frame before openAck");
    }
    const frame: HostFrame = {
      kind: "openAck",
      manifest: openFrame.manifest,
      optionalManifest: openFrame.optionalManifest,
    };
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  private respondToRequest(requestId: string): void {
    const frame: HostFrame = {
      kind: "response",
      requestId,
      method: "host.ping",
      schemaVersion: { major: 1, minor: 0 },
      result: { pong: true },
      error: null,
    };
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function readRequestFrame(socket: StubWebSocket): ClientRequestFrame {
  const frame = socket.sentFrames.find(
    (candidate) => candidate.kind === "request",
  );
  if (frame === undefined || frame.kind !== "request") {
    throw new Error("Expected request frame");
  }
  return frame;
}

describe("HostClient", () => {
  // The slot is gone, the reason union is down to two, and nothing re-binds - so the same-id re-bind comparison those five existed to exercise has no code path left to run against.
  // Two concerns outlived their tests and are recorded rather than quietly dropped.
  it("invalidates every host's scope on a RequestContext identity change", () => {
    const { client, invalidator, events } = buildHostClientWithMock();

    const ctx = makeContext("user-1", "tok-1");
    client.setRequestContext(ctx);
    client.setRequestContext(ctx); // no-op, same reference
    client.setRequestContext(null);

    // Scope-free, and it used to be scoped to the bound host.
    // Scoping it to one host was only ever defensible while exactly one host was reachable.
    expect(invalidator.calls).toEqual([null, null]);
    expect(events.map((e) => e.reason)).toEqual([
      "auth-changed",
      "auth-changed",
    ]);
    // The event no longer carries a host, because the client no longer has one.
    expect(events.map((e) => e.currentHostId)).toEqual([null, null]);
  });

  it("returns the live RequestContext to transport-layer extractors", () => {
    const { client } = buildHostClientWithMock();
    expect(client.getRequestContext()).toBeNull();

    const ctx = makeContext("user-1", "tok-1");
    client.setRequestContext(ctx);
    expect(client.getRequestContext()).toBe(ctx);
    expect(client.getRequestContext()?.credentials.getBearerToken()).toBe(
      "tok-1",
    );
  });

  // Deleted: "invalidates on availability recovery only when a host is bound".
  // It was a test OF the bound-gate - the no-arg `notifyAvailabilityRecovered()` it drove was the active slot's entry point, and its first half asserted that an unbound client stays silent.

  it("announces an availability recovery for whichever host recovered", async () => {
    const { client, invalidator, events } = buildHostClientWithMock();

    // A tab-bound durable stream heartbeats its own host; its queries are keyed by that id.
    // Pre-P4.2 this host was "not the active one" and was deliberately invalidated without an event, because an event meant "the active host changed" and this was not it.
    client.notifyHostAvailabilityRecovered("other-host");
    await flushAvailabilityCoalescing();
    expect(invalidator.calls).toEqual(["other-host"]);
    expect(invalidator.options).toEqual([{ refetchActive: true }]);
    // Now IT announces, and the event names the host it is about.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      currentHostId: "other-host",
      reason: "availability-recovered",
    });

    events.length = 0;
    client.notifyHostAvailabilityRecovered("mock-local");
    await flushAvailabilityCoalescing();
    expect(invalidator.calls).toEqual(["other-host", "mock-local"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      currentHostId: "mock-local",
      reason: "availability-recovered",
    });
  });

  it("un-strands a host's scope without announcing a change", async () => {
    const { client, invalidator, events } = buildHostClientWithMock();

    // Two callers reach this, and neither is reporting an availability recovery - which is why the method is named for what it does rather than for either of their reasons.
    client.invalidateHostScopeUnannounced("mock-local");
    await flushAvailabilityCoalescing();

    expect(invalidator.calls).toEqual(["mock-local"]);
    expect(invalidator.options).toEqual([{ refetchActive: true }]);
    expect(events).toEqual([]);
  });

  it("coalesces same-tick availability reports per host into one invalidation and at most one change event", async () => {
    const { client, invalidator, events } = buildHostClientWithMock();

    // Per host: one invalidation; the change event survives because at least one caller asked for it.
    client.notifyHostAvailabilityRecovered("mock-local");
    client.notifyHostAvailabilityRecovered("mock-local");
    client.invalidateHostScopeUnannounced("mock-local");
    client.notifyHostAvailabilityRecovered("other-host");
    await flushAvailabilityCoalescing();

    expect(invalidator.calls.sort()).toEqual(["mock-local", "other-host"]);
    // Per host, and that is the claim.
    // Coalescing merges reports for the same host - it never merges across hosts, because the event names one.
    expect(events.map((e) => e.currentHostId).sort()).toEqual([
      "mock-local",
      "other-host",
    ]);
    expect(events.every((e) => e.reason === "availability-recovered")).toBe(
      true,
    );

    // The unannounced sweep alone must not gain a change event from the merge machinery when nothing in its tick asked for one.
    invalidator.calls.length = 0;
    events.length = 0;
    client.invalidateHostScopeUnannounced("mock-local");
    await flushAvailabilityCoalescing();
    expect(invalidator.calls).toEqual(["mock-local"]);
    expect(events).toEqual([]);
  });

  it("coalesces recovery bursts across wiring cooldowns while unannounced sweeps bypass the time gate", async () => {
    vi.useFakeTimers();
    try {
      const { client, invalidator, events } = buildHostClientWithMock();

      client.notifyHostAvailabilityRecovered("mock-local");
      await flushAvailabilityCoalescing();
      expect(invalidator.calls).toEqual(["mock-local"]);

      await vi.advanceTimersByTimeAsync(HOST_AVAILABILITY_SWEEP_WINDOW_MS / 2);
      client.notifyHostAvailabilityRecovered("mock-local");
      await flushAvailabilityCoalescing();
      expect(invalidator.calls).toHaveLength(1);

      // Rotation/ready-boundary sweeps are correctness boundaries, not noisy
      // recovery hints, so they remain immediate even inside the recovery gate.
      client.invalidateHostScopeUnannounced("mock-local");
      await flushAvailabilityCoalescing();
      expect(invalidator.calls).toHaveLength(2);
      expect(events).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(HOST_AVAILABILITY_SWEEP_WINDOW_MS / 2);
      await flushAvailabilityCoalescing();
      expect(invalidator.calls).toHaveLength(3);
      expect(events).toHaveLength(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("coalesces N independently-wired reports arriving in SEPARATE macrotasks into one sweep plus one trailing catch-up", async () => {
    vi.useFakeTimers();
    try {
      const { client, invalidator, events } = buildHostClientWithMock();

      // The production shape the older cases miss: every wiring in this suite reports in the same synchronous tick, so a purely-microtask merge would satisfy them.
      for (let i = 0; i < 5; i += 1) {
        client.notifyHostAvailabilityRecovered("mock-local");
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(invalidator.calls).toEqual(["mock-local"]);
      expect(events).toHaveLength(1);

      // One trailing catch-up for the reports the gate swallowed, and no more.
      await vi.advanceTimersByTimeAsync(HOST_AVAILABILITY_SWEEP_WINDOW_MS);
      expect(invalidator.calls).toEqual(["mock-local", "mock-local"]);
      expect(events).toHaveLength(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("delegates a requester's unary request to the messenger under that host's authority", async () => {
    const { client, requester, messenger } = buildHostClientWithMock();
    client.setRequestContext(makeContext("user-1", "tok-1"));

    const result = await requester.request("host.ping", {});
    expect(result).toEqual({ pong: true });
    expect(messenger.calls).toHaveLength(1);
    expect(messenger.calls[0]).toMatchObject({
      method: "host.ping",
      params: {},
      requestId: "req-1",
      authority: {
        endpoint: {
          hostId: mockLocalHostEntry.hostId,
          websocketUrl: mockLocalHostEntry.websocketUrl,
        },
        bearer: client.getRequestContext()?.credentials,
      },
    });
  });

  it("emits byte-identical frames for request and an explicit null idempotency key", async () => {
    const invalidator = new RecordingInvalidator();
    const sockets: StubWebSocket[] = [];
    const factory: IWebSocketFactory = {
      create(): WebSocketLike {
        const socket = new StubWebSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.fireOpen());
        return socket;
      },
    };
    const wsClient = new WsRpcClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry,
      requestId: () => "req-byte-identical",
      webSocketFactory: factory,
      dialTimeoutMs: 1_000,
      frameTimeoutMs: 1_000,
      hostAttestationWindowMs: 0,
      evidence: NO_TRANSPORT_EVIDENCE,
    });
    const client = new HostClient({
      registry,
      invalidator,
      messenger: wsClient,
      schedulingPolicy,
      requestCoordinator: null,
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    });
    client.setRequestContext(makeContext("user-1", "tok-1"));
    const requester = client.createRequester(mockLocalHostEntry);

    await requester.request("host.ping", {});
    await requester.requestWithIdempotencyKey("host.ping", {}, null);

    expect(sockets).toHaveLength(2);
    expect(JSON.stringify(readRequestFrame(sockets[0]))).toBe(
      JSON.stringify(readRequestFrame(sockets[1])),
    );
  });

  it("createRequester follows same-host directory refreshes instead of freezing its snapshot", async () => {
    // A host's directory entry refreshes in place (status, version, endpoint) while a dialog holding a requester stays open.
    // `captureAuthority` refuses a routed entry that no longer matches the live directory, so a requester frozen on its creation-time snapshot would fail every request after the refresh until rebuilt.
    const invalidator = new RecordingInvalidator();
    const messenger = new MockHostMessenger<typeof registry>({
      registry,
      handlers: { "host.ping": () => ({ pong: true }) },
      requestId: () => "req-1",
    });
    let current: HostDirectoryEntry = mockLocalHostEntry;
    const client = new HostClient({
      registry,
      messenger,
      invalidator,
      schedulingPolicy,
      requestCoordinator: null,
      findHostById: (hostId) => (hostId === current.hostId ? current : null),
    });
    client.setRequestContext(makeContext("user-1", "tok-1"));
    const requester = client.createRequester(mockLocalHostEntry);

    await expect(requester.request("host.ping", {})).resolves.toEqual({
      pong: true,
    });

    // The host restarts on a new version: same id, refreshed transport fields.
    current = { ...mockLocalHostEntry, version: "0.0.1-mock" };

    await expect(requester.request("host.ping", {})).resolves.toEqual({
      pong: true,
    });
    expect(requester.getActiveHost()).toBe(current);
    expect(requester.getActiveHostId()).toBe(mockLocalHostEntry.hostId);
    expect(messenger.calls).toHaveLength(2);
  });

  it("rejects unary requests before the messenger when auth context is missing", async () => {
    const { requester, messenger } = buildHostClientWithMock();

    await expect(requester.request("host.ping", {})).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.message.includes("authenticated request context"),
    );
    expect(messenger.calls).toEqual([]);
  });

  it("drives WsRpcClient through its pluggable endpoint/context providers - final transport layer extracts the bearer", async () => {
    const invalidator = new RecordingInvalidator();
    const dialed: Array<{
      readonly url: string;
      readonly socket: StubWebSocket;
    }> = [];
    const factory: IWebSocketFactory = {
      create(url: string): WebSocketLike {
        const socket = new StubWebSocket();
        dialed.push({ url, socket });
        queueMicrotask(() => socket.fireOpen());
        return socket;
      },
    };

    const wsClient = new WsRpcClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry,
      requestId: () => "req-1",
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: 0,
      evidence: NO_TRANSPORT_EVIDENCE,
    });

    const client = new HostClient({
      registry,
      invalidator,
      messenger: wsClient,
      schedulingPolicy,
      requestCoordinator: null,
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId
          ? mockLocalHostEntry
          : hostId === mockRemoteHostEntry.hostId
            ? mockRemoteHostEntry
            : null,
    });
    // Two hosts, addressed by two requesters rather than by re-binding one slot - which is the whole substitution P4.2 makes.
    const ctx1 = makeContext("user-1", "tok-1");
    client.setRequestContext(ctx1);
    await client.createRequester(mockLocalHostEntry).request("host.ping", {});

    const ctx2 = makeContext("user-2", "tok-2");
    client.setRequestContext(ctx2);
    await client.createRequester(mockRemoteHostEntry).request("host.ping", {});

    expect(dialed).toHaveLength(2);
    expect(dialed[0].url).toBe(mockLocalHostEntry.websocketUrl);
    expect(dialed[1].url).toBe(mockRemoteHostEntry.websocketUrl);

    const openFrames = dialed.map((d) =>
      d.socket.sentFrames.find((f) => f.kind === "open"),
    );
    expect(openFrames[0]).toMatchObject({ kind: "open", token: "tok-1" });
    expect(openFrames[1]).toMatchObject({ kind: "open", token: "tok-2" });
  });

  it("rejects before dialing when the request-context lease is released", async () => {
    const invalidator = new RecordingInvalidator();
    const dialed: Array<{
      readonly url: string;
      readonly socket: StubWebSocket;
    }> = [];
    const factory: IWebSocketFactory = {
      create(url: string): WebSocketLike {
        const socket = new StubWebSocket();
        dialed.push({ url, socket });
        queueMicrotask(() => socket.fireOpen());
        return socket;
      },
    };
    const ctx = makeContext("user-1", "tok-1");
    ctx.release();

    const wsClient = new WsRpcClient({
      clientIdentity: TEST_CLIENT_IDENTITY,
      registry,
      requestId: () => "req-1",
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: 0,
      evidence: NO_TRANSPORT_EVIDENCE,
    });
    const client = new HostClient({
      registry,
      invalidator,
      messenger: wsClient,
      schedulingPolicy,
      requestCoordinator: null,
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    });
    client.setRequestContext(ctx);
    const requester = client.createRequester(mockLocalHostEntry);
    await expect(requester.request("host.ping", {})).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.message.includes("released authenticated request context"),
    );

    expect(dialed).toHaveLength(0);
  });
});
