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
    openAgentActivityStream(reconnectEngine, secondClient, null);

    expect(useAgentActivityStore.getState().connectionStatus).toBe(
      "connecting",
    );
    expect(useAgentActivityStore.getState().cloudSyncStatus).toBeNull();
  });

  it("the retired epoch leaves no live claim behind", () => {
    const session = new StubSession();
    const client = new StubHostStreamClient(session, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    const dispose = openAgentActivityStream(reconnectEngine, client, null);

    driveToOpenAndConnected(session);

    expect(useAgentActivityStore.getState().connectionStatus).toBe("open");
    expect(useAgentActivityStore.getState().cloudSyncStatus).toBe("connected");

    dispose();

    expect(useAgentActivityStore.getState().connectionStatus).toBe(
      "connecting",
    );
    expect(useAgentActivityStore.getState().cloudSyncStatus).toBeNull();
  });

  it("the per-user cloud union survives a stream replacement", () => {
    const firstSession = new StubSession();
    const firstClient = new StubHostStreamClient(firstSession, "host-stream-1");
    const reconnectEngine = createStubReconnectEngine();

    const disposeFirst = openAgentActivityStream(
      reconnectEngine,
      firstClient,
      null,
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
    openAgentActivityStream(reconnectEngine, secondClient, null);

    // `byEpic` is per-user, not per-stream-epoch: a host switch does not
    // clear it, only the health of the stream that reported it.
    expect(
      useAgentActivityStore.getState().byEpic.get(EPIC_ID)?.working,
    ).toEqual(new Set([AGENT_ID]));
  });
});
