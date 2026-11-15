import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
} from "../i-stream-session";
import {
  WorktreeDeleteStreamClient,
  type WorktreeDeleteStreamClientOptions,
} from "../worktree-delete-stream-client";
import { WsStreamClient } from "../ws-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { FakeStreamClient } from "../__testing__/fake-stream-client";
import {
  completeHandshake,
  makeStubSocketFactory,
  makeStubSocketStreamClient,
  subscribeParams,
} from "../__testing__/stub-stream-socket";

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
    this.statusChangeHandler(status, reason, null, null);
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
    userId: AUTHENTICATED_USER_FIXTURE_ID,
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
        onDroppedAfterStart: () => {},
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
        onDroppedAfterStart: () => {},
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
        onDroppedAfterStart: () => {},
        onConnectionStatus: () => {},
      },
    });
    session.emitFrame({
      kind: "failed",
      reason: "Worktree is in use",
      holders: HOLDERS,
      hasBinaryPayload: false,
    });
    expect(onFailed).toHaveBeenCalledWith(
      "Worktree is in use",
      HOLDERS,
      undefined,
    );
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
        onDroppedAfterStart: () => {},
        onConnectionStatus: () => {},
      },
    });
    session.emitFrame({
      kind: "failed",
      reason: "Worktree is in use",
      hasBinaryPayload: false,
    });
    expect(onFailed).toHaveBeenCalledWith(
      "Worktree is in use",
      undefined,
      undefined,
    );
    client.close();
  });

  it("does not send an expected holder revision and still forwards a legacy HOLDERS_CHANGED code", () => {
    const session = new StubSession();
    const wsStreamClient = makeWsStreamClient(session);
    const onFailed = vi.fn();
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
        onFailed,
        onDroppedAfterStart: () => {},
        onConnectionStatus: () => {},
      },
    });
    expect(wsStreamClient.subscribe).toHaveBeenCalledWith(
      "worktree.deleteByPath",
      {
        worktreePath: "/wt/a",
        scripts: null,
        stopOwners: true,
      },
    );
    session.emitFrame({
      kind: "failed",
      reason: "Holders changed",
      holders: HOLDERS,
      holdersRevision:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      code: "WORKTREE_HOLDERS_CHANGED",
      hasBinaryPayload: false,
    });
    expect(onFailed).toHaveBeenCalledWith(
      "Holders changed",
      HOLDERS,
      "WORKTREE_HOLDERS_CHANGED",
    );
    client.close();
  });

  it("delivers a 1.2 failed frame with an unknown code instead of dropping it", () => {
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
        onDroppedAfterStart: () => {},
        onConnectionStatus: () => {},
      },
    });
    session.emitFrame({
      kind: "failed",
      reason: "Worktree is in use",
      code: "SOME_FUTURE_CODE",
      holders: HOLDERS,
      hasBinaryPayload: false,
    });
    expect(onFailed).toHaveBeenCalledWith(
      "Worktree is in use",
      HOLDERS,
      undefined,
    );
    client.close();
  });
});

describe("WorktreeDeleteStreamClient replay safety", () => {
  function openDelete(
    wsStreamClient: WorktreeDeleteStreamClientOptions["wsStreamClient"],
  ): {
    readonly client: WorktreeDeleteStreamClient;
    readonly onDroppedAfterStart: Mock<() => void>;
    readonly onConnectionStatus: Mock<StatusChangeHandler>;
  } {
    const onDroppedAfterStart = vi.fn<() => void>();
    const onConnectionStatus = vi.fn<StatusChangeHandler>();
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
        onDroppedAfterStart,
        onConnectionStatus,
      },
    });
    return { client, onDroppedAfterStart, onConnectionStatus };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes on a drop after the request went out, so the transport never sends the delete again", () => {
    const { factory, sockets } = makeStubSocketFactory();
    const { client, onDroppedAfterStart } = openDelete(
      makeStubSocketStreamClient(factory),
    );

    completeHandshake(sockets[0]);
    expect(subscribeParams(sockets[0])).toEqual({
      worktreePath: "/wt/a",
      scripts: null,
    });

    sockets[0].fireClose(1006, "abnormal");
    vi.advanceTimersByTime(5_000);

    expect(sockets).toHaveLength(1);
    expect(onDroppedAfterStart).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("keeps the transport's retry when the drop came before the request went out", () => {
    const { factory, sockets } = makeStubSocketFactory();
    const { client, onDroppedAfterStart } = openDelete(
      makeStubSocketStreamClient(factory),
    );

    expect(sockets[0].textSent).toHaveLength(0);
    sockets[0].fireClose(1006, "abnormal");
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);

    completeHandshake(sockets[1]);
    expect(subscribeParams(sockets[1])).toEqual({
      worktreePath: "/wt/a",
      scripts: null,
    });
    expect(onDroppedAfterStart).not.toHaveBeenCalled();
    client.close();
  });

  it("keeps the session while the host holds the subscription", () => {
    const fake = new FakeStreamClient(true);
    const { client, onDroppedAfterStart, onConnectionStatus } =
      openDelete(fake);
    const session = fake.sessions[0];

    session.emitContinuityStatus("reconnecting", "held");

    expect(session.closed).toBe(false);
    expect(onDroppedAfterStart).not.toHaveBeenCalled();
    expect(onConnectionStatus).toHaveBeenLastCalledWith(
      "reconnecting",
      null,
      null,
      "held",
    );
    client.close();
  });
});
