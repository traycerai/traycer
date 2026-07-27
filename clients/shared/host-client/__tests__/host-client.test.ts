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

    const sameIdOffline = {
      ...mockLocalHostEntry,
      websocketUrl: null,
      status: "unavailable" as const,
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

  it("invalidates on availability recovery only when a host is bound", () => {
    const { client, invalidator, events } = buildHostClientWithMock();
    client.notifyAvailabilityRecovered();
    expect(invalidator.calls).toEqual([]);
    expect(events).toEqual([]);

    client.bind(mockLocalHostEntry);
    invalidator.calls.length = 0;
    events.length = 0;

    client.notifyAvailabilityRecovered();
    expect(invalidator.calls).toEqual(["mock-local"]);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("availability-recovered");
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
