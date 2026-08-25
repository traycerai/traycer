import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import type { ChatSubscribeClientFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import { mockLocalHostEntry } from "../../host-client/mock/mock-host-directory";
import { createAuthenticatedUserFixture } from "../../test-fixtures/authenticated-user";
import type {
  WebSocketCloseEvent,
  WebSocketErrorEvent,
  WebSocketOpenEvent,
} from "../ws-factory";
import type {
  IStreamWebSocketFactory,
  StreamWebSocketLike,
  StreamWebSocketMessageEvent,
} from "../ws-stream-factory";
import { WsStreamClient } from "../ws-stream-client";
import type { IStreamClient } from "../i-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StreamFrameEnvelope,
} from "../i-stream-session";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  ChatStreamClient,
  type ChatStreamCallbacks,
} from "../chat-stream-client";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

class StubStreamWebSocket implements StreamWebSocketLike {
  onopen: ((event: WebSocketOpenEvent) => void) | null = null;
  onmessage: ((event: StreamWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: WebSocketErrorEvent) => void) | null = null;
  onclose: ((event: WebSocketCloseEvent) => void) | null = null;

  readonly textSent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.textSent.push(data);
    }
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.onopen?.({ type: "open" });
  }

  fireText(data: unknown): void {
    this.onmessage?.({ type: "text", data: JSON.stringify(data) });
  }
}

function makeFactory(): {
  readonly factory: IStreamWebSocketFactory;
  readonly sockets: StubStreamWebSocket[];
} {
  const sockets: StubStreamWebSocket[] = [];
  const factory: IStreamWebSocketFactory = {
    create(): StreamWebSocketLike {
      const socket = new StubStreamWebSocket();
      sockets.push(socket);
      return socket;
    },
  };
  return { factory, sockets };
}

function makeWsStreamClient(
  factory: IStreamWebSocketFactory,
): WsStreamClient<typeof hostStreamRpcRegistry> {
  const ctx = makeRequestContext("token");
  return new WsStreamClient({
    clientIdentity: TEST_CLIENT_IDENTITY,
    registry: hostStreamRpcRegistry,
    endpoint: () => mockLocalHostEntry,
    bearer: () => ctx?.credentials ?? null,
    auth: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: factory,
    dialTimeoutMs: 1000,
    openAckTimeoutMs: 1000,
    pingIntervalMs: 25_000,
    pongTimeoutMs: 50_000,
    initialBackoffMs: 10,
    maxBackoffMs: 1000,
  });
}

function makeRequestContext(bearer: string): RequestContext {
  const fixture = createAuthenticatedUserFixture(undefined);
  return createRequestContext({
    identity: identityFromAuthenticatedUser(fixture),
    bearerToken: bearer,
    origin: "renderer",
    connectionId: undefined,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
}

function completeHandshake(socket: StubStreamWebSocket): void {
  socket.fireOpen();
  const openParsed = JSON.parse(socket.textSent[0]) as {
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({
    kind: "openAck",
    manifest: openParsed.manifest,
  });
}

/**
 * Same handshake as `completeHandshake`, except the echoed manifest's
 * `chat.subscribe` entry is overridden to `schemaVersion` instead of being
 * echoed back verbatim. `WsStreamClient` negotiates to the OLDER of the
 * client's own canonical version and whatever the host's `openAck` manifest
 * advertises (`prepareStreamSubscribeRequest` in `ws-stream-client.ts`), so
 * this is how a black-box test forces a down-negotiated session without
 * touching production code.
 */
function completeHandshakeAtVersion(
  socket: StubStreamWebSocket,
  schemaVersion: { readonly major: number; readonly minor: number },
): void {
  socket.fireOpen();
  const openParsed = JSON.parse(socket.textSent[0]) as {
    readonly manifest: Record<string, { major: number; minor: number }>;
  };
  socket.fireText({
    kind: "openAck",
    manifest: {
      ...openParsed.manifest,
      "chat.subscribe": schemaVersion,
    },
  });
}

/**
 * A `chat.subscribe@1.5`-shaped assistant message: no `imageResolutions` key
 * at all, matching how a pre-image host actually persisted/emitted it (see
 * `chat-subscribe.test.ts`'s "stays frozen without image fields on every
 * released minor 1.0-1.5"). Only the deep schema's compatibility default
 * (`imageResolutions: []`) up-converts this; the shallow schema is
 * structural-only and leaves it exactly as sent.
 */
function frozenPreImageAssistantMessage(): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "agent-1",
      displayName: "Coder",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        blockId: "text-1",
        status: "completed",
        timestamp: 10,
        parentBlockId: null,
        type: "text",
        text: "hello",
      },
    ],
    startedAt: 10,
    timestamp: 20,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    // Deliberately no `imageResolutions` key.
  };
}

function snapshotFrameWithAssistantMessage(
  assistantMessage: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat: {
        id: "chat-1",
        parentId: null,
        userId: "owner-1",
        hostId: "test-host",
        title: "Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        sessionRef: null,
        messages: [assistantMessage],
        events: [],
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
    },
  };
}

function parseText(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object text frame");
  }
  return value as Record<string, unknown>;
}

describe("ChatStreamClient", () => {
  it("subscribes to chat.subscribe and dispatches typed frames", () => {
    const { factory, sockets } = makeFactory();
    const snapshots: string[] = [];
    const worktreeBindings: Array<{
      readonly hasWorktree: boolean;
      readonly entryCount: number;
    } | null> = [];
    const fileEditApprovalFrames: string[] = [];
    const interviewFrames: string[] = [];
    const restoreFrames: string[] = [];
    // Collected as whole sets, because that is what the frame carries - there
    // is no per-command delta to accumulate.
    const managedCommandSets: string[][] = [];
    const heldUpdateSets: string[][] = [];
    const callbacks: ChatStreamCallbacks = {
      ...NOOP_WINDOWED_CALLBACKS,
      onSnapshot: (frame) => {
        snapshots.push(frame.snapshot.chat.id);
      },
      onActionAck: () => undefined,
      onMessageAccepted: () => undefined,
      onQueueChanged: () => undefined,
      onTurnStateChanged: () => undefined,
      onBlockDelta: () => undefined,
      onApprovalRequested: () => undefined,
      onApprovalResolved: () => undefined,
      onFileEditApprovalRequested: (frame) => {
        fileEditApprovalFrames.push(frame.approval.approvalId);
      },
      onFileEditApprovalResolved: (frame) => {
        fileEditApprovalFrames.push(frame.approvalId);
      },
      onInterviewRequested: (frame) => {
        interviewFrames.push(`${frame.kind}:${frame.blockId}`);
      },
      onInterviewAnswered: (frame) => {
        interviewFrames.push(`${frame.kind}:${frame.blockId}`);
      },
      onInterviewErrored: (frame) => {
        interviewFrames.push(`${frame.kind}:${frame.blockId}`);
      },
      onEventAppended: () => undefined,
      onRestoreStarted: (frame) => {
        restoreFrames.push(frame.kind);
      },
      onRestoreProgress: (frame) => {
        restoreFrames.push(frame.kind);
      },
      onRestoreCompleted: (frame) => {
        restoreFrames.push(frame.kind);
      },
      onErrorNotice: () => undefined,
      onWorktreeStateChanged: (frame) => {
        worktreeBindings.push(
          frame.worktreeBinding === null
            ? null
            : {
                hasWorktree: frame.worktreeBinding.entries.some(
                  (e) => e.mode === "worktree",
                ),
                entryCount: frame.worktreeBinding.entries.length,
              },
        );
      },
      onManagedCommandsChanged: (frame) => {
        managedCommandSets.push(
          frame.managedCommands.map((command) => command.id),
        );
      },
      onHeldUpdatesChanged: (frame) => {
        heldUpdateSets.push(frame.heldUpdates.map((held) => held.commandId));
      },
      onConnectionStatus: () => undefined,
    };

    const client = new ChatStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks,
    });
    completeHandshake(sockets[0]);

    // The advertised version tracks the registry's canonical chat.subscribe
    // line - a literal here rots every time a minor lands.
    expect(parseText(sockets[0].textSent[1])).toEqual({
      kind: "subscribe",
      method: "chat.subscribe",
      schemaVersion: buildStreamManifest(hostStreamRpcRegistry)[
        "chat.subscribe"
      ],
      params: { epicId: "epic-1", chatId: "chat-1" },
    });

    sockets[0].fireText({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat: {
          id: "chat-1",
          parentId: null,
          userId: "owner-1",
          hostId: "test-host",
          title: "Chat",
          createdAt: 1,
          updatedAt: 1,
          isTitleEditedByUser: false,
          sessionRef: null,
          messages: [],
          events: [],
        },
        access: { role: "owner", ownerUserId: "owner-1", canAct: true },
        queue: { status: "idle", items: [] },
        runStatus: "idle",
        activeTurn: null,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChanges: [],
      },
    });

    sockets[0].fireText({
      kind: "worktreeStateChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      missingWorktreePaths: [],
      worktreeBinding: {
        entries: [
          {
            workspacePath: "/repo",
            mode: "worktree",
            repoIdentifier: { owner: "acme", repo: "app" },
            worktreePath: "/repo-wt",
            branch: "feat/x",
            isPrimary: true,
            isImported: false,
            setupState: "running",
            setupTerminalSessionId: "term-1",
            setupExitCode: null,
            setupFailedAt: null,
            createdAt: 10,
            ownedSubmodules: [],
          },
        ],
      },
    });

    sockets[0].fireText({
      kind: "managedCommandsChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      managedCommands: [
        {
          id: "cmd-1",
          monitoring: true,
          description: "deploy watcher",
          status: { state: "running", pid: 4410, startedAtMs: 10 },
          chatId: "chat-1",
          createdAtMs: 10,
          updatedAtMs: 10,
        },
      ],
    });
    // The set going empty is how a chat's last command goes away; a frame that
    // omits the field entirely is what a host sends when it has none, and the
    // schema's default has to make both read identically here.
    sockets[0].fireText({
      kind: "managedCommandsChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
    });

    // Routed to `onHeldUpdatesChanged` and nothing else - this frame was a
    // deliberate no-op until the Deliver affordance landed, and the switch it
    // rides has no exhaustiveness guard, so only this assertion catches a
    // regression back to silently dropping it.
    sockets[0].fireText({
      kind: "heldUpdatesChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      heldUpdates: [
        {
          commandId: "cmd-held-1",
          description: "deploy watcher",
          heldAtMs: 10,
        },
      ],
    });

    sockets[0].fireText({
      kind: "fileEditApprovalRequested",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      approval: {
        approvalId: "file-approval-1",
        toolName: "apply_patch",
        description: "Edit source files",
        paths: ["/repo/src/app.ts"],
        operation: "edit",
        input: null,
        requestedAt: 2,
      },
    });
    sockets[0].fireText({
      kind: "fileEditApprovalResolved",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      approvalId: "file-approval-1",
      decision: { approved: true },
      resolvedAt: 3,
    });
    sockets[0].fireText({
      kind: "interviewRequested",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "question-1",
      requestedAt: 4,
    });
    sockets[0].fireText({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "question-1",
      answers: [],
      resolvedAt: 5,
    });
    sockets[0].fireText({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "question-2",
      reason: "Skipped",
      resolvedAt: 6,
    });

    sockets[0].fireText({
      kind: "restoreStarted",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      checkpointId: "turn-1",
      restoringUserId: "owner-1",
      restoringHostId: "host-1",
      startedAt: 2,
    });
    sockets[0].fireText({
      kind: "restoreProgress",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      checkpointId: "turn-1",
      processedCount: 1,
      totalCount: 2,
    });
    sockets[0].fireText({
      kind: "restoreCompleted",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      checkpointId: "turn-1",
      finishedAt: 3,
      results: [
        {
          filePath: "/repo/src/app.ts",
          status: "restored",
          operation: "edit",
          reason: null,
        },
      ],
    });

    const frame: ChatSubscribeClientFrame = {
      kind: "resumeQueue",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
    };
    client.sendAction(frame);

    expect(snapshots).toEqual(["chat-1"]);
    expect(worktreeBindings).toEqual([{ hasWorktree: true, entryCount: 1 }]);
    expect(fileEditApprovalFrames).toEqual([
      "file-approval-1",
      "file-approval-1",
    ]);
    expect(interviewFrames).toEqual([
      "interviewRequested:question-1",
      "interviewAnswered:question-1",
      "interviewErrored:question-2",
    ]);
    expect(restoreFrames).toEqual([
      "restoreStarted",
      "restoreProgress",
      "restoreCompleted",
    ]);
    expect(managedCommandSets).toEqual([["cmd-1"], []]);
    expect(heldUpdateSets).toEqual([["cmd-held-1"]]);
    expect(parseText(sockets[0].textSent[2])).toEqual(frame);

    client.close();
    expect(sockets[0].closed).toEqual({
      code: 1000,
      reason: "closed-by-caller",
    });
  });
});

/**
 * The five windowed callbacks as no-ops, for the tests that are not about
 * them. Spread rather than repeated so adding a sixth is one edit here, not
 * one per literal.
 */
const NOOP_WINDOWED_CALLBACKS = {
  onWindowedSnapshot: () => undefined,
  onSkeletonChunk: () => undefined,
  onIndexChanged: () => undefined,
  onRange: () => undefined,
  onAccumulatedChanges: () => undefined,
} satisfies Pick<
  ChatStreamCallbacks,
  | "onWindowedSnapshot"
  | "onSkeletonChunk"
  | "onIndexChanged"
  | "onRange"
  | "onAccumulatedChanges"
>;

describe("ChatStreamClient shallow-vs-deep snapshot parse gating", () => {
  function makeNoopCallbacks(
    onSnapshot: ChatStreamCallbacks["onSnapshot"],
  ): ChatStreamCallbacks {
    return {
      ...NOOP_WINDOWED_CALLBACKS,
      onSnapshot,
      onActionAck: () => undefined,
      onMessageAccepted: () => undefined,
      onQueueChanged: () => undefined,
      onTurnStateChanged: () => undefined,
      onBlockDelta: () => undefined,
      onApprovalRequested: () => undefined,
      onApprovalResolved: () => undefined,
      onFileEditApprovalRequested: () => undefined,
      onFileEditApprovalResolved: () => undefined,
      onInterviewRequested: () => undefined,
      onInterviewAnswered: () => undefined,
      onInterviewErrored: () => undefined,
      onEventAppended: () => undefined,
      onRestoreStarted: () => undefined,
      onRestoreProgress: () => undefined,
      onRestoreCompleted: () => undefined,
      onErrorNotice: () => undefined,
      onWorktreeStateChanged: () => undefined,
      onManagedCommandsChanged: () => undefined,
      onHeldUpdatesChanged: () => undefined,
      onConnectionStatus: () => undefined,
    };
  }

  it("takes the deep parse path and up-converts a down-negotiated (1.5) snapshot's pre-image assistant message", () => {
    const { factory, sockets } = makeFactory();
    const deliveredMessages: unknown[] = [];

    const client = new ChatStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: makeNoopCallbacks((frame) => {
        deliveredMessages.push(...frame.snapshot.chat.messages);
      }),
    });
    completeHandshakeAtVersion(sockets[0], { major: 1, minor: 5 });

    sockets[0].fireText(
      snapshotFrameWithAssistantMessage(frozenPreImageAssistantMessage()),
    );

    expect(deliveredMessages).toHaveLength(1);
    const [assistant] = deliveredMessages;
    // The deep schema's compatibility default filled the field the frozen
    // 1.5 wire shape never carried - proof the deep parse ran, not the
    // structural-only shallow one, which would have left it absent.
    expect(assistant).toMatchObject({
      messageId: "assistant-1",
      imageResolutions: [],
    });

    client.close();
  });

  it("takes the shallow parse path and passes a live (1.6) snapshot's message through structurally unchanged", () => {
    const { factory, sockets } = makeFactory();
    const deliveredMessages: unknown[] = [];

    const client = new ChatStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: makeNoopCallbacks((frame) => {
        deliveredMessages.push(...frame.snapshot.chat.messages);
      }),
    });
    // Default handshake echoes the client's own manifest verbatim, which
    // negotiates to the client's canonical chat.subscribe version - today
    // exactly `chatSubscribeLiveSchemaVersion` ({major:1, minor:6}).
    completeHandshake(sockets[0]);

    sockets[0].fireText(
      snapshotFrameWithAssistantMessage(frozenPreImageAssistantMessage()),
    );

    expect(deliveredMessages).toHaveLength(1);
    const [assistant] = deliveredMessages;
    // No deep parse ran, so no compatibility default filled the field: the
    // structural-only shallow schema hands the message through exactly as
    // sent, `imageResolutions` genuinely absent.
    expect(assistant).not.toHaveProperty("imageResolutions");
    expect(assistant).toMatchObject({ messageId: "assistant-1" });

    client.close();
  });
});

/**
 * # Driving the windowed line before it is negotiable
 *
 * These tests inject the session rather than handshaking through
 * `WsStreamClient`, and the reason is structural rather than convenience.
 *
 * `prepareStreamSubscribeRequest` declares MY canonical version whenever the
 * peer's is newer (`myCanonical.minor <= theirCanonical.minor` →
 * `onWireVersion: myCanonical`), and that value is what the session reports as
 * negotiated. `chatSubscribeV17` is deliberately not in the registry, so this
 * client's canonical `chat.subscribe` is `1.6` — which means a host advertising
 * `1.7` negotiates **1.6**, and no handshake this test can perform will ever
 * make `getNegotiatedSchemaVersion()` return `1.7`. That is correct negotiation
 * and it is exactly why the windowed producer is unreachable today; it also
 * means a handshake-driven test of this path is not merely awkward but
 * impossible until the switch is thrown.
 *
 * `IStreamClient` is the documented seam for standing a different transport in
 * (`RemoteStreamClient` does), so a stub here tests the unit at a boundary that
 * already exists rather than one invented for the test.
 */
class StubStreamSession implements IStreamSession {
  private serverFrameHandler: ServerFrameHandler | null = null;
  readonly sentFrames: StreamFrameEnvelope[] = [];
  closed = false;

  constructor(private readonly version: SchemaVersion | null) {}

  sendClientFrame(
    envelope: StreamFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ): void {
    void binaryPayload;
    this.sentFrames.push(envelope);
  }

  onServerFrame(handler: ServerFrameHandler): void {
    this.serverFrameHandler = handler;
  }

  onStatusChange(): void {}

  requestReconnect(): void {}

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.version;
  }

  close(): void {
    this.closed = true;
  }

  deliver(envelope: StreamFrameEnvelope): void {
    this.serverFrameHandler?.(envelope, null);
  }
}

function stubClientAtVersion(version: SchemaVersion | null): {
  readonly wsStreamClient: IStreamClient<typeof hostStreamRpcRegistry>;
  readonly session: StubStreamSession;
} {
  const session = new StubStreamSession(version);
  const wsStreamClient: IStreamClient<typeof hostStreamRpcRegistry> = {
    subscribe: () => session,
    subscribeWithParamsProvider: () => session,
    getMethodSchemaVersion: () => version,
  };
  return { wsStreamClient, session };
}

interface RecordedWindowedFrames {
  readonly snapshots: unknown[];
  readonly skeletonChunks: unknown[];
  readonly indexChanges: unknown[];
  readonly ranges: unknown[];
  readonly accumulatedChanges: unknown[];
  readonly legacySnapshots: unknown[];
  readonly blockDeltas: unknown[];
}

function recordingCallbacks(): {
  readonly callbacks: ChatStreamCallbacks;
  readonly recorded: RecordedWindowedFrames;
} {
  const recorded: RecordedWindowedFrames = {
    snapshots: [],
    skeletonChunks: [],
    indexChanges: [],
    ranges: [],
    accumulatedChanges: [],
    legacySnapshots: [],
    blockDeltas: [],
  };
  const callbacks: ChatStreamCallbacks = {
    onSnapshot: (frame) => {
      recorded.legacySnapshots.push(frame.snapshot.chat.id);
    },
    onWindowedSnapshot: (frame) => {
      recorded.snapshots.push(frame.snapshot.transcriptEpoch);
    },
    onSkeletonChunk: (frame) => {
      recorded.skeletonChunks.push(frame.chunk.fromOrdinal);
    },
    onIndexChanged: (frame) => {
      recorded.indexChanges.push(frame.rowCount);
    },
    onRange: (frame) => {
      recorded.ranges.push(frame.range.requestId);
    },
    onAccumulatedChanges: (frame) => {
      recorded.accumulatedChanges.push(frame.chunk.fromIndex);
    },
    onActionAck: () => undefined,
    onMessageAccepted: () => undefined,
    onQueueChanged: () => undefined,
    onTurnStateChanged: () => undefined,
    onBlockDelta: (frame) => {
      recorded.blockDeltas.push(frame.event.type);
    },
    onApprovalRequested: () => undefined,
    onApprovalResolved: () => undefined,
    onFileEditApprovalRequested: () => undefined,
    onFileEditApprovalResolved: () => undefined,
    onInterviewRequested: () => undefined,
    onInterviewAnswered: () => undefined,
    onInterviewErrored: () => undefined,
    onEventAppended: () => undefined,
    onRestoreStarted: () => undefined,
    onRestoreProgress: () => undefined,
    onRestoreCompleted: () => undefined,
    onErrorNotice: () => undefined,
    onWorktreeStateChanged: () => undefined,
    onManagedCommandsChanged: () => undefined,
    onHeldUpdatesChanged: () => undefined,
    onConnectionStatus: () => undefined,
  };
  return { callbacks, recorded };
}

const WINDOWED_VERSION: SchemaVersion = { major: 1, minor: 7 };

function windowedChatRecord(): Record<string, unknown> {
  return {
    id: "chat-1",
    parentId: null,
    userId: "owner-1",
    hostId: "test-host",
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    sessionRef: null,
    settings: null,
    archivedAt: null,
    lastDeliveredRolesDigest: null,
  };
}

function windowedSnapshotFrame(): StreamFrameEnvelope {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat: windowedChatRecord(),
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      transcriptEpoch: 3,
      rowCount: 0,
      tail: { fromOrdinal: 0, messages: [], events: [] },
      derived: {
        latestAssistantUsage: null,
        // `pinnedTodo`, singular - the fold's single result, not a list. It is
        // nullable but NOT optional, so a fixture that omits it fails the
        // parse, which is what caught the name here.
        pinnedTodo: null,
        latestForkableAssistantMessageId: null,
        restorableSetupInterruption: null,
      },
    },
  };
}

describe("ChatStreamClient windowed line", () => {
  it("routes all five windowed frames, and shared frames to their existing callbacks", () => {
    const { wsStreamClient, session } = stubClientAtVersion(WINDOWED_VERSION);
    const { callbacks, recorded } = recordingCallbacks();
    const client = new ChatStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks,
    });

    session.deliver(windowedSnapshotFrame());
    session.deliver({
      kind: "skeletonChunk",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      chunk: { epoch: 3, fromOrdinal: 12, entries: [], isFinal: true },
    });
    session.deliver({
      kind: "indexChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      epoch: 3,
      rowCount: 41,
      changes: [{ type: "reindexed" }],
    });
    session.deliver({
      kind: "range",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      range: {
        requestId: "req-7",
        epoch: 3,
        fromOrdinal: 0,
        rowIds: [],
        messages: [],
        events: [],
        reachedStart: true,
        reachedEnd: false,
      },
    });
    session.deliver({
      kind: "accumulatedChanges",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      chunk: { epoch: 3, fromIndex: 5, summaries: [], isFinal: true },
    });
    // A shared frame: same schema on both lines, so it must reach the callback
    // the legacy line already uses rather than needing a windowed twin.
    session.deliver({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      event: {
        type: "text.delta",
        blockId: "block-1",
        timestamp: 1,
        delta: "hi",
      },
    });

    expect(recorded.snapshots).toEqual([3]);
    expect(recorded.skeletonChunks).toEqual([12]);
    expect(recorded.indexChanges).toEqual([41]);
    expect(recorded.ranges).toEqual(["req-7"]);
    expect(recorded.accumulatedChanges).toEqual([5]);
    expect(recorded.blockDeltas).toEqual(["text.delta"]);
    // The windowed snapshot went to its OWN callback. Routing it to
    // `onSnapshot` would hand a consumer typed for `chat.messages` a record
    // that has no such key.
    expect(recorded.legacySnapshots).toEqual([]);

    client.close();
  });

  it("does not take the windowed parse path off the windowed line", () => {
    // The two lines share the `snapshot` kind and disagree about its shape, so
    // this is not a tidiness gate: parsing a legacy snapshot against the
    // windowed union fails, and the frame would be dropped silently.
    const { wsStreamClient, session } = stubClientAtVersion({
      major: 1,
      minor: 6,
    });
    const { callbacks, recorded } = recordingCallbacks();
    const client = new ChatStreamClient({
      wsStreamClient,
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks,
    });

    session.deliver(windowedSnapshotFrame());
    session.deliver({
      kind: "skeletonChunk",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      chunk: { epoch: 3, fromOrdinal: 0, entries: [], isFinal: true },
    });

    expect(recorded.snapshots).toEqual([]);
    expect(recorded.skeletonChunks).toEqual([]);
    // And it did not leak into the legacy callback either: a windowed snapshot
    // has no `chat.messages`, so it fails the legacy parse as well.
    expect(recorded.legacySnapshots).toEqual([]);

    client.close();
  });

  it("sends loadRange and resnapshot only on the windowed line", () => {
    const windowed = stubClientAtVersion(WINDOWED_VERSION);
    const windowedClient = new ChatStreamClient({
      wsStreamClient: windowed.wsStreamClient,
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: recordingCallbacks().callbacks,
    });
    windowedClient.requestTranscriptRange({
      requestId: "req-1",
      epoch: 3,
      fromOrdinal: 0,
      toOrdinal: 20,
      maxBytes: 65536,
    });
    windowedClient.requestResnapshot();
    expect(windowed.session.sentFrames.map((frame) => frame.kind)).toEqual([
      "loadRange",
      "resnapshot",
    ]);

    // A `1.6` host's client-frame union has no case for either, so the frame
    // would fail its parse and be dropped. Not sending it is the same outcome
    // without the round trip - and without a client that believes it asked.
    const legacy = stubClientAtVersion({ major: 1, minor: 6 });
    const legacyClient = new ChatStreamClient({
      wsStreamClient: legacy.wsStreamClient,
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: recordingCallbacks().callbacks,
    });
    legacyClient.requestTranscriptRange({
      requestId: "req-1",
      epoch: 3,
      fromOrdinal: 0,
      toOrdinal: 20,
      maxBytes: 65536,
    });
    legacyClient.requestResnapshot();
    expect(legacy.session.sentFrames).toEqual([]);

    windowedClient.close();
    legacyClient.close();
  });

  it("sends nothing once closed, on either line", () => {
    const windowed = stubClientAtVersion(WINDOWED_VERSION);
    const client = new ChatStreamClient({
      wsStreamClient: windowed.wsStreamClient,
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: recordingCallbacks().callbacks,
    });
    client.close();
    client.requestResnapshot();
    expect(windowed.session.sentFrames).toEqual([]);
  });
});
