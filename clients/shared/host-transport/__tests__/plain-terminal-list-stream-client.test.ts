import { describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
} from "../i-stream-session";
import { PlainTerminalListStreamClient } from "../plain-terminal-list-stream-client";
import { WsStreamClient } from "../ws-stream-client";

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

function projection(
  runtime: PlainTerminalProjection["runtime"],
): PlainTerminalProjection {
  return {
    record: {
      terminalId: "terminal-1",
      hostId: "host-1",
      scope: { kind: "epic", epicId: "epic-1" },
      launch: {
        cwd: "/workspace/project",
        shellCommand: "/bin/zsh",
        shellArgs: ["-l"],
      },
      manualTitle: "Build shell",
      revision: 7,
      createdAt: "2026-08-15T12:00:00.000Z",
      updatedAt: "2026-08-15T12:05:00.000Z",
    },
    runtime,
  };
}

const dormant = projection({ status: "dormant" });
const running = projection({
  status: "running",
  sessionId: "terminal-1",
  currentCwd: "/workspace/project/packages/app",
  activeProcessName: "bun",
  cols: 120,
  rows: 40,
});

function harness() {
  const session = new StubSession();
  const wsStreamClient = makeWsStreamClient(session);
  const onSnapshot = vi.fn();
  const onInitialized = vi.fn();
  const onUpsert = vi.fn();
  const onDeleted = vi.fn();
  const onConnectionStatus = vi.fn();
  const client = new PlainTerminalListStreamClient({
    wsStreamClient,
    scope: { kind: "epic", epicId: "epic-1" },
    callbacks: {
      onSnapshot,
      onInitialized,
      onUpsert,
      onDeleted,
      onConnectionStatus,
    },
  });
  return {
    session,
    wsStreamClient,
    onSnapshot,
    onInitialized,
    onUpsert,
    onDeleted,
    onConnectionStatus,
    client,
  };
}

describe("PlainTerminalListStreamClient", () => {
  it("subscribes to the list method with its exact scope", () => {
    const h = harness();
    expect(h.wsStreamClient.subscribe).toHaveBeenCalledWith(
      "terminal.plain.subscribeList",
      { scope: { kind: "epic", epicId: "epic-1" } },
    );
    h.client.close();
  });

  it("routes snapshot, initialization, upsert, and deleted frames while treating pong as inert", () => {
    const h = harness();
    const snapshot = {
      kind: "snapshot" as const,
      hasBinaryPayload: false as const,
      terminals: [dormant],
    };
    const upsert = {
      kind: "upsert" as const,
      hasBinaryPayload: false as const,
      terminal: running,
    };
    const deleted = {
      kind: "deleted" as const,
      hasBinaryPayload: false as const,
      terminalId: "terminal-1",
      revision: 8,
    };

    h.session.emitFrame(snapshot);
    h.session.emitFrame({ kind: "initialized", hasBinaryPayload: false });
    h.session.emitFrame(upsert);
    h.session.emitFrame(deleted);
    h.session.emitFrame({ kind: "pong", hasBinaryPayload: false });

    expect(h.onSnapshot).toHaveBeenCalledOnce();
    expect(h.onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(h.onInitialized).toHaveBeenCalledOnce();
    expect(h.onUpsert).toHaveBeenCalledOnce();
    expect(h.onUpsert).toHaveBeenCalledWith(upsert);
    expect(h.onDeleted).toHaveBeenCalledOnce();
    expect(h.onDeleted).toHaveBeenCalledWith(deleted);
    h.client.close();
  });

  it("warns and drops every malformed collection frame", () => {
    const h = harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const frame of [
        { kind: "snapshot", hasBinaryPayload: false },
        { kind: "upsert", hasBinaryPayload: false },
        { kind: "initialized", hasBinaryPayload: false, extra: true },
        {
          kind: "deleted",
          hasBinaryPayload: false,
          terminalId: "terminal-1",
          revision: -1,
        },
        { kind: "pong", hasBinaryPayload: false, extra: true },
        { kind: "reset", hasBinaryPayload: false },
      ]) {
        h.session.emitFrame(frame);
      }

      expect(h.onSnapshot).not.toHaveBeenCalled();
      expect(h.onInitialized).not.toHaveBeenCalled();
      expect(h.onUpsert).not.toHaveBeenCalled();
      expect(h.onDeleted).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(6);
    } finally {
      warn.mockRestore();
      h.client.close();
    }
  });

  it("propagates connection status and closes its session idempotently", () => {
    const h = harness();
    const reason: StreamCloseReason = { kind: "caller" };
    h.session.emitStatus("reconnecting", null);
    h.session.emitStatus("closed", reason);

    expect(h.onConnectionStatus).toHaveBeenNthCalledWith(
      1,
      "reconnecting",
      null,
    );
    expect(h.onConnectionStatus).toHaveBeenNthCalledWith(2, "closed", reason);

    h.client.close();
    h.client.close();
    expect(h.session.close).toHaveBeenCalledTimes(1);
  });
});
