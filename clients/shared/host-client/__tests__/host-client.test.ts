import { describe, expect, it } from "vitest";
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
  HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type { RpcSchedulingPolicy } from "../rpc-scheduling-policy";

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
 * Availability reports are coalesced per host per microtask tick (see
 * `HostClient.deliverAvailabilityRecovered`), so their invalidation/change
 * event lands one microtask after the notify call. One awaited resolved
 * promise is exactly that boundary.
 */
async function flushAvailabilityCoalescing(): Promise<void> {
  await Promise.resolve();
}

function buildHostClientWithMock(): {
  client: HostClient<typeof registry>;
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
  const client = new HostClient({
    registry,
    messenger,
    invalidator,
    schedulingPolicy,
    requestCoordinator: null,
  });
  const events: HostClientChangeEvent[] = [];
  client.onChange((e) => events.push(e));
  return { client, invalidator, messenger, events };
}

/**
 * Minimal `WebSocketLike` stub that scripts the host side of a single
 * request: open → openAck → request → response → close.
 */
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

describe("HostClient", () => {
  it("invalidates host-scoped queries and emits on bind/unbind", () => {
    const { client, invalidator, events } = buildHostClientWithMock();

    client.bind(mockLocalHostEntry);
    client.bind(mockRemoteHostEntry);
    client.bind(null);

    expect(invalidator.calls).toEqual([
      null,
      "mock-local",
      "mock-local",
      "mock-remote",
      "mock-remote",
    ]);
    expect(events.map((e) => e.reason)).toEqual([
      "host-bound",
      "host-bound",
      "host-unbound",
    ]);
    expect(events[0]).toMatchObject({
      previousHostId: null,
      currentHostId: "mock-local",
    });
    expect(events[1]).toMatchObject({
      previousHostId: "mock-local",
      currentHostId: "mock-remote",
    });
    expect(events[2]).toMatchObject({
      previousHostId: "mock-remote",
      currentHostId: null,
    });
  });

  it("does not re-invalidate when binding to the same host id", () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    client.bind(mockLocalHostEntry);
    invalidator.calls.length = 0;
    events.length = 0;

    const sameId = { ...mockLocalHostEntry, label: "renamed" };
    client.bind(sameId);

    expect(invalidator.calls).toEqual([]);
    expect(events).toEqual([]);
    expect(client.getActiveHost()?.label).toBe("renamed");
  });

  it("emits and refetches when a same-id host entry changes transport state", () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    client.bind(mockLocalHostEntry);
    invalidator.calls.length = 0;
    invalidator.options.length = 0;
    events.length = 0;

    const sameIdOffline: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      websocketUrl: null,
      transportDialability: "not-dialable",
    };
    client.bind(sameIdOffline);

    expect(client.getActiveHost()).toBe(sameIdOffline);
    expect(invalidator.calls).toEqual(["mock-local"]);
    expect(invalidator.options).toEqual([{ refetchActive: true }]);
    expect(events).toEqual([
      {
        previousHostId: "mock-local",
        currentHostId: "mock-local",
        reason: "host-updated",
      },
    ]);
  });

  it("treats a coarse flip the directory cannot vouch for as the same transport - no cancel, no sweep, no event", () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    // A blind liveness read: `unknown` connectivity, so the entry is
    // not-dialable but the REASON is `indeterminate` — the absence of an
    // answer, not a refusal. Everything a caller can act on is unchanged:
    // same relay URL, same version, same key.
    //
    // This is where the shell's `busy` lands too. `busy` says one loopback
    // probe went unanswered while the process is demonstrably alive, and a
    // wedged host flaps it for as long as the stall lasts; each flap used to
    // cancel-then-abort every in-flight request on the bound host, sweep its
    // query scope with `refetchActive`, and announce `host-updated` to every
    // subscriber. It can no longer reach this layer at all — the directory
    // service projects it to `dialable` (pinned in
    // `host-directory-service.test.ts`) — so what is left to guard here is the
    // general rule that covered it: a coarse move that is not evidence of a
    // refusal must not churn the transport.
    const blind = (
      transportDialability: "dialable" | "not-dialable",
    ): RemoteHostDirectoryEntry => ({
      hostId: "mock-remote",
      label: "Mock Remote Host",
      kind: "remote",
      websocketUrl: "wss://mock-remote.traycer.invalid/rpc",
      version: "0.0.0-mock",
      transportDialability,
      publicKey: "pubkey-a",
      relayFuseGrace: false,
      remoteStatus: {
        connectivity: "unknown",
        viewerReachability: "ok",
        clientCloud: "ok",
        updateState: "current",
        appVersion: null,
        lastSeenAt: null,
      },
    });
    client.bind(blind("dialable"));
    invalidator.calls.length = 0;
    invalidator.options.length = 0;
    events.length = 0;

    const flipped = blind("not-dialable");
    client.bind(flipped);

    expect(client.getActiveHost()).toBe(flipped);
    expect(invalidator.calls).toEqual([]);
    expect(events).toEqual([]);

    // ... and back, which is the other half of the flap.
    client.bind(blind("dialable"));
    expect(invalidator.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it("still emits when a same-id host is positively refused, with every other field held stable", () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    client.bind(mockLocalHostEntry);
    invalidator.calls.length = 0;
    invalidator.options.length = 0;
    events.length = 0;

    // The sibling that makes the test above mean something: ONLY the coarse
    // bit moves, and here it IS a refusal — a local entry that cannot be
    // dialed is `offline` by derivation. `websocketUrl` is deliberately held
    // (the directory can refuse a host while still carrying its last URL), so
    // nothing but the dialability can be firing this.
    const sameIdRefused: HostDirectoryEntry = {
      ...mockLocalHostEntry,
      transportDialability: "not-dialable",
    };
    client.bind(sameIdRefused);

    expect(invalidator.calls).toEqual(["mock-local"]);
    expect(invalidator.options).toEqual([{ refetchActive: true }]);
    expect(events).toEqual([
      {
        previousHostId: "mock-local",
        currentHostId: "mock-local",
        reason: "host-updated",
      },
    ]);
  });

  it("emits host-updated on a same-id remote host's public-key rotation, isolated from every other field (R-1)", () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    const remoteEntry = (publicKey: string): RemoteHostDirectoryEntry => ({
      hostId: "mock-remote",
      label: "Mock Remote Host",
      kind: "remote",
      // Every remote host shares one fixed relay attach URL - a rotation is
      // a same-URL event by construction, so this must stay identical.
      websocketUrl: "wss://mock-remote.traycer.invalid/rpc",
      version: "0.0.0-mock",
      transportDialability: "dialable",
      publicKey,
      relayFuseGrace: false,
      remoteStatus: {
        connectivity: "connectable",
        viewerReachability: "ok",
        clientCloud: "ok",
        updateState: "current",
        appVersion: null,
        lastSeenAt: null,
      },
    });
    client.bind(remoteEntry("pubkey-a"));
    invalidator.calls.length = 0;
    invalidator.options.length = 0;
    events.length = 0;

    // hostId / kind / websocketUrl / version / status all held stable -
    // ONLY the public key rotates (re-enrollment / corruption recovery).
    const rotated = remoteEntry("pubkey-b");
    client.bind(rotated);

    expect(client.getActiveHost()).toBe(rotated);
    expect(invalidator.calls).toEqual(["mock-remote"]);
    expect(invalidator.options).toEqual([{ refetchActive: true }]);
    expect(events).toEqual([
      {
        previousHostId: "mock-remote",
        currentHostId: "mock-remote",
        reason: "host-updated",
      },
    ]);
  });

  it("invalidates on RequestContext identity change", () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    client.bind(mockLocalHostEntry);
    invalidator.calls.length = 0;
    events.length = 0;

    const ctx = makeContext("user-1", "tok-1");
    client.setRequestContext(ctx);
    client.setRequestContext(ctx); // no-op, same reference
    client.setRequestContext(null);

    expect(invalidator.calls).toEqual(["mock-local", "mock-local"]);
    expect(events.map((e) => e.reason)).toEqual([
      "auth-changed",
      "auth-changed",
    ]);
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

  it("invalidates on availability recovery only when a host is bound", async () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    client.notifyAvailabilityRecovered();
    await flushAvailabilityCoalescing();
    expect(invalidator.calls).toEqual([]);
    expect(events).toEqual([]);

    client.bind(mockLocalHostEntry);
    invalidator.calls.length = 0;
    events.length = 0;

    client.notifyAvailabilityRecovered();
    await flushAvailabilityCoalescing();
    expect(invalidator.calls).toEqual(["mock-local"]);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("availability-recovered");
  });

  it("explicit-host recovery invalidates a NON-active host's scope without announcing an active-host change", async () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    client.bind(mockLocalHostEntry);
    invalidator.calls.length = 0;
    invalidator.options.length = 0;
    events.length = 0;

    // A tab-bound durable stream heartbeats its own host, which need not be
    // the active one; its queries are keyed by THAT id.
    client.notifyHostAvailabilityRecovered("other-host");
    await flushAvailabilityCoalescing();
    expect(invalidator.calls).toEqual(["other-host"]);
    expect(invalidator.options).toEqual([{ refetchActive: true }]);
    expect(events).toEqual([]);

    // For the active host it is exactly notifyAvailabilityRecovered(),
    // change event included.
    client.notifyHostAvailabilityRecovered("mock-local");
    await flushAvailabilityCoalescing();
    expect(invalidator.calls).toEqual(["other-host", "mock-local"]);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("availability-recovered");
  });

  it("un-strands the ACTIVE host's scope without announcing a change", async () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    client.bind(mockLocalHostEntry);
    invalidator.calls.length = 0;
    invalidator.options.length = 0;
    events.length = 0;

    // The caller is a remote binding that owes a ready boundary for a host
    // which became active mid-dial. It must still deliver - the active stream
    // runtime replays nothing to a session that is already ready, so a dropped
    // boundary strands those queries for good - but it must NOT announce, or
    // the runtime answers the change by resetting the very binding reporting
    // the recovery.
    client.invalidateHostScopeForAvailability("mock-local");
    await flushAvailabilityCoalescing();

    expect(invalidator.calls).toEqual(["mock-local"]);
    expect(invalidator.options).toEqual([{ refetchActive: true }]);
    expect(events).toEqual([]);
  });

  it("coalesces same-tick availability reports per host into one invalidation and at most one change event", async () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    client.bind(mockLocalHostEntry);
    invalidator.calls.length = 0;
    invalidator.options.length = 0;
    events.length = 0;

    // One shared session's ready boundary fans out to every consumer wiring
    // in the same tick: the app-wide stream and a durable tab both notify,
    // the runtime messenger delivers its change-event-free variant, and an
    // unrelated host's tab reports too. Per host: ONE invalidation; the
    // change event survives because at least one caller asked for it.
    client.notifyAvailabilityRecovered();
    client.notifyHostAvailabilityRecovered("mock-local");
    client.invalidateHostScopeForAvailability("mock-local");
    client.notifyHostAvailabilityRecovered("other-host");
    await flushAvailabilityCoalescing();

    expect(invalidator.calls.sort()).toEqual(["mock-local", "other-host"]);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("availability-recovered");

    // The messenger-only variant alone must NOT gain a change event from the
    // merge machinery when nothing in its tick asked for one.
    invalidator.calls.length = 0;
    events.length = 0;
    client.invalidateHostScopeForAvailability("mock-local");
    await flushAvailabilityCoalescing();
    expect(invalidator.calls).toEqual(["mock-local"]);
    expect(events).toEqual([]);
  });

  it("delegates unary requests to the bound messenger", async () => {
    const { client, messenger } = buildHostClientWithMock();
    client.bind(mockLocalHostEntry);
    client.setRequestContext(makeContext("user-1", "tok-1"));

    const result = await client.request("host.ping", {});
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

  it("createRequester follows same-host directory refreshes instead of freezing its snapshot", async () => {
    // A host's directory entry refreshes in place (status, version, endpoint)
    // while a dialog holding a requester stays open. `captureAuthority`
    // refuses a routed entry that no longer matches the live directory, so a
    // requester frozen on its creation-time snapshot would fail every request
    // after the refresh until rebuilt.
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
    const { client, messenger } = buildHostClientWithMock();
    client.bind(mockLocalHostEntry);

    await expect(client.request("host.ping", {})).rejects.toSatisfy(
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
      registry,
      requestId: () => "req-1",
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: 0,
    });

    const client = new HostClient({
      registry,
      invalidator,
      messenger: wsClient,
      schedulingPolicy,
      requestCoordinator: null,
    });
    const ctx1 = makeContext("user-1", "tok-1");
    client.bind(mockLocalHostEntry);
    client.setRequestContext(ctx1);
    await client.request("host.ping", {});

    const ctx2 = makeContext("user-2", "tok-2");
    client.bind(mockRemoteHostEntry);
    client.setRequestContext(ctx2);
    await client.request("host.ping", {});

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
      registry,
      requestId: () => "req-1",
      webSocketFactory: factory,
      dialTimeoutMs: 1000,
      frameTimeoutMs: 1000,
      hostAttestationWindowMs: 0,
    });
    const client = new HostClient({
      registry,
      invalidator,
      messenger: wsClient,
      schedulingPolicy,
      requestCoordinator: null,
    });
    client.bind(mockLocalHostEntry);
    client.setRequestContext(ctx);
    await expect(client.request("host.ping", {})).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HostRpcError &&
        error.code === "RPC_ERROR" &&
        error.message.includes("released authenticated request context"),
    );

    expect(dialed).toHaveLength(0);
  });
});
