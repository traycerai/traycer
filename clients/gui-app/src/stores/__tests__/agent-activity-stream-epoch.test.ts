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

const EPIC_ID = "epic-1";
const AGENT_ID = "agent-1";

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
      reconnectEngine,
      firstClient,
      null,
      "host-a",
    );

    driveToOpenAndConnected(firstSession);

    expect(useAgentActivityStore.getState().connectionStatus).toBe("open");
    expect(useAgentActivityStore.getState().cloudSyncStatus).toBe("connected");
    expect(useAgentActivityStore.getState().byEpic.size).toBeGreaterThan(0);

    disposeFirst();

    const secondSession = new StubSession();
    const secondClient = new StubHostStreamClient(
      secondSession,
      "host-stream-2",
    );
    // The new epoch is opened, but its session is never driven - no frame,
    // no status change. Without the fix the store would still be reading
    // `open` / `connected` from the torn-down first session.
    openAgentActivityStream(reconnectEngine, secondClient, null, "host-a");

    expect(useAgentActivityStore.getState().connectionStatus).toBe(
      "connecting",
    );
    expect(useAgentActivityStore.getState().cloudSyncStatus).toBeNull();
  });

  it("the retired epoch leaves no live claim behind", () => {
    const session = new StubSession();
    const client = new StubHostStreamClient(session, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    const dispose = openAgentActivityStream(
      reconnectEngine,
      client,
      null,
      "host-a",
    );

    driveToOpenAndConnected(session);

    expect(useAgentActivityStore.getState().connectionStatus).toBe("open");
    expect(useAgentActivityStore.getState().cloudSyncStatus).toBe("connected");

    dispose();

    expect(useAgentActivityStore.getState().connectionStatus).toBe(
      "connecting",
    );
    expect(useAgentActivityStore.getState().cloudSyncStatus).toBeNull();
  });

  it("a replacement epoch does not vouch for the union until its own frame arrives, though servedBy survived the swap", () => {
    const firstSession = new StubSession();
    const firstClient = new StubHostStreamClient(firstSession, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    const disposeFirst = openAgentActivityStream(
      reconnectEngine,
      firstClient,
      null,
      "host-a",
    );
    driveToOpenAndConnected(firstSession);
    expect(agentActivityPlaneAnswers()).toBe(true);

    disposeFirst();

    const secondSession = new StubSession();
    const secondClient = new StubHostStreamClient(
      secondSession,
      "host-stream-2",
    );
    openAgentActivityStream(reconnectEngine, secondClient, null, "host-a");
    // The window this pins: a raw transport open with no frame behind it. The
    // per-user union and its `servedBy` are still the FIRST epoch's, by
    // design, so a plane predicate that read `servedBy !== null` would vouch
    // here - and the epic cap, which fails closed on a plane that cannot
    // vouch, would prune against a working set nobody has re-attested,
    // evicting an Epic whose agent started during the gap.
    secondSession.emitStatus("open", null);
    expect(useAgentActivityStore.getState().connectionStatus).toBe("open");
    expect(useAgentActivityStore.getState().servedBy).toBe("cloud");
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

    openAgentActivityStream(reconnectEngine, client, null, "host-a");
    driveToOpenAndConnected(session);
    expect(agentActivityPlaneAnswers()).toBe(true);

    // A dropped socket never reports `closed`: the client goes `open` ->
    // `reconnecting` -> `open` in place and keeps redialing, so no epoch
    // boundary runs and the union stays on record. What must NOT stay is the
    // claim that it describes now - an agent can start on the other side of
    // that gap, and the cap would evict its Epic on the old map's silence.
    session.emitStatus("reconnecting", null);
    expect(agentActivityPlaneAnswers()).toBe(false);
    expect(
      useAgentActivityStore.getState().byEpic.get(EPIC_ID)?.working,
    ).toEqual(new Set([AGENT_ID]));

    // Back on the wire, still unattested: the socket is not the answer.
    session.emitStatus("open", null);
    expect(useAgentActivityStore.getState().connectionStatus).toBe("open");
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
      reconnectEngine,
      firstClient,
      null,
      "host-a",
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
    openAgentActivityStream(reconnectEngine, secondClient, null, "host-b");
    driveOpenWithNarrowFrame(secondSession);
    expect(agentActivityPlaneCoversHost("host-b")).toBe(true);
    expect(agentActivityPlaneCoversHost("host-a")).toBe(false);
  });

  it("the per-user cloud union survives a stream replacement", () => {
    const firstSession = new StubSession();
    const firstClient = new StubHostStreamClient(firstSession, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    const disposeFirst = openAgentActivityStream(
      reconnectEngine,
      firstClient,
      null,
      "host-a",
    );

    driveToOpenAndConnected(firstSession);

    expect(
      useAgentActivityStore.getState().byEpic.get(EPIC_ID)?.working,
    ).toEqual(new Set([AGENT_ID]));

    disposeFirst();

    const secondSession = new StubSession();
    const secondClient = new StubHostStreamClient(
      secondSession,
      "host-stream-2",
    );
    openAgentActivityStream(reconnectEngine, secondClient, null, "host-a");

    // `byEpic` is per-user, not per-stream-epoch: a host switch does not
    // clear it, only the health of the stream that reported it.
    expect(
      useAgentActivityStore.getState().byEpic.get(EPIC_ID)?.working,
    ).toEqual(new Set([AGENT_ID]));
  });
});
