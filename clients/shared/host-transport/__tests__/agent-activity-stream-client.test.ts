import { describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
} from "../i-stream-session";
import type { IHostStreamClient } from "../host-stream-client";
import {
  AGENT_ACTIVITY_LOCAL_ONLY_MINOR,
  AgentActivityStreamClient,
} from "../agent-activity-stream-client";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

class StubSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler = () => undefined;
  private statusChangeHandler: StatusChangeHandler = () => undefined;
  /** Settable so a test can model this session's own negotiated minor. */
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

  emitFrame(frame: Parameters<ServerFrameHandler>[0]): void {
    this.serverFrameHandler(frame, null);
  }

  emitStatus(
    status: Parameters<StatusChangeHandler>[0],
    reason: StreamCloseReason | null,
  ): void {
    this.statusChangeHandler(status, reason);
  }
}

function makeWsStreamClient(
  session: IStreamSession,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const client = new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => null,
    hostId: null,
    bearer: () => null,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: {
      create: () => {
        throw new Error("unexpected WebSocket creation");
      },
    },
    dialTimeoutMs: 1_000,
    openAckTimeoutMs: 1_000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1_000,
  });
  vi.spyOn(client, "subscribe").mockReturnValue(session);
  vi.spyOn(client, "subscribeAtVersion").mockReturnValue(session);
  return client;
}

/**
 * A transport that structurally omits `subscribeAtVersion` altogether (the
 * method stays OPTIONAL on `IStreamClient` for exactly a transport like this
 * one) - the constructor's pre-send guard for a SELECTED plane against such a
 * transport, distinct from a transport that has the method but whose peer
 * refuses the version (case 1's dispatch-time path, not this constructor-time
 * one).
 */
function makeTransportWithoutVersionPin(): IHostStreamClient<
  typeof hostStreamRpcRegistry
> {
  return {
    subscribe: () => {
      throw new Error("unexpected subscribe on a version-pin-less transport");
    },
    subscribeWithParamsProvider: () => {
      throw new Error(
        "unexpected subscribeWithParamsProvider on a version-pin-less transport",
      );
    },
    getMethodSchemaVersion: () => null,
    close: () => undefined,
    isClosed: () => false,
    getClosedReason: () => null,
    onClosed: () => () => undefined,
    instanceId: "stub-transport-no-version-pin",
    notifyBearerRotated: () => undefined,
    // Arrived with another lane's cloud-capability verdict work, which added
    // it as a REQUIRED member of `IHostStreamClient` after this literal was
    // written. Neither lane's compile could see the break: this fixture
    // post-dates their interface read, and their widening post-dates ours.
    notifyCloudVerdictChanged: () => undefined,
    reconnectAll: () => undefined,
    isReady: () => true,
    getMethodSupport: () => "unknown",
    subscribeMethodSupport: () => () => undefined,
    subscribeAvailabilityRecovered: () => () => undefined,
  };
}

describe("AgentActivityStreamClient", () => {
  it("dispatches frames and status changes, then closes idempotently", () => {
    const session = new StubSession();
    const wsStreamClient = makeWsStreamClient(session);
    const onState = vi.fn();
    const onConnectionStatus = vi.fn();
    const client = new AgentActivityStreamClient({
      wsStreamClient,
      plane: null,
      callbacks: { onState, onConnectionStatus },
    });

    // `null` leaves the plane to the host, and must put NO key on the wire:
    // `plane` is an optional enum, so a literal `null` would fail the host's
    // parse rather than read as "no preference".
    expect(wsStreamClient.subscribe).toHaveBeenCalledWith(
      "agent.activity.subscribe",
      {},
    );

    const localState = {
      "epic-1": { working: ["agent-1"], turn: ["agent-1"] },
    };
    const cloudState = {
      "epic-1": { working: ["agent-1", "agent-2"], turn: ["agent-2"] },
    };
    session.emitFrame({
      kind: "state",
      servedBy: "local",
      byEpic: localState,
      hasBinaryPayload: false,
    });
    session.emitFrame({
      kind: "state",
      servedBy: "cloud",
      byEpic: cloudState,
      hasBinaryPayload: false,
    });

    // Neither fixture frame carries `cloudSyncStatus` (a `1.0` host's shape):
    // the live schema defaults it to `null` - no claim - never "connected".
    expect(onState).toHaveBeenNthCalledWith(1, "local", localState, null);
    expect(onState).toHaveBeenNthCalledWith(2, "cloud", cloudState, null);

    const reason: StreamCloseReason = { kind: "caller" };
    session.emitStatus("closed", reason);
    expect(onConnectionStatus).toHaveBeenCalledWith("closed", reason);

    client.close();
    client.close();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("pins a selected plane to the local-only minor via subscribeAtVersion, never plain subscribe", () => {
    const session = new StubSession();
    const wsStreamClient = makeWsStreamClient(session);
    const onState = vi.fn();
    const onConnectionStatus = vi.fn();

    new AgentActivityStreamClient({
      wsStreamClient,
      plane: "local-only",
      callbacks: { onState, onConnectionStatus },
    });

    // The version object itself is the pin: a call that named the right
    // method but the wrong minor would still read as "subscribeAtVersion was
    // used" on a looser assertion.
    expect(wsStreamClient.subscribeAtVersion).toHaveBeenCalledWith(
      "agent.activity.subscribe",
      { major: 1, minor: AGENT_ACTIVITY_LOCAL_ONLY_MINOR },
      { plane: "local-only" },
    );
    expect(wsStreamClient.subscribe).not.toHaveBeenCalled();
  });

  it("leaves an unselected plane on plain subscribe with an empty open request - the pin is scoped, not unconditional", () => {
    // Non-vacuity for the case above: the only variable that moved is
    // `plane`, and the pinned path stands down in favour of the exact
    // pre-existing call this suite's first case already asserts on.
    const session = new StubSession();
    const wsStreamClient = makeWsStreamClient(session);
    const onState = vi.fn();
    const onConnectionStatus = vi.fn();

    new AgentActivityStreamClient({
      wsStreamClient,
      plane: null,
      callbacks: { onState, onConnectionStatus },
    });

    expect(wsStreamClient.subscribe).toHaveBeenCalledWith(
      "agent.activity.subscribe",
      {},
    );
    expect(wsStreamClient.subscribeAtVersion).not.toHaveBeenCalled();
  });

  it("throws at construction when a selected plane meets a transport with no subscribeAtVersion", () => {
    const wsStreamClient = makeTransportWithoutVersionPin();
    const onState = vi.fn();
    const onConnectionStatus = vi.fn();

    expect(
      () =>
        new AgentActivityStreamClient({
          wsStreamClient,
          plane: "local-only",
          callbacks: { onState, onConnectionStatus },
        }),
    ).toThrow("This stream transport cannot pin a schema version");
  });
});
