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

/**
 * A `chat.subscribe@1.6` assistant message carrying a pre-settlement
 * interview block: no outcome/drafts/settlement/diagnostics/delivery, and
 * answers without `selection`. A 1.6 shallow parse leaves those keys
 * absent; `normalizeInterviewBlocksInShallowSnapshot` is what fills them.
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

function makeNoopCallbacks(
  onSnapshot: ChatStreamCallbacks["onSnapshot"],
): ChatStreamCallbacks {
  return {
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
    // Default handshake echoes the client's own manifest verbatim, which
    // negotiates to the client's canonical chat.subscribe version - today
    // exactly `chatSubscribeLiveSchemaVersion` ({major:1, minor:7}). The live
    // shallow path does NOT run the 1.6 interview normalizer.
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

  // `1.6` is a RELEASED line that is not the live one, and it emits live-SHAPED
  // frames. Gating the shallow path on exact equality with
  // `chatSubscribeLiveSchemaVersion` would silently deep-parse every snapshot
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
