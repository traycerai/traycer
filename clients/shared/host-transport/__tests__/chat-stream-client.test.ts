import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
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
/**
 * The full-snapshot chat.subscribe line. Named here because the canonical
 * version moved to the windowed 1.8 line: a test that wants the full-snapshot
 * shape has to say so, or it silently gets the windowed one.
 */
const FULL_SNAPSHOT_VERSION: {
  readonly major: number;
  readonly minor: number;
} = { major: 1, minor: 7 };

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

/**
 * A `chat.subscribe@1.6` assistant message carrying a pre-settlement
 * interview block: no outcome/drafts/settlement/diagnostics/delivery, and
 * answers without `selection`. A 1.6 shallow parse leaves those keys
 * absent; `normalizeV16MessagesInShallowSnapshot` is what fills them.
 * Also omits `imageResolutions` so the test can tell shallow from deep.
 */
function frozenV16InterviewAssistantMessage(): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "assistant-interview-1",
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
      {
        blockId: "iv-1",
        status: "completed",
        timestamp: 20,
        parentBlockId: null,
        type: "interview",
        toolName: "AskUserQuestion",
        title: "Library",
        description: "Pick one",
        questions: [
          {
            questionId: "q1",
            question: "Which library?",
            header: "Library",
            options: [{ label: "date-fns", description: null, preview: null }],
            multiSelect: false,
          },
        ],
        answers: [
          {
            questionId: "q1",
            question: "Which library?",
            values: ["date-fns"],
            notes: null,
          },
        ],
        error: null,
        metadata: null,
      },
    ],
    startedAt: 10,
    timestamp: 20,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function interviewBlockFromMessage(message: unknown): Record<string, unknown> {
  if (!isRecord(message)) {
    throw new Error("expected assistant message");
  }
  if (!Array.isArray(message.blocks)) {
    throw new Error("expected blocks");
  }
  for (const block of message.blocks) {
    if (isRecord(block) && block.type === "interview") return block;
  }
  throw new Error("expected interview block");
}

function interviewAnswerAction(): ChatSubscribeClientFrame {
  return {
    kind: "interviewAnswer",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    clientActionId: "action-answer",
    blockId: "iv-1",
    answers: [
      {
        questionId: "q1",
        question: "Which library?",
        values: ["date-fns"],
        notes: null,
        selection: {
          questionIndex: 0,
          optionIndices: [0],
          optionLabels: ["date-fns"],
          customText: null,
        },
      },
    ],
  };
}

function interviewErrorAction(): ChatSubscribeClientFrame {
  return {
    kind: "interviewError",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    clientActionId: "action-error",
    blockId: "iv-1",
    reason: "Not now",
    settlement: {
      outcome: "skipped",
      draftAnswers: [
        {
          questionId: "q1",
          question: "Which library?",
          values: ["lodash"],
          notes: null,
          selection: null,
        },
      ],
    },
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
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error("Expected object text frame");
  }
  return value;
}

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
    // Pinned to the FULL-SNAPSHOT line this test is about. `completeHandshake`
    // echoes the client's own manifest, so it negotiates whatever the canonical
    // chat.subscribe is - and since the windowed line opened as 1.8 that is a
    // snapshot with no inline `chat.messages` at all, which is not the shape
    // asserted below. The full-snapshot line is still a released line the
    // client must serve, so this keeps testing it rather than being retargeted.
    completeHandshakeAtVersion(sockets[0], FULL_SNAPSHOT_VERSION);

    // The advertised version is the NEGOTIATED one, not the client's canonical
    // - which is the point worth pinning: a client whose registry says 1.8 must
    // still subscribe at 1.7 to a host that only offers 1.7.
    expect(parseText(sockets[0].textSent[1])).toEqual({
      kind: "subscribe",
      method: "chat.subscribe",
      // Deliberately NOT read off the manifest, which main's side of this
      // merge changed to `buildStreamManifest(registry,
      // CLIENT_SERVED_STREAM_MAJORS)`. That restriction covers
      // `epic.subscribe` only, so it would still answer `chat.subscribe` with
      // the client's canonical - which is now the windowed `1.8`, while
      // `completeHandshakeAtVersion` above deliberately stands up a `1.7`
      // host. Asserting the manifest here would assert the client's canonical
      // and quietly stop testing the down-negotiation this case is named for.
      schemaVersion: FULL_SNAPSHOT_VERSION,
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

describe("ChatStreamClient shallow-vs-deep snapshot parse gating", () => {
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

  it("takes the live (1.7) shallow parse path and passes the message through structurally unchanged", () => {
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
    // Pinned rather than defaulted: the default handshake negotiates the
    // CANONICAL chat.subscribe, which is the windowed 1.8 line now, and a
    // windowed snapshot carries no inline `chat.messages`. This test is about
    // the full-snapshot shallow path, so it names that line. The shallow path
    // does NOT run the 1.6 interview normalizer.
    completeHandshakeAtVersion(sockets[0], FULL_SNAPSHOT_VERSION);

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

  // `1.6` is a RELEASED line that is not the live one, and it emits live-SHAPED
  // frames. Gating the shallow path on exact equality with
  // `chatSubscribeFullSnapshotSchemaVersion` would silently deep-parse every snapshot
  // from a current `1.6` host the moment `1.7` opened - "seconds of
  // render-thread CPU per snapshot" by the shallow schema's own doc, on the
  // routine new-app-before-new-host pairing. Hence the per-line fast path.
  it("takes the 1.6 shallow path and delivers a normalized interview snapshot", () => {
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
    completeHandshakeAtVersion(sockets[0], { major: 1, minor: 6 });

    sockets[0].fireText(
      snapshotFrameWithAssistantMessage(frozenV16InterviewAssistantMessage()),
    );

    expect(deliveredMessages).toHaveLength(1);
    const [assistant] = deliveredMessages;
    // Shallow: the 1.6 envelope did not walk histories, so the deep
    // schema's `imageResolutions: []` default was never applied.
    expect(assistant).not.toHaveProperty("imageResolutions");
    const interview = interviewBlockFromMessage(assistant);
    expect(interview.outcome).toBeNull();
    expect(interview.draftAnswers).toEqual([]);
    expect(interview.settlement).toBeNull();
    expect(interview.diagnostics).toEqual([]);
    expect(interview.delivery).toBeNull();
    expect(interview.settlementExtensions).toEqual({});
    if (!Array.isArray(interview.answers) || !isRecord(interview.answers[0])) {
      throw new Error("expected interview answers");
    }
    expect(interview.answers[0].selection).toBeNull();
    expect(interview.answers[0].values).toEqual(["date-fns"]);

    client.close();
  });
});

describe("ChatStreamClient.sendAction interview projection", () => {
  it("sends interviewAnswer/interviewError verbatim on a 1.7 session", () => {
    const { factory, sockets } = makeFactory();
    const client = new ChatStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: makeNoopCallbacks(() => undefined),
    });
    completeHandshake(sockets[0]);

    const answer = interviewAnswerAction();
    const error = interviewErrorAction();
    client.sendAction(answer);
    client.sendAction(error);

    const sentAnswer = parseText(sockets[0].textSent[2]);
    const sentError = parseText(sockets[0].textSent[3]);
    expect(sentAnswer).toEqual(answer);
    expect(sentError).toEqual(error);
    if (
      !Array.isArray(sentAnswer.answers) ||
      !isRecord(sentAnswer.answers[0])
    ) {
      throw new Error("expected projected answers");
    }
    expect(Object.hasOwn(sentAnswer.answers[0], "selection")).toBe(true);
    expect(Object.hasOwn(sentError, "settlement")).toBe(true);

    client.close();
  });

  it("strips selection and settlement before sending on a 1.6 session", () => {
    const { factory, sockets } = makeFactory();
    const client = new ChatStreamClient({
      wsStreamClient: makeWsStreamClient(factory),
      epicId: "epic-1",
      chatId: "chat-1",
      callbacks: makeNoopCallbacks(() => undefined),
    });
    completeHandshakeAtVersion(sockets[0], { major: 1, minor: 6 });

    client.sendAction(interviewAnswerAction());
    client.sendAction(interviewErrorAction());

    const sentAnswer = parseText(sockets[0].textSent[2]);
    const sentError = parseText(sockets[0].textSent[3]);
    if (
      !Array.isArray(sentAnswer.answers) ||
      !isRecord(sentAnswer.answers[0])
    ) {
      throw new Error("expected projected answers");
    }
    expect(Object.hasOwn(sentAnswer.answers[0], "selection")).toBe(false);
    expect(sentAnswer.answers[0].values).toEqual(["date-fns"]);
    expect(Object.hasOwn(sentError, "settlement")).toBe(false);
    expect(sentError.reason).toBe("Not now");

    client.close();
  });
});

/**
 * # Driving the windowed line without a windowed peer
 *
 * These tests inject the session rather than handshaking through
 * `WsStreamClient`, and the reason is structural rather than convenience.
 *
 * Negotiation settles on the LOWER of the two canonical versions:
 * `prepareStreamSubscribeRequest` declares my canonical only while the peer's
 * is at least as new (`myCanonical.minor <= theirCanonical.minor` →
 * `onWireVersion: myCanonical`), and that value is what the session reports as
 * negotiated. So reaching `1.8` needs a peer that also advertises `1.8`, and
 * the stubs in `WsStreamClient`'s own harness stand in for a `1.7` host — a
 * handshake against one of those negotiates **1.7** no matter what this client
 * supports, and `getNegotiatedSchemaVersion()` never returns `1.8`.
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

const WINDOWED_VERSION: SchemaVersion = { major: 1, minor: 8 };

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
      // Nullable but NOT optional, exactly like `pinnedTodo` below: `null` is
      // the bootstrap value, and omitting it fails the parse - which drops the
      // frame before routing and reads as a routing bug.
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
      derived: {
        latestAssistantUsage: null,
        // `pinnedTodo`, singular - the fold's SELECTED result, not a list. It
        // is nullable but NOT optional, so a fixture that omits it fails the
        // parse, which is what caught the name here.
        pinnedTodo: null,
        // The fold's other half, and neither optional nor nullable: the task
        // accumulator is an array that is simply empty when the chat used no
        // task tools. Omitting it fails the parse the same way.
        pinnedTaskTodoItems: [],
        latestForkableAssistantMessageId: null,
        restorableSetupInterruption: null,
        interviewAnswerability: [],
        latestAssistantAuthFailureTurnKey: null,
        // Neither optional nor nullable, same as `pinnedTaskTodoItems`.
        setupCardWindows: [],
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
      // Required and NOT nullable on an index-change frame - unlike the
      // snapshot's, which may be `null` while a full skeleton is on its way.
      // It is the number the client compares to notice a delta it never got.
      indexRevision: 1,
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
      // `generation` distinguishes a re-stream from an extension: without it a
      // client's only gap test is `fromIndex > assembled.length`, measured
      // against the PREVIOUS generation's array.
      chunk: {
        epoch: 3,
        generation: 0,
        fromIndex: 5,
        summaries: [],
        isFinal: true,
      },
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
    //
    // Driven at `1.7` rather than `1.6` because `1.7` is the ADJACENT line -
    // the live, full-snapshot one - and an off-by-one in the windowed
    // predicate lands exactly there. `1.6` would pass with the bound set
    // either way.
    const { wsStreamClient, session } = stubClientAtVersion({
      major: 1,
      minor: 7,
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

    // `1.7` is the highest NON-windowed line - it shipped as the
    // interview-settlement full-snapshot line, which is why `isOnWindowedLine`
    // bounds at `>= 8` rather than the `>= 7` it was drafted with. Such a
    // host's client-frame union has no case for either request, so the frame
    // would fail its parse and be dropped. Not sending it is the same outcome
    // without the round trip - and without a client that believes it asked.
    const legacy = stubClientAtVersion({ major: 1, minor: 7 });
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

/**
 * Browser payloads on the frames that arrive OUTSIDE a snapshot.
 *
 * A snapshot from a `1.6` host is parsed against the FROZEN `1.6` schemas
 * first, so a browser payload on it is stripped as an unknown key. Every other
 * frame kind takes the LIVE union whatever line was negotiated - so without a
 * normalize pass, a mislabeled, stale or hostile "1.6" peer's browser payload
 * arrives VALIDATED on `messageAccepted` / `queueChanged` and is written into
 * history as canonical. Same smuggling the snapshot path refuses, through the
 * door beside it.
 *
 * Both directions are pinned here: neutralized to `[]` on `1.6`, passed through
 * on the live line. `[]` and not `undefined` matters as much as the stripping -
 * consumers are typed as if the array is present.
 */
function smuggledBrowserPayload(): Record<string, unknown> {
  return {
    kind: "user",
    content: { type: "doc", content: [] },
    // Deliberately VALID records: the point is that they survive the live
    // parse, so only a normalize pass can keep them off a 1.6 consumer.
    browserAnnotations: [
      {
        kind: "browser-annotation",
        annotationId: "ann-1",
        tabId: "tab-1",
        sessionId: "session-1",
        origin: "https://example.com",
        pageUrl: "https://example.com/app",
        pageTitle: "App",
        capturedAt: 5,
        comment: "look here",
        counts: { elements: 0, regions: 0, strokes: 0 },
        elements: [],
        imageFileName: "shot.png",
        imageHash: "hash-1",
      },
    ],
  };
}

function messageAcceptedFrame(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "messageAccepted",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    message: {
      role: "user",
      messageId: "user-1",
      sender: { type: "user", userId: "user-1" },
      message: payload,
      timestamp: 5,
      sessionAnchor: null,
    },
  };
}

function queueChangedFrame(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "queueChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    queue: {
      status: "idle",
      items: [
        {
          kind: "prompt",
          queueItemId: "queue-1",
          messageId: "user-1",
          message: payload,
          sender: { type: "user", userId: "user-1" },
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "supervised",
            reasoningEffort: "high",
            agentMode: "epic",
          },
          accountContext: { type: "PERSONAL" },
          delivery: "next_turn",
          status: "pending",
          targetTurnId: null,
          steerRequest: null,
          fallbackReason: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
  };
}

function browserPayloadArrays(value: unknown): {
  readonly annotations: unknown;
} {
  if (!isRecord(value)) {
    throw new Error("expected user-authored payload");
  }
  return {
    annotations: value.browserAnnotations,
  };
}

function acceptedPayload(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error("expected messageAccepted frame");
  }
  if (!isRecord(value.message)) {
    throw new Error("expected user message");
  }
  return value.message.message;
}

function queuedPayload(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error("expected queueChanged frame");
  }
  if (!isRecord(value.queue) || !Array.isArray(value.queue.items)) {
    throw new Error("expected queue items");
  }
  const [item] = value.queue.items;
  if (!isRecord(item)) {
    throw new Error("expected queue item");
  }
  return item.message;
}

function runBrowserPayloadSession(
  schemaVersion: {
    readonly major: number;
    readonly minor: number;
  } | null,
): {
  readonly accepted: unknown[];
  readonly queued: unknown[];
} {
  const { factory, sockets } = makeFactory();
  const accepted: unknown[] = [];
  const queued: unknown[] = [];
  const client = new ChatStreamClient({
    wsStreamClient: makeWsStreamClient(factory),
    epicId: "epic-1",
    chatId: "chat-1",
    callbacks: {
      ...makeNoopCallbacks(() => undefined),
      onMessageAccepted: (frame) => {
        accepted.push(frame);
      },
      onQueueChanged: (frame) => {
        queued.push(frame);
      },
    },
  });
  if (schemaVersion === null) {
    completeHandshake(sockets[0]);
  } else {
    completeHandshakeAtVersion(sockets[0], schemaVersion);
  }

  sockets[0].fireText(messageAcceptedFrame(smuggledBrowserPayload()));
  sockets[0].fireText(queueChangedFrame(smuggledBrowserPayload()));
  client.close();
  return { accepted, queued };
}

describe("ChatStreamClient pre-1.7 browser payload neutralization", () => {
  it("empties smuggled browser arrays on messageAccepted and queueChanged from a 1.6 host", () => {
    const { accepted, queued } = runBrowserPayloadSession({
      major: 1,
      minor: 6,
    });

    expect(accepted).toHaveLength(1);
    expect(queued).toHaveLength(1);
    // Empty, not absent: consumers are typed as if the array is present.
    expect(browserPayloadArrays(acceptedPayload(accepted[0]))).toEqual({
      annotations: [],
    });
    expect(browserPayloadArrays(queuedPayload(queued[0]))).toEqual({
      annotations: [],
    });
  });

  it("empties it on a pre-1.6 line too - every line below 1.7 predates the field", () => {
    const { accepted, queued } = runBrowserPayloadSession({
      major: 1,
      minor: 2,
    });

    expect(browserPayloadArrays(acceptedPayload(accepted[0]))).toEqual({
      annotations: [],
    });
    expect(browserPayloadArrays(queuedPayload(queued[0]))).toEqual({
      annotations: [],
    });
  });

  it("passes the same validated browser payload through on the live line", () => {
    // Default handshake negotiates the client's canonical version (1.7), where
    // this array is legal, deep-validated content rather than smuggled.
    const { accepted, queued } = runBrowserPayloadSession(null);

    const acceptedArrays = browserPayloadArrays(acceptedPayload(accepted[0]));
    const queuedArrays = browserPayloadArrays(queuedPayload(queued[0]));
    for (const arrays of [acceptedArrays, queuedArrays]) {
      if (!Array.isArray(arrays.annotations)) {
        throw new Error("expected browser payload array");
      }
      expect(arrays.annotations).toHaveLength(1);
      // `.default(0)` on a live-only field, applied by the deep parse -
      // proof this really is the validated live shape, not a pass-through.
      expect(arrays.annotations[0]).toMatchObject({
        annotationId: "ann-1",
        droppedElementCount: 0,
      });
    }
  });
});
