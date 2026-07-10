import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../ws-stream-factory";
import { WsStreamClient } from "../ws-stream-client";
import {
  ResourcesStreamClient,
  type ResourcesProjectionPayload,
  type ResourcesStreamCallbacks,
} from "../resources-stream-client";

class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.textSent.push(data);
    }
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }
}

function makeFactory(): {
  readonly factory: IStreamWebSocketFactory;
  readonly sockets: StubStreamWebSocket[];
} {
  const sockets: StubStreamWebSocket[] = [];
  const factory: IStreamWebSocketFactory = {
    create(): StreamWebSocketLike {
      const socket = new StubStreamWebSocket();
      sockets.push(socket);
      return socket;
    },
  };
  return { factory, sockets };
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

function makeWsStreamClient(
  factory: IStreamWebSocketFactory,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const ctx = makeRequestContext("token");
  return new WsStreamClient({
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx?.credentials ?? null,
    auth: null,
    webSocketFactory: factory,
    dialTimeoutMs: 1000,
    openAckTimeoutMs: 1000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1000,
  });
}

function completeHandshake(socket: StubStreamWebSocket): void {
  socket.fireOpen();
  const openParsed = JSON.parse(socket.textSent[0]) as {
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({
    kind: "openAck",
    manifest: openParsed.manifest,
  });
}

function parseText(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object text frame");
  }
  return value as Record<string, unknown>;
}

const OWNER = {
  owner: {
    kind: "terminal" as const,
    hostId: "host-1",
    epicId: "epic-1",
    ownerId: "s1",
  },
  sampledAt: 1_000,
  rootPids: [1],
  activeProcessName: "bash",
  processCount: 2,
  cpuPercent: 10,
  rssBytes: 1_000,
  processes: [
    {
      pid: 1,
      parentPid: null,
      rootPid: 1,
      name: "bash",
      command: "/bin/bash",
      cpuPercent: 10,
      rssBytes: 1_000,
    },
  ],
};

const EPIC = {
  hostId: "host-1",
  epicId: "epic-1",
  sampledAt: 1_000,
  ownerCount: 1,
  processCount: 2,
  cpuPercent: 10,
  rssBytes: 1_000,
};

const APP = {
  sampledAt: 1_000,
  hostTotalMemoryBytes: 16_000,
  process: {
    pid: 10,
    parentPid: null,
    rootPid: 10,
    name: "traycer-host",
    command: "traycer-host",
    cpuPercent: 1,
    rssBytes: 2_000,
  },
  processCount: 1,
  cpuPercent: 1,
  rssBytes: 2_000,
};

const HOST_TREE = {
  sampledAt: 1_000,
  processCount: 3,
  cpuPercent: 15,
  rssBytes: 3_000,
};

const OTHER = {
  sampledAt: 1_000,
  rootPids: [20],
  processCount: 1,
  cpuPercent: 4,
  rssBytes: 500,
  processes: [
    {
      pid: 20,
      parentPid: null,
      rootPid: 20,
      name: "worker",
      command: "worker",
      cpuPercent: 4,
      rssBytes: 500,
    },
  ],
};

describe("ResourcesStreamClient", () => {
  it("subscribes to resources.subscribe with the epicId and dispatches typed frames", () => {
    const { factory, sockets } = makeFactory();
    const snapshots: ResourcesProjectionPayload[] = [];
    const updates: ResourcesProjectionPayload[] = [];
    const callbacks: ResourcesStreamCallbacks = {
      onSnapshot: (p) => snapshots.push(p),
      onUpdate: (p) => updates.push(p),
      onConnectionStatus: () => undefined,
    };

    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks,
    });
    completeHandshake(sockets[0]);

    expect(parseText(sockets[0].textSent[1])).toEqual({
      kind: "subscribe",
      method: "resources.subscribe",
      schemaVersion: { major: 1, minor: 2 },
      params: {
        epicId: "epic-1",
        scope: { kind: "epic", epicId: "epic-1" },
      },
    });

    sockets[0].fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      sampledAt: 1_000,
      app: APP,
      owners: [OWNER],
      epic: EPIC,
      hostTree: HOST_TREE,
      other: OTHER,
    });
    sockets[0].fireText({
      kind: "update",
      hasBinaryPayload: false,
      epicId: "epic-1",
      sampledAt: 2_000,
      app: { ...APP, sampledAt: 2_000, cpuPercent: 2 },
      owners: [{ ...OWNER, cpuPercent: 55, sampledAt: 2_000 }],
      epic: { ...EPIC, cpuPercent: 55, sampledAt: 2_000 },
      hostTree: { ...HOST_TREE, sampledAt: 2_000, cpuPercent: 60 },
      other: { ...OTHER, sampledAt: 2_000, cpuPercent: 5 },
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].app?.process?.name).toBe("traycer-host");
    expect(snapshots[0].owners[0].owner.ownerId).toBe("s1");
    expect(snapshots[0].owners[0].processes[0].command).toBe("/bin/bash");
    expect(snapshots[0].epic?.epicId).toBe("epic-1");
    expect(snapshots[0].epics).toEqual([]);
    expect(snapshots[0].hostTree?.cpuPercent).toBe(15);
    expect(snapshots[0].other?.processes[0].name).toBe("worker");
    expect(updates).toHaveLength(1);
    expect(updates[0].owners[0].cpuPercent).toBe(55);
    expect(updates[0].sampledAt).toBe(2_000);
    expect(updates[0].hostTree?.cpuPercent).toBe(60);

    client.close();
  });

  it("ignores pong and malformed frames without invoking callbacks", () => {
    const { factory, sockets } = makeFactory();
    const snapshots: ResourcesProjectionPayload[] = [];
    const updates: ResourcesProjectionPayload[] = [];
    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onSnapshot: (p) => snapshots.push(p),
        onUpdate: (p) => updates.push(p),
        onConnectionStatus: () => undefined,
      },
    });
    completeHandshake(sockets[0]);

    sockets[0].fireText({ kind: "pong", hasBinaryPayload: false });
    // Missing the required `owners`/`epic` fields -> fails the frame schema.
    sockets[0].fireText({
      kind: "update",
      hasBinaryPayload: false,
      epicId: "epic-1",
    });

    expect(snapshots).toHaveLength(0);
    expect(updates).toHaveLength(0);

    client.close();
  });
});
