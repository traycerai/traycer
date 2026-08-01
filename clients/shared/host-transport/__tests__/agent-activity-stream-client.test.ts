import { describe, expect, it, vi } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
} from "../i-stream-session";
import { AgentActivityStreamClient } from "../agent-activity-stream-client";
import { WsStreamClient } from "../ws-stream-client";

class StubSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler = () => undefined;
  private statusChangeHandler: StatusChangeHandler = () => undefined;

  readonly close = vi.fn();

  sendClientFrame(): void {}

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
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
    registry: hostStreamRpcRegistry,
    endpoint: () => null,
    bearer: () => null,
    auth: null,
    hostCredentialMint: null,
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
    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    const onConnectionStatus = vi.fn();
    const client = new AgentActivityStreamClient({
      wsStreamClient,
      callbacks: { onSnapshot, onUpdate, onConnectionStatus },
    });

    expect(wsStreamClient.subscribe).toHaveBeenCalledWith(
      "agent.activity.subscribe",
      {},
    );

    const snapshot = {
      "epic-1": { working: ["agent-1"], turn: ["agent-1"] },
    };
    const update = {
      "epic-1": { working: ["agent-1", "agent-2"], turn: ["agent-2"] },
    };
    session.emitFrame({
      kind: "snapshot",
      byEpic: snapshot,
      hasBinaryPayload: false,
    });
    session.emitFrame({
      kind: "update",
      byEpic: update,
      hasBinaryPayload: false,
    });

    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(onUpdate).toHaveBeenCalledWith(update);

    const reason: StreamCloseReason = { kind: "caller" };
    session.emitStatus("closed", reason);
    expect(onConnectionStatus).toHaveBeenCalledWith("closed", reason);

    client.close();
    client.close();
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});
