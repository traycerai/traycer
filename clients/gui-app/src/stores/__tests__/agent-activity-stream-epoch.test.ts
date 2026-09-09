import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  IHostStreamClient,
  ReconnectAllOptions,
} from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { ParamsOf } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  HostReconnectEngine,
  ReopenLane,
  StreamRebuildPacer,
} from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import {
  __resetAgentActivityStoreForTests,
  agentActivityPlaneAnswers,
  agentActivityPlaneCoversHost,
  openAgentActivityStream,
  useAgentActivityStore,
} from "@/stores/agent-activity-store";

/**
 * Records the frame/status handlers `AgentActivityStreamClient` installs so a
 * test can drive them directly - mirrors the `StubSession` in
 * `clients/shared/host-transport/__tests__/agent-activity-stream-client.test.ts`.
 */
class StubSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler = () => undefined;
  private statusChangeHandler: StatusChangeHandler = () => undefined;
  negotiatedSchemaVersion: SchemaVersion | null = null;

  readonly close = vi.fn();

  sendClientFrame(): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.negotiatedSchemaVersion;
  }

  requestReconnect(): void {}

  emitFrame(frame: StreamFrameEnvelope): void {
    this.serverFrameHandler(frame, null);
  }

  emitStatus(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler(status, reason);
  }
}

/**
 * A whole `IHostStreamClient<HostStreamRpcRegistry>` bound to a single
 * `StubSession`. `openAgentActivityStream` only ever calls `.subscribe(...)`
 * on it (through `AgentActivityStreamClient`), so every other member is a
 * stub that is never expected to be reached.
 */
class StubHostStreamClient implements IHostStreamClient<HostStreamRpcRegistry> {
  constructor(
    private readonly session: IStreamSession,
    readonly instanceId: string,
  ) {}

  isReady(): boolean {
    return true;
  }

  subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return this.session;
  }

  subscribeWithParamsProvider<
    Method extends keyof HostStreamRpcRegistry & string,
  >(
    _method: Method,
    _paramsProvider: () => ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return this.session;
  }

  getMethodSchemaVersion(): SchemaVersion | null {
    return null;
  }

  close(): void {}

  isClosed(): boolean {
    return false;
  }

  getClosedReason(): string | null {
    return null;
  }

  onClosed(): () => void {
    return () => {};
  }

  notifyBearerRotated(): void {}

  reconnectAll(_reason: string, _options: ReconnectAllOptions): void {}

  getMethodSupport(): StreamMethodSupport {
    return "unknown";
  }

  subscribeMethodSupport(): () => void {
    return () => {};
  }

  subscribeAvailabilityRecovered(): () => void {
    return () => {};
  }
}

function createStubReopenLane(): ReopenLane {
  return {
    scheduleAfterClose: vi.fn(),
    resetBackoff: vi.fn(),
    dispose: vi.fn(),
  };
}

function createStubRebuildPacer(): StreamRebuildPacer {
  return {
    markBuilt: vi.fn(),
    nextRebuildDelayMs: vi.fn(() => 0),
    clearStreak: vi.fn(),
  };
}

/**
 * Stubs the reconnect engine's `openReopenLane` (the only member
 * `openAgentActivityStream` calls) while still satisfying the full
 * `HostReconnectEngine` shape.
 */
function createStubReconnectEngine(): HostReconnectEngine {
  return {
    createRebuildPacer: vi.fn(createStubRebuildPacer),
    openReopenLane: vi.fn(createStubReopenLane),
    claimWakeEpisode: vi.fn(() => true),
    isWithinWakeEpisode: vi.fn(() => false),
    dispose: vi.fn(),
  };
}

/**
 * Like {@link createStubReconnectEngine}, but the reopen lane also hands back
 * the `reopen` callback `openAgentActivityStream` gives `openReopenLane`, so a
 * test can fire it directly - standing in for the real engine's backoff timer
 * elapsing, which is that module's own suite's job to cover, not this file's.
 */
function createReopenCapturingReconnectEngine(): {
  readonly reconnectEngine: HostReconnectEngine;
  readonly fireReopen: () => void;
} {
  let reopen: (() => void) | null = null;
  const reconnectEngine: HostReconnectEngine = {
    createRebuildPacer: vi.fn(createStubRebuildPacer),
    openReopenLane: vi.fn((onReopen: () => void) => {
      reopen = onReopen;
      return createStubReopenLane();
    }),
    claimWakeEpisode: vi.fn(() => true),
    isWithinWakeEpisode: vi.fn(() => false),
    dispose: vi.fn(),
  };
  return {
    reconnectEngine,
    fireReopen: () => {
      if (reopen === null) throw new Error("openReopenLane was never called");
      reopen();
    },
  };
}

/** A close reason a reopen lane actually retries (`isReopenableHostStreamClose`). */
function reopenableFatalClose(): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code: "CONNECTION_LOST",
      reason: "test close: CONNECTION_LOST",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

const EPIC_ID = "epic-1";
const AGENT_ID = "agent-1";
/**
 * Both epochs open under the SAME host: this suite is about one host's client
 * being replaced, which is exactly the case where the outgoing session's
 * health used to stay readable. The store is keyed by host now, so every read
 * below goes through that host's slice rather than a flat top-level field.
 */
const HOST_ID = "host-1";

function hostSlice(hostId: string): {
  readonly connectionStatus: string;
  readonly servedBy: string | null;
  readonly cloudSyncStatus: string | null;
  readonly byEpic: ReadonlyMap<
    string,
    { readonly working: ReadonlySet<string> }
  >;
} {
  const host = useAgentActivityStore.getState().byHost.get(hostId);
  if (host === undefined) throw new Error(`no activity slice for ${hostId}`);
  return host;
}

function driveToOpenAndConnected(session: StubSession): void {
  session.emitStatus("open", null);
  session.emitFrame({
    kind: "state",
    servedBy: "cloud",
    byEpic: { [EPIC_ID]: { working: [AGENT_ID], turn: [AGENT_ID] } },
    cloudSyncStatus: "connected",
    hasBinaryPayload: false,
  });
}

describe("agent activity stream epoch handoff", () => {
  beforeEach(() => {
    __resetAgentActivityStoreForTests();
  });

  afterEach(() => {
    __resetAgentActivityStoreForTests();
  });

  it("a live session's health does not survive into the next stream epoch", () => {
    const firstSession = new StubSession();
    const firstClient = new StubHostStreamClient(firstSession, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    const disposeFirst = openAgentActivityStream(
      HOST_ID,
      reconnectEngine,
      firstClient,
      null,
    );

    driveToOpenAndConnected(firstSession);

    expect(hostSlice(HOST_ID).connectionStatus).toBe("open");
    expect(hostSlice(HOST_ID).cloudSyncStatus).toBe("connected");
    expect(hostSlice(HOST_ID).byEpic.size).toBeGreaterThan(0);

    disposeFirst();

    const secondSession = new StubSession();
    const secondClient = new StubHostStreamClient(
      secondSession,
      "host-stream-2",
    );
    // The new epoch is opened, but its session is never driven - no frame,
    // no status change. Without the fix the store would still be reading
    // `open` / `connected` from the torn-down first session.
    openAgentActivityStream(HOST_ID, reconnectEngine, secondClient, null);

    expect(hostSlice(HOST_ID).connectionStatus).toBe("connecting");
    expect(hostSlice(HOST_ID).cloudSyncStatus).toBeNull();
  });

  it("the retired epoch leaves no live claim behind", () => {
    const session = new StubSession();
    const client = new StubHostStreamClient(session, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    const dispose = openAgentActivityStream(
      HOST_ID,
      reconnectEngine,
      client,
      null,
    );

    driveToOpenAndConnected(session);

    expect(hostSlice(HOST_ID).connectionStatus).toBe("open");
    expect(hostSlice(HOST_ID).cloudSyncStatus).toBe("connected");

    dispose();

    expect(hostSlice(HOST_ID).connectionStatus).toBe("connecting");
    expect(hostSlice(HOST_ID).cloudSyncStatus).toBeNull();
  });

  it("a replacement epoch does not vouch for the union until its own frame arrives, though servedBy survived the swap", () => {
    const firstSession = new StubSession();
    const firstClient = new StubHostStreamClient(firstSession, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    const disposeFirst = openAgentActivityStream(
      "host-a",
      reconnectEngine,
      firstClient,
      null,
    );
    driveToOpenAndConnected(firstSession);
    expect(agentActivityPlaneAnswers()).toBe(true);

    disposeFirst();

    const secondSession = new StubSession();
    const secondClient = new StubHostStreamClient(
      secondSession,
      "host-stream-2",
    );
    openAgentActivityStream("host-a", reconnectEngine, secondClient, null);
    // The window this pins: a raw transport open with no frame behind it. The
    // per-user union and its `servedBy` are still the FIRST epoch's, by
    // design, so a plane predicate that read `servedBy !== null` would vouch
    // here - and the epic cap, which fails closed on a plane that cannot
    // vouch, would prune against a working set nobody has re-attested,
    // evicting an Epic whose agent started during the gap.
    secondSession.emitStatus("open", null);
    expect(hostSlice("host-a").connectionStatus).toBe("open");
    expect(hostSlice("host-a").servedBy).toBe("cloud");
    expect(agentActivityPlaneAnswers()).toBe(false);

    // Its own frame is the proof, and it is the thing that flips the answer.
    secondSession.emitFrame({
      kind: "state",
      servedBy: "cloud",
      byEpic: { [EPIC_ID]: { working: [AGENT_ID], turn: [AGENT_ID] } },
      cloudSyncStatus: "connected",
      hasBinaryPayload: false,
    });
    expect(agentActivityPlaneAnswers()).toBe(true);
  });

  it("an in-place reconnect withdraws the attestation but keeps the union", () => {
    const session = new StubSession();
    const client = new StubHostStreamClient(session, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    openAgentActivityStream("host-a", reconnectEngine, client, null);
    driveToOpenAndConnected(session);
    expect(agentActivityPlaneAnswers()).toBe(true);

    // A dropped socket never reports `closed`: the client goes `open` ->
    // `reconnecting` -> `open` in place and keeps redialing, so no epoch
    // boundary runs and the union stays on record. What must NOT stay is the
    // claim that it describes now - an agent can start on the other side of
    // that gap, and the cap would evict its Epic on the old map's silence.
    session.emitStatus("reconnecting", null);
    expect(agentActivityPlaneAnswers()).toBe(false);
    expect(hostSlice("host-a").byEpic.get(EPIC_ID)?.working).toEqual(
      new Set([AGENT_ID]),
    );

    // Back on the wire, still unattested: the socket is not the answer.
    session.emitStatus("open", null);
    expect(hostSlice("host-a").connectionStatus).toBe("open");
    expect(agentActivityPlaneAnswers()).toBe(false);

    session.emitFrame({
      kind: "state",
      servedBy: "cloud",
      byEpic: { [EPIC_ID]: { working: [AGENT_ID], turn: [AGENT_ID] } },
      cloudSyncStatus: "connected",
      hasBinaryPayload: false,
    });
    expect(agentActivityPlaneAnswers()).toBe(true);
  });

  it("records the caller's servingHostId, and a replacement's own", () => {
    // A NARROW frame throughout (`cloudSyncStatus: null`, not the shared
    // `driveToOpenAndConnected` helper's `"connected"`): a fleet-wide union
    // would cover every host and this test would prove nothing about which
    // one was actually recorded.
    function driveOpenWithNarrowFrame(session: StubSession): void {
      session.emitStatus("open", null);
      session.emitFrame({
        kind: "state",
        servedBy: "local",
        byEpic: { [EPIC_ID]: { working: [AGENT_ID], turn: [AGENT_ID] } },
        cloudSyncStatus: null,
        hasBinaryPayload: false,
      });
    }

    const firstSession = new StubSession();
    const firstClient = new StubHostStreamClient(firstSession, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    const disposeFirst = openAgentActivityStream(
      "host-a",
      reconnectEngine,
      firstClient,
      null,
    );
    // Set at open, ahead of any frame - `agentActivityPlaneCoversHost` is
    // still false here because `agentActivityPlaneAnswers` gates it first,
    // not because the host was not recorded.
    expect(agentActivityPlaneAnswers()).toBe(false);
    driveOpenWithNarrowFrame(firstSession);
    expect(agentActivityPlaneCoversHost("host-a")).toBe(true);
    expect(agentActivityPlaneCoversHost("host-b")).toBe(false);

    disposeFirst();

    const secondSession = new StubSession();
    const secondClient = new StubHostStreamClient(
      secondSession,
      "host-stream-2",
    );
    // A different host now serves the union - the exact swap a host failover
    // performs, with the registry potentially still holding a session bound
    // to `host-a` from before it.
    openAgentActivityStream("host-b", reconnectEngine, secondClient, null);
    driveOpenWithNarrowFrame(secondSession);
    expect(agentActivityPlaneCoversHost("host-b")).toBe(true);
    expect(agentActivityPlaneCoversHost("host-a")).toBe(false);
  });

  it("re-asserts the serving host on every reopen dial, not only the first", () => {
    // A NARROW frame (`cloudSyncStatus: null`), not the shared
    // `driveToOpenAndConnected` helper's fleet-spanning one:
    // `agentActivityPlaneCoversHost` short-circuits true for ANY host once the
    // union spans the fleet, which would prove nothing about `servingHostId`
    // specifically.
    function driveOpenWithNarrowFrame(session: StubSession): void {
      session.emitStatus("open", null);
      session.emitFrame({
        kind: "state",
        servedBy: "local",
        byEpic: { [EPIC_ID]: { working: [AGENT_ID], turn: [AGENT_ID] } },
        cloudSyncStatus: null,
        hasBinaryPayload: false,
      });
    }

    const { reconnectEngine, fireReopen } =
      createReopenCapturingReconnectEngine();
    const session = new StubSession();
    const client = new StubHostStreamClient(session, "host-stream-1");

    openAgentActivityStream("host-a", reconnectEngine, client, null);
    driveOpenWithNarrowFrame(session);
    expect(agentActivityPlaneCoversHost("host-a")).toBe(true);

    // A terminal close retires the whole reading through
    // `noteAgentActivityConnectionStatus("closed")` - `servingHostId`
    // included, same as every other field.
    session.emitStatus("closed", reopenableFatalClose());
    expect(hostSlice("host-a").connectionStatus).toBe("closed");
    expect(agentActivityPlaneCoversHost("host-a")).toBe(false);

    // The reopen lane's timer firing, simulated directly: the callback
    // `openAgentActivityStream` gave `openReopenLane` closes the old client
    // and dials a fresh one against the same stub session - it does not go
    // through `openAgentActivityStream` again, so nothing outside `openClient`
    // itself can re-assert `servingHostId` for this dial.
    fireReopen();
    driveOpenWithNarrowFrame(session);

    // Without the fix this reads false forever past a reopen: the close above
    // cleared `servingHostId` to `null` and nothing on the reopen path re-set
    // it, though the stream is, in fact, open against "host-a" again with its
    // own fresh attestation.
    expect(agentActivityPlaneCoversHost("host-a")).toBe(true);
  });

  it("the per-user cloud union survives a stream replacement", () => {
    const firstSession = new StubSession();
    const firstClient = new StubHostStreamClient(firstSession, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    const disposeFirst = openAgentActivityStream(
      HOST_ID,
      reconnectEngine,
      firstClient,
      null,
    );

    driveToOpenAndConnected(firstSession);

    expect(hostSlice(HOST_ID).byEpic.get(EPIC_ID)?.working).toEqual(
      new Set([AGENT_ID]),
    );

    disposeFirst();

    const secondSession = new StubSession();
    const secondClient = new StubHostStreamClient(
      secondSession,
      "host-stream-2",
    );
    openAgentActivityStream(HOST_ID, reconnectEngine, secondClient, null);

    // `byEpic` is per-user, not per-stream-epoch: a host switch does not
    // clear it, only the health of the stream that reported it.
    expect(hostSlice(HOST_ID).byEpic.get(EPIC_ID)?.working).toEqual(
      new Set([AGENT_ID]),
    );
  });
});
