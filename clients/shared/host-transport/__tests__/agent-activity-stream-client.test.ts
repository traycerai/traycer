import { describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
} from "../i-stream-session";
import { AgentActivityStreamClient } from "../agent-activity-stream-client";
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
    bearer: () => null,
    auth: null,
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
  return client;
}

describe("AgentActivityStreamClient", () => {
  it("dispatches frames and status changes, then closes idempotently", () => {
    const session = new StubSession();
    const wsStreamClient = makeWsStreamClient(session);
    const onState = vi.fn();
    const onConnectionStatus = vi.fn();
    const client = new AgentActivityStreamClient({
      wsStreamClient,
      callbacks: { onState, onConnectionStatus },
    });

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
});
