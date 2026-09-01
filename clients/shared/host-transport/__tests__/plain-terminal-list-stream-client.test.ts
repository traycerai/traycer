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
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { WsStreamClient } from "../ws-stream-client";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

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
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    // Required since this branch made transport evidence a construction
    // input rather than an optional hook: every WsStreamClient reports
    // dial outcomes to the selection authority. This suite asserts stream
    // framing, not selection, so it reports into the no-op sink.
    evidence: NO_TRANSPORT_EVIDENCE,
    endpoint: () => null,
    bearer: () => null,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
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
  const onState = vi.fn();
  const onConnectionStatus = vi.fn();
  const client = new PlainTerminalListStreamClient({
    wsStreamClient,
    servingHostId: "host-1",
    scope: { kind: "epic", epicId: "epic-1" },
    callbacks: {
      onState,
      onConnectionStatus,
    },
  });
  return {
    session,
    wsStreamClient,
    onState,
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

  it("routes replacement state frames while treating pong as inert", () => {
    const h = harness();
    const complete = {
      kind: "state" as const,
      hasBinaryPayload: false as const,
      state: {
        coverage: "complete-fleet" as const,
        scope: { kind: "epic" as const, epicId: "epic-1" },
        terminals: [dormant],
      },
    };
    const partial = {
      kind: "state" as const,
      hasBinaryPayload: false as const,
      state: {
        coverage: "partial-serving-host" as const,
        scope: { kind: "epic" as const, epicId: "epic-1" },
        servingHostId: "host-1",
        terminals: [running],
      },
    };

    h.session.emitFrame(complete);
    h.session.emitFrame(partial);
    h.session.emitFrame({ kind: "pong", hasBinaryPayload: false });

    expect(h.onState).toHaveBeenCalledTimes(2);
    expect(h.onState).toHaveBeenNthCalledWith(1, complete);
    expect(h.onState).toHaveBeenNthCalledWith(2, partial);
    h.client.close();
  });

  it("adapts frozen v1 incremental frames into local replacement states", () => {
    const h = harness();
    h.session.negotiatedSchemaVersion = { major: 1, minor: 0 };

    h.session.emitFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      terminals: [dormant],
    });
    h.session.emitFrame({
      kind: "upsert",
      hasBinaryPayload: false,
      terminal: running,
    });
    expect(h.onState).not.toHaveBeenCalled();

    h.session.emitFrame({ kind: "initialized", hasBinaryPayload: false });
    expect(h.onState).toHaveBeenLastCalledWith({
      kind: "state",
      hasBinaryPayload: false,
      state: {
        coverage: "partial-serving-host",
        scope: { kind: "epic", epicId: "epic-1" },
        servingHostId: "host-1",
        terminals: [running],
      },
    });

    h.session.emitFrame({
      kind: "deleted",
      hasBinaryPayload: false,
      terminalId: "terminal-1",
      revision: 8,
    });
    expect(h.onState).toHaveBeenLastCalledWith({
      kind: "state",
      hasBinaryPayload: false,
      state: {
        coverage: "partial-serving-host",
        scope: { kind: "epic", epicId: "epic-1" },
        servingHostId: "host-1",
        terminals: [],
      },
    });
    h.client.close();
  });

  it("warns and drops every malformed collection frame", () => {
    const h = harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const frame of [
        { kind: "state", hasBinaryPayload: false },
        { kind: "snapshot", hasBinaryPayload: false, terminals: [] },
        { kind: "upsert", hasBinaryPayload: false, terminal: running },
        { kind: "initialized", hasBinaryPayload: false },
        {
          kind: "deleted",
          hasBinaryPayload: false,
          terminalId: "terminal-1",
          revision: 1,
        },
        { kind: "pong", hasBinaryPayload: false, extra: true },
        { kind: "reset", hasBinaryPayload: false },
      ]) {
        h.session.emitFrame(frame);
      }

      expect(h.onState).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(7);
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
