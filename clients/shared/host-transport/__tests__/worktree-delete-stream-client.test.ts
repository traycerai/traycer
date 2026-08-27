import { describe, expect, it, vi } from "vitest";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
} from "../i-stream-session";
import { WorktreeDeleteStreamClient } from "../worktree-delete-stream-client";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

const HOLDERS: readonly WorktreeBusyHolder[] = [
  {
    ownerRef: {
      epicId: "epic-1",
      ownerKind: "terminal-agent",
      ownerId: "tui-1",
    },
    holdKind: "terminal-agent-pty",
    activity: "working",
    label: "Claude Code agent polite-ocelot is working",
  },
];

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

describe("WorktreeDeleteStreamClient", () => {
  it("omits stopOwners on the open request when false so a 1.0 subscribe stays identical", () => {
    const session = new StubSession();
    const wsStreamClient = makeWsStreamClient(session);
    const client = new WorktreeDeleteStreamClient({
      wsStreamClient,
      worktreePath: "/wt/a",
      scripts: null,
      stopOwners: false,
      callbacks: {
        onStarted: () => {},
        onPhase: () => {},
        onOutput: () => {},
        onComplete: () => {},
        onFailed: () => {},
        onConnectionStatus: () => {},
      },
    });
    expect(wsStreamClient.subscribe).toHaveBeenCalledWith(
      "worktree.deleteByPath",
      { worktreePath: "/wt/a", scripts: null },
    );
    client.close();
  });

  it("sends stopOwners: true on the open request when asked to stop holders", () => {
    const session = new StubSession();
    const wsStreamClient = makeWsStreamClient(session);
    const client = new WorktreeDeleteStreamClient({
      wsStreamClient,
      worktreePath: "/wt/a",
      scripts: null,
      stopOwners: true,
      callbacks: {
        onStarted: () => {},
        onPhase: () => {},
        onOutput: () => {},
        onComplete: () => {},
        onFailed: () => {},
        onConnectionStatus: () => {},
      },
    });
    expect(wsStreamClient.subscribe).toHaveBeenCalledWith(
      "worktree.deleteByPath",
      { worktreePath: "/wt/a", scripts: null, stopOwners: true },
    );
    client.close();
  });

  it("forwards typed holders from a 1.1 failed frame", () => {
    const session = new StubSession();
    const wsStreamClient = makeWsStreamClient(session);
    const onFailed = vi.fn();
    const client = new WorktreeDeleteStreamClient({
      wsStreamClient,
      worktreePath: "/wt/a",
      scripts: null,
      stopOwners: false,
      callbacks: {
        onStarted: () => {},
        onPhase: () => {},
        onOutput: () => {},
        onComplete: () => {},
        onFailed,
        onConnectionStatus: () => {},
      },
    });
    session.emitFrame({
      kind: "failed",
      reason: "Worktree is in use",
      holders: HOLDERS,
      hasBinaryPayload: false,
    });
    expect(onFailed).toHaveBeenCalledWith("Worktree is in use", HOLDERS);
    client.close();
  });

  it("leaves holders undefined when a failed frame omits them", () => {
    const session = new StubSession();
    const wsStreamClient = makeWsStreamClient(session);
    const onFailed = vi.fn();
    const client = new WorktreeDeleteStreamClient({
      wsStreamClient,
      worktreePath: "/wt/a",
      scripts: null,
      stopOwners: false,
      callbacks: {
        onStarted: () => {},
        onPhase: () => {},
        onOutput: () => {},
        onComplete: () => {},
        onFailed,
        onConnectionStatus: () => {},
      },
    });
    session.emitFrame({
      kind: "failed",
      reason: "Worktree is in use",
      hasBinaryPayload: false,
    });
    expect(onFailed).toHaveBeenCalledWith("Worktree is in use", undefined);
    client.close();
  });
});
