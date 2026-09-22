import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  HostListItem,
  HostListResponse,
} from "@traycer/protocol/host/host-status";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { AuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  startLocalHostInventorySubscription,
  type LocalHostEndpoint,
  type LocalHostInventorySubscriptionDeps,
} from "../local-host-inventory-subscription";

/**
 * A drivable double for one `host.hostInventory.subscribe` session.
 *
 * `getNegotiatedSchemaVersion()` answers `{ major: 1, minor: 0 }` rather than
 * `null` - either is legal per `HostInventoryStreamClient`'s own guard (a
 * `null` negotiated version skips the minor check entirely), but pinning the
 * real value here is what a healthy handshake actually reports.
 */
class FakeInventorySession implements IStreamSession {
  closed = false;
  private serverHandler: ServerFrameHandler | null = null;
  private statusHandler: StatusChangeHandler | null = null;

  sendClientFrame(): void {
    // Not exercised: `HostInventoryStreamClient` never sends a client frame
    // itself (the transport's own ping/pong lives below this seam).
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusHandler = handler;
  }

  requestReconnect(): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return { major: 1, minor: 0 };
  }

  close(): void {
    this.closed = true;
  }

  /** Drives `IStreamSession.onStatusChange`'s handler. */
  emitStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    this.statusHandler?.(status, reason, null);
  }

  /** Drives `IStreamSession.onServerFrame`'s handler with one snapshot frame. */
  emitSnapshot(
    hosts: readonly HostListItem[],
    stale: boolean,
    fetchedAtMs: number,
  ): void {
    const envelope: StreamFrameEnvelope = {
      kind: "snapshot",
      hasBinaryPayload: false,
      hosts,
      fetchedAtMs,
      stale,
    };
    this.serverHandler?.(envelope, null);
  }
}

/**
 * A drivable double for `IHostStreamClient<HostStreamRpcRegistry>`.
 *
 * The shared `FakeStreamClient` (`__testing__/fake-stream-client.ts`) always
 * answers `getMethodSupport()` with `"unknown"` and discards the listener
 * `subscribeMethodSupport` is handed, so it cannot drive A1's `"unsupported"`
 * case or a support-change notification. This double keeps everything that
 * fixture already gets right (a real `IStreamSession` double parsed against
 * the wire schema, one session per `subscribe()` call) and adds the two
 * pieces this suite needs: a settable `getMethodSupport()` answer and a
 * `subscribeMethodSupport` listener a test can actually fire.
 */
class FakeInventoryStreamClient implements IHostStreamClient<HostStreamRpcRegistry> {
  readonly instanceId: string;
  readonly sessions: FakeInventorySession[] = [];
  readonly subscribes: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];
  private closed = false;
  private closedReason: string | null = null;
  private methodSupport: StreamMethodSupport;
  private readonly supportListeners = new Set<() => void>();

  constructor(instanceId: string, initialMethodSupport: StreamMethodSupport) {
    this.instanceId = instanceId;
    this.methodSupport = initialMethodSupport;
  }

  subscribe(method: string, params: unknown): FakeInventorySession {
    const session = new FakeInventorySession();
    this.sessions.push(session);
    this.subscribes.push({ method, params });
    return session;
  }

  subscribeWithParamsProvider(
    method: string,
    paramsProvider: (onWireVersion: SchemaVersion | null) => unknown,
  ): FakeInventorySession {
    return this.subscribe(method, paramsProvider(null));
  }

  getMethodSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(reason: string): void {
    this.closed = true;
    this.closedReason = reason;
  }

  isClosed(): boolean {
    return this.closed;
  }

  getClosedReason(): string | null {
    return this.closedReason;
  }

  onClosed(): () => void {
    return () => undefined;
  }

  notifyBearerRotated(): void {}

  notifyCloudVerdictChanged(): void {}

  reconnectAll(): void {}

  isReady(): boolean {
    return true;
  }

  getMethodSupport(): StreamMethodSupport {
    return this.methodSupport;
  }

  /** Lets a test change what `getMethodSupport()` answers without a re-dial. */
  setMethodSupport(support: StreamMethodSupport): void {
    this.methodSupport = support;
  }

  subscribeMethodSupport(listener: () => void): () => void {
    this.supportListeners.add(listener);
    return () => {
      this.supportListeners.delete(listener);
    };
  }

  /** Fires every listener registered through `subscribeMethodSupport`. */
  fireMethodSupportChanged(): void {
    for (const listener of Array.from(this.supportListeners)) listener();
  }

  subscribeAvailabilityRecovered(): () => void {
    return () => undefined;
  }
}

const silentLog: AuthorityLog = {
  debug: () => undefined,
  warn: () => undefined,
};

function buildRow(hostId: string): HostListItem {
  return {
    hostId,
    displayName: null,
    platform: null,
    kind: "personal",
    publicKey: "pub-key",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    updatePolicy: "manual",
  };
}

interface RowsCall {
  readonly response: HostListResponse;
  readonly readAtMs: number;
}

interface Harness {
  readonly deps: LocalHostInventorySubscriptionDeps;
  /** Every `FakeInventoryStreamClient` this harness has opened, in order. */
  readonly clients: FakeInventoryStreamClient[];
  readonly rowsCalls: RowsCall[];
  readonly pushActiveCalls: boolean[];
  /**
   * Sets the machine's published host and fires `onLocalHostChanged`
   * listeners (a no-op before a subscription has registered one, which is
   * exactly what lets this same method seed the INITIAL endpoint too).
   */
  setLocalHost(endpoint: LocalHostEndpoint | null): void;
  /** The support the NEXT `openStreamClient()` call hands its new client. */
  setNextMethodSupport(support: StreamMethodSupport): void;
}

function buildHarness(): Harness {
  let currentHost: LocalHostEndpoint | null = null;
  let nextMethodSupport: StreamMethodSupport = "unknown";
  let nextClientIndex = 0;
  const localHostChangeListeners = new Set<() => void>();
  const clients: FakeInventoryStreamClient[] = [];
  const rowsCalls: RowsCall[] = [];
  const pushActiveCalls: boolean[] = [];

  const deps: LocalHostInventorySubscriptionDeps = {
    localHost: () => currentHost,
    onLocalHostChanged: (listener) => {
      localHostChangeListeners.add(listener);
      return () => {
        localHostChangeListeners.delete(listener);
      };
    },
    openStreamClient: () => {
      const client = new FakeInventoryStreamClient(
        `client-${nextClientIndex}`,
        nextMethodSupport,
      );
      nextClientIndex += 1;
      clients.push(client);
      return client;
    },
    onRows: (read) => {
      rowsCalls.push(read);
    },
    onPushActiveChanged: (active) => {
      pushActiveCalls.push(active);
    },
    log: silentLog,
  };

  return {
    deps,
    clients,
    rowsCalls,
    pushActiveCalls,
    setLocalHost: (endpoint) => {
      currentHost = endpoint;
      for (const listener of Array.from(localHostChangeListeners)) listener();
    },
    setNextMethodSupport: (support) => {
      nextMethodSupport = support;
    },
  };
}

const HOST_1: LocalHostEndpoint = {
  hostId: "host-1",
  websocketUrl: "ws://host-1",
};
const HOST_2: LocalHostEndpoint = {
  hostId: "host-2",
  websocketUrl: "ws://host-2",
};

describe("startLocalHostInventorySubscription", () => {
  it("A1: a host answering unsupported opens no session and never arms push", () => {
    const harness = buildHarness();
    harness.setLocalHost(HOST_1);
    harness.setNextMethodSupport("unsupported");

    const subscription = startLocalHostInventorySubscription(harness.deps);

    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.sessions).toHaveLength(0);
    expect(harness.pushActiveCalls).not.toContain(true);

    subscription.dispose();
  });

  it("A2: unknown support DOES open a session - it is the pre-handshake answer and the subscribe is the probe", () => {
    const harness = buildHarness();
    harness.setLocalHost(HOST_1);
    harness.setNextMethodSupport("unknown");

    const subscription = startLocalHostInventorySubscription(harness.deps);

    expect(harness.clients).toHaveLength(1);
    const client = harness.clients[0];
    expect(client?.sessions).toHaveLength(1);
    expect(client?.subscribes).toEqual([
      { method: "host.hostInventory.subscribe", params: {} },
    ]);

    subscription.dispose();
  });

  it("A3: a healthy snapshot adopts the rows and arms push coverage", () => {
    const harness = buildHarness();
    harness.setLocalHost(HOST_1);
    const subscription = startLocalHostInventorySubscription(harness.deps);
    const session = harness.clients[0]?.sessions[0];
    if (session === undefined) throw new Error("no session opened");

    session.emitSnapshot([buildRow("host-1")], false, 1_000);

    expect(harness.rowsCalls).toEqual([
      { response: { hosts: [buildRow("host-1")] }, readAtMs: 1_000 },
    ]);
    expect(harness.pushActiveCalls).toEqual([true]);

    subscription.dispose();
  });

  it("A4: a stale snapshot still adopts the rows, but withdraws (or never arms) push coverage", () => {
    const harness = buildHarness();
    harness.setLocalHost(HOST_1);
    const subscription = startLocalHostInventorySubscription(harness.deps);
    const session = harness.clients[0]?.sessions[0];
    if (session === undefined) throw new Error("no session opened");

    // Arm it first, so the stale frame below is proven to WITHDRAW coverage
    // rather than merely never granting it.
    session.emitSnapshot([buildRow("host-1")], false, 1_000);
    expect(harness.pushActiveCalls).toEqual([true]);

    session.emitSnapshot([buildRow("host-1")], true, 2_000);

    // Rows are still adopted - they are the freshest anyone has.
    expect(harness.rowsCalls).toEqual([
      { response: { hosts: [buildRow("host-1")] }, readAtMs: 1_000 },
      { response: { hosts: [buildRow("host-1")] }, readAtMs: 2_000 },
    ]);
    // Coverage is withdrawn.
    expect(harness.pushActiveCalls).toEqual([true, false]);

    subscription.dispose();
  });

  it("A5: a status change to anything other than open withdraws push coverage", () => {
    for (const status of ["reconnecting", "closed", "connecting"] as const) {
      const harness = buildHarness();
      harness.setLocalHost(HOST_1);
      const subscription = startLocalHostInventorySubscription(harness.deps);
      const session = harness.clients[0]?.sessions[0];
      if (session === undefined) throw new Error("no session opened");

      session.emitSnapshot([buildRow("host-1")], false, 1_000);
      expect(harness.pushActiveCalls).toEqual([true]);

      session.emitStatus(status, null);

      expect(harness.pushActiveCalls).toEqual([true, false]);
      subscription.dispose();
    }
  });

  it("A6: onPushActiveChanged fires only on TRANSITIONS, not on every frame", () => {
    const harness = buildHarness();
    harness.setLocalHost(HOST_1);
    const subscription = startLocalHostInventorySubscription(harness.deps);
    const session = harness.clients[0]?.sessions[0];
    if (session === undefined) throw new Error("no session opened");

    session.emitSnapshot([buildRow("host-1")], false, 1_000);
    session.emitSnapshot([buildRow("host-1")], false, 2_000);

    expect(harness.rowsCalls).toHaveLength(2);
    expect(harness.rowsCalls.map((call) => call.readAtMs)).toEqual([
      1_000, 2_000,
    ]);
    // One true, not two, even though two healthy snapshots landed.
    expect(harness.pushActiveCalls).toEqual([true]);

    subscription.dispose();
  });

  it("A7: no published local host at start means no client is opened at all", () => {
    const harness = buildHarness();

    const subscription = startLocalHostInventorySubscription(harness.deps);

    expect(harness.clients).toHaveLength(0);
    expect(harness.pushActiveCalls).not.toContain(true);

    subscription.dispose();
  });

  it("A8: a local-host change to a DIFFERENT hostId tears the old client down and opens a new one; the SAME hostId does not re-open", () => {
    const harness = buildHarness();
    harness.setLocalHost(HOST_1);
    const subscription = startLocalHostInventorySubscription(harness.deps);
    expect(harness.clients).toHaveLength(1);
    const firstClient = harness.clients[0];
    if (firstClient === undefined) throw new Error("no client opened");

    // Same host id (a fresh endpoint object, but the identity is unchanged):
    // no teardown, no new client.
    harness.setLocalHost({
      hostId: "host-1",
      websocketUrl: "ws://host-1-again",
    });
    expect(harness.clients).toHaveLength(1);
    expect(firstClient.isClosed()).toBe(false);

    // A different host id: the old client is torn down and a new one opened.
    harness.setLocalHost(HOST_2);
    expect(firstClient.isClosed()).toBe(true);
    expect(harness.clients).toHaveLength(2);

    subscription.dispose();
  });

  it("A9: dispose() closes the client and the session and leaves push inactive", () => {
    const harness = buildHarness();
    harness.setLocalHost(HOST_1);
    const subscription = startLocalHostInventorySubscription(harness.deps);
    const client = harness.clients[0];
    const session = client?.sessions[0];
    if (client === undefined || session === undefined) {
      throw new Error("no client/session opened");
    }

    session.emitSnapshot([buildRow("host-1")], false, 1_000);
    expect(harness.pushActiveCalls).toEqual([true]);

    subscription.dispose();

    expect(session.closed).toBe(true);
    expect(client.isClosed()).toBe(true);
    expect(harness.pushActiveCalls).toEqual([true, false]);
  });
});
