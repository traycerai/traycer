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
  type ResourcesScopeSupport,
  type ResourcesStreamCallbacks,
} from "../resources-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";

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

  fireClose(code: number, reason: string, wasClean: boolean): void {
    this.onclose?.({ code, reason, wasClean });
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
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: factory,
    dialTimeoutMs: 1000,
    openAckTimeoutMs: 1000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1000,
  });
}

/**
 * Acks the open with the client's own manifest echoed back, except that
 * `resources.subscribe` is pinned to `resourcesVersion` when one is given -
 * which is how a host too old to carry a global projection is expressed, since
 * the negotiated version IS the whole signal.
 */
function respondToOpen(
  socket: StubStreamWebSocket,
  resourcesVersion: { readonly major: number; readonly minor: number } | null,
): void {
  socket.fireOpen();
  const openParsed = JSON.parse(socket.textSent[0]) as {
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({
    kind: "openAck",
    manifest:
      resourcesVersion === null
        ? openParsed.manifest
        : { ...openParsed.manifest, "resources.subscribe": resourcesVersion },
  });
}

function completeHandshake(socket: StubStreamWebSocket): void {
  respondToOpen(socket, null);
}

function completeHandshakeAt(
  socket: StubStreamWebSocket,
  resourcesVersion: { readonly major: number; readonly minor: number },
): void {
  respondToOpen(socket, resourcesVersion);
}

/**
 * Records every scope verdict the client publishes, newest last — plus one
 * ORDERED log interleaving verdicts with connection statuses, because the
 * client documents that it publishes the verdict first and a consumer reacting
 * to `closed` depends on it. Recording only the verdicts would let a swap of
 * those two calls pass every test here.
 */
function trackScopeSupport(): {
  readonly callbacks: ResourcesStreamCallbacks;
  readonly verdicts: ResourcesScopeSupport[];
  readonly events: string[];
} {
  const verdicts: ResourcesScopeSupport[] = [];
  const events: string[] = [];
  return {
    verdicts,
    events,
    callbacks: {
      onSnapshot: () => undefined,
      onUpdate: () => undefined,
      onConnectionStatus: (status) => {
        events.push(`status:${status}`);
      },
      onScopeSupport: (support) => {
        events.push(`support:${support}`);
        verdicts.push(support);
      },
    },
  };
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
  harnessId: null,
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
      onScopeSupport: () => undefined,
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
      schemaVersion: { major: 1, minor: 4 },
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
    expect(snapshots[0].owners[0].harnessId).toBeNull();
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

  it("backfills harnessId to null for a pre-1.3 (harnessId-less) frame", () => {
    const { factory, sockets } = makeFactory();
    const snapshots: ResourcesProjectionPayload[] = [];
    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onSnapshot: (p) => snapshots.push(p),
        onUpdate: () => {},
        onConnectionStatus: () => {},
        onScopeSupport: () => {},
      },
    });
    completeHandshake(sockets[0]);

    // An older host emits a `@1.2` frame whose owner carries NO harnessId. It
    // fails the `@1.3` parse, falls back to `@1.2`, and `toPayload` normalizes
    // the missing field to `null` so downstream always reads a defined value.
    const { harnessId: _omit, ...ownerWithoutHarness } = OWNER;
    sockets[0].fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      sampledAt: 1_000,
      app: APP,
      owners: [ownerWithoutHarness],
      epic: EPIC,
      hostTree: HOST_TREE,
      other: OTHER,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].owners[0].harnessId).toBeNull();
    client.close();
  });

  it("surfaces a managed-command owner from an @1.4 frame", () => {
    const { factory, sockets } = makeFactory();
    const snapshots: ResourcesProjectionPayload[] = [];
    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onSnapshot: (p) => snapshots.push(p),
        onUpdate: () => {},
        onConnectionStatus: () => {},
        onScopeSupport: () => {},
      },
    });
    completeHandshake(sockets[0]);

    sockets[0].fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      sampledAt: 1_000,
      app: APP,
      owners: [
        {
          ...OWNER,
          owner: { ...OWNER.owner, kind: "managed-command", ownerId: "cmd-1" },
          managedCommand: {
            commandId: "cmd-1",
            monitoring: true,
            description: "deploy watcher",
            createdByAgentId: "chat-1",
          },
        },
      ],
      epic: EPIC,
      hostTree: HOST_TREE,
      other: OTHER,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].owners[0].owner.kind).toBe("managed-command");
    expect(snapshots[0].owners[0].managedCommand).toEqual({
      commandId: "cmd-1",
      monitoring: true,
      description: "deploy watcher",
      createdByAgentId: "chat-1",
    });
    client.close();
  });

  it("backfills managedCommand to null for a pre-1.4 frame", () => {
    const { factory, sockets } = makeFactory();
    const snapshots: ResourcesProjectionPayload[] = [];
    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks: {
        onSnapshot: (p) => snapshots.push(p),
        onUpdate: () => {},
        onConnectionStatus: () => {},
        onScopeSupport: () => {},
      },
    });
    completeHandshake(sockets[0]);

    // A `@1.3` host emits owners without `managedCommand` - and folds any
    // running command's tree into `other` rather than naming it as an owner.
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

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].owners[0].managedCommand).toBeNull();
    expect(snapshots[0].owners[0].harnessId).toBeNull();
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
        onScopeSupport: () => undefined,
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

/**
 * The scope verdict is what lets a surface say "this host cannot report its
 * processes" instead of waiting forever on a stream that will never carry one.
 * These cover it on the LOCAL transport because that is what this suite can
 * drive end to end - but every signal it reads (the session's own negotiated
 * version, and a terminal incompatible close) is `IStreamSession` surface that
 * `LogicalStream` implements identically, which is the entire point: the
 * client-wide capability cache the old pre-check read is the one thing a remote
 * session does NOT have.
 */
describe("ResourcesStreamClient scope support", () => {
  it("clears a global scope on a host that negotiates a global-capable version", () => {
    const { factory, sockets } = makeFactory();
    const { callbacks, verdicts } = trackScopeSupport();

    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "global" },
      callbacks,
    });
    completeHandshake(sockets[0]);

    expect(verdicts).toEqual(["supported"]);

    client.close();
  });

  // The case that has no other tell. An `@1.0` host does not reject a global
  // probe - the `@1.1` request keeps `epicId` on the wire so the downgrade
  // succeeds - so it accepts, reads only `epicId`, and answers about an epic
  // called `__global__` that does not exist. No error, no close, one empty
  // projection, silence. Asserting the subscribe actually WENT OUT at `@1.0`
  // with the scope field stripped is what proves the verdict came from the
  // negotiation rather than from a failure that never happened.
  it("convicts a host whose global probe silently downgraded to @1.0", () => {
    const { factory, sockets } = makeFactory();
    const { callbacks, verdicts } = trackScopeSupport();

    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "global" },
      callbacks,
    });
    completeHandshakeAt(sockets[0], { major: 1, minor: 0 });

    expect(parseText(sockets[0].textSent[1])).toEqual({
      kind: "subscribe",
      method: "resources.subscribe",
      schemaVersion: { major: 1, minor: 0 },
      params: { epicId: "__global__" },
    });
    expect(sockets[0].closed).toBeNull();
    expect(verdicts).toEqual(["unsupported"]);

    client.close();
  });

  // Same host, same negotiation, opposite verdict: `@1.0` serves a per-epic
  // subscription perfectly well, and that fallback is genuinely this machine's
  // own data. A verdict that keyed on the version alone would blank it.
  it("clears an epic scope on that same @1.0 host", () => {
    const { factory, sockets } = makeFactory();
    const { callbacks, verdicts } = trackScopeSupport();

    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "epic", epicId: "epic-1" },
      callbacks,
    });
    completeHandshakeAt(sockets[0], { major: 1, minor: 0 });

    expect(verdicts).toEqual(["supported"]);

    client.close();
  });

  // The other half: a host that does not advertise a bridgeable method at all
  // never negotiates a version to judge, and fails the mirror check instead.
  // This is the close a REMOTE session produces for the same host.
  it("convicts a host whose method cannot be bridged at all", () => {
    const { factory, sockets } = makeFactory();
    const { callbacks, verdicts } = trackScopeSupport();

    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "global" },
      callbacks,
    });
    // No cross-major stream bridge exists, so the mirror check fails and the
    // client goes terminal with INCOMPATIBLE before any subscribe is sent.
    completeHandshakeAt(sockets[0], { major: 2, minor: 0 });

    expect(verdicts).toEqual(["unsupported"]);

    client.close();
  });

  // Every fatal arrives through the one channel, and most of them say nothing
  // about capability. Reading this one as incompatibility would accuse a host
  // that is merely unauthorized of being too old - permanently, since nothing
  // reconnects after a terminal close to correct it.
  it("does not read a non-capability fatal as incompatibility", () => {
    const { factory, sockets } = makeFactory();
    const { callbacks, verdicts } = trackScopeSupport();

    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "global" },
      callbacks,
    });
    completeHandshake(sockets[0]);
    expect(verdicts).toEqual(["supported"]);

    sockets[0].fireText({
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "bearer rejected",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });

    expect(verdicts).toEqual(["supported"]);

    client.close();
  });

  // The client documents this ordering as load-bearing: a consumer reacting to
  // the `closed` transition has to already see WHY, rather than reading the
  // verdict from the previous round. Nothing but this asserts it.
  it("publishes the verdict before the status it was derived from", () => {
    const { factory, sockets } = makeFactory();
    const { callbacks, events } = trackScopeSupport();

    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "global" },
      callbacks,
    });
    // Terminal INCOMPATIBLE: the transition that carries both a status and the
    // verdict explaining it, which is exactly where the order can be observed.
    completeHandshakeAt(sockets[0], { major: 2, minor: 0 });

    expect(events).toEqual(["support:unsupported", "status:closed"]);

    client.close();
  });

  // A verdict belongs to the connection that produced it. A reconnect may reach
  // a NEW host incarnation - an upgrade is exactly how one stops being too old -
  // so capability has to be re-probed, never remembered across the gap.
  it("drops the verdict when the connection that negotiated it goes away", () => {
    const { factory, sockets } = makeFactory();
    const { callbacks, verdicts } = trackScopeSupport();

    const client = new ResourcesStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      scope: { kind: "global" },
      callbacks,
    });
    completeHandshakeAt(sockets[0], { major: 1, minor: 0 });
    expect(verdicts).toEqual(["unsupported"]);

    sockets[0].fireClose(1006, "connection lost", false);

    expect(verdicts).toEqual(["unsupported", "unknown"]);

    client.close();
  });
});
