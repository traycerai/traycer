import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  Chat,
  ChatEvent,
  ClaudePendingWake,
  InterviewDeliveryProjection,
  Message,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  BackgroundItem,
  ChatActiveTurn,
  ChatErrorNotice,
  ChatFileEditApprovalState,
  ChatPendingInterviewState,
  ChatQueueDeliveryPolicy,
  ChatQueueState,
  ChatRunSettings,
  ChatRunStatus,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { createImageResolutionUpdatedFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import type { RuntimeEvent } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type {
  HeldManagedCommandUpdate,
  ManagedCommand,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  hostStreamRpcRegistry,
  type HostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import {
  ChatStreamClient,
  type ChatStreamCallbacks,
} from "@traycer-clients/shared/host-transport/chat-stream-client";
import type {
  IStreamSession,
  ServerFrameHandler,
  StatusChangeHandler,
  StreamCloseReason,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  WsStreamClient,
  type ParamsOf,
} from "@traycer-clients/shared/host-transport/ws-stream-client";
import { resolveSubmitDeliveryPolicy } from "@/lib/chats/resolve-steer-submit";
import {
  ACCEPTED_CHAT_ACTION_RETENTION_MS,
  MAX_ACCEPTED_CHAT_ACTION_RECORDS,
  MAX_ERROR_NOTICE_RECORDS,
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type SentChatMessageAction,
} from "@/stores/chats/chat-session-store";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import {
  IMMEDIATE_STREAM_FLUSH_COORDINATOR,
  type StreamFlushCoordinator,
  type StreamFlushRegistrationInput,
} from "@/stores/chats/stream-flush-coordinator";
import type { ChatTranscriptDerived } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { RestorableSetupInterruption } from "@traycer/protocol/persistence/chat-transcript/setup-interruption";
import { selectRestorableSetupInterruption } from "@/stores/chats/chat-session-selectors";
import { emptyTranscriptWindow } from "@/stores/chats/transcript-window";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { interviewDraftKey } from "@/lib/persist";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import {
  readInterviewDraftSnapshot,
  useInterviewDraftStore,
} from "@/stores/composer/interview-draft-store";
import { isOptimisticQueuedItem } from "@/stores/chats/optimistic-queue";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";

/**
 * The plain text send these suites exercise: content in, no browser context,
 * nothing staged for restore beyond the content itself.
 */
function sendTestMessage(
  store: ChatSessionStoreHandle["store"],
  content: JsonContent,
  sender: UserMessageSender,
  delivery: {
    readonly settings: ChatRunSettings;
    readonly deliveryPolicy: ChatQueueDeliveryPolicy;
  },
): SentChatMessageAction | null {
  return store.getState().sendMessage({
    content,
    sender,
    settings: delivery.settings,
    attachments: buildAttachmentsFromJSONContent(content),
    deliveryPolicy: delivery.deliveryPolicy,
    restore: { content, browserAnnotations: [] },
  });
}

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const OWNER_ID = "owner-1";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const SECOND_CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "World" }] }],
};

const MENTION_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "mention",
          attrs: {
            contextType: "file",
            path: "src/app.ts",
            relPath: "src/app.ts",
            absolutePath: "/repo/src/app.ts",
            workspacePath: "/repo",
            label: "app.ts",
          },
        },
        { type: "text", text: " needs a second look" },
      ],
    },
  ],
};

const SOURCED_QUOTE_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "sourcedQuote",
      attrs: {
        sourceType: "ticket",
        sourceId: "ticket-7",
        sourceEpicId: "epic-9",
      },
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "the acceptance criteria" }],
        },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: "does this hold?" }] },
  ],
};

const LIST_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "foo" }] },
          ],
        },
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "bar" }] },
          ],
        },
      ],
    },
  ],
};

const DIAGRAM_CONTENT: JsonContent = {
  type: "doc",
  content: [
    { type: "mermaidBlock", attrs: { code: "graph TD;\n  Start-->Done;" } },
  ],
};

const UNKNOWN_NODE_CONTENT: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "look at this" }] },
    { type: "someFutureEmbed", attrs: { widgetId: "w-1" } },
  ],
};

const THIRD_CONTENT: JsonContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Third draft" }] },
  ],
};

const IMAGE_CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "imageAttachment",
      attrs: {
        id: "image-1",
        fileName: "screenshot.png",
        b64content: "abc123",
        mimeType: "image/png",
        size: 128,
      },
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Review this screenshot" }],
    },
  ],
};

const SETTINGS = {
  harnessId: "codex" as const,
  model: "gpt-5-codex",
  permissionMode: "supervised" as const,
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic" as const,
  profileId: null,
};

const UPDATED_SETTINGS = {
  harnessId: "claude" as const,
  model: "claude-sonnet",
  permissionMode: "supervised" as const,
  reasoningEffort: "low",
  serviceTier: null,
  agentMode: "epic" as const,
  profileId: null,
};

const FILE_APPROVAL: ChatFileEditApprovalState = {
  approvalId: "file-approval-1",
  toolName: "apply_patch",
  description: "Edit source files",
  paths: ["/repo/src/app.ts"],
  operation: "edit",
  input: null,
  requestedAt: 2,
};

const PENDING_CLAUDE_WAKE: ClaudePendingWake = {
  sessionId: "claude-session-1",
  toolUseId: "wake-tool-1",
  scheduledFor: 1_769_000_000_000,
  prompt: "Write the standup update.",
  reason: "Standup",
};

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly sent: ChatSubscribeClientFrame[];
  callbacks(): ChatStreamCallbacks;
}

interface ProtocolChainHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly chatStreamClient: ChatStreamClient;
  readonly session: ProtocolMockStreamSession;
}

class ProtocolMockStreamSession implements IStreamSession {
  private statusChangeHandler: StatusChangeHandler | null = null;

  onServerFrame(_handler: ServerFrameHandler): void {
    // Protocol-chain tests only need connection status + schema version.
  }

  onStatusChange(handler: StatusChangeHandler): void {
    this.statusChangeHandler = handler;
  }

  sendClientFrame(
    _envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    // Protocol-chain tests only need status + schema version, not outbound frames.
  }

  /**
   * The version THIS session negotiated - what `ChatStreamClient` reads to gate
   * steering. Set by the owning mock client; every chat tab is its own session,
   * so the gate must not be answerable from a client-wide value.
   */
  negotiatedSchemaVersion: SchemaVersion | null = null;

  getNegotiatedSchemaVersion(): SchemaVersion | null {
    return this.negotiatedSchemaVersion;
  }

  requestReconnect(): void {
    // No-op: reconnect is owned by the real StreamSession.
  }

  close(): void {
    this.statusChangeHandler?.("closed", { kind: "caller" });
  }

  emitStatus(
    status: "connecting" | "open" | "reconnecting" | "closed",
    reason: StreamCloseReason | null,
  ): void {
    if (this.statusChangeHandler !== null) {
      this.statusChangeHandler(status, reason);
    }
  }
}

class ProtocolMockWsStreamClient extends WsStreamClient<HostStreamRpcRegistry> {
  readonly session = new ProtocolMockStreamSession();
  private readonly negotiatedVersion: SchemaVersion;

  constructor(negotiatedVersion: SchemaVersion) {
    super({
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
          throw new Error(
            "ProtocolMockWsStreamClient should not open a websocket",
          );
        },
      },
      dialTimeoutMs: 1_000,
      openAckTimeoutMs: 1_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 50_000,
      initialBackoffMs: 10,
      maxBackoffMs: 1_000,
    });
    this.negotiatedVersion = negotiatedVersion;
    this.session.negotiatedSchemaVersion = negotiatedVersion;
  }

  override subscribe<Method extends keyof HostStreamRpcRegistry & string>(
    _method: Method,
    _params: ParamsOf<HostStreamRpcRegistry, Method>,
  ): IStreamSession {
    return this.session;
  }

  override getMethodSchemaVersion<
    Method extends keyof HostStreamRpcRegistry & string,
  >(method: Method): SchemaVersion | null {
    if (method === "chat.subscribe") return this.negotiatedVersion;
    return null;
  }
}

function createHarness(): Harness {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    sent,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

function createProtocolChainHarness(
  negotiatedVersion: SchemaVersion,
): ProtocolChainHarness {
  const mockWs = new ProtocolMockWsStreamClient(negotiatedVersion);
  const created: { client: ChatStreamClient | null } = { client: null };
  const handle = createChatSessionStore({
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (epicId, chatId, nextCallbacks) => {
      const client = new ChatStreamClient({
        wsStreamClient: mockWs,
        epicId,
        chatId,
        callbacks: nextCallbacks,
      });
      created.client = client;
      return {
        sendAction: (frame) => {
          client.sendAction(frame);
        },
        sameTurnSteeringProtocolSupported: () =>
          client.sameTurnSteeringProtocolSupported(),
        // Delegated rather than stubbed: this harness drives a REAL
        // `ChatStreamClient` over a mock socket, so the reads have to reach it
        // for a test to observe what was put on the wire.
        requestTranscriptRange: (request) => {
          client.requestTranscriptRange(request);
        },
        requestResnapshot: () => {
          client.requestResnapshot();
        },
        interviewSettlementActionsProtocolSupported: () =>
          client.interviewSettlementActionsProtocolSupported(),
        close: () => {
          client.close();
        },
      };
    },
  });
  if (created.client === null) {
    throw new Error("Expected protocol chain factory to run");
  }
  return {
    handle,
    chatStreamClient: created.client,
    session: mockWs.session,
  };
}

function acceptLastAction(harness: Harness): string {
  const frame = harness.sent.at(-1);
  if (frame === undefined || frame.kind === "ping") {
    throw new Error("Expected owner action frame");
  }
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: frame.clientActionId,
    action: frame.kind,
    status: "accepted",
    reason: null,
    code: null,
    backgroundStopTaskIds: [],
  });
  return frame.clientActionId;
}

function worktreeIntentFor(branchName: string): WorktreeIntent {
  return {
    entries: [
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: null,
        isPrimary: true,
        branch: {
          type: "new",
          name: branchName,
          source: "main",
          carryUncommittedChanges: false,
        },
      },
    ],
  };
}

/**
 * Drive a send that loses the restoration race while carrying `intent`, and
 * return the statement it earned.
 */
function statedNoticeWithIntent(intent: WorktreeIntent): ChatErrorNotice {
  const harness = createHarness();
  const callbacks = harness.callbacks();
  emitSnapshot(callbacks, "owner");
  sendTestMessage(
    harness.handle.store,
    CONTENT,
    { type: "user", userId: OWNER_ID },
    { settings: SETTINGS, deliveryPolicy: "auto" },
  );
  useWorktreeIntentStagingStore.getState().setIntent(
    {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    },
    intent,
  );
  sendTestMessage(
    harness.handle.store,
    SECOND_CONTENT,
    { type: "user", userId: OWNER_ID },
    { settings: SETTINGS, deliveryPolicy: "auto" },
  );
  const second = harness.sent[1];
  if (second.kind !== "send") throw new Error("Expected a send frame");
  callbacks.onConnectionStatus("reconnecting", null);
  emitSnapshot(callbacks, "owner");
  return noticeFor(harness, second.clientActionId);
}

function sendTwo(
  harness: Harness,
  first: JsonContent,
  second: JsonContent,
): void {
  sendTestMessage(
    harness.handle.store,
    first,
    { type: "user", userId: OWNER_ID },
    { settings: SETTINGS, deliveryPolicy: "auto" },
  );
  sendTestMessage(
    harness.handle.store,
    second,
    { type: "user", userId: OWNER_ID },
    { settings: SETTINGS, deliveryPolicy: "auto" },
  );
}

function noticeFor(harness: Harness, clientActionId: string): ChatErrorNotice {
  const notice = harness.handle.store
    .getState()
    .errorNotices.find((entry) => entry.clientActionId === clientActionId);
  if (notice === undefined) throw new Error("Expected a statement");
  return notice;
}

function rejectLastAction(harness: Harness, reason: string): string {
  const frame = harness.sent.at(-1);
  if (frame === undefined || frame.kind === "ping") {
    throw new Error("Expected owner action frame");
  }
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: frame.clientActionId,
    action: frame.kind,
    status: "rejected",
    reason,
    code: null,
    backgroundStopTaskIds: [],
  });
  return frame.clientActionId;
}

function emitSnapshot(
  callbacks: ChatStreamCallbacks,
  access: "owner" | "viewer",
): void {
  emitSnapshotFrame({
    callbacks,
    access,
    messages: [],
    queue: { status: "idle", items: [] },
    pendingFileEditApprovals: [],
  });
}

interface SnapshotFrameInput {
  readonly callbacks: ChatStreamCallbacks;
  readonly access: "owner" | "viewer";
  readonly messages: ReadonlyArray<Message>;
  readonly queue: ChatQueueState;
  readonly pendingFileEditApprovals: ReadonlyArray<ChatFileEditApprovalState>;
  readonly settings?: ChatRunSettings | null;
  readonly pendingInterviews?: ReadonlyArray<ChatPendingInterviewState>;
  readonly backgroundItems?: ReadonlyArray<BackgroundItem>;
  readonly managedCommands?: ReadonlyArray<ManagedCommand>;
  readonly heldUpdates?: ReadonlyArray<HeldManagedCommandUpdate>;
  readonly claudePendingWakes?: ReadonlyArray<ClaudePendingWake>;
  // Default to the idle/no-turn snapshot every existing caller relies on;
  // the session-stop reconnect tests need a snapshot that reports a live
  // turn instead.
  readonly runStatus?: ChatRunStatus;
  readonly activeTurn?: ChatActiveTurn | null;
  readonly turnInProgress?: boolean;
}

/**
 * Put a live turn on the wire, so the next send is QUEUED rather than rendered
 * as an optimistic `pendingUserMessage` - the shape `-LJlY` lives in.
 */
function startTurn(callbacks: ChatStreamCallbacks): void {
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    // `isChatSessionSettled` is false as soon as the run is not idle, which
    // is all this needs - no activeTurn literal to keep in sync.
    runStatus: "running",
    activeTurn: null,
  });
}

/** A reconnect snapshot that still shows the send parked in the host queue. */
function emitSnapshotWithQueuedSend(
  callbacks: ChatStreamCallbacks,
  messageId: string,
): void {
  emitSnapshotFrame({
    callbacks,
    access: "owner",
    messages: [],
    pendingFileEditApprovals: [],
    queue: {
      status: "running",
      items: [
        {
          kind: "prompt",
          queueItemId: `queue-${messageId}`,
          messageId,
          message: {
            kind: "user",
            content: CONTENT,
            browserAnnotations: [],
          },
          sender: { type: "user", userId: OWNER_ID },
          settings: SETTINGS,
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
  });
}

/**
 * Returns the raw `chat` record it just sent, so a caller can hold a
 * reference to the exact object the snapshot carried - the aliasing test
 * mutates it after the fact to prove the store copied rather than aliased it.
 */
function emitSnapshotFrame(input: SnapshotFrameInput): Chat {
  input.callbacks.onConnectionStatus("open", null);
  const chat: Chat = {
    id: CHAT_ID,
    parentId: null,
    userId: OWNER_ID,
    hostId: "test-host",
    title: "Host Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser: false,
    settings: input.settings ?? null,
    activeSessionChain: null,
    claudePendingWakes: [...(input.claudePendingWakes ?? [])],
    messages: [...input.messages],
    events: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
  input.callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat,
      access: {
        role: input.access,
        ownerUserId: OWNER_ID,
        canAct: input.access === "owner",
      },
      queue: input.queue,
      runStatus: input.runStatus ?? "idle",
      activeTurn: input.activeTurn ?? null,
      pendingApprovals: [],
      pendingInterviews: [...(input.pendingInterviews ?? [])],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [...input.pendingFileEditApprovals],
      accumulatedFileChanges: [],
      managedCommands: [...(input.managedCommands ?? [])],
      heldUpdates: [...(input.heldUpdates ?? [])],
      ...(input.backgroundItems === undefined
        ? {}
        : { backgroundItems: [...input.backgroundItems] }),
      ...(input.turnInProgress === undefined
        ? {}
        : { turnInProgress: input.turnInProgress }),
    },
  });
  return chat;
}

function emitSnapshotWithWorktree(
  callbacks: ChatStreamCallbacks,
  events: ReadonlyArray<ChatEvent>,
  worktreeBinding: WorktreeBinding | null,
): void {
  callbacks.onConnectionStatus("open", null);
  callbacks.onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: "test-host",
        title: "Host Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [],
        events: [...events],
        archivedAt: null,
        pinnedUserProviderHandle: null,
        lastDeliveredRolesDigest: null,
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      worktreeBinding,
      missingWorktreePaths: [],
    },
  });
}

function bindingForEntry(
  workspacePath: string,
  setupState:
    | "not_required"
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled",
): WorktreeBinding {
  return {
    entries: [
      {
        workspacePath,
        mode: "worktree",
        repoIdentifier: { owner: "acme", repo: "app" },
        worktreePath: `${workspacePath}-wt`,
        branch: "feat/x",
        isPrimary: true,
        isImported: false,
        setupState,
        setupTerminalSessionId: null,
        setupExitCode: null,
        setupFailedAt: null,
        createdAt: 10,
        ownedSubmodules: [],
      },
    ],
  };
}

function chatEvent(
  eventId: string,
  type: ChatEvent["type"],
  metadata: Record<string, unknown> | null,
): ChatEvent {
  return {
    eventId,
    type,
    timestamp: 1,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: null,
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata,
  };
}

function assistantSteerMessage(
  messageId: string,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "codex",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "steer",
        blockId: `steer:queue-${messageId}`,
        status: "completed",
        timestamp: 4,
        queueItemId: `queue-${messageId}`,
        messageId,
        content: CONTENT,
        mode: "safe_point",
        sender: null,
      },
    ],
    startedAt: 4,
    timestamp: 4,
    turnId: "turn-steered",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

function persistedUserMessage(
  messageId: string,
): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: {
      kind: "user",
      content: CONTENT,
      browserAnnotations: [],
    },
    timestamp: 4,
    sessionAnchor: null,
  };
}

function persistedInterviewMessage(
  delivery: InterviewDeliveryProjection,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: "assistant-interview",
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "agent-1",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "interview",
        blockId: "interview-delivery-retry",
        status: "completed",
        timestamp: 4,
        parentBlockId: null,
        toolName: "AskUserQuestion",
        title: null,
        description: null,
        questions: [
          {
            questionId: "q1",
            question: "Which scope?",
            header: null,
            options: [],
            multiSelect: false,
          },
        ],
        answers: [
          {
            questionId: "q1",
            question: "Which scope?",
            values: ["Alpha"],
            notes: null,
            selection: null,
          },
        ],
        error: null,
        metadata: null,
        outcome: "answered",
        draftAnswers: [],
        settlement: { settlementId: "settlement-1", source: "gui" },
        diagnostics: [],
        delivery,
        settlementExtensions: {},
      },
    ],
    startedAt: 4,
    blocksVersion: 1,
    timestamp: 4,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

describe("createChatSessionStore", () => {
  // The worktree intent staging store is a module-global Zustand store; a test
  // that leaves a staged (or restored-on-reject) intent behind would make later
  // tests order-dependent. Reset it after every test so each starts clean.
  // Interview drafts share the same module-global risk across lifecycle tests.
  afterEach(() => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    // In-memory zustand state, so `localStorage.clear()` below does not touch
    // it - a TEAM context set by a billing-drift test would otherwise leak
    // into every case after it.
    useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
    useInterviewDraftStore.setState({ draftsByChat: {} });
    __resetAppLocalNotificationsStoreForTests();
    window.localStorage.clear();
  });

  it("clears a running chat when the stream closes", () => {
    const harness = createHarness();

    startRunningTurn(harness.callbacks());
    expect(harness.handle.store.getState().runStatus).toBe("running");

    harness.callbacks().onConnectionStatus("closed", { kind: "caller" });

    expect(harness.handle.store.getState().connectionStatus).toBe("closed");
    expect(harness.handle.store.getState().runStatus).toBe("idle");
    expect(harness.handle.store.getState().activeTurn).toBeNull();
  });

  it("captures a fatal close (CHAT_INVALID) but not a caller close", () => {
    const harness = createHarness();

    harness.callbacks().onConnectionStatus("closed", { kind: "caller" });
    expect(harness.handle.store.getState().fatalClose).toBeNull();

    harness.callbacks().onConnectionStatus("closed", {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason:
          "CHAT_INVALID: Chat 'x' could not be read from persisted state.",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    expect(harness.handle.store.getState().fatalClose?.reason).toContain(
      "CHAT_INVALID",
    );
    expect(harness.handle.store.getState().snapshotLoaded).toBe(false);
  });

  it("emits each actual fatal close once and resurfaces a later close", () => {
    useAppLocalNotificationsStore.getState().activateIdentity(OWNER_ID);
    const harness = createHarness();
    const reason = {
      kind: "fatalError" as const,
      details: {
        code: "CONNECTION_LOST",
        reason: "Connection lost",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    };
    const notificationId =
      "stream.transport.error:host-a:chat-1:CONNECTION_LOST";

    harness.callbacks().onConnectionStatus("closed", reason);
    useAppLocalNotificationsStore
      .getState()
      .markAsRead(notificationId, Date.now());
    harness.callbacks().onConnectionStatus("closed", reason);
    expect(
      useAppLocalNotificationsStore.getState().byId[notificationId].readAt,
    ).not.toBeNull();

    harness.handle.store.getState().retry();
    harness.callbacks().onConnectionStatus("closed", reason);
    expect(
      useAppLocalNotificationsStore.getState().byId[notificationId].readAt,
    ).toBeNull();
  });

  it("acknowledges an earlier stream failure only on a live completed turn", () => {
    useAppLocalNotificationsStore.getState().activateIdentity(OWNER_ID);
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const notificationId =
      "stream.transport.error:host-a:chat-1:CONNECTION_LOST";
    const fatalClose = {
      kind: "fatalError" as const,
      details: {
        code: "CONNECTION_LOST",
        reason: "Connection lost",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    };

    callbacks.onConnectionStatus("closed", fatalClose);
    expect(
      useAppLocalNotificationsStore.getState().byId[notificationId].readAt,
    ).toBeNull();

    harness.handle.store.getState().retry();
    const recoveredCallbacks = harness.callbacks();
    startRunningTurn(recoveredCallbacks);
    recoveredCallbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "turn.completed",
        blockId: "turn-0",
        timestamp: 4,
        turnId: "turn-0",
      },
    });

    expect(
      useAppLocalNotificationsStore.getState().byId[notificationId].readAt,
    ).toBeNull();

    recoveredCallbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "turn.completed",
        blockId: "turn-1",
        timestamp: 4,
        turnId: "turn-1",
      },
    });

    expect(
      useAppLocalNotificationsStore.getState().byId[notificationId].readAt,
    ).not.toBeNull();

    recoveredCallbacks.onConnectionStatus("closed", fatalClose);
    expect(
      useAppLocalNotificationsStore.getState().byId[notificationId].readAt,
    ).toBeNull();
  });

  it("retry re-subscribes and clears the fatal close", () => {
    let factoryCalls = 0;
    let lastCallbacks: ChatStreamCallbacks | null = null;
    let closeCalls = 0;
    const handle = createChatSessionStore({
      hostId: "host-a",
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      userId: OWNER_ID,
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
        factoryCalls += 1;
        lastCallbacks = nextCallbacks;
        return {
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => {
            closeCalls += 1;
          },
        };
      },
    });
    expect(factoryCalls).toBe(1);
    // Read through a getter so the closure-assigned var keeps its declared type
    // (a direct narrow on the `let` collapses the else-branch to `never`).
    const callbacks = (): ChatStreamCallbacks => {
      if (lastCallbacks === null) throw new Error("Expected callbacks");
      return lastCallbacks;
    };

    callbacks().onConnectionStatus("closed", {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "CHAT_INVALID: nope",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    expect(handle.store.getState().fatalClose?.reason).toContain(
      "CHAT_INVALID",
    );

    handle.store.getState().retry();

    // The stale stream was torn down and a fresh one opened; state reset.
    expect(closeCalls).toBe(1);
    expect(factoryCalls).toBe(2);
    expect(handle.store.getState().fatalClose).toBeNull();
    expect(handle.store.getState().connectionStatus).toBe("connecting");
  });

  it("retry ignores callbacks from the stale stream client", () => {
    let lastCallbacks: ChatStreamCallbacks | null = null;
    const handle = createChatSessionStore({
      hostId: "host-a",
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      userId: OWNER_ID,
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
        lastCallbacks = nextCallbacks;
        return {
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        };
      },
    });
    const callbacks = (): ChatStreamCallbacks => {
      if (lastCallbacks === null) throw new Error("Expected callbacks");
      return lastCallbacks;
    };
    const staleCallbacks = callbacks();
    staleCallbacks.onConnectionStatus("open", null);
    expect(handle.store.getState().steerProtocolSupported).toBe(true);

    handle.store.getState().retry();
    expect(handle.store.getState().steerProtocolSupported).toBe(false);

    staleCallbacks.onConnectionStatus("open", null);
    expect(handle.store.getState().connectionStatus).toBe("connecting");

    callbacks().onConnectionStatus("open", null);
    expect(handle.store.getState().connectionStatus).toBe("open");
  });

  it("preserves pending Claude wakes from snapshot chat state", () => {
    const harness = createHarness();
    emitSnapshotFrame({
      callbacks: harness.callbacks(),
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      claudePendingWakes: [PENDING_CLAUDE_WAKE],
    });

    expect(harness.handle.store.getState().chat?.claudePendingWakes).toEqual([
      PENDING_CLAUDE_WAKE,
    ]);
  });

  it("carries the transcript once: `chat` drops the arrays while the scalars and the real messages copy survive", () => {
    const harness = createHarness();
    const messages = [persistedUserMessage("m1"), persistedUserMessage("m2")];

    emitSnapshotFrame({
      callbacks: harness.callbacks(),
      access: "owner",
      messages,
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });

    const state = harness.handle.store.getState();
    if (state.chat === null) throw new Error("Expected chat");

    // The regression guard: a future `{...snapshot.chat}` spread would
    // silently reintroduce the duplicate, and this is the only check that
    // would catch it - the type-level guarantee disappears the moment
    // someone widens `ChatSessionRecord` back to `Chat`.
    expect(Object.keys(state.chat)).not.toContain("messages");
    expect(Object.keys(state.chat)).not.toContain("events");

    // The four scalar reads `ChatSessionRecord` exists to serve.
    expect(state.chat.title).toBe("Host Chat");
    expect(state.chat.isTitleEditedByUser).toBe(false);
    expect(state.chat.settings).toEqual(SETTINGS);
    expect(state.chat.parentId).toBeNull();

    // The strip must not have taken the real copy.
    expect(state.messages).toEqual(messages);
  });

  it("carries the events transcript once: `chat` drops events too, and state.events keeps the full copy", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const events = [
      chatEvent("event-1", "turn.started", null),
      chatEvent("event-2", "turn.completed", null),
    ];

    emitSnapshotWithWorktree(callbacks, events, null);

    const state = harness.handle.store.getState();
    if (state.chat === null) throw new Error("Expected chat");
    expect(Object.keys(state.chat)).not.toContain("events");
    expect(Object.keys(state.chat)).not.toContain("messages");
    expect(state.events).toEqual(events);
  });

  it("does not alias the snapshot's chat object - mutating it after the fact does not write through into store state", () => {
    const harness = createHarness();
    const sentChat = emitSnapshotFrame({
      callbacks: harness.callbacks(),
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    // Simulates a caller (or a future bug) mutating the object it handed to
    // the store after the fact - it must not be the same reference.
    sentChat.title = "mutated after the fact";

    expect(harness.handle.store.getState().chat?.title).toBe("Host Chat");
  });

  it("seeds composer settings from the initial persisted chat snapshot", () => {
    const harness = createHarness();

    emitSnapshotFrame({
      callbacks: harness.callbacks(),
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });

    expect(harness.handle.store.getState().currentComposerSettings).toEqual(
      SETTINGS,
    );
  });

  it("threads deliveryPolicy onto the send frame (Cmd+Enter after_safe_point)", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    const clientActionId = sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "after_safe_point" },
    );

    expect(clientActionId).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");
    expect(frame.deliveryPolicy).toBe("after_safe_point");
    expect(frame.settings).toEqual(SETTINGS);
  });

  it("threads steerProtocolSupported through real ChatStreamClient from negotiated chat.subscribe 1.4 (F1 protocol chain)", () => {
    // Transport → store → resolver: getMethodSchemaVersion(chat.subscribe)=1.4
    // → ChatStreamClient.sameTurnSteeringProtocolSupported()=false → store
    // onConnectionStatus("open") sets steerProtocolSupported=false →
    // resolveSubmitDeliveryPolicy returns "auto" (never after_safe_point).
    const harness = createProtocolChainHarness({ major: 1, minor: 4 });
    expect(harness.chatStreamClient.sameTurnSteeringProtocolSupported()).toBe(
      false,
    );

    harness.session.emitStatus("open", null);
    expect(harness.handle.store.getState().steerProtocolSupported).toBe(false);
    expect(
      resolveSubmitDeliveryPolicy({
        source: "mod-enter",
        activeTurnStatus: "running",
        steerEnabled: true,
        steerProtocolSupported:
          harness.handle.store.getState().steerProtocolSupported,
      }),
    ).toBe("auto");

    harness.handle.dispose();
  });

  it("threads steerProtocolSupported true through real ChatStreamClient from negotiated chat.subscribe 1.5 (F1 protocol chain mirror)", () => {
    const harness = createProtocolChainHarness({ major: 1, minor: 5 });
    expect(harness.chatStreamClient.sameTurnSteeringProtocolSupported()).toBe(
      true,
    );

    harness.session.emitStatus("open", null);
    expect(harness.handle.store.getState().steerProtocolSupported).toBe(true);
    expect(
      resolveSubmitDeliveryPolicy({
        source: "mod-enter",
        activeTurnStatus: "running",
        steerEnabled: true,
        steerProtocolSupported:
          harness.handle.store.getState().steerProtocolSupported,
      }),
    ).toBe("after_safe_point");

    harness.handle.dispose();
  });

  it("dedupes an exact interview delivery retry and reconciles newer generations", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const failedDelivery = {
      deliveryId: "delivery-1",
      status: "failed" as const,
      retryable: true,
      generation: 0,
    };
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedInterviewMessage(failedDelivery)],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    harness.handle.store.setState({
      interviewDeliveryRetryProtocolSupported: true,
    });

    const identity = {
      blockId: "interview-delivery-retry",
      settlementId: "settlement-1",
      deliveryId: "delivery-1",
      generation: 0,
    };
    const first = harness.handle.store
      .getState()
      .interviewDeliveryRetry(identity);
    expect(first).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.kind).toBe("interviewDeliveryRetry");
    expect(harness.sent[0]).toMatchObject({ generation: 0 });
    expect(
      harness.handle.store.getState().pendingActions[first ?? ""]
        .interviewBlockId,
    ).toBeNull();

    // The same exact outbox identity is a single action while pending, and
    // remains one action after its ACK moves it to acceptedActions.
    expect(
      harness.handle.store.getState().interviewDeliveryRetry(identity),
    ).toBe(first);
    acceptLastAction(harness);
    expect(
      harness.handle.store.getState().interviewDeliveryRetry(identity),
    ).toBe(first);
    expect(harness.sent).toHaveLength(1);

    // Any authoritative status transition retires the accepted retry. A later
    // failed generation is a fresh exact identity and can be retried once.
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        persistedInterviewMessage({
          ...failedDelivery,
          status: "delivering",
        }),
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    expect(harness.handle.store.getState().acceptedActions).toEqual({});

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        persistedInterviewMessage({
          ...failedDelivery,
          generation: 1,
        }),
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    harness.handle.store.setState({
      interviewDeliveryRetryProtocolSupported: true,
    });
    const newer = harness.handle.store
      .getState()
      .interviewDeliveryRetry({ ...identity, generation: 1 });
    expect(newer).not.toBeNull();
    expect(newer).not.toBe(first);
    expect(harness.sent).toHaveLength(2);
  });

  it("retires an accepted retry when a reconnect snapshot leaves the failed tuple unchanged", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const delivery = {
      deliveryId: "delivery-1",
      status: "failed" as const,
      retryable: true,
      generation: 0,
    };
    const snapshot = (): void => {
      // Block body: this branch's `emitSnapshotFrame` returns the chat record
      // it emitted (the windowed adapter needs it), so a concise arrow would
      // return it out of a `: void` annotation.
      emitSnapshotFrame({
        callbacks,
        access: "owner",
        messages: [persistedInterviewMessage(delivery)],
        queue: { status: "idle", items: [] },
        pendingFileEditApprovals: [],
      });
    };
    snapshot();
    harness.handle.store.setState({
      interviewDeliveryRetryProtocolSupported: true,
    });
    const identity = {
      blockId: "interview-delivery-retry",
      settlementId: "settlement-1",
      deliveryId: "delivery-1",
      generation: 0,
    };
    const first = harness.handle.store
      .getState()
      .interviewDeliveryRetry(identity);
    acceptLastAction(harness);

    callbacks.onConnectionStatus("reconnecting", null);
    snapshot();
    expect(harness.handle.store.getState().acceptedActions).toEqual({});
    harness.handle.store.setState({
      interviewDeliveryRetryProtocolSupported: true,
    });
    const retried = harness.handle.store
      .getState()
      .interviewDeliveryRetry(identity);
    expect(retried).not.toBeNull();
    expect(retried).not.toBe(first);
    expect(harness.sent).toHaveLength(2);
  });

  it("applies correlated lifecycle delivery updates without waiting for a snapshot", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        persistedInterviewMessage({
          deliveryId: "delivery-1",
          status: "pending",
          retryable: true,
          generation: 0,
        }),
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    callbacks.onInterviewAnswered({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "interview-delivery-retry",
      answers: [
        {
          questionId: "q1",
          question: "Which scope?",
          values: ["Beta"],
          notes: null,
          selection: null,
        },
      ],
      resolvedAt: 5,
      settlementId: "settlement-1",
      settlementSource: "gui",
      delivery: {
        deliveryId: "delivery-1",
        status: "failed",
        retryable: true,
        generation: 1,
      },
    });

    const message = harness.handle.store.getState().messages[0];
    const block =
      message.role === "assistant"
        ? message.blocks.find((candidate) => candidate.type === "interview")
        : undefined;
    expect(block).toMatchObject({
      settlement: { settlementId: "settlement-1", source: "gui" },
      outcome: "answered",
      answers: [{ values: ["Alpha"] }],
      delivery: {
        deliveryId: "delivery-1",
        status: "failed",
        generation: 1,
      },
    });
  });

  it("installs lifecycle authority on a streaming block and ignores a stale settlement", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const persisted = persistedInterviewMessage({
      deliveryId: "delivery-old",
      status: "pending",
      retryable: true,
      generation: 0,
    });
    const existing = persisted.blocks[0];
    if (existing.type !== "interview") throw new Error("Expected interview");
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        {
          ...persisted,
          blocks: [
            {
              ...existing,
              status: "streaming",
              answers: [],
              outcome: null,
              settlement: null,
              delivery: null,
            },
          ],
        },
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    callbacks.onInterviewAnswered({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "interview-delivery-retry",
      answers: [
        {
          questionId: "q1",
          question: "Which scope?",
          values: ["Beta"],
          notes: null,
          selection: null,
        },
      ],
      resolvedAt: 5,
      settlementId: "settlement-new",
      settlementSource: "gui",
      delivery: {
        deliveryId: "delivery-new",
        status: "failed",
        retryable: true,
        generation: 0,
      },
    });
    callbacks.onInterviewErrored({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "interview-delivery-retry",
      reason: "Stale failure",
      resolvedAt: 6,
      settlementId: "settlement-stale",
      settlementSource: "runtime",
      outcome: "failed",
      draftAnswers: [],
      delivery: null,
    });
    const message = harness.handle.store.getState().messages[0];
    const block =
      message.role === "assistant"
        ? message.blocks.find((candidate) => candidate.type === "interview")
        : undefined;
    expect(block).toMatchObject({
      status: "completed",
      answers: [{ values: ["Beta"] }],
      error: null,
      outcome: "answered",
      settlement: { settlementId: "settlement-new", source: "gui" },
      delivery: { deliveryId: "delivery-new", status: "failed" },
    });
  });

  it("applies a lifecycle frame only to the newest unresolved owner when block ids repeat", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const historical = persistedInterviewMessage({
      deliveryId: "delivery-old",
      status: "pending",
      retryable: true,
      generation: 0,
    });
    const current = persistedInterviewMessage({
      deliveryId: "delivery-placeholder",
      status: "pending",
      retryable: true,
      generation: 0,
    });
    const currentBlock = current.blocks[0];
    if (currentBlock.type !== "interview") {
      throw new Error("Expected interview");
    }
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        { ...historical, messageId: "assistant-historical" },
        {
          ...current,
          messageId: "assistant-current",
          blocks: [
            {
              ...currentBlock,
              status: "streaming",
              answers: [],
              outcome: null,
              settlement: null,
              delivery: null,
            },
          ],
        },
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    // An unchanged update for the older exact settlement must still count as
    // routed; it must not fall through and install old authority on the newer
    // unresolved row that happens to reuse the block id.
    callbacks.onInterviewAnswered({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "interview-delivery-retry",
      answers: [
        {
          questionId: "q1",
          question: "Which scope?",
          values: ["Alpha"],
          notes: null,
          selection: null,
        },
      ],
      resolvedAt: 4,
      settlementId: "settlement-1",
      settlementSource: "gui",
      delivery: {
        deliveryId: "delivery-old",
        status: "pending",
        retryable: true,
        generation: 0,
      },
    });
    callbacks.onInterviewAnswered({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "interview-delivery-retry",
      answers: [
        {
          questionId: "q1",
          question: "Which scope?",
          values: ["Beta"],
          notes: null,
          selection: null,
        },
      ],
      resolvedAt: 5,
      settlementId: "settlement-current",
      settlementSource: "gui",
      delivery: null,
    });
    callbacks.onInterviewAnswered({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "interview-delivery-retry",
      answers: [
        {
          questionId: "q1",
          question: "Which scope?",
          values: ["Alpha"],
          notes: null,
          selection: null,
        },
      ],
      resolvedAt: 6,
      settlementId: "settlement-1",
      settlementSource: "gui",
      delivery: {
        deliveryId: "delivery-old",
        status: "failed",
        retryable: true,
        generation: 1,
      },
    });

    const messages = harness.handle.store.getState().messages;
    const oldBlock =
      messages[0]?.role === "assistant" ? messages[0].blocks[0] : null;
    const newBlock =
      messages[1]?.role === "assistant" ? messages[1].blocks[0] : null;
    expect(oldBlock).toMatchObject({
      outcome: "answered",
      answers: [{ values: ["Alpha"] }],
      settlement: { settlementId: "settlement-1" },
      delivery: { deliveryId: "delivery-old", generation: 1 },
    });
    expect(newBlock).toMatchObject({
      outcome: "answered",
      answers: [{ values: ["Beta"] }],
      settlement: { settlementId: "settlement-current" },
    });
  });

  it("preserves the current pending owner when historical lifecycle frames reuse its block id", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const blockId = "interview-delivery-retry";
    const historicalAnswered = persistedInterviewMessage({
      deliveryId: "delivery-historical-answered",
      status: "pending",
      retryable: true,
      generation: 0,
    });
    const historicalErrored = persistedInterviewMessage({
      deliveryId: "delivery-historical-errored",
      status: "pending",
      retryable: true,
      generation: 0,
    });
    const current = persistedInterviewMessage({
      deliveryId: "delivery-current-placeholder",
      status: "pending",
      retryable: true,
      generation: 0,
    });
    const answeredBlock = historicalAnswered.blocks[0];
    const erroredBlock = historicalErrored.blocks[0];
    const currentBlock = current.blocks[0];
    if (
      answeredBlock.type !== "interview" ||
      erroredBlock.type !== "interview" ||
      currentBlock.type !== "interview"
    ) {
      throw new Error("Expected interview blocks");
    }
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        {
          ...historicalAnswered,
          messageId: "assistant-historical-answered",
          blocks: [
            {
              ...answeredBlock,
              settlement: {
                settlementId: "settlement-historical-answered",
                source: "gui",
              },
            },
          ],
        },
        {
          ...historicalErrored,
          messageId: "assistant-historical-errored",
          blocks: [
            {
              ...erroredBlock,
              settlement: {
                settlementId: "settlement-historical-errored",
                source: "gui",
              },
            },
          ],
        },
        {
          ...current,
          messageId: "assistant-current-pending",
          blocks: [
            {
              ...currentBlock,
              status: "streaming",
              answers: [],
              outcome: null,
              settlement: null,
              delivery: null,
            },
          ],
        },
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId, requestedAt: 2 }],
    });
    const draft = {
      pageIndex: 0,
      answers: [{ selected: ["Beta"], otherText: "", otherSelected: false }],
    };
    useInterviewDraftStore.getState().saveDraft(CHAT_ID, blockId, draft);
    const actionId = harness.handle.store
      .getState()
      .interviewAnswer(blockId, []);
    if (actionId === null) throw new Error("Expected interview answer action");

    const expectCurrentOwnerStatePreserved = (): void => {
      expect(harness.handle.store.getState().pendingInterviews).toEqual([
        { blockId, requestedAt: 2 },
      ]);
      expect(readInterviewDraftSnapshot(CHAT_ID, blockId)).toEqual(draft);
    };

    callbacks.onInterviewAnswered({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId,
      answers: [],
      resolvedAt: 4,
      settlementId: "settlement-historical-answered",
      settlementSource: "gui",
      delivery: null,
    });
    expectCurrentOwnerStatePreserved();
    expect(
      harness.handle.store.getState().pendingActions[actionId],
    ).toBeDefined();

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: actionId,
      action: "interviewAnswer",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });
    expect(
      harness.handle.store.getState().acceptedActions[actionId],
    ).toBeDefined();

    callbacks.onInterviewErrored({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId,
      reason: "Historical failure",
      resolvedAt: 5,
      settlementId: "settlement-historical-errored",
      settlementSource: "gui",
      outcome: "failed",
      draftAnswers: [],
      delivery: null,
    });
    expectCurrentOwnerStatePreserved();
    expect(
      harness.handle.store.getState().acceptedActions[actionId],
    ).toBeDefined();
  });

  it("does not let an ambiguous legacy cleanup overwrite a terminal outcome", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const persisted = persistedInterviewMessage({
      deliveryId: "delivery-legacy",
      status: "delivered",
      retryable: false,
      generation: 0,
    });
    const existing = persisted.blocks[0];
    if (existing.type !== "interview") throw new Error("Expected interview");
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        {
          ...persisted,
          blocks: [{ ...existing, settlement: null, delivery: null }],
        },
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    callbacks.onInterviewErrored({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "interview-delivery-retry",
      reason: "Late ambiguous cleanup",
      resolvedAt: 6,
      settlementId: null,
      settlementSource: null,
      outcome: null,
      draftAnswers: [],
      delivery: null,
    });

    const message = harness.handle.store.getState().messages[0];
    const block = message.role === "assistant" ? message.blocks[0] : null;
    expect(block).toMatchObject({
      status: "completed",
      outcome: "answered",
      answers: [{ values: ["Alpha"] }],
      error: null,
    });
  });

  it("keeps a null lifecycle outcome ambiguous even when provenance is present", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const persisted = persistedInterviewMessage({
      deliveryId: "delivery-unknown",
      status: "pending",
      retryable: true,
      generation: 0,
    });
    const existing = persisted.blocks[0];
    if (existing.type !== "interview") throw new Error("Expected interview");
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        {
          ...persisted,
          blocks: [
            {
              ...existing,
              status: "streaming",
              answers: [],
              outcome: null,
              settlement: null,
              delivery: null,
            },
          ],
        },
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    callbacks.onInterviewErrored({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "interview-delivery-retry",
      reason: "Older host did not classify this result",
      resolvedAt: 5,
      settlementId: "settlement-unknown",
      settlementSource: "runtime",
      outcome: null,
      draftAnswers: [],
      delivery: null,
    });

    const message = harness.handle.store.getState().messages[0];
    const block =
      message.role === "assistant"
        ? message.blocks.find((candidate) => candidate.type === "interview")
        : undefined;
    expect(block).toMatchObject({
      status: "errored",
      error: "Older host did not classify this result",
      outcome: null,
      settlement: null,
    });
  });

  it("does not emit an interview delivery retry on a pre-1.7 chat session", () => {
    const harness = createProtocolChainHarness({ major: 1, minor: 6 });
    harness.session.emitStatus("open", null);
    expect(
      harness.handle.store.getState().interviewDeliveryRetry({
        blockId: "interview-delivery-retry",
        settlementId: "settlement-1",
        deliveryId: "delivery-1",
        generation: 0,
      }),
    ).toBeNull();
    expect(
      harness.handle.store.getState().interviewDeliveryRetryProtocolSupported,
    ).toBe(false);
    harness.handle.dispose();
  });

  it("enables interview delivery retry from a negotiated 1.7 session", () => {
    const harness = createProtocolChainHarness({ major: 1, minor: 7 });
    harness.session.emitStatus("open", null);
    expect(
      harness.handle.store.getState().interviewDeliveryRetryProtocolSupported,
    ).toBe(true);
    harness.handle.dispose();
  });

  it("tracks send actions until actionAck and accepts host messages", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    const clientActionId = sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    expect(clientActionId).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");
    expect(Object.keys(harness.handle.store.getState().pendingActions)).toEqual(
      [frame.clientActionId],
    );

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "send",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });
    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([
      expect.objectContaining({
        clientActionId: frame.clientActionId,
        messageId: frame.messageId,
      }),
    ]);

    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: frame.messageId,
        sender: { type: "user", userId: OWNER_ID },
        message: {
          kind: "user",
          content: CONTENT,
          browserAnnotations: [],
        },
        timestamp: 2,
        sessionAnchor: null,
      },
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(harness.handle.store.getState().messages).toHaveLength(1);
  });

  it("attaches a staged worktree intent to the send frame and consumes it", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, intent);
    harness.handle.store.getState().refreshMissingWorktreePaths(["/repo"]);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected send frame");
    }
    const sentEntry = frame.worktreeIntent?.entries[0];
    expect(sentEntry?.kind === "worktree" ? sentEntry.branch.name : null).toBe(
      "feat",
    );
    // Consumed once it's on the wire (the frame carries it across retries).
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
    // Remembered per-epic so reopening the epic restores the same picks.
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent(EPIC_ID, "host-a"),
    ).not.toBeNull();
    expect(harness.handle.store.getState().missingWorktreePaths).toEqual([]);
    // A worktree-creating send IS echoed optimistically (like every other
    // mid-chat send) so the user message paints INSTANTLY - the host persists
    // it only after the slow `git worktree add`. The earlier optimistic-vs-
    // persisted reorder is avoided NOT by suppressing the echo but by anchoring
    // the setup card to this message's id (rendered-messages.ts). The echo must
    // carry the same `messageId` the card's `triggeringMessageId` will reference.
    const pendingEchoes = harness.handle.store.getState().pendingUserMessages;
    expect(pendingEchoes).toHaveLength(1);
    expect(pendingEchoes[0]?.messageId).toBe(frame.messageId);
  });

  it("restores a staged worktree intent when the send is rejected", () => {
    useWorktreeIntentStagingStore.setState({ intentByKey: {} });
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, intent);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected send frame");
    }
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "send",
      status: "rejected",
      reason: "Stop the active chat run before rebinding its worktree.",
      code: "WORKTREE_CREATE_FAILED",
      backgroundStopTaskIds: [],
    });

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(intent);
  });

  it("restores a staged worktree intent when an edit-and-resend is rejected", () => {
    useWorktreeIntentStagingStore.setState({ intentByKey: {} });
    const harness = createHarness();
    const callbacks = harness.callbacks();
    // Seed the message the edit targets so `editUserMessage` has something to
    // rewrite. A stopped first message is the real-world trigger for this path.
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, intent);

    const result = harness.handle.store.getState().editUserMessage({
      targetMessageId: "msg-original",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      revertFileChanges: false,
      revertArtifacts: false,
    });
    expect(result).not.toBeNull();

    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "editUserMessage") {
      throw new Error("Expected editUserMessage frame");
    }
    expect(frame.worktreeIntent).toEqual(intent);
    // The dispatch consumes the slot up front (mirrors send).
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "editUserMessage",
      status: "rejected",
      reason: "feat already exists; choose a new branch name.",
      code: "WORKTREE_CREATE_FAILED",
      backgroundStopTaskIds: [],
    });

    // The rejected edit puts the selection back, so the chip reflects the
    // worktree the user chose rather than silently reverting to the binding.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(intent);
  });

  it("restores a staged worktree intent when a pending edit is swept after reconnect", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, intent);

    const result = harness.handle.store.getState().editUserMessage({
      targetMessageId: "msg-original",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      revertFileChanges: false,
      revertArtifacts: false,
    });
    expect(result).not.toBeNull();
    // Dispatch consumed the slot.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();

    // Connection drops before the ack (epoch bumps), then a fresh snapshot
    // arrives with the edit still un-acked: the stale pending is swept, and the
    // sweep restores its staged intent instead of leaving the slot cleared for
    // the next resend to run against the prior binding.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(intent);
  });

  // R14 `-CKjC`: the sweep's fallback is a PICK hand-back for one specific
  // action, so it inherits the rejection path's ownership rule - a swept
  // action hands its pick back only when the outstanding consumption is ITS
  // OWN. Here it is not: a later send consumed the slot and was ACCEPTED, so
  // the mark names the send. Staging the swept edit's pick on top of that
  // overwrites a binding an accepted send already ran against, and the next
  // resend looks right while running somewhere else.
  it("refuses a swept edit's hand-back when an accepted send owns the slot", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const editIntent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "from-edit",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    const sendIntent: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };

    // The edit consumes the slot and never gets its ack.
    useWorktreeIntentStagingStore.getState().stageIntent(key, editIntent);
    expect(
      harness.handle.store.getState().editUserMessage({
        targetMessageId: "msg-original",
        content: CONTENT,
        sender: { type: "user", userId: OWNER_ID },
        settings: SETTINGS,
        revertFileChanges: false,
        revertArtifacts: false,
      }),
    ).not.toBeNull();

    // A later send stages its own pick, consumes, and IS accepted - so the
    // outstanding mark is the send's, and the slot state is the send's.
    useWorktreeIntentStagingStore.getState().stageIntent(key, sendIntent);
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const sendFrame = harness.sent.find((frame) => frame.kind === "send");
    if (sendFrame === undefined) throw new Error("Expected the send frame");
    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: sendFrame.clientActionId,
      action: "send",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });

    // The reconnect sweeps the still-pending edit. The accepted send IS in the
    // transcript, so it is not restored - this is the sweep's own fallback
    // deciding alone, with no prompt hand-back to defer to.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        persistedUserMessage("msg-original"),
        persistedUserMessage(sendFrame.messageId),
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    // The edit does not own the consumption, so its pick stays gone. The
    // accepted send decided this slot.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  // `consumeForDispatch` is UNCONDITIONAL - a dispatch is the slot's current
  // state whether or not it took a pick - so its rollback has to be too. A
  // send refused locally (intent-free, racing a disconnection) never reached
  // the wire, so the slot must come back exactly as it was found.
  //
  // Left marked, the mark names an action that never became pending: no ack,
  // sweep or restoration can ever resolve it, so it stands until some
  // unrelated user mutation clears it, and every owner-matched hand-back in
  // the meantime is refused against a phantom owner.
  it("leaves no consumption mark when a refused intent-free send found none", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };

    // Nothing staged, and the connection is gone: the send is refused before
    // it reaches the wire.
    callbacks.onConnectionStatus("reconnecting", null);
    expect(
      sendTestMessage(
        harness.handle.store,
        CONTENT,
        { type: "user", userId: OWNER_ID },
        { settings: SETTINGS, deliveryPolicy: "auto" },
      ),
    ).toBeNull();

    // The slot was empty and unmarked before the attempt; it is empty and
    // unmarked after it.
    expect(
      useWorktreeIntentStagingStore.getState().consumedForDispatchByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  // The other half of "exactly as it was found": when the slot was empty
  // because an EARLIER dispatch took it, the rollback restores THAT mark.
  //
  // A send that never left the client supersedes nothing, so clearing the slot
  // clean would be the opposite lie from the phantom - it reports "empty by
  // user choice" and strands the earlier dispatch's pick just as surely.
  it("hands a superseded dispatch its slot back when the next send is refused locally", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const editIntent = worktreeIntentFor("edit-branch");

    // The edit consumes the slot and never gets its ack.
    useWorktreeIntentStagingStore.getState().stageIntent(key, editIntent);
    expect(
      harness.handle.store.getState().editUserMessage({
        targetMessageId: "msg-original",
        content: CONTENT,
        sender: { type: "user", userId: OWNER_ID },
        settings: SETTINGS,
        revertFileChanges: false,
        revertArtifacts: false,
      }),
    ).not.toBeNull();

    // A send then finds the slot empty (the edit took the pick) and is refused
    // locally. It never reached the host, so the edit is still the last
    // dispatch that actually took this slot.
    callbacks.onConnectionStatus("reconnecting", null);
    expect(
      sendTestMessage(
        harness.handle.store,
        CONTENT,
        { type: "user", userId: OWNER_ID },
        { settings: SETTINGS, deliveryPolicy: "auto" },
      ),
    ).toBeNull();

    // The reconnect sweeps the still-pending edit. No prompt is handed back,
    // so the sweep's own fallback decides - and it may, because the edit still
    // owns the consumption.
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(editIntent);
  });

  // The suspended paths are displaced by the consume too, and losing them
  // fails the dispatch gate OPEN rather than merely losing a pick.
  //
  // `stagedWorktreeIntentIsSuspended` only refuses when the suspended set
  // INTERSECTS the staged intent, so a slot routinely carries suspended paths
  // the gate ignores - the workspace selector records every folder whose
  // metadata has not resolved, staged or not. Here `/other-repo` is suspended
  // while the pick names `/repo`: the send is allowed through, and if the
  // refusal takes the suspended set with it, the retry of the very draft still
  // sitting in the composer meets a gate with nothing left to test.
  it("restores suspended workspace paths a refused send displaced", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intent = worktreeIntentFor("feat");

    useWorktreeIntentStagingStore.getState().stageIntent(key, intent);
    // Suspended, but for a folder the pick does not name - so the gate lets
    // this send through rather than refusing it.
    useWorktreeIntentStagingStore
      .getState()
      .setSuspendedWorkspacePaths(key, ["/other-repo"]);

    callbacks.onConnectionStatus("reconnecting", null);
    expect(
      sendTestMessage(
        harness.handle.store,
        CONTENT,
        { type: "user", userId: OWNER_ID },
        { settings: SETTINGS, deliveryPolicy: "auto" },
      ),
    ).toBeNull();

    expect(
      useWorktreeIntentStagingStore.getState().suspendedWorkspacePathsByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(["/other-repo"]);
  });

  // The restore path deliberately does NOT match on owner - a prompt and the
  // worktree it was written for travel together, whichever dispatch consumed
  // last. So the rollback must leave the slot still reporting what it truly
  // is: empty BECAUSE a dispatch took it. Clearing it clean would report
  // "empty by user choice" and send the prompt back unbound, which is the
  // silent-local-run this whole path exists to prevent.
  it("still returns a restored prompt's binding after a refused intent-free send", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intent = worktreeIntentFor("send-branch");

    useWorktreeIntentStagingStore.getState().stageIntent(key, intent);
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    // A second send finds the slot empty and is refused locally.
    callbacks.onConnectionStatus("reconnecting", null);
    expect(
      sendTestMessage(
        harness.handle.store,
        SECOND_CONTENT,
        { type: "user", userId: OWNER_ID },
        { settings: SETTINGS, deliveryPolicy: "auto" },
      ),
    ).toBeNull();

    // The reconnect snapshot omits the first send, so its prompt comes back -
    // and its binding has to come with it.
    emitSnapshot(callbacks, "owner");

    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(CONTENT);
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(intent);
  });

  // `-H9e2`: the two slots have to move TOGETHER.
  //
  // Two sends in flight, A then B, B's pick consumed last so the mark is B's.
  // A's rejection lands first: it wins the prompt slot, but its worktree
  // hand-back is refused because the mark is not its own - correct on its own
  // terms. B's rejection lands second: it DOES own the mark, so it staged B's
  // pick, while B's prompt was displaced into a statement. Net effect, from
  // two individually-correct decisions: the composer holds A's prompt paired
  // with B's worktree, and resending runs A's text in B's checkout.
  it("never pairs one rejection's prompt with another's worktree", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intentA = worktreeIntentFor("feat/a");
    const intentB = worktreeIntentFor("feat/b");

    useWorktreeIntentStagingStore.getState().setIntent(key, intentA);
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    // B stages its own pick and consumes it, so the outstanding mark is B's.
    useWorktreeIntentStagingStore.getState().setIntent(key, intentB);
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const [first, second] = harness.sent;
    if (first.kind !== "send" || second.kind !== "send") {
      throw new Error("Expected two send frames");
    }

    const reject = (clientActionId: string, reason: string): void => {
      callbacks.onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        clientActionId,
        action: "send",
        status: "rejected",
        reason,
        code: null,
        backgroundStopTaskIds: [],
      });
    };

    // A first: wins the prompt slot, does not own the mark.
    reject(first.clientActionId, "Host refused A.");
    // B second: owns the mark, but its prompt is displaced.
    reject(second.clientActionId, "Host refused B.");

    const state = harness.handle.store.getState();
    // A's prompt is what came back...
    expect(state.failedSendRestoration?.content).toEqual(CONTENT);
    // ...so B's worktree must NOT be sitting under it.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
    // B loses nothing by the refusal: its displaced statement carries its text
    // AND names the worktree it was staged for, so it can be re-picked.
    const statement = noticeFor(harness, second.clientActionId);
    expect(statement.message).toContain("World");
    expect(statement.message).toContain("feat/b");
    // And A does not come back silently unbound: the slot is empty because a
    // LATER dispatch took it, which is the one refusal the user cannot see.
    expect(state.failedSendRestoration?.reason).toContain(
      "taken by a later message",
    );
  });

  // `-IfOZ`, at the seam that matters. A `WorktreeIntent` is one binding PER
  // WORKSPACE FOLDER, and those are independent - so a sweep that takes one
  // folder's worktree must not forfeit the others. The all-or-nothing refusal
  // handed the prompt back with NO binding at all and said "its staged
  // worktree no longer exists", and the surviving folders then resent against
  // whatever the chat is bound to now.
  it("restores the folders a partial sweep left alone", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const doomed: WorktreeIntent["entries"][number] = {
      kind: "worktree",
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
      scripts: null,
      branch: {
        type: "new",
        name: "feat/doomed",
        source: "main",
        carryUncommittedChanges: false,
      },
    };
    const survivor: WorktreeIntent["entries"][number] = {
      kind: "local",
      workspacePath: "/other-repo",
      repoIdentifier: null,
      isPrimary: false,
    };

    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, { entries: [doomed, survivor] });
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    // Only the first folder's worktree is swept while the send is in flight.
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents("host-a", {
        worktreePaths: new Set<string>(),
        branches: [{ repoIdentifier: null, branch: "main" }],
      });

    rejectLastAction(harness, "Host refused the send.");

    // The survivor comes back; the swept folder does not.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual({ entries: [survivor] });
    // And the sentence matches what actually happened. "It was not restored"
    // would now be false in front of a folder that WAS - which is exactly the
    // kind of confidently-wrong statement this family exists to avoid.
    const sent = harness.sent[0];
    if (sent.kind !== "send") throw new Error("Expected a send frame");
    const notice = noticeFor(harness, sent.clientActionId);
    // The partial sentence NAMES the folder that went and says the rest came
    // back. An unnamed "its staged worktree no longer exists" could not tell
    // the user which of two bindings they still have - which is the whole of
    // `-Jy8x`.
    expect(notice.message).toContain("feat/doomed");
    expect(notice.message).toContain("the rest of its staging came back");
    expect(notice.message).not.toContain("so it was not restored");
  });

  // `-LJlY`: a send dispatched while a turn is running renders as a QUEUED
  // item, not a `pendingUserMessage`, so its recovery fields live only on the
  // pending action - and the accepted ack moves that record to
  // `acceptedActions`, which nothing walked. A connection dying between the
  // ack and the host's durable confirmation took the only copy of the draft
  // with it: a dead send with no account at all.
  it("restores a queued send whose accepted ack died with the connection", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    // A turn is running, so the send is queued rather than optimistic.
    startTurn(callbacks);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    acceptLastAction(harness);
    // It has left `pendingActions` - this record is now the only copy.
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({ action: "send", messageId: frame.messageId });

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toMatchObject({
      clientActionId: frame.clientActionId,
      content: CONTENT,
    });
    expect(state.failedSendRestoration?.reason ?? "").toContain(
      "A queued message was not confirmed after reconnect.",
    );
    // The record is gone, and so is the optimistic row standing in for it.
    expect(state.acceptedActions[frame.clientActionId]).toBeUndefined();
    expect(
      state.queue.items.some(
        (item) => item.kind === "prompt" && item.messageId === frame.messageId,
      ),
    ).toBe(false);
  });

  // `-MPLN`, the durability half. When the composer is busy the prompt cannot
  // go there, so it becomes a LAST-COPY notice: never evicted, survives an
  // unfocused pane, text inlined. Anything less and the displaced prompt is
  // simply destroyed by the newer draft, which is the loss this whole surface
  // exists to prevent - just arriving from the composer's side.
  it("states a displaced restoration as a last-copy notice", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    harness.handle.store
      .getState()
      .setCurrentComposerSettings({ ...SETTINGS, model: "gpt-5.6" });
    const rejected = rejectLastAction(harness, "Host refused the send.");
    expect(
      harness.handle.store.getState().failedSendRestoration,
    ).not.toBeNull();

    harness.handle.store.getState().stateFailedSendRestoration(rejected);

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    // BY CODE: the rejection already left an `ACTION_REJECTED` notice under
    // this same action id, and `noticeFor` would hand back whichever came
    // first. One action, two speakers - the same fact the tracker key learned.
    const stated = state.errorNotices.find(
      (notice) =>
        notice.clientActionId === rejected &&
        notice.code === "SEND_NOT_RECORDED",
    );
    expect(stated).toBeDefined();
    if (stated === undefined) throw new Error("Expected a last-copy statement");
    // The account it was carrying survives...
    expect(stated.message).toContain("Host refused the send.");
    expect(stated.message).toContain("model");
    // ...it says why the composer did not take it...
    expect(stated.message).toContain("started another message");
    // ...and the text itself is inlined, which is what makes it a last copy.
    expect(stated.message).toContain("Hello");
  });

  // `-NRic`: the two passes divide one send between them - the accepted pass
  // skips a send that still has an optimistic row because the settled pass
  // owns the row - but nothing retired the RECORD. The next snapshot then
  // found it never-confirmed, absent and from an earlier epoch, and recovered
  // the same send a second time.
  it("recovers a stranded send once, not again on the next snapshot", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    // Not queued: it keeps its optimistic row, so the SETTLED pass owns it.
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }
    acceptLastAction(harness);

    // Snapshot A settles the stranded row: recovery happens exactly here.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");
    expect(
      harness.handle.store.getState().failedSendRestoration,
    ).not.toBeNull();
    // ...and the record went with the row.
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toBeUndefined();

    // The composer takes it, freeing the slot.
    harness.handle.store
      .getState()
      .ackFailedSendRestoration(frame.clientActionId);

    // Snapshot B on a later epoch must find nothing left to recover.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    expect(
      state.errorNotices.filter(
        (notice) => notice.code === "SEND_NOT_RECORDED",
      ),
    ).toEqual([]);
  });

  // `P42f`: the same divide, at the LIVE site. `-NRic` fixed the record
  // retirement where the settled pass runs inside a snapshot; the settled
  // pass also runs on a live `turnStateChanged` frame, and THAT caller
  // applied every field of the patch except the retirement. So a send
  // settled live - prompt restored, row dropped - left its unconfirmed
  // record behind, and the next snapshot found it absent, from an earlier
  // epoch, never confirmed, and recovered the same send a second time. The
  // reconciler's own docblock promises "no later pass can find the same send
  // unaccounted for"; this held it at one of the two call sites.
  it("recovers a live-settled stranded send once, not again on the next snapshot", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    // Not queued: it keeps its optimistic row, so the SETTLED pass owns it.
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }
    acceptLastAction(harness);

    // A LIVE settled frame - not a snapshot - settles the stranded row:
    // recovery happens exactly here.
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });
    expect(
      harness.handle.store.getState().failedSendRestoration,
    ).not.toBeNull();
    // ...and the record went with the row, from this caller too.
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toBeUndefined();

    // The composer takes it, freeing the slot.
    harness.handle.store
      .getState()
      .ackFailedSendRestoration(frame.clientActionId);

    // A snapshot on a later epoch must find nothing left to recover.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    expect(
      state.errorNotices.filter(
        (notice) => notice.code === "SEND_NOT_RECORDED",
      ),
    ).toEqual([]);
  });

  // `-N1x4`: the displaced path used to leave the older send's re-staged
  // binding attached to the NEWER draft, so submitting that draft ran in a
  // checkout the user never picked for it. "Visible in the picker" does not
  // survive that - it is a silent wrong-checkout submit.
  it("releases the binding when the prompt is displaced to a notice", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const staged: WorktreeIntent["entries"][number] = {
      kind: "local",
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
    };
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, { entries: [staged] });

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const rejected = rejectLastAction(harness, "Host refused the send.");
    // The hand-back put the binding back with the prompt.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual({ entries: [staged] });

    // The composer is busy, so the prompt is stated rather than restored -
    // and its binding must not stay attached to somebody else's draft.
    harness.handle.store.getState().stateFailedSendRestoration(rejected);

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  // Per SITE, because the capture ordering is per site: the rejection version
  // above passes on an ordering the two reconcile paths did not share. This is
  // the SNAPSHOT path.
  it("releases the binding when a snapshot-restored prompt is displaced", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    useWorktreeIntentStagingStore.getState().setIntent(key, {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected a send frame");

    // The snapshot pass restores it and hands the binding back.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeDefined();

    harness.handle.store
      .getState()
      .stateFailedSendRestoration(frame.clientActionId);

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  // ...and the TURN-SETTLED path, whose capture site is different again.
  it("releases the binding when a turn-settled restored prompt is displaced", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    useWorktreeIntentStagingStore.getState().setIntent(key, {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected a send frame");
    // Accepted, so only a live turn settling can strand it.
    acceptLastAction(harness);

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });
    expect(
      harness.handle.store.getState().failedSendRestoration,
    ).not.toBeNull();
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeDefined();

    harness.handle.store
      .getState()
      .stateFailedSendRestoration(frame.clientActionId);

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  // ...and the notice then has to ASK for the re-pick, because nothing else
  // will. With `handedBack: true` the clauses report a binding that came back,
  // which is now false.
  it("asks for a re-pick in a displaced notice", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    useWorktreeIntentStagingStore.getState().setIntent(key, {
      entries: [
        {
          kind: "worktree",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          scripts: null,
          branch: { type: "existing", name: "feat/kept" },
        },
      ],
    });

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const rejected = rejectLastAction(harness, "Host refused the send.");
    harness.handle.store.getState().stateFailedSendRestoration(rejected);

    const stated = harness.handle.store
      .getState()
      .errorNotices.find(
        (notice) =>
          notice.clientActionId === rejected &&
          notice.code === "SEND_NOT_RECORDED",
      );
    expect(stated?.message ?? "").toContain("feat/kept");
    expect(stated?.message ?? "").toContain("re-pick");
  });

  // The refusal branch. `restoreStagedWorktreeIntent` has three doors that
  // refuse BEFORE its write, and a refusal bumps no revision - so a capture
  // taken unconditionally still matches at displacement and the release
  // deletes whatever is standing at the key. Here that is the user's own
  // unconsumed pick: nothing was handed back, so nothing may be taken back.
  it("leaves a standing pick alone when the hand-back was refused", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };

    // The send CONSUMES a staged pick, so its pending action carries a
    // worktree intent - which is what gets a capture taken for it.
    useWorktreeIntentStagingStore.getState().setIntent(key, {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected a send frame");

    // The user then stages a NEW pick. That write clears the dispatch mark, so
    // the slot is no longer awaiting any dispatch's outcome and the hand-back
    // below is REFUSED - their pick wins, correctly.
    const standingPick: WorktreeIntent["entries"][number] = {
      kind: "local",
      workspacePath: "/users-own-pick",
      repoIdentifier: null,
      isPrimary: true,
    };
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, { entries: [standingPick] });

    // A reconnect restoration arrives carrying a worktree intent...
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");
    expect(
      harness.handle.store.getState().failedSendRestoration,
    ).not.toBeNull();
    // ...and the hand-back was refused: the user's pick still stands.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual({ entries: [standingPick] });

    // The composer is busy, so the prompt is displaced. Nothing was staged by
    // that hand-back, so the release must take nothing.
    harness.handle.store
      .getState()
      .stateFailedSendRestoration(frame.clientActionId);

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual({ entries: [standingPick] });
  });

  // The blind-clear concern that motivated the old call, as a TEST: the unwind
  // is scoped by the staging revision the hand-back left, so anything that has
  // touched the slot since - a user pick, a newer dispatch - makes it a no-op.
  it("leaves a pick made after the hand-back alone", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    useWorktreeIntentStagingStore.getState().setIntent(key, {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const rejected = rejectLastAction(harness, "Host refused the send.");

    // The user picks something else AFTER the hand-back.
    const ownPick: WorktreeIntent["entries"][number] = {
      kind: "local",
      workspacePath: "/other-repo",
      repoIdentifier: null,
      isPrimary: true,
    };
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, { entries: [ownPick] });

    harness.handle.store.getState().stateFailedSendRestoration(rejected);

    // Their pick stands: the revision moved, so the unwind declined to act.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual({ entries: [ownPick] });
  });

  // `-NRii`: this notice is the LAST accounting - the optimistic row is gone -
  // so it owes the same content clauses the displaced statement gives. An
  // attachment-only prompt produced a notice with no body AND no hint that
  // anything had existed.
  it("names attachment losses in a displaced restoration", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      IMAGE_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const rejected = rejectLastAction(harness, "Host refused the send.");
    harness.handle.store.getState().stateFailedSendRestoration(rejected);

    const stated = harness.handle.store
      .getState()
      .errorNotices.find(
        (notice) =>
          notice.clientActionId === rejected &&
          notice.code === "SEND_NOT_RECORDED",
      );
    expect(stated?.message ?? "").toContain("image attachment");
    // The account is said ONCE: `reason` already carries it, so the shared
    // builder must not render it a second time.
    const occurrences =
      (stated?.message ?? "").split("Host refused the send.").length - 1;
    expect(occurrences).toBe(1);
  });

  // Door 4: the ACK-FIRST ordering. Whether the accepted ack or the
  // `queueChanged` broadcast wins is a race between an RPC settling and a
  // broadcast landing. When the queue frame wins, the send is still pending
  // and the queue pass transitions it - confirmed on the way through. When the
  // ACK wins, the record has already left `pendingActions`, that pass is a
  // no-op, and nothing ever marked it confirmed. Cancel-safety rests entirely
  // on confirmation, so an unstamped record here is a canceled prompt waiting
  // for the next reconnect to resurrect it.
  it("stays quiet when the ack beat the queue frame and the user canceled", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }

    // ACK FIRST: the record leaves `pendingActions` before the queue frame.
    acceptLastAction(harness);
    expect(
      harness.handle.store.getState().pendingActions[frame.clientActionId],
    ).toBeUndefined();
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({ confirmedByHost: false });

    // ...then the live queue frame reports it parked. Nothing is pending, so
    // only the accepted-record stamping pass can see this.
    callbacks.onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: {
        status: "running",
        items: [
          {
            kind: "prompt",
            queueItemId: `queue-${frame.messageId}`,
            messageId: frame.messageId,
            message: {
              kind: "user",
              content: CONTENT,
              browserAnnotations: [],
            },
            sender: { type: "user", userId: OWNER_ID },
            settings: SETTINGS,
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
    });
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({ confirmedByHost: true });

    // The user cancels; the queue empties and the reconnect snapshot lacks it.
    callbacks.onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: { status: "running", items: [] },
    });
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    expect(
      state.errorNotices.filter(
        (notice) => notice.clientActionId === frame.clientActionId,
      ),
    ).toEqual([]);
  });

  // Door 5: `messageAccepted`, and the one that closes the set. Every other
  // door reads the queue or a snapshot, so an IMMEDIATE send - one that
  // materializes straight into the transcript instead of parking - reaches
  // none of them when its ack wins the race: the record leaves
  // `pendingActions` at the ack, the two queue passes never see it, and this
  // frame is the only thing that ever confirms it. Note the absence of
  // `startTurn` below; that is the whole point of the shape.
  //
  // It matters because an accepted message can legitimately go away again.
  // `editUserMessage` rewrites history from the edited message onward, so a
  // message this frame appended is gone from every later snapshot - and an
  // unstamped record reads that absence as death and pushes a deliberately
  // removed prompt back at the user, the `-MPLI` resurrection through a fifth
  // door.
  it("stays quiet when messageAccepted confirmed the send and an edit then removed it", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }

    // ACK FIRST: the record leaves `pendingActions` still unconfirmed, and
    // nothing queues an immediate send, so no queue pass can ever stamp it.
    acceptLastAction(harness);
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({ confirmedByHost: false });

    // The host reports it in the transcript. That IS confirmation.
    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: frame.messageId,
        sender: { type: "user", userId: OWNER_ID },
        message: {
          kind: "user",
          content: CONTENT,
          browserAnnotations: [],
        },
        timestamp: 2,
        sessionAnchor: null,
      },
    });
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({ confirmedByHost: true });
    expect(
      harness.handle.store
        .getState()
        .messages.some((message) => message.messageId === frame.messageId),
    ).toBe(true);

    // ...then an edit rewrites history and the message is gone for good.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    expect(
      state.errorNotices.filter(
        (notice) => notice.clientActionId === frame.clientActionId,
      ),
    ).toEqual([]);
  });

  // The MIRROR order of door 5's race, which the stamp alone cannot reach.
  // `messageAccepted` legitimately arrives before the ack - the
  // `takeSetupFailedRestoration` docblock names this order as its slot 2 - and
  // in that order door 5 fires while the send is still PENDING: no accepted
  // record exists, the stamp finds nothing, and that is correct. The ack then
  // births the record, and a hardcoded `false` at that birth threw away the
  // sighting: the message sat host-authoritative in `state.messages` while its
  // record said unconfirmed, so an `editUserMessage` removing it plus a
  // reconnect resurrected it through the other arm of the same race. Birth
  // must carry what the transcript already holds.
  it("stays quiet when messageAccepted outran the ack and an edit then removed it", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }

    // TRANSCRIPT FIRST: the host reports the message while the send is still
    // pending. Door 5 has no record to stamp, and correctly stamps nothing.
    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: frame.messageId,
        sender: { type: "user", userId: OWNER_ID },
        message: {
          kind: "user",
          content: CONTENT,
          browserAnnotations: [],
        },
        timestamp: 2,
        sessionAnchor: null,
      },
    });
    expect(
      harness.handle.store.getState().pendingActions[frame.clientActionId],
    ).toBeDefined();
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toBeUndefined();

    // ...then the ack lands and the record is BORN. The transcript already
    // holds the message, and the birth must say so.
    acceptLastAction(harness);
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({ confirmedByHost: true });

    // An edit rewrites history; the message is gone from every later snapshot.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    expect(
      state.errorNotices.filter(
        (notice) => notice.clientActionId === frame.clientActionId,
      ),
    ).toEqual([]);
  });

  // The negative at the same birth: the ack itself still confirms NOTHING.
  // With no transcript sighting the record must be born unconfirmed, or every
  // acked-then-dropped send would die silently - the dangerous direction.
  // Stated as its own test so the claim survives independently of the door
  // tests that assert it mid-flight.
  it("births the ack record unconfirmed when the transcript lacks the message", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }
    acceptLastAction(harness);

    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({ confirmedByHost: false });
  });

  // The other half of door 5, and the half a stamp door fails at quietly: it
  // must confirm the record the frame NAMES, not merely some unconfirmed send.
  // A door that stamps the first record it finds silences a send the host
  // never confirmed - the exact failure the stamp exists to prevent, inverted
  // onto a different prompt. So the frame here names the SECOND send while the
  // first is still unconfirmed, which is the only ordering that can tell the
  // two apart.
  it("confirms only the send messageAccepted names, and reports the other", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks);

    sendTwo(harness, CONTENT, SECOND_CONTENT);
    const [first, second] = harness.sent;
    if (first.kind !== "send" || second.kind !== "send") {
      throw new Error("Expected two send frames");
    }
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: first.clientActionId,
      action: "send",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });
    acceptLastAction(harness);

    // The host dispatches the SECOND one out of the queue and reports it.
    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: second.messageId,
        sender: { type: "user", userId: OWNER_ID },
        message: {
          kind: "user",
          content: SECOND_CONTENT,
          browserAnnotations: [],
        },
        timestamp: 2,
        sessionAnchor: null,
      },
    });

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    // Named: confirmed, and so silent about its later absence.
    expect(state.acceptedActions[second.clientActionId]).toMatchObject({
      confirmedByHost: true,
    });
    expect(
      state.errorNotices.filter(
        (notice) => notice.clientActionId === second.clientActionId,
      ),
    ).toEqual([]);
    // Not named: nothing ever confirmed it, it is gone, and it keeps its
    // account. Asserted on the CONTENT, because a door that stamped the wrong
    // record would still leave a restoration here - just the wrong prompt in
    // it.
    expect(state.failedSendRestoration?.clientActionId).toBe(
      first.clientActionId,
    );
    expect(state.failedSendRestoration?.content).toEqual(CONTENT);
  });

  // `-MPLI` through the COMMON door. Confirmation arrives three ways and only
  // one is a snapshot: a live `queueChanged` fires promptly on the dispatching
  // connection and is how most queued sends are confirmed. That transition
  // happens BECAUSE the host's queue reports the message, so it confirms - and
  // a record left unstamped there resurrects a canceled prompt on the next
  // reconnect exactly as an unstamped snapshot would.
  it("stays quiet about a send confirmed by queueChanged and then canceled", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }

    // Door 1: the host reports it queued. No snapshot involved.
    callbacks.onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: {
        status: "running",
        items: [
          {
            kind: "prompt",
            queueItemId: `queue-${frame.messageId}`,
            messageId: frame.messageId,
            message: {
              kind: "user",
              content: CONTENT,
              browserAnnotations: [],
            },
            sender: { type: "user", userId: OWNER_ID },
            settings: SETTINGS,
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
    });
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({ confirmedByHost: true });

    // The user cancels it, so the queue - and every later snapshot - lacks it.
    callbacks.onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: { status: "running", items: [] },
    });
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    expect(
      state.errorNotices.filter(
        (notice) => notice.clientActionId === frame.clientActionId,
      ),
    ).toEqual([]);
  });

  // Door 2: a send still PENDING when a snapshot shows it queued transitions
  // to accepted BECAUSE of that sighting, so it is confirmed on the way
  // through. Same rule, third door - and the one an unstamped `false` would
  // hide behind the other two passing.
  it("stays quiet about a send a snapshot confirmed while still pending", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }
    // No ack: it is still pending when the snapshot arrives showing it queued.
    expect(
      harness.handle.store.getState().pendingActions[frame.clientActionId],
    ).toBeDefined();

    emitSnapshotWithQueuedSend(callbacks, frame.messageId);
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({ confirmedByHost: true });

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    expect(
      state.errorNotices.filter(
        (notice) => notice.clientActionId === frame.clientActionId,
      ),
    ).toEqual([]);
  });

  // `-MPLI`: absence stops being evidence once presence has been SEEN. A
  // queued send the user then cancels is absent from every later snapshot, and
  // reading that as death pushed the deliberately-discarded prompt back at
  // them - on top of the copy the cancel UX already put in the composer. The
  // host queue is durable across restarts, so for an observed send a later
  // absence can only be a cancel or a consumption; neither is ours to narrate.
  it("stays quiet about a queued send it once saw and the user then canceled", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }
    acceptLastAction(harness);

    // A snapshot CONFIRMS it parked in the host queue...
    emitSnapshotWithQueuedSend(callbacks, frame.messageId);
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({ confirmedByHost: true });

    // ...the user cancels it, so every later snapshot lacks it.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    expect(
      state.errorNotices.filter(
        (notice) => notice.clientActionId === frame.clientActionId,
      ),
    ).toEqual([]);
  });

  // Same evidence bar as the pending pass, and for the same reason: a refresh
  // snapshot on the LIVE connection has simply outrun the send.
  it("keeps a just-accepted queued send when a same-connection snapshot omits it", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }
    acceptLastAction(harness);

    // No connection transition: same epoch.
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    expect(state.acceptedActions[frame.clientActionId]).toMatchObject({
      action: "send",
    });
  });

  // PRESENCE is authoritative whatever dispatched it: the host has the send
  // parked in its queue, so nothing is owed and the record ages out normally.
  it("settles a queued send the reconnect snapshot still shows queued", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }
    acceptLastAction(harness);

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotWithQueuedSend(callbacks, frame.messageId);

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration).toBeNull();
    expect(
      state.errorNotices.filter(
        (notice) => notice.clientActionId === frame.clientActionId,
      ),
    ).toEqual([]);
  });

  // `-Jy83`: a `SEND_RESTORED` notice is replayable ON PURPOSE - it can arrive
  // while the pane is unfocused, and the ring is its ONLY replay source. The
  // ordinary 32-record cap deleted it before the pane ever came back, so the
  // qualifications vanished while the restored prompt sat in the composer
  // ready to resend. It is NOT last-copy (the draft is safe, so no permanent
  // pin); the axis is different - survive EVICTION until DELIVERED.
  it("keeps a restored-send notice through the cap until the pane sees it", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected a send frame");
    harness.handle.store
      .getState()
      .setCurrentComposerSettings({ ...SETTINGS, model: "gpt-5.6" });
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");
    harness.handle.store
      .getState()
      .ackFailedSendRestoration(frame.clientActionId);

    const restoredNotice = () =>
      harness.handle.store
        .getState()
        .errorNotices.find((notice) => notice.code === "SEND_RESTORED");
    expect(restoredNotice()).toBeDefined();

    const flood = (from: number) => {
      for (let index = from; index < from + MAX_ERROR_NOTICE_RECORDS * 2;) {
        callbacks.onErrorNotice({
          kind: "errorNotice",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          notice: {
            code: "APPROVAL_NOT_PENDING",
            message: `No longer pending (${index}).`,
            severity: "warning",
            clientActionId: `approval-${index}`,
          },
        });
        index += 1;
      }
    };

    // Undelivered: it outlives far more than the cap's worth of history.
    flood(0);
    expect(restoredNotice()).toBeDefined();

    // Once the pane has actually shown it, it is ordinary history again and
    // ages out like anything else - the exemption is a delivery guarantee,
    // not a permanent pin.
    harness.handle.store.getState().markNoticeDelivered(frame.clientActionId);
    flood(1000);
    expect(restoredNotice()).toBeUndefined();
  });

  // `-IfOo`: the qualifications were written to `failedSendRestoration.reason`
  // and read by NOBODY. `nextHandoffTransition` is that field's only consumer
  // and both branches are dead ends - `markFailedByAction` routes it to
  // `InitialChatHandoff.failureReason`, which no component renders, and
  // `restoreAndAckFailed` drops it. The ack is where the draft lands in the
  // composer, and the one moment both branches share, so it speaks there.
  it("states why a restored prompt came back when the composer takes it", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected a send frame");

    // The chat's model moves while the send is in flight, so the restored
    // prompt would resend under something else.
    harness.handle.store
      .getState()
      .setCurrentComposerSettings({ ...SETTINGS, model: "gpt-5.6" });
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const reason =
      harness.handle.store.getState().failedSendRestoration?.reason ?? "";
    expect(reason).toContain("model");

    // Nothing has been said yet - the draft is still in the slot.
    expect(
      harness.handle.store
        .getState()
        .errorNotices.filter((notice) => notice.code === "SEND_RESTORED"),
    ).toEqual([]);

    harness.handle.store
      .getState()
      .ackFailedSendRestoration(frame.clientActionId);

    const stated = harness.handle.store
      .getState()
      .errorNotices.filter((notice) => notice.code === "SEND_RESTORED");
    expect(stated).toHaveLength(1);
    expect(stated[0].message).toBe(reason);
    expect(stated[0].severity).toBe("warning");
  });

  // Spoken exactly ONCE - when the rejection's own notice actually REACHED the
  // user. `-LV77`: deferring to a notice that was merely appended left the
  // prompt in the composer with silently changed semantics whenever the pane
  // was unfocused, so the ack now asks the delivery axis rather than assuming.
  it("does not repeat a rejection's account the user has already seen", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    harness.handle.store
      .getState()
      .setCurrentComposerSettings({ ...SETTINGS, model: "gpt-5.6" });
    const rejected = rejectLastAction(harness, "Host refused the send.");

    // The rejection said it on its own surface, qualifications included.
    const spoken = noticeFor(harness, rejected);
    expect(spoken.message).toContain("Host refused the send.");
    expect(spoken.message).toContain("model");

    // The pane was active, so the toast layer showed it and said so.
    harness.handle.store.getState().markNoticeDelivered(rejected);
    harness.handle.store.getState().ackFailedSendRestoration(rejected);

    expect(
      harness.handle.store
        .getState()
        .errorNotices.filter((notice) => notice.code === "SEND_RESTORED"),
    ).toEqual([]);
  });

  // ...and the other half of `-LV77`: the pane was NOT active, so nothing
  // showed the rejection notice. Its qualifications must still reach the user,
  // because the prompt is sitting in the composer ready to resend under a
  // different model / account / delivery than it was written for.
  it("says a rejection's account the user never saw when the draft returns", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    harness.handle.store
      .getState()
      .setCurrentComposerSettings({ ...SETTINGS, model: "gpt-5.6" });
    const rejected = rejectLastAction(harness, "Host refused the send.");

    // No `markNoticeDelivered`: the pane was elsewhere, so the ring holds a
    // notice nobody has seen.
    harness.handle.store.getState().ackFailedSendRestoration(rejected);

    const spoken = harness.handle.store
      .getState()
      .errorNotices.filter((notice) => notice.code === "SEND_RESTORED");
    expect(spoken).toHaveLength(1);
    expect(spoken[0].message).toContain("model");
  });

  // The flood case: the rejection notice can be EVICTED before the pane comes
  // back, so it is not merely unseen but gone. The ack is the backstop either
  // way, because it asks about delivery rather than about the ring.
  it("says the account when the rejection notice was evicted before refocus", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    harness.handle.store
      .getState()
      .setCurrentComposerSettings({ ...SETTINGS, model: "gpt-5.6" });
    const rejected = rejectLastAction(harness, "Host refused the send.");

    for (let index = 0; index < MAX_ERROR_NOTICE_RECORDS * 2; index += 1) {
      callbacks.onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "APPROVAL_NOT_PENDING",
          message: `No longer pending (${index}).`,
          severity: "warning",
          clientActionId: `approval-${index}`,
        },
      });
    }
    expect(
      harness.handle.store
        .getState()
        .errorNotices.some((notice) => notice.clientActionId === rejected),
    ).toBe(false);

    harness.handle.store.getState().ackFailedSendRestoration(rejected);

    const spoken = harness.handle.store
      .getState()
      .errorNotices.filter((notice) => notice.code === "SEND_RESTORED");
    expect(spoken).toHaveLength(1);
    expect(spoken[0].message).toContain("model");
  });

  // The silence rule's premise is "the user can see why". It holds when their
  // own pick stands in the slot, so a statement would narrate their own action
  // back at them - and this is the case that must NOT start speaking.
  it("says nothing about a worktree the user re-picked themselves", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };

    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/sent"));
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    // The user picks again while the send is in flight, so their choice is
    // standing in the slot when the rejection lands.
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/repicked"));
    rejectLastAction(harness, "Host refused the send.");

    const reason =
      harness.handle.store.getState().failedSendRestoration?.reason ?? "";
    expect(reason).toContain("Host refused the send.");
    expect(reason).not.toContain("taken by a later message");
    expect(reason).not.toContain("no longer exists");
  });

  // The other silent arm: no mark at all. The user cleared the slot, so
  // sending without a worktree was their decision.
  it("says nothing about a worktree the user cleared", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };

    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/sent"));
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    useWorktreeIntentStagingStore.getState().clear(key);
    rejectLastAction(harness, "Host refused the send.");

    const reason =
      harness.handle.store.getState().failedSendRestoration?.reason ?? "";
    expect(reason).not.toContain("taken by a later message");
  });

  // The same pairing rule, reached through the OTHER door. The sweep's
  // fallback defers to a prompt handed back by its own pass - but a prompt
  // handed back by an EARLIER pass is still sitting in the slot, and staging a
  // swept action's binding under it is the identical mismatch.
  it("never pairs an earlier restored prompt with a swept action's worktree", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };

    // A rejected send claims the restoration slot; the composer has not
    // consumed it yet.
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    rejectLastAction(harness, "Host refused the send.");
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(CONTENT);

    // An edit then stages and consumes its own pick, and never gets its ack.
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/edit"));
    expect(
      harness.handle.store.getState().editUserMessage({
        targetMessageId: "msg-original",
        content: SECOND_CONTENT,
        sender: { type: "user", userId: OWNER_ID },
        settings: SETTINGS,
        revertFileChanges: false,
        revertArtifacts: false,
      }),
    ).not.toBeNull();

    // The reconnect sweeps the edit. No prompt is handed back by THIS pass, so
    // the sweep's fallback would otherwise stage the edit's pick - underneath
    // the send's prompt that is still waiting in the slot.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(CONTENT);
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  it("does not restore a rejected worktree intent after a newer explicit clear", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected send frame");
    }

    // The send consumed this slot. Clearing the now-empty slot is a deliberate
    // newer choice to send without a workspace selection on retry.
    useWorktreeIntentStagingStore.getState().clear(key);

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "send",
      status: "rejected",
      reason: "Stop the active chat run before rebinding its worktree.",
      code: "WORKTREE_CREATE_FAILED",
      backgroundStopTaskIds: [],
    });

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  it("refuses chat send while staged worktree metadata is unresolved", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat-unresolved",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    });
    useWorktreeIntentStagingStore
      .getState()
      .setSuspendedWorkspacePaths(key, ["/repo"]);

    const result = sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    expect(result).toBeNull();
    expect(harness.sent).toEqual([]);
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeDefined();
  });

  it("sends worktreeIntent null when nothing is staged", () => {
    useWorktreeIntentStagingStore.setState({ intentByKey: {} });
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected send frame");
    }
    expect(frame.worktreeIntent).toBeNull();
  });

  it("keeps accepted send records consumable until they are acked", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "send",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });

    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({
      action: "send",
      messageId: frame.messageId,
    });

    harness.handle.store.getState().ackAcceptedAction(frame.clientActionId);

    expect(
      Object.hasOwn(
        harness.handle.store.getState().acceptedActions,
        frame.clientActionId,
      ),
    ).toBe(false);
  });

  it("restores an unconfirmed send when a reconnect snapshot omits it", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(harness.handle.store.getState().failedSendRestoration).toEqual({
      clientActionId: frame.clientActionId,
      content: CONTENT,
      browserAnnotations: [],
      reason: "Message was not confirmed after reconnect.",
      displacedReason: "Message was not confirmed after reconnect.",
      stated: false,
    });
  });

  // The restoration slot is a single slot, first-writer-wins. A send that
  // loses it is DEAD - its ack died with the connection and this snapshot is
  // authoritative - so it is settled here and now rather than left pending.
  // Leaving it eligible is what made the same statement re-fire on every later
  // snapshot, and what let its stale text walk back into the composer after
  // the user had already resent it.
  it("settles and states a displaced send once, without re-presenting it", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const first = harness.sent[0];
    const second = harness.sent[1];
    if (first.kind !== "send" || second.kind !== "send") {
      throw new Error("Expected two send frames");
    }

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const noticesFor = (clientActionId: string) =>
      harness.handle.store
        .getState()
        .errorNotices.filter(
          (notice) => notice.clientActionId === clientActionId,
        );

    // First writer keeps the slot: it has waited longest, so last-wins would
    // bury it instead.
    expect(harness.handle.store.getState().failedSendRestoration).toEqual({
      clientActionId: first.clientActionId,
      content: CONTENT,
      browserAnnotations: [],
      reason: "Message was not confirmed after reconnect.",
      displacedReason: "Message was not confirmed after reconnect.",
      stated: false,
    });
    // The displaced send is stated, and the statement carries its text - the
    // row is gone, so nothing else holds it.
    expect(noticesFor(second.clientActionId)).toHaveLength(1);
    expect(noticesFor(second.clientActionId)[0]).toMatchObject({
      code: "SEND_NOT_RECORDED",
      severity: "warning",
    });
    expect(noticesFor(second.clientActionId)[0].message).toContain("World");
    // Settled, not parked: no pending action, no row that will never confirm.
    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);

    // THREAD 1: a second snapshot must not restate it. The action is gone, so
    // there is nothing left to re-present - the ring keeps one statement
    // rather than one per snapshot until it evicts unrelated notices.
    emitSnapshot(callbacks, "owner");
    emitSnapshot(callbacks, "owner");

    expect(noticesFor(second.clientActionId)).toHaveLength(1);
  });

  // Once the row is dropped the notice IS the data, so it inherits the row's
  // durability. The ring is a capped FIFO built for notice HISTORY, where
  // eviction lost a pointer and the text survived on screen. Now eviction
  // would destroy the draft outright - so a last-copy statement is not
  // evictable history, it is the last copy.
  it("keeps a last-copy statement when the notice ring overflows", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");
    expect(
      harness.handle.store
        .getState()
        .errorNotices.filter(
          (notice) => notice.clientActionId === second.clientActionId,
        ),
    ).toHaveLength(1);

    // A busy chat buries it - a pane left inactive while ordinary notices
    // arrive is exactly how this happens, and the mount replay never runs.
    for (let index = 0; index < MAX_ERROR_NOTICE_RECORDS * 2; index += 1) {
      callbacks.onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "APPROVAL_NOT_PENDING",
          message: `The approval request is no longer pending (${index}).`,
          severity: "warning",
          clientActionId: `approval-${index}`,
        },
      });
    }

    const state = harness.handle.store.getState();
    const survivor = state.errorNotices.filter(
      (notice) => notice.clientActionId === second.clientActionId,
    );
    expect(survivor).toHaveLength(1);
    expect(survivor[0].message).toContain("World");
    // Ordinary history still rotates - the exemption is for last-copy
    // records, not a licence for the ring to grow without bound.
    expect(
      state.errorNotices.filter(
        (notice) => notice.code === "APPROVAL_NOT_PENDING",
      ).length,
    ).toBeLessThanOrEqual(MAX_ERROR_NOTICE_RECORDS);
  });

  // The exemption above is only safe because a last-copy record cannot pile
  // up: one per settled send. Dedupe on insert is what guarantees that, and
  // it is also the answer to a re-emitting path appending the same statement
  // forever - the hazard the ring's append-only shape used to carry.
  it("keeps one last-copy record per send however often it is appended", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    // A FRESH object each time, so the dedupe cannot pass on reference
    // equality - the store has to key on the client action id.
    for (let index = 0; index < 5; index += 1) {
      callbacks.onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "SEND_NOT_RECORDED",
          message:
            "A message was not recorded.\n\nCopy the message below to resend it:\ndraft",
          severity: "warning",
          clientActionId: "send-1",
        },
      });
    }

    expect(
      harness.handle.store
        .getState()
        .errorNotices.filter((entry) => entry.clientActionId === "send-1"),
    ).toHaveLength(1);
  });

  // R11 `-ApT-`: a multi-workspace intent labelled as "branch a, branch b"
  // with no workspace association, so a multi-repo staging could not actually
  // be re-picked. A SINGLE-workspace intent stays unqualified - the workspace
  // is unambiguous there and naming it would be noise.
  it("associates each staged branch with its workspace when several are staged", () => {
    const notice = statedNoticeWithIntent({
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo/frontend",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat/fe",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo/backend",
          repoIdentifier: null,
          isPrimary: false,
          branch: { type: "existing", name: "feat/be" },
        },
      ],
    });

    expect(notice.message).toContain("/repo/frontend");
    expect(notice.message).toContain("/repo/backend");
  });

  it("leaves a single staged workspace unqualified", () => {
    const notice = statedNoticeWithIntent(worktreeIntentFor("feat/only"));

    expect(notice.message).toContain("feat/only");
    expect(notice.message).not.toContain(" in /repo");
  });

  // R12 `-A8bB`: the winning prompt's claim is TERMINAL. A send deliberately
  // dispatched with no worktree still decides the slot - it just decides it is
  // empty. Skipping a null claim let a stale edit's binding attach itself to a
  // prompt that was sent without one: the same wrong-binding hazard as round
  // 10, reached through the gap in the precedence rule.
  it("leaves the slot empty when the winning prompt carried no worktree", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };

    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/edit"));
    harness.handle.store.getState().editUserMessage({
      targetMessageId: "msg-original",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      revertFileChanges: false,
      revertArtifacts: false,
    });
    // A send deliberately dispatched with NO worktree staged.
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    // The send's prompt won restoration and was sent without a worktree - so
    // the composer must be exactly that: prompt back, slot empty.
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(SECOND_CONTENT);
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  // R10 `-AdAP`: the consumed-mark said "a dispatch took this slot" but not
  // WHICH one. With a dead edit and a dead send both wanting their intent
  // back, the sweep runs first and the older EDIT claimed the mark - so the
  // send's recovered prompt landed in the composer bound to the edit's
  // worktree. Wrong binding is worse than none: the resend looks right.
  it("re-stages the intent belonging to the prompt it handed back", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const editIntent = worktreeIntentFor("feat/edit");
    const sendIntent = worktreeIntentFor("feat/send");

    useWorktreeIntentStagingStore.getState().setIntent(key, editIntent);
    harness.handle.store.getState().editUserMessage({
      targetMessageId: "msg-original",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      revertFileChanges: false,
      revertArtifacts: false,
    });
    // A newer pick, consumed by a SEND. The slot's last consumer is the send.
    useWorktreeIntentStagingStore.getState().setIntent(key, sendIntent);
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    // Both die. The sweep restores the edit first, then the reconcile hands
    // the send's prompt back.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    // The prompt in the composer is the SEND's...
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(SECOND_CONTENT);
    // ...so the worktree staged with it must be the SEND's, and never the
    // edit's - an unrelated action's restoration must not bind this prompt.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(sendIntent);
  });

  // R13 `-BtWD`: the consume-site mirror of round 12's terminal-claim rule. An
  // intent-FREE send skipped `consumeForDispatch` entirely, so the mark stayed
  // owned by an earlier edit - and that edit's rejection handed E back even
  // though a later send had superseded it. A dispatch's state is authoritative
  // whether or not it took a pick.
  it("supersedes an outstanding mark even when the send took no pick", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };

    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/edit"));
    harness.handle.store.getState().editUserMessage({
      targetMessageId: "msg-original",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      revertFileChanges: false,
      revertArtifacts: false,
    });
    const editFrame = harness.sent.at(-1);
    if (editFrame === undefined || editFrame.kind !== "editUserMessage") {
      throw new Error("Expected an edit frame");
    }
    // A later send with NOTHING staged - it takes no pick, but it is still a
    // dispatch and still the current state of this slot.
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: editFrame.clientActionId,
      action: "editUserMessage",
      status: "rejected",
      reason: "Host refused the edit.",
      code: null,
      backgroundStopTaskIds: [],
    });

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  // R13 `-BmQF`: the sweep tested the LAST consumption's entries, but a
  // restoration hands back its OWN action's intent. Send 1 took A; the user
  // then staged B and send 2 took that, so the mark describes B. A sweep that
  // removes A leaves the mark untouched - and send 1's prompt comes back with
  // a worktree that no longer exists.
  it("refuses a hand-back whose own worktree was swept, not the last one's", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };

    useWorktreeIntentStagingStore.getState().setIntent(key, {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: { type: "existing", name: "feat/gone" },
        },
      ],
    });
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    // A newer pick, consumed by a second send: the mark now describes THIS
    // one, and the RESTORATION path is deliberately ownerless - so it stages
    // send 1's own intent while the mark's entries belong to send 2.
    useWorktreeIntentStagingStore.getState().setIntent(key, {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          // A DIFFERENT source, so the sweep below cannot touch this one.
          branch: {
            type: "new",
            name: "feat/kept",
            source: "develop",
            carryUncommittedChanges: false,
          },
        },
      ],
    });
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    // The sweep removes the FIRST send's branch. The mark's own entries
    // survive it, so nothing about the mark changes.
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents("host-a", {
        worktreePaths: new Set<string>(),
        branches: [{ repoIdentifier: null, branch: "feat/gone" }],
      });

    // Both die; send 1's prompt wins the restoration slot, so its binding is
    // what the arbiter tries to stage - and that worktree is gone.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(CONTENT);
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  // R12 `-BZH4`: a third arrival order the claimant rules never saw. The edit
  // consumed E; the user then staged S and a send consumed THAT, so the slot's
  // mark now belongs to the send's dispatch. If the edit's rejection lands
  // first and hands E back, it takes a slot the send still needs AND
  // overrides a newer pick the user actually made.
  it("refuses a rejected action's pick when a later dispatch owns the slot", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage("msg-original")],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };

    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/edit"));
    harness.handle.store.getState().editUserMessage({
      targetMessageId: "msg-original",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      revertFileChanges: false,
      revertArtifacts: false,
    });
    const editFrame = harness.sent.at(-1);
    if (editFrame === undefined || editFrame.kind !== "editUserMessage") {
      throw new Error("Expected an edit frame");
    }

    // A NEWER pick, consumed by a send. The mark now represents that dispatch.
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/send"));
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    // The EDIT's rejection arrives.
    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: editFrame.clientActionId,
      action: "editUserMessage",
      status: "rejected",
      reason: "Host refused the edit.",
      code: null,
      backgroundStopTaskIds: [],
    });

    // It must not take the slot: that mark is the send's outcome to claim,
    // and E was superseded by the pick the user made after it.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
  });

  // R12 `-BQcb`: the rejection path refuses the hand-back like the reconnect
  // paths do, but states things through its own errorNotice rather than
  // `failedSendRestoration.reason` - so the refusal was silent here while
  // being spoken everywhere else.
  it("says the worktree is gone on the rejection path too", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/doomed"));
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    // The worktree the send is staged for is swept while it is in flight.
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents("host-a", {
        worktreePaths: new Set<string>(),
        branches: [{ repoIdentifier: null, branch: "main" }],
      });

    const rejected = rejectLastAction(harness, "Host refused the send.");

    const notice = noticeFor(harness, rejected);
    expect(notice.message).toContain("Host refused the send.");
    expect(notice.message).toContain(
      "staged worktree a new branch feat/doomed from main no longer exists",
    );
  });

  // `-CbBM`: the FOURTH surface. The send is accepted, its worktree is swept,
  // and a LIVE `turnStateChanged` settles the turn before `messageAccepted`.
  // The re-stage refuses correctly, but this path reached the refusal through
  // `restoreStagedWorktreeIntent` directly - never computing the flag - so the
  // prompt came back unbound with a reason that said only that it was not
  // recorded. Same rule, fourth surface.
  it("says the worktree is gone when a live turn settles the send", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/doomed"));
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    // Accepted, so the action leaves `pendingActions` while its optimistic row
    // waits for a `messageAccepted` that never arrives.
    acceptLastAction(harness);
    // The worktree it was staged for is swept while it waits.
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents("host-a", {
        worktreePaths: new Set<string>(),
        branches: [{ repoIdentifier: null, branch: "main" }],
      });

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    // The prompt came back...
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(CONTENT);
    // ...and the slot stayed empty, because the re-stage refused.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
    // So the reason has to say why.
    expect(
      harness.handle.store.getState().failedSendRestoration?.reason,
    ).toContain(
      "staged worktree a new branch feat/doomed from main no longer exists",
    );
  });

  // `-HVoV`: the displaced-rejection branch. Another rejected send already
  // holds the restoration slot, so this one is STATED rather than restored -
  // and the early return into the shared statement builder bypassed the only
  // branch that reported `worktreeGone`. The statement then told the user to
  // re-pick a worktree that had been deleted underneath them.
  it("does not tell a displaced rejection to re-pick a deleted worktree", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };

    // The first send is rejected and claims the restoration slot.
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    rejectLastAction(harness, "Host refused the first send.");

    // The second carries a staged worktree that is swept while it is in
    // flight, and is rejected into an occupied slot - so it is displaced.
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(key, worktreeIntentFor("feat/doomed"));
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    useWorktreeIntentStagingStore
      .getState()
      .purgeRemovedWorktreeIntents("host-a", {
        worktreePaths: new Set<string>(),
        branches: [{ repoIdentifier: null, branch: "main" }],
      });
    const displaced = rejectLastAction(harness, "Host refused the second.");

    const notice = noticeFor(harness, displaced);
    // It still carries the only copy of the text.
    expect(notice.message).toContain("World");
    // But it must not send the user after a worktree that is gone.
    expect(notice.message).toContain("no longer exists");
    expect(notice.message).not.toContain("re-pick that before resending");
  });

  // R13 `-B5UX`: the founding invariant's last uncovered surface. Two sends
  // rejected together - the first claims the restoration slot, the second's
  // optimistic row is dropped, and the rejection path appended only the host's
  // REASON. A dead send neither restored nor stated, on the one path that
  // never learned the obligation the settle passes learned in rounds 1-4.
  it("states a rejection-displaced send's text, not just the host's reason", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const first = harness.sent[0];
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const second = harness.sent[1];
    if (first.kind !== "send" || second.kind !== "send") {
      throw new Error("Expected two send frames");
    }

    const reject = (clientActionId: string) => {
      callbacks.onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        clientActionId,
        action: "send",
        status: "rejected",
        reason: "Host refused the send.",
        code: null,
        backgroundStopTaskIds: [],
      });
    };
    reject(first.clientActionId);
    reject(second.clientActionId);

    // First writer keeps the slot.
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(CONTENT);
    // The second is DISPLACED, so its text has to be in its statement - the
    // host's reason alone hands nothing back.
    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.code).toBe("SEND_NOT_RECORDED");
    expect(notice.message).toContain("World");
    expect(notice.message).toContain("Host refused the send");
  });

  // R13 `-BZHy`: the SEEDED first message (landing handoff) stamped PERSONAL
  // on its pendings while the frame carried the real context - so a
  // Team-billed first message that stranded would report it was going to bill
  // personal. A drift statement lying about the very thing it warns about.
  it("keeps a seeded send's real billing context", () => {
    useAccountContextStore.setState({
      accountContext: { type: "TEAM", teamId: "team-7" },
    });
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });
    // Occupy the restoration slot so the seeded send is STATED, not restored.
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    harness.handle.store.getState().sendSeededUserMessage({
      messageId: "seeded-1",
      clientActionId: "seeded-action-1",
      content: SECOND_CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
    });

    // Billing moves; the seeded send's own context must be what is reported.
    useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });

    const notice = noticeFor(harness, "seeded-action-1");
    expect(notice.message).toContain("billing team team-7");
  });

  // R13 `-BmQJ`: delivery is dispatched per send and dies with the action, so
  // a resend takes whatever the submit gesture implies then - a message queued
  // to land after a safe point can come back and interrupt instead.
  it("states a non-default delivery the send was queued with", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "after_safe_point" },
    );
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).toContain("reached a safe point");
  });

  it("says nothing about a default delivery", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    sendTwo(harness, CONTENT, SECOND_CONTENT);
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    // Naming `auto` every time would bury the case that matters.
    expect(noticeFor(harness, second.clientActionId).message).not.toContain(
      "queued to be delivered",
    );
  });

  // R12 `-A8bF`: billing context is stamped at dispatch and dies with the
  // action, so a resend bills whatever the picker holds now. Unlike a model
  // change it leaves no trace in the conversation.
  it("states that a resend would bill a different account", () => {
    useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
    const harness = createHarness();
    const callbacks = harness.callbacks();
    // Settings must be seeded: the drift clause needs BOTH tuples, and a
    // snapshot with `settings: null` short-circuits it before billing is
    // ever compared.
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });
    sendTwo(harness, CONTENT, SECOND_CONTENT);
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    useAccountContextStore.setState({
      accountContext: { type: "TEAM", teamId: "team-9" },
    });
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });

    const notice = noticeFor(harness, second.clientActionId);
    // Billing sits in the same drift table as the run settings now, so it
    // reads with them rather than as a separate sentence.
    expect(notice.message).toContain("billing your personal account");
    expect(notice.message).toContain("different settings now");
  });

  // R9 `-AQUj`: the drift compared against the last SNAPSHOT's settings. When
  // the user changes settings and a `turnStateChanged` settles the send before
  // another snapshot lands, the live composer already holds the new tuple - so
  // the clause was omitted exactly when the change most worth warning about
  // had just been made.
  it("compares drift against the live composer, not the last snapshot", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    rejectLastAction(harness, "Host refused the send.");
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const second = harness.sent.at(-1);
    if (second === undefined || second.kind !== "send") {
      throw new Error("Expected a send frame");
    }
    acceptLastAction(harness);

    // The user switches model. No snapshot follows - just the settle.
    harness.handle.store
      .getState()
      .setCurrentComposerSettings(UPDATED_SETTINGS);
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).toContain("gpt-5-codex");
  });

  // R9 `-AQUm`: `null` is a VALUE - "use the default" - not an absence. A send
  // dispatched under default effort and settled after the user picked an
  // explicit one drifts, and dropping the field because its sent value was
  // null hid exactly that.
  it("states drift from a default to an explicit value", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const defaulted = { ...SETTINGS, serviceTier: null };
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: defaulted,
    });
    sendTwo(harness, CONTENT, SECOND_CONTENT);
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: { ...defaulted, serviceTier: "priority" },
    });

    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).toContain("service tier default");
  });

  // R9 `-AQUo`: the exemption's cost must not be paid by ordinary history. The
  // cap counted TOTAL length, so retained records crowded the ordinary window
  // down to nothing and an ordinary notice was evicted before it was ever seen.
  it("keeps the ordinary notice window intact alongside retained records", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    for (let index = 0; index < MAX_ERROR_NOTICE_RECORDS; index += 1) {
      callbacks.onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "SEND_NOT_RECORDED",
          message: `draft ${index}`,
          severity: "warning",
          clientActionId: `send-${index}`,
        },
      });
    }
    for (let index = 0; index < 4; index += 1) {
      callbacks.onErrorNotice({
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        notice: {
          code: "APPROVAL_NOT_PENDING",
          message: `pending ${index}`,
          severity: "warning",
          clientActionId: `approval-${index}`,
        },
      });
    }

    const state = harness.handle.store.getState();
    // Every draft survives...
    expect(
      state.errorNotices.filter((n) => n.code === "SEND_NOT_RECORDED"),
    ).toHaveLength(MAX_ERROR_NOTICE_RECORDS);
    // ...and ordinary history still gets its own window rather than one slot.
    expect(
      state.errorNotices.filter((n) => n.code === "APPROVAL_NOT_PENDING"),
    ).toHaveLength(4);
  });

  // R8 `-6Te`: the dead send's run settings die with it, so a resend picks up
  // whatever the chat uses NOW. A different model changes what the agent does,
  // silently - same statement-obligation class as the worktree.
  it("names run settings that moved between dispatch and settle", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });
    sendTwo(harness, CONTENT, SECOND_CONTENT);
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    // The chat's settings change while both sends are in flight.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: UPDATED_SETTINGS,
    });

    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).toContain("gpt-5-codex");
    expect(notice.message).toContain("model");
  });

  it("says nothing about settings that did not move", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });
    sendTwo(harness, CONTENT, SECOND_CONTENT);
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      settings: SETTINGS,
    });

    // Stating the full tuple every time would bury the one field that moved.
    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).not.toContain("different settings now");
  });

  // R7 `-oRb`: "no branch to re-pick" is not "nothing to state". A send staged
  // to switch to a LOCAL checkout or to IMPORT an existing worktree settles
  // with no statement at all today, so the resend runs against the previous
  // binding - the same silent-wrong-worktree class, two entry kinds over.
  it("names a local workspace a stated send was staged to switch to", () => {
    const notice = statedNoticeWithIntent({
      entries: [
        {
          kind: "local",
          workspacePath: "/repo/service-a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });

    expect(notice.message).toContain("/repo/service-a");
  });

  it("names an imported worktree a stated send was staged to adopt", () => {
    const notice = statedNoticeWithIntent({
      entries: [
        {
          kind: "import",
          workspacePath: "/repo",
          worktreePath: "/repo/../wt-hotfix",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });

    expect(notice.message).toContain("/repo/../wt-hotfix");
  });

  // R7 `-oRn`: the guard's contract is "a newer LIVE pick wins", but it was
  // implemented as "a newer REVISION wins". A second send consuming its own
  // staged pick advances the revision and then leaves the slot EMPTY - so
  // nothing live is at risk, yet the winner's binding was suppressed.
  it("re-stages the winner's intent when later picks were consumed too", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const first = worktreeIntentFor("feat/first");
    const second = worktreeIntentFor("feat/second");

    useWorktreeIntentStagingStore.getState().setIntent(key, first);
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    acceptLastAction(harness);
    // A second staged pick, consumed by its own send. The slot ends EMPTY.
    useWorktreeIntentStagingStore.getState().setIntent(key, second);
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    acceptLastAction(harness);
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    // The first send won the restoration slot, so its prompt came back - and
    // its binding has to come with it. Nothing live was there to protect.
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(CONTENT);
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(first);
  });

  // R6 `-cbH`: a diagram-only send used to be told it had "no recoverable
  // content" while its source was deleted. The block is an ATOM - the source
  // is in `attrs.code`, not in children - so the projection saw nothing, and
  // classifying it text-complete on top of that was the defect.
  it("hands back the source of a diagram-only send", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    sendTwo(harness, CONTENT, DIAGRAM_CONTENT);
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).toContain("graph TD;");
    expect(notice.message).toContain("Start-->Done;");
    expect(notice.message).not.toContain("no recoverable content");
  });

  // R5 `-LSI`: the slot LOSER's worktree. Round 4 gave the winner its binding
  // back; a send that loses the race is STATED, and its intent dies with the
  // row. The staging slot is single and the winner holds it, so this cannot be
  // a restore - it is a statement obligation, and the branch name is the part
  // worth naming so the user can re-pick it deliberately.
  it("names the worktree a stated send was going to run in", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    // First send takes the slot on reconnect; the second is stated.
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    useWorktreeIntentStagingStore.getState().setIntent(key, {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat/rescue",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    });
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).toContain("World");
    expect(notice.message).toContain("feat/rescue");
  });

  // R5 `-LSS`: the quoted draft must be the user's text, not a mangling of it.
  // `plainTextFromNode` joins a list's children with "", so `foo`/`bar` come
  // back as `foobar` - the statement tells them to copy something they never
  // wrote, which is worse than saying nothing.
  it("keeps list-item boundaries in the text it tells the user to copy", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    sendTwo(harness, CONTENT, LIST_CONTENT);
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).not.toContain("foobar");
    // `-Jy8u`: with markers, the boundary is the marker rather than the bare
    // newline - and this IS what the serializer sent, so the copy matches it.
    expect(notice.message).toContain("- foo\n- bar");
  });

  // R5 `-KNQ`: the settled patch is spread into the state object, so its
  // non-state keys land in the store. They are reconcile plumbing, not state,
  // and every `useShallow` subscriber compares them forever after.
  it("keeps reconcile-only patch keys out of the store state", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    const stateKeys = Object.keys(harness.handle.store.getState());
    expect(stateKeys).not.toContain("appendedErrorNotices");
    expect(stateKeys).not.toContain("restoredWorktreeIntent");
  });

  // R4-2: a terminal/artifact quote projects through the blockquote branch to
  // plain quoted text, dropping sourceType/sourceId/sourceEpicId - the
  // provenance `serializeSourcedQuote` sends to the agent. Second member of
  // the mention class: projection-loses-invisible-structure.
  it("qualifies a statement whose quoted source loses its provenance", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    sendTwo(harness, CONTENT, SOURCED_QUOTE_CONTENT);
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).toContain("the acceptance criteria");
    expect(notice.message).toContain("quote");
  });

  // The classification must be TOTAL. A node kind nobody has classified is
  // exactly the third member of this class, and it has to fail CLOSED - a
  // generic qualification - rather than pass silently as text-complete.
  it("fails closed on an unrecognized node kind", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    sendTwo(harness, CONTENT, UNKNOWN_NODE_CONTENT);
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).toContain("look at this");
    expect(notice.message).toContain("will not survive");
  });

  // Ordinary prose must NOT be qualified, or the warning becomes noise that
  // hides the cases that matter.
  it("does not qualify a plain-text statement", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    sendTwo(harness, CONTENT, SECOND_CONTENT);
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const notice = noticeFor(harness, second.clientActionId);
    expect(notice.message).toContain("World");
    expect(notice.message).not.toContain("will not survive");
    expect(notice.message).not.toContain("re-add");
    expect(notice.message).not.toContain("re-pick");
  });

  // R4-1: a staged worktree/branch choice rides the send, and dispatch clears
  // the slot. The ACCEPTED ack drops the pending action - `acceptedActions`
  // does not retain `restoreWorktreeIntent` - so a stop before
  // `messageAccepted` leaves this pass restoring the prompt with no binding.
  // Resubmitting would then run against the chat's PREVIOUS worktree: the
  // silent-local-run `restoreStagedWorktreeIntentForPending` exists to stop,
  // reached by a third caller that skipped it.
  it("re-stages the worktree intent when a stranded send is restored", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().setIntent(key, intent);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("Expected a send frame");
    }
    expect(frame.worktreeIntent).toEqual(intent);
    // Dispatch consumed the slot.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();

    // Accepted - so the pending action is gone and only the optimistic row
    // remains - then the turn is stopped before the message is appended.
    acceptLastAction(harness);
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    // The prompt came back to the composer...
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(CONTENT);
    // ...and so did the worktree it was going to run in.
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(intent);
  });

  it("does not clobber a newer staged selection when restoring a stranded send", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const original: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feat",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    const newer: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: { type: "existing", name: "release/v1.2.0" },
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().setIntent(key, original);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    acceptLastAction(harness);
    // The user picks a DIFFERENT worktree while the send is in flight. The
    // revision guard's existing contract is that the newer pick wins.
    useWorktreeIntentStagingStore.getState().setIntent(key, newer);

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(newer);
  });

  // R3-1: absence from a snapshot is only evidence for a send dispatched on an
  // EARLIER connection, where the ack is definitively dead. A send dispatched
  // after this connection reached `open` can be missing simply because the
  // snapshot was generated before it arrived - settling on that would tell the
  // user to resend a message whose accepted ack is still on its way.
  it("keeps a live-epoch send pending when the snapshot predates it", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    // Occupy the restoration slot, so the live send would take the
    // displacement branch.
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    rejectLastAction(harness, "Host refused the send.");

    // The connection drops and comes back; the composer gate reopens on
    // `open`, so the user can send again before the snapshot lands.
    callbacks.onConnectionStatus("reconnecting", null);
    callbacks.onConnectionStatus("open", null);
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const live = harness.sent.at(-1);
    if (live === undefined || live.kind !== "send") {
      throw new Error("Expected the live send frame");
    }

    // This connection's snapshot arrives without it - a race, not evidence.
    emitSnapshot(callbacks, "owner");

    const noticesForLive = () =>
      harness.handle.store
        .getState()
        .errorNotices.filter(
          (notice) => notice.clientActionId === live.clientActionId,
        );

    expect(
      Object.keys(harness.handle.store.getState().pendingActions),
    ).toContain(live.clientActionId);
    expect(noticesForLive()).toEqual([]);

    // The ack was always coming. It lands and reconciles normally - the
    // message materializes and nothing ever told the user to resend it.
    acceptLastAction(harness);
    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: live.messageId,
        sender: { type: "user", userId: OWNER_ID },
        message: {
          kind: "user",
          content: SECOND_CONTENT,
          browserAnnotations: [],
        },
        timestamp: 4,
        sessionAnchor: null,
      },
    });

    expect(
      harness.handle.store
        .getState()
        .messages.some((message) => message.messageId === live.messageId),
    ).toBe(true);
    expect(noticesForLive()).toEqual([]);
  });

  // R3-2: a mention chip projects to plain `@path`, so the quoted text LOOKS
  // complete - but the workspace, host and entity binding behind the chip do
  // not survive, and pasting the text back does not rebuild it. A partial loss
  // presented as a whole recovery is the same silence one content class over.
  it("qualifies a statement whose mention chips lose their binding", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    sendTestMessage(
      harness.handle.store,
      MENTION_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const notice = harness.handle.store
      .getState()
      .errorNotices.find(
        (entry) => entry.clientActionId === second.clientActionId,
      );
    if (notice === undefined) throw new Error("Expected a statement");
    // The text - including the @path - is carried...
    expect(notice.message).toContain("@src/app.ts");
    expect(notice.message).toContain("needs a second look");
    // ...but the statement says the chip itself has to be re-picked, rather
    // than implying the pasted text restores it.
    expect(notice.message).toContain("mention");
  });

  // Attachment loss was detected by text-EMPTINESS, which is a proxy for
  // "had attachments" and fails on the mixed case: text plus an image quotes
  // the text and says nothing, so following the advice resends an incomplete
  // request. Detection has to be structural.
  it("warns about attachments a mixed-content statement cannot carry", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    sendTestMessage(
      harness.handle.store,
      IMAGE_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const second = harness.sent[1];
    if (second.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const notice = harness.handle.store
      .getState()
      .errorNotices.find(
        (entry) => entry.clientActionId === second.clientActionId,
      );
    if (notice === undefined) throw new Error("Expected a statement");
    // The text is carried...
    expect(notice.message).toContain("Review this screenshot");
    // ...and the image it cannot carry is called out rather than dropped in
    // silence behind a quote that looks complete.
    expect(notice.message).toContain("attachment");
  });

  // THREAD 3: the statement tells the user to resend. If the displaced action
  // were still restoration-eligible, freeing the slot would push its stale
  // text back into the composer AFTER the resend - the notice's own advice
  // manufacturing a duplicate send.
  it("does not push a stated send back into the composer once the slot frees", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const first = harness.sent[0];
    if (first.kind !== "send") throw new Error("Expected a send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    // The composer consumes the winning restoration, freeing the slot - what
    // the handoff driver does once the user has the text back.
    harness.handle.store
      .getState()
      .ackFailedSendRestoration(first.clientActionId);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();

    // The user resends the displaced text under a new message id, then a
    // later snapshot lands.
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const resent = harness.sent.at(-1);
    if (resent === undefined || resent.kind !== "send") {
      throw new Error("Expected the resend frame");
    }
    acceptLastAction(harness);
    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: resent.messageId,
        sender: { type: "user", userId: OWNER_ID },
        message: {
          kind: "user",
          content: SECOND_CONTENT,
          browserAnnotations: [],
        },
        timestamp: 3,
        sessionAnchor: null,
      },
    });
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        {
          role: "user",
          messageId: resent.messageId,
          sender: { type: "user", userId: OWNER_ID },
          message: {
            kind: "user",
            content: SECOND_CONTENT,
            browserAnnotations: [],
          },
          timestamp: 3,
          sessionAnchor: null,
        },
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    // The slot stays empty: the displaced send was settled when it was
    // stated, so there is nothing left to restore on top of the resend.
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
  });

  // The settled-turn pass shares the single-slot rule - and unlike the
  // snapshot path it DROPS the stranded rows, deliberately: an entry that
  // survives keeps edit/delete gated off and renders a user message the host
  // never recorded, which is the bug that pass exists to fix. So the row
  // cannot hold the text here, and the statement has to carry it instead, or
  // a stranded send that loses the slot is gone with nothing left to recover.
  it("carries the text of every stranded send that loses the slot when the turn settles", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const send = (content: JsonContent): void => {
      sendTestMessage(
        harness.handle.store,
        content,
        { type: "user", userId: OWNER_ID },
        { settings: SETTINGS, deliveryPolicy: "auto" },
      );
    };

    // Occupy the slot first, so BOTH stranded sends below lose it.
    send(CONTENT);
    const occupant = rejectLastAction(harness, "Host refused the send.");
    // Two sends whose accepted ack landed - so they leave `pendingActions`
    // and only the optimistic row remains - but whose message the host never
    // appended. Nothing else holds this text.
    send(SECOND_CONTENT);
    const strandedA = acceptLastAction(harness);
    send(THIRD_CONTENT);
    const strandedB = acceptLastAction(harness);

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    // First writer keeps the slot.
    expect(state.failedSendRestoration?.clientActionId).toBe(occupant);
    // The rows are still dropped - that is what the settled pass is for.
    expect(state.pendingUserMessages).toEqual([]);
    // EVERY stranded send that lost the slot is stated, and each statement
    // carries its own text, since nothing else holds it any more.
    const noticeFor = (clientActionId: string) =>
      state.errorNotices.filter(
        (notice) => notice.clientActionId === clientActionId,
      );
    expect(noticeFor(strandedA)).toHaveLength(1);
    expect(noticeFor(strandedA)[0]).toMatchObject({
      code: "SEND_NOT_RECORDED",
      severity: "warning",
      clientActionId: strandedA,
    });
    expect(noticeFor(strandedA)[0].message).toContain("World");
    expect(noticeFor(strandedB)).toHaveLength(1);
    expect(noticeFor(strandedB)[0]).toMatchObject({
      code: "SEND_NOT_RECORDED",
      severity: "warning",
      clientActionId: strandedB,
    });
    expect(noticeFor(strandedB)[0].message).toContain("Third draft");
  });

  // The settled pass has TWO callers - the reconnect snapshot above and the
  // live `turnStateChanged` frame here - and the live one applies the patch by
  // SPREADING it. A delta field cannot reach the `errorNotices` state key that
  // way, so that caller needs its own append and its own coverage.
  it("carries the stranded send's text when a live turnStateChanged settles the turn", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const occupant = rejectLastAction(harness, "Host refused the send.");
    sendTestMessage(
      harness.handle.store,
      SECOND_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const stranded = acceptLastAction(harness);

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration?.clientActionId).toBe(occupant);
    expect(state.pendingUserMessages).toEqual([]);
    const stated = state.errorNotices.filter(
      (notice) => notice.clientActionId === stranded,
    );
    expect(stated).toHaveLength(1);
    expect(stated[0].code).toBe("SEND_NOT_RECORDED");
    expect(stated[0].message).toContain("World");
    // The rejection notice for the slot occupant is still in the ring - the
    // delta was APPENDED, not written over it.
    expect(
      state.errorNotices.some((notice) => notice.clientActionId === occupant),
    ).toBe(true);
  });

  it("states nothing extra when the only stranded send wins the free slot", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const stranded = acceptLastAction(harness);

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    const state = harness.handle.store.getState();
    // It claimed the slot, so its text is in the composer - the notice would
    // be noise, and the composer restoration is the statement.
    expect(state.failedSendRestoration).toEqual({
      clientActionId: stranded,
      content: CONTENT,
      browserAnnotations: [],
      reason: "The message was not recorded before the turn stopped.",
      displacedReason: "The message was not recorded before the turn stopped.",
      stated: false,
    });
    expect(state.errorNotices).toEqual([]);
  });

  it("keeps an in-flight send pending when a same-connection refresh snapshot omits it", () => {
    // The host broadcasts snapshots on a live connection for unrelated
    // reasons (a turn finishing, a pump-backlog backfill). One built before
    // the host processed this send naturally lacks the message - that is not
    // evidence the send was lost, and restoring it would re-fill the composer
    // with a prompt that then lands in the transcript anyway.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    // No connection-status transition: this snapshot rides the same epoch
    // the send was dispatched on.
    emitSnapshot(callbacks, "owner");

    expect(
      harness.handle.store.getState().pendingActions[frame.clientActionId],
    ).toMatchObject({ action: "send", messageId: frame.messageId });
    expect(
      harness.handle.store
        .getState()
        .pendingUserMessages.map((message) => message.messageId),
    ).toEqual([frame.messageId]);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();

    // The ack and the durable message then settle it normally.
    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "send",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });
    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: frame.messageId,
        sender: { type: "user", userId: OWNER_ID },
        message: {
          kind: "user",
          content: CONTENT,
          browserAnnotations: [],
        },
        timestamp: 2,
        sessionAnchor: null,
      },
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    expect(
      harness.handle.store
        .getState()
        .messages.some((message) => message.messageId === frame.messageId),
    ).toBe(true);
  });

  it("clears a pending send when reconnect snapshot contains the accepted message", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        {
          role: "user",
          messageId: frame.messageId,
          sender: { type: "user", userId: OWNER_ID },
          message: {
            kind: "user",
            content: CONTENT,
            browserAnnotations: [],
          },
          timestamp: 2,
          sessionAnchor: null,
        },
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    expect(harness.handle.store.getState().messages).toHaveLength(1);
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({
      action: "send",
      messageId: frame.messageId,
    });
  });

  it("prunes expired non-send accepted action records", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");

    const firstActionId = harness.handle.store.getState().resumeQueue();
    if (firstActionId === null) throw new Error("Expected resume action");
    acceptLastAction(harness);

    expect(
      Object.hasOwn(
        harness.handle.store.getState().acceptedActions,
        firstActionId,
      ),
    ).toBe(true);
    harness.handle.store.setState((state) => ({
      acceptedActions: {
        ...state.acceptedActions,
        [firstActionId]: {
          ...state.acceptedActions[firstActionId],
          acceptedAt: Date.now() - ACCEPTED_CHAT_ACTION_RETENTION_MS - 1,
        },
      },
    }));

    const secondActionId = harness.handle.store.getState().resumeQueue();
    if (secondActionId === null) throw new Error("Expected resume action");
    acceptLastAction(harness);

    expect(
      Object.hasOwn(
        harness.handle.store.getState().acceptedActions,
        firstActionId,
      ),
    ).toBe(false);
    expect(
      harness.handle.store.getState().acceptedActions[secondActionId],
    ).toMatchObject({
      action: "resumeQueue",
    });
  });

  it("sends pause queue owner actions", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");

    const clientActionId = harness.handle.store.getState().pauseQueue();

    expect(clientActionId).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "pauseQueue") {
      throw new Error("Expected pauseQueue frame");
    }
    expect(
      harness.handle.store.getState().pendingActions[frame.clientActionId],
    ).toMatchObject({
      action: "pauseQueue",
    });
  });

  it("retains accepted send records when pruning accepted action records by cap", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");

    const sent = sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    if (sent === null) throw new Error("Expected send action");
    acceptLastAction(harness);

    const nonSendActionIds = Array.from(
      { length: MAX_ACCEPTED_CHAT_ACTION_RECORDS + 3 },
      () => {
        const actionId = harness.handle.store.getState().resumeQueue();
        if (actionId === null) throw new Error("Expected resume action");
        acceptLastAction(harness);
        return actionId;
      },
    );

    const acceptedActions = harness.handle.store.getState().acceptedActions;
    expect(Object.keys(acceptedActions)).toHaveLength(
      MAX_ACCEPTED_CHAT_ACTION_RECORDS,
    );
    expect(acceptedActions[sent.clientActionId]).toMatchObject({
      action: "send",
      messageId: sent.messageId,
    });
    expect(
      nonSendActionIds.filter((actionId) =>
        Object.hasOwn(acceptedActions, actionId),
      ),
    ).toHaveLength(MAX_ACCEPTED_CHAT_ACTION_RECORDS - 1);
  });

  it("clears a pending send when reconnect snapshot contains the queued prompt", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: {
        status: "running",
        items: [
          {
            kind: "prompt" as const,
            queueItemId: "queue-1",
            messageId: frame.messageId,
            message: {
              kind: "user",
              content: CONTENT,
              browserAnnotations: [],
            },
            sender: { type: "user", userId: OWNER_ID },
            settings: SETTINGS,
            accountContext: { type: "PERSONAL" as const },
            delivery: "next_turn",
            status: "pending",
            targetTurnId: null,
            steerRequest: null,
            fallbackReason: null,
            createdAt: 2,
            updatedAt: 2,
          },
        ],
      },
      pendingFileEditApprovals: [],
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    expect(harness.handle.store.getState().queue.items).toHaveLength(1);
  });

  it("clears a pending send when reconnect snapshot contains the steered user row", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        assistantSteerMessage(frame.messageId),
        persistedUserMessage(frame.messageId),
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
  });

  it("clears an accepted duplicate send when the steered user row already exists", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const message = persistedUserMessage("message-steered");
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [assistantSteerMessage(message.messageId), message],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    harness.handle.store.getState().sendSeededUserMessage({
      clientActionId: "retry-steered",
      messageId: "message-steered",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
    });
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "send",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });
    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message,
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
  });

  it("shows active-turn attachment sends in the queued list immediately", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: runningActiveTurn(),
    });

    sendTestMessage(
      harness.handle.store,
      IMAGE_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    const state = harness.handle.store.getState();
    expect(state.pendingUserMessages).toEqual([]);
    expect(Object.keys(state.pendingActions)).toEqual([frame.clientActionId]);
    expect(state.queue.status).toBe("running");
    expect(state.queue.items).toHaveLength(1);
    const item = state.queue.items[0];
    expect(isOptimisticQueuedItem(item)).toBe(true);
    if (item.kind !== "prompt") throw new Error("expected prompt item");
    expect(item.messageId).toBe(frame.messageId);
    expect(item.message.content).toEqual(IMAGE_CONTENT);
    expect(item.sender).toEqual({ type: "user", userId: OWNER_ID });
    expect(item.delivery).toBe("next_turn");
    expect(item.status).toBe("pending");
  });

  it("keeps optimistic queued sends across queue frames until rejection", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);

    sendTestMessage(
      harness.handle.store,
      IMAGE_CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    callbacks.onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: { status: "idle", items: [] },
    });

    expect(harness.handle.store.getState().queue.items).toHaveLength(1);
    expect(
      isOptimisticQueuedItem(harness.handle.store.getState().queue.items[0]),
    ).toBe(true);

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "send",
      status: "rejected",
      reason: "Attachment upload failed.",
      code: "ATTACHMENT_UPLOAD_FAILED",
      backgroundStopTaskIds: [],
    });

    expect(harness.handle.store.getState().queue.items).toEqual([]);
    expect(harness.handle.store.getState().queue.status).toBe("idle");
  });

  it("clears an active-turn pending send when reconnect snapshot remints the queued message id", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: runningActiveTurn(),
    });

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: {
        status: "running",
        items: [
          {
            kind: "prompt" as const,
            queueItemId: "queue-1",
            messageId: "reminted-message",
            message: {
              kind: "user",
              content: CONTENT,
              browserAnnotations: [],
            },
            sender: { type: "user", userId: OWNER_ID },
            settings: SETTINGS,
            accountContext: { type: "PERSONAL" as const },
            delivery: "next_turn",
            status: "pending",
            targetTurnId: "turn-1",
            steerRequest: null,
            fallbackReason: null,
            createdAt: 4,
            updatedAt: 4,
          },
        ],
      },
      pendingFileEditApprovals: [],
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
  });

  it("keeps active-turn sends out of optimistic transcript rows", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: runningActiveTurn(),
    });

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(Object.keys(harness.handle.store.getState().pendingActions)).toEqual(
      [frame.clientActionId],
    );
    expect(harness.handle.store.getState().queue.items).toHaveLength(1);
    expect(
      isOptimisticQueuedItem(harness.handle.store.getState().queue.items[0]),
    ).toBe(true);

    callbacks.onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: {
        status: "running",
        items: [
          {
            kind: "prompt" as const,
            queueItemId: "queue-1",
            messageId: frame.messageId,
            message: {
              kind: "user",
              content: CONTENT,
              browserAnnotations: [],
            },
            sender: { type: "user", userId: OWNER_ID },
            settings: SETTINGS,
            accountContext: { type: "PERSONAL" as const },
            delivery: "next_turn",
            status: "pending",
            targetTurnId: "turn-1",
            steerRequest: null,
            fallbackReason: null,
            createdAt: 4,
            updatedAt: 4,
          },
        ],
      },
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(harness.handle.store.getState().queue.items).toHaveLength(1);
    expect(harness.handle.store.getState().queue.items[0].queueItemId).toBe(
      "queue-1",
    );
    expect(
      isOptimisticQueuedItem(harness.handle.store.getState().queue.items[0]),
    ).toBe(false);
    expect(
      harness.handle.store.getState().acceptedActions[frame.clientActionId],
    ).toMatchObject({
      action: "send",
      messageId: frame.messageId,
    });
  });

  it("clears a pending send when queue updates remint the message id", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: runningActiveTurn(),
    });

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    callbacks.onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: {
        status: "running",
        items: [
          {
            kind: "prompt" as const,
            queueItemId: "queue-1",
            messageId: "reminted-message",
            message: {
              kind: "user",
              content: CONTENT,
              browserAnnotations: [],
            },
            sender: { type: "user", userId: OWNER_ID },
            settings: SETTINGS,
            accountContext: { type: "PERSONAL" as const },
            delivery: "next_turn",
            status: "pending",
            targetTurnId: "turn-1",
            steerRequest: null,
            fallbackReason: null,
            createdAt: 4,
            updatedAt: 4,
          },
        ],
      },
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
  });

  it("restores rejected sends only through the initiating store", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "send",
      status: "rejected",
      reason: "Only the agent owner can perform this action.",
      code: "NOT_OWNER",
      backgroundStopTaskIds: [],
    });

    expect(harness.handle.store.getState().failedSendRestoration).toMatchObject(
      {
        clientActionId: frame.clientActionId,
        content: CONTENT,
        reason: "Only the agent owner can perform this action.",
      },
    );
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
  });

  it("keeps the first restoration when a second send is rejected before the composer consumes it", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    const rejectSend = (index: number, reason: string): string => {
      sendTestMessage(
        harness.handle.store,
        index === 0 ? CONTENT : IMAGE_CONTENT,
        { type: "user", userId: OWNER_ID },
        { settings: SETTINGS, deliveryPolicy: "auto" },
      );
      const frame = harness.sent[index];
      if (frame.kind !== "send") throw new Error("Expected send frame");
      callbacks.onActionAck({
        kind: "actionAck",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        clientActionId: frame.clientActionId,
        action: "send",
        status: "rejected",
        reason,
        code: "ACTION_REJECTED",
        backgroundStopTaskIds: [],
      });
      return frame.clientActionId;
    };

    const firstActionId = rejectSend(0, "First rejection.");
    rejectSend(1, "Second rejection.");

    // The slot is single-consumer: the second rejection must not clobber
    // content the composer has not restored yet.
    expect(harness.handle.store.getState().failedSendRestoration).toMatchObject(
      {
        clientActionId: firstActionId,
        content: CONTENT,
        reason: "First rejection.",
      },
    );

    // Once acked, the slot is free again for the next failure.
    harness.handle.store.getState().ackFailedSendRestoration(firstActionId);
    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
  });

  it("does not send owner actions for read-only viewers", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "viewer");

    const clientActionId = sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );

    expect(clientActionId).toBeNull();
    expect(harness.sent).toEqual([]);
  });

  it("sends delete-message-suffix owner actions without optimistic user rows", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");

    const clientActionId = harness.handle.store
      .getState()
      .deleteMessageSuffix("message-1");

    expect(clientActionId).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "deleteMessageSuffix") {
      throw new Error("Expected deleteMessageSuffix frame");
    }
    expect(frame.fromMessageId).toBe("message-1");
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
  });

  it("sends edit-user-message owner actions and keeps edited text out of the composer restoration path", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");

    const sent = harness.handle.store.getState().editUserMessage({
      targetMessageId: "message-1",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      revertFileChanges: false,
      revertArtifacts: true,
    });

    expect(sent).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "editUserMessage") {
      throw new Error("Expected editUserMessage frame");
    }
    expect(frame.targetMessageId).toBe("message-1");
    expect(frame.messageId).toBe(sent?.messageId);
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);

    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "editUserMessage",
      status: "rejected",
      reason: "Rejected edit.",
      code: "EDIT_REJECTED",
      backgroundStopTaskIds: [],
    });

    expect(harness.handle.store.getState().failedSendRestoration).toBeNull();
    expect(harness.handle.store.getState().errorNotices.at(-1)).toMatchObject({
      clientActionId: frame.clientActionId,
      message: "Rejected edit.",
    });
  });

  it("attaches a staged worktree intent when editing and resending a stopped message", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    useWorktreeIntentMemoryStore.getState().resetForTests();
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "edited-first-message",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, intent);

    harness.handle.store.getState().editUserMessage({
      targetMessageId: "message-1",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      revertFileChanges: false,
      revertArtifacts: true,
    });

    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "editUserMessage") {
      throw new Error("Expected editUserMessage frame");
    }
    expect(frame).toMatchObject({ worktreeIntent: intent });
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toBeUndefined();
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent(EPIC_ID, "host-a"),
    ).toEqual(intent);
  });

  it("does not restore a rejected edit intent over a newer selection", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const staleIntent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "edited-stale",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, staleIntent);

    harness.handle.store.getState().editUserMessage({
      targetMessageId: "message-1",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      revertFileChanges: false,
      revertArtifacts: true,
    });
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "editUserMessage") {
      throw new Error("Expected editUserMessage frame");
    }

    // While the edit is in flight the user re-picks. The rejection of the
    // OLD edit must not clobber this newer choice.
    const newerIntent: WorktreeIntent = {
      entries: [
        {
          kind: "local",
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, newerIntent);

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: "editUserMessage",
      status: "rejected",
      reason: "feat already exists; choose a new branch name.",
      code: "WORKTREE_CREATE_FAILED",
      backgroundStopTaskIds: [],
    });

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(newerIntent);
    useWorktreeIntentStagingStore.getState().resetForTests();
  });

  it("refuses edit and resend while staged worktree metadata is unresolved", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    useWorktreeIntentMemoryStore.getState().resetForTests();
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
      hostId: "host-a",
      epicId: EPIC_ID,
      ownerKind: "chat",
      ownerId: CHAT_ID,
    };
    const intent: WorktreeIntent = {
      entries: [
        {
          kind: "worktree",
          scripts: null,
          workspacePath: "/repo",
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "edited-unresolved",
            source: "main",
            carryUncommittedChanges: false,
          },
        },
      ],
    };
    useWorktreeIntentStagingStore.getState().stageIntent(key, intent);
    useWorktreeIntentStagingStore
      .getState()
      .setSuspendedWorkspacePaths(key, ["/repo"]);

    const result = harness.handle.store.getState().editUserMessage({
      targetMessageId: "message-1",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      revertFileChanges: false,
      revertArtifacts: true,
    });

    expect(result).toBeNull();
    expect(harness.sent).toEqual([]);
    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(key)
      ],
    ).toEqual(intent);
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent(EPIC_ID, "host-a"),
    ).toBeNull();
    useWorktreeIntentStagingStore.getState().resetForTests();
  });

  it("sends queue settings update owner actions", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");

    const clientActionId = harness.handle.store
      .getState()
      .queueSettingsUpdate("queue-1", UPDATED_SETTINGS);

    expect(clientActionId).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "queueSettingsUpdate") {
      throw new Error("Expected queueSettingsUpdate frame");
    }
    expect(frame.queueItemId).toBe("queue-1");
    expect(frame.settings).toEqual(UPDATED_SETTINGS);
    expect(
      harness.handle.store.getState().pendingActions[frame.clientActionId],
    ).toMatchObject({
      action: "queueSettingsUpdate",
    });
  });

  it("sends active permission mode update owner actions", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");

    const clientActionId = harness.handle.store
      .getState()
      .updateActivePermissionMode("full_access");

    expect(clientActionId).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "activePermissionModeUpdate") {
      throw new Error("Expected activePermissionModeUpdate frame");
    }
    expect(frame.permissionMode).toBe("full_access");
    expect(
      harness.handle.store.getState().pendingActions[frame.clientActionId],
    ).toMatchObject({
      action: "activePermissionModeUpdate",
    });
  });

  it("live-mirrors only pending, non-excluded, changed queued items", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");
    const queuedItem = (
      queueItemId: string,
      settings: ChatRunSettings,
      status: "pending" | "steering",
    ) => ({
      kind: "prompt" as const,
      queueItemId,
      messageId: `m-${queueItemId}`,
      message: {
        kind: "user" as const,
        content: CONTENT,
        browserAnnotations: [],
      },
      sender: { type: "user" as const, userId: OWNER_ID },
      settings,
      accountContext: { type: "PERSONAL" as const },
      delivery: "next_turn" as const,
      status,
      targetTurnId: null,
      steerRequest: null,
      fallbackReason: null,
      createdAt: 1,
      updatedAt: 1,
    });
    harness.callbacks().onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: {
        status: "running",
        items: [
          queuedItem("queue-stale", SETTINGS, "pending"),
          queuedItem("queue-already", UPDATED_SETTINGS, "pending"),
          queuedItem("queue-steering", SETTINGS, "steering"),
          queuedItem("queue-editing", SETTINGS, "pending"),
        ],
      },
    });

    harness.handle.store
      .getState()
      .restampQueuedItemSettings(UPDATED_SETTINGS, "queue-editing");

    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "queueSettingsRestamp") {
      throw new Error("Expected queueSettingsRestamp frame");
    }
    expect(frame.excludeQueueItemId).toBe("queue-editing");
    expect(frame.settings).toEqual(UPDATED_SETTINGS);
    expect(
      harness.handle.store.getState().pendingActions[frame.clientActionId],
    ).toMatchObject({
      action: "queueSettingsRestamp",
    });
  });

  it("sends queue steer-now owner actions", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");

    const clientActionId = harness.handle.store
      .getState()
      .queueSteerNow("queue-1", null);

    expect(clientActionId).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "queueSteerNow") {
      throw new Error("Expected queueSteerNow frame");
    }
    expect(frame.queueItemId).toBe("queue-1");
    expect(frame.newSettings).toBeNull();
    expect(
      harness.handle.store.getState().pendingActions[frame.clientActionId],
    ).toMatchObject({
      action: "queueSteerNow",
    });
  });

  it("reconciles file-edit approval snapshots and sends decisions", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onFileEditApprovalRequested({
      kind: "fileEditApprovalRequested",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      approval: {
        ...FILE_APPROVAL,
        approvalId: "file-approval-stale",
        paths: ["/repo/src/stale.ts"],
      },
    });

    expect(harness.handle.store.getState().pendingFileEditApprovals).toEqual([
      expect.objectContaining({ approvalId: "file-approval-stale" }),
    ]);

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [FILE_APPROVAL],
    });

    expect(harness.handle.store.getState().pendingFileEditApprovals).toEqual([
      FILE_APPROVAL,
    ]);

    const actionId = harness.handle.store
      .getState()
      .fileEditApprovalDecision(FILE_APPROVAL.approvalId, { approved: true });

    if (actionId === null) throw new Error("Expected file-edit action");
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "fileEditApprovalDecision") {
      throw new Error("Expected fileEditApprovalDecision frame");
    }
    expect(frame.approvalId).toBe(FILE_APPROVAL.approvalId);
    expect(frame.decision).toEqual({ approved: true });
    expect(
      harness.handle.store.getState().pendingActions[frame.clientActionId],
    ).toMatchObject({ action: "fileEditApprovalDecision" });

    acceptLastAction(harness);
    callbacks.onFileEditApprovalResolved({
      kind: "fileEditApprovalResolved",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      approvalId: FILE_APPROVAL.approvalId,
      decision: { approved: true },
      resolvedAt: 3,
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingFileEditApprovals).toEqual(
      [],
    );
  });

  it("tracks host-owned pending interviews across snapshots and lifecycle frames", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId: "question-snapshot", requestedAt: 2 }],
    });

    expect(harness.handle.store.getState().pendingInterviews).toEqual([
      { blockId: "question-snapshot", requestedAt: 2 },
    ]);

    callbacks.onInterviewRequested({
      kind: "interviewRequested",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "question-live",
      requestedAt: 3,
    });

    expect(harness.handle.store.getState().pendingInterviews).toEqual([
      { blockId: "question-snapshot", requestedAt: 2 },
      { blockId: "question-live", requestedAt: 3 },
    ]);

    callbacks.onInterviewAnswered({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "question-snapshot",
      answers: [],
      resolvedAt: 4,
      settlementId: null,
      settlementSource: null,
      delivery: null,
    });

    expect(harness.handle.store.getState().pendingInterviews).toEqual([
      { blockId: "question-live", requestedAt: 3 },
    ]);

    callbacks.onInterviewErrored({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "question-live",
      reason: "Skipped",
      resolvedAt: 5,
      settlementId: null,
      settlementSource: null,
      outcome: "skipped",
      draftAnswers: [],
      delivery: null,
    });

    expect(harness.handle.store.getState().pendingInterviews).toEqual([]);
  });

  it("keeps pending interviews until host lifecycle frames resolve them", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [
        { blockId: "question-answer", requestedAt: 2 },
        { blockId: "question-skip", requestedAt: 3 },
      ],
    });

    const answerActionId = harness.handle.store
      .getState()
      .interviewAnswer("question-answer", []);
    const skipActionId = harness.handle.store
      .getState()
      .interviewSkip("question-skip", "Skipped by user", []);

    expect(answerActionId).not.toBeNull();
    expect(skipActionId).not.toBeNull();
    expect(harness.sent.map((frame) => frame.kind)).toEqual([
      "interviewAnswer",
      "interviewError",
    ]);
    expect(harness.sent[1]).toMatchObject({
      kind: "interviewError",
      blockId: "question-skip",
      reason: "Skipped by user",
      settlement: { outcome: "skipped", draftAnswers: [] },
    });
    expect(harness.handle.store.getState().pendingInterviews).toEqual([
      { blockId: "question-answer", requestedAt: 2 },
      { blockId: "question-skip", requestedAt: 3 },
    ]);

    if (answerActionId === null || skipActionId === null) {
      throw new Error("expected sent interview actions");
    }

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: answerActionId,
      action: "interviewAnswer",
      status: "rejected",
      reason: "Interview answer rejected.",
      code: "INTERVIEW_REJECTED",
      backgroundStopTaskIds: [],
    });
    expect(harness.handle.store.getState().pendingInterviews).toEqual([
      { blockId: "question-answer", requestedAt: 2 },
      { blockId: "question-skip", requestedAt: 3 },
    ]);
    expect(harness.handle.store.getState().errorNotices.at(-1)).toMatchObject({
      clientActionId: answerActionId,
      message: "Interview answer rejected.",
    });

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: skipActionId,
      action: "interviewError",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });
    expect(harness.handle.store.getState().pendingInterviews).toEqual([
      { blockId: "question-answer", requestedAt: 2 },
      { blockId: "question-skip", requestedAt: 3 },
    ]);

    callbacks.onInterviewErrored({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "question-skip",
      reason: "Skipped by user",
      resolvedAt: 4,
      settlementId: null,
      settlementSource: null,
      outcome: "skipped",
      draftAnswers: [],
      delivery: null,
    });
    expect(harness.handle.store.getState().pendingInterviews).toEqual([
      { blockId: "question-answer", requestedAt: 2 },
    ]);
  });

  it("clears the interview draft on host interviewAnswered", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const blockId = "question-draft-answered";

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId, requestedAt: 2 }],
    });

    useInterviewDraftStore.getState().saveDraft(CHAT_ID, blockId, {
      pageIndex: 0,
      answers: [{ selected: ["Alpha"], otherText: "", otherSelected: false }],
    });
    expect(
      useInterviewDraftStore.getState().draftsByChat[CHAT_ID]?.[blockId],
    ).toBeDefined();

    callbacks.onInterviewAnswered({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId,
      answers: [],
      resolvedAt: 4,
      settlementId: null,
      settlementSource: null,
      delivery: null,
    });

    expect(
      useInterviewDraftStore.getState().draftsByChat[CHAT_ID],
    ).toBeUndefined();
    expect(harness.handle.store.getState().pendingInterviews).toEqual([]);
  });

  it("clears the interview draft on host interviewErrored", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const blockId = "question-draft-errored";

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId, requestedAt: 2 }],
    });

    useInterviewDraftStore.getState().saveDraft(CHAT_ID, blockId, {
      pageIndex: 1,
      answers: [
        { selected: [], otherText: "skip me later", otherSelected: true },
      ],
    });
    expect(
      useInterviewDraftStore.getState().draftsByChat[CHAT_ID]?.[blockId],
    ).toBeDefined();

    callbacks.onInterviewErrored({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId,
      reason: "Skipped by user",
      resolvedAt: 5,
      settlementId: null,
      settlementSource: null,
      outcome: "skipped",
      draftAnswers: [],
      delivery: null,
    });

    expect(
      useInterviewDraftStore.getState().draftsByChat[CHAT_ID],
    ).toBeUndefined();
    expect(harness.handle.store.getState().pendingInterviews).toEqual([]);
  });

  it("does not clear the interview draft when an interview action is rejected", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const blockId = "question-draft-rejected";

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId, requestedAt: 2 }],
    });

    const draft = {
      pageIndex: 0,
      answers: [{ selected: ["Retry"], otherText: "", otherSelected: false }],
    };
    useInterviewDraftStore.getState().saveDraft(CHAT_ID, blockId, draft);

    const answerActionId = harness.handle.store
      .getState()
      .interviewAnswer(blockId, []);
    if (answerActionId === null) {
      throw new Error("expected sent interviewAnswer action");
    }

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: answerActionId,
      action: "interviewAnswer",
      status: "rejected",
      reason: "Interview answer rejected.",
      code: "INTERVIEW_REJECTED",
      backgroundStopTaskIds: [],
    });

    expect(harness.handle.store.getState().pendingInterviews).toEqual([
      { blockId, requestedAt: 2 },
    ]);
    expect(
      useInterviewDraftStore.getState().draftsByChat[CHAT_ID]?.[blockId],
    ).toEqual(draft);
  });

  it("refuses a second interviewAnswer while the first is still in flight", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const blockId = "question-double-dispatch";

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId, requestedAt: 2 }],
    });

    const firstId = harness.handle.store
      .getState()
      .interviewAnswer(blockId, []);
    const secondId = harness.handle.store
      .getState()
      .interviewAnswer(blockId, []);

    expect(firstId).not.toBeNull();
    expect(secondId).toBe(firstId);
    expect(
      harness.sent.filter((frame) => frame.kind === "interviewAnswer"),
    ).toHaveLength(1);
    const pendingInterviewActions = Object.values(
      harness.handle.store.getState().pendingActions,
    ).filter((action) => action.interviewBlockId === blockId);
    expect(pendingInterviewActions).toHaveLength(1);
    expect(pendingInterviewActions[0]?.clientActionId).toBe(firstId);
  });

  it("allows a new interviewAnswer after a rejected ack and retains the draft", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const blockId = "question-reject-retry";
    const draft = {
      pageIndex: 0,
      answers: [{ selected: ["Retry"], otherText: "", otherSelected: false }],
    };

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId, requestedAt: 2 }],
    });
    useInterviewDraftStore.getState().saveDraft(CHAT_ID, blockId, draft);

    const firstId = harness.handle.store
      .getState()
      .interviewAnswer(blockId, []);
    if (firstId === null) {
      throw new Error("expected first interviewAnswer action");
    }

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: firstId,
      action: "interviewAnswer",
      status: "rejected",
      reason: "Interview answer rejected.",
      code: "INTERVIEW_REJECTED",
      backgroundStopTaskIds: [],
    });

    expect(
      harness.handle.store.getState().pendingActions[firstId],
    ).toBeUndefined();
    expect(
      Object.values(harness.handle.store.getState().pendingActions).some(
        (action) => action.interviewBlockId === blockId,
      ),
    ).toBe(false);
    expect(harness.handle.store.getState().pendingInterviews).toEqual([
      { blockId, requestedAt: 2 },
    ]);
    expect(readInterviewDraftSnapshot(CHAT_ID, blockId)).toEqual(draft);

    const retryId = harness.handle.store
      .getState()
      .interviewAnswer(blockId, []);
    expect(retryId).not.toBeNull();
    expect(retryId).not.toBe(firstId);
    expect(
      harness.sent.filter((frame) => frame.kind === "interviewAnswer"),
    ).toHaveLength(2);
    expect(
      harness.handle.store.getState().pendingActions[retryId ?? ""],
    ).toMatchObject({
      action: "interviewAnswer",
      interviewBlockId: blockId,
    });
  });

  it("drops pending and accepted interview actions on interviewAnswered", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const blockId = "question-resolve-actions";

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId, requestedAt: 2 }],
    });
    useInterviewDraftStore.getState().saveDraft(CHAT_ID, blockId, {
      pageIndex: 0,
      answers: [{ selected: ["Done"], otherText: "", otherSelected: false }],
    });

    const actionId = harness.handle.store
      .getState()
      .interviewAnswer(blockId, []);
    if (actionId === null) {
      throw new Error("expected interviewAnswer action");
    }
    expect(
      harness.handle.store.getState().pendingActions[actionId],
    ).toBeDefined();

    callbacks.onInterviewAnswered({
      kind: "interviewAnswered",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId,
      answers: [],
      resolvedAt: 4,
      settlementId: null,
      settlementSource: null,
      delivery: null,
    });

    expect(harness.handle.store.getState().pendingInterviews).toEqual([]);
    expect(
      harness.handle.store.getState().pendingActions[actionId],
    ).toBeUndefined();
    expect(
      Object.values(harness.handle.store.getState().pendingActions).some(
        (action) => action.interviewBlockId === blockId,
      ),
    ).toBe(false);
    expect(
      Object.values(harness.handle.store.getState().acceptedActions).some(
        (action) => action.interviewBlockId === blockId,
      ),
    ).toBe(false);
    expect(readInterviewDraftSnapshot(CHAT_ID, blockId)).toBeNull();
  });

  it("drops pending and accepted interview actions on interviewErrored", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const blockId = "question-error-actions";

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId, requestedAt: 2 }],
    });
    useInterviewDraftStore.getState().saveDraft(CHAT_ID, blockId, {
      pageIndex: 0,
      answers: [{ selected: [], otherText: "skip", otherSelected: true }],
    });

    const actionId = harness.handle.store
      .getState()
      .interviewSkip(blockId, "Skipped by user", []);
    if (actionId === null) {
      throw new Error("expected interview Skip action");
    }

    callbacks.onInterviewErrored({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId,
      reason: "Skipped by user",
      resolvedAt: 5,
      settlementId: null,
      settlementSource: null,
      outcome: "skipped",
      draftAnswers: [],
      delivery: null,
    });

    expect(harness.handle.store.getState().pendingInterviews).toEqual([]);
    expect(
      harness.handle.store.getState().pendingActions[actionId],
    ).toBeUndefined();
    expect(
      Object.values(harness.handle.store.getState().acceptedActions).some(
        (action) => action.interviewBlockId === blockId,
      ),
    ).toBe(false);
    expect(readInterviewDraftSnapshot(CHAT_ID, blockId)).toBeNull();
  });

  it("prunes orphan interview drafts on the first snapshot", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const keepBlock = "question-keep";
    const dropBlock = "question-drop";
    const keepDraft = {
      pageIndex: 0,
      answers: [{ selected: ["Keep"], otherText: "", otherSelected: false }],
    };
    const dropDraft = {
      pageIndex: 1,
      answers: [{ selected: ["Drop"], otherText: "", otherSelected: false }],
    };

    useInterviewDraftStore.getState().saveDraft(CHAT_ID, keepBlock, keepDraft);
    useInterviewDraftStore.getState().saveDraft(CHAT_ID, dropBlock, dropDraft);

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId: keepBlock, requestedAt: 2 }],
    });

    expect(readInterviewDraftSnapshot(CHAT_ID, keepBlock)).toEqual(keepDraft);
    expect(readInterviewDraftSnapshot(CHAT_ID, dropBlock)).toBeNull();
    expect(
      window.localStorage.getItem(interviewDraftKey(CHAT_ID, keepBlock)),
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(interviewDraftKey(CHAT_ID, dropBlock)),
    ).toBeNull();
  });

  it("prunes orphan interview drafts on a later reconnect snapshot", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const keepBlock = "question-keep-later";
    const dropBlock = "question-drop-later";
    const keepDraft = {
      pageIndex: 0,
      answers: [{ selected: ["Keep"], otherText: "", otherSelected: false }],
    };
    const dropDraft = {
      pageIndex: 0,
      answers: [{ selected: ["Drop"], otherText: "", otherSelected: false }],
    };

    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [
        { blockId: keepBlock, requestedAt: 2 },
        { blockId: dropBlock, requestedAt: 3 },
      ],
    });
    useInterviewDraftStore.getState().saveDraft(CHAT_ID, keepBlock, keepDraft);
    useInterviewDraftStore.getState().saveDraft(CHAT_ID, dropBlock, dropDraft);

    // Reconnect snapshot: only keepBlock is still pending.
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      pendingInterviews: [{ blockId: keepBlock, requestedAt: 2 }],
    });

    expect(readInterviewDraftSnapshot(CHAT_ID, keepBlock)).toEqual(keepDraft);
    expect(readInterviewDraftSnapshot(CHAT_ID, dropBlock)).toBeNull();
    expect(
      window.localStorage.getItem(interviewDraftKey(CHAT_ID, dropBlock)),
    ).toBeNull();
  });

  it("tracks checkpoint restore action and lifecycle frames", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    const actionId = harness.handle.store
      .getState()
      .restoreCheckpoint("turn-1", true);

    if (actionId === null) throw new Error("Expected restore action");
    expect(harness.sent).toHaveLength(1);
    const frame = harness.sent[0];
    if (frame.kind !== "restoreCheckpoint") {
      throw new Error("Expected restoreCheckpoint frame");
    }
    expect(frame.checkpointId).toBe("turn-1");
    acceptLastAction(harness);
    expect(
      harness.handle.store.getState().acceptedActions[actionId],
    ).toMatchObject({ action: "restoreCheckpoint" });

    callbacks.onRestoreStarted({
      kind: "restoreStarted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      checkpointId: "turn-1",
      restoringUserId: OWNER_ID,
      restoringHostId: "host-1",
      startedAt: 2,
    });
    callbacks.onRestoreProgress({
      kind: "restoreProgress",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      checkpointId: "turn-1",
      processedCount: 1,
      totalCount: 2,
    });

    expect(harness.handle.store.getState().restore).toEqual({
      kind: "progressing",
      checkpointId: "turn-1",
      restoringUserId: OWNER_ID,
      restoringHostId: "host-1",
      startedAt: 2,
      processedCount: 1,
      totalCount: 2,
      connectionEpoch: 0,
    });

    callbacks.onRestoreCompleted({
      kind: "restoreCompleted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
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

    expect(harness.handle.store.getState().restore).toEqual({
      kind: "completed",
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
  });

  it("reduces live queue, approval, and assistant delta frames", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: {
        status: "paused",
        items: [
          {
            kind: "prompt" as const,
            queueItemId: "queue-1",
            messageId: "message-queue-1",
            message: {
              kind: "user",
              content: CONTENT,
              browserAnnotations: [],
            },
            sender: { type: "user", userId: OWNER_ID },
            settings: SETTINGS,
            accountContext: { type: "PERSONAL" as const },
            delivery: "next_turn",
            status: "paused",
            targetTurnId: null,
            steerRequest: null,
            fallbackReason: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    callbacks.onApprovalRequested({
      kind: "approvalRequested",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      approval: {
        kind: "tool",
        approvalId: "approval-1",
        toolName: "edit",
        description: "Apply change",
        input: null,
        planId: null,
        actions: [],
        requestedAt: 2,
      },
    });
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: runningActiveTurn(),
    });
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "text.delta",
        blockId: "block-1",
        timestamp: 4,
        delta: "Hi",
      },
    });

    const state = harness.handle.store.getState();
    expect(state.queue.status).toBe("paused");
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.liveAssistantMessage?.blocks).toMatchObject([
      { type: "text", text: "Hi" },
    ]);
    expect(state.liveAssistantMessage?.blocksVersion).toBe(1);
  });

  it("converts accepted stop-all background tasks into per-task pending state", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const backgroundItem: BackgroundItem = {
      taskId: "task-1",
      kind: "command",
      title: "sleep 60",
      blockId: "tool-1",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: null,
    };
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [backgroundItem],
    });

    const sent = harness.handle.store.getState().stopAllBackgroundItems();
    expect(sent).not.toBeNull();
    expect(
      harness.handle.store.getState().pendingBackgroundStopAll,
    ).not.toBeNull();

    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind === "ping") {
      throw new Error("Expected stop-all frame");
    }
    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: frame.kind,
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: ["task-1"],
    });
    expect(harness.handle.store.getState().pendingBackgroundStopAll).toBeNull();
    expect(harness.handle.store.getState().pendingBackgroundStops).toEqual({
      "task-1": frame.clientActionId,
    });

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
      backgroundItems: [backgroundItem],
    });
    expect(harness.handle.store.getState().pendingBackgroundStops).toEqual({
      "task-1": frame.clientActionId,
    });

    const newBackgroundItem: BackgroundItem = {
      taskId: "task-2",
      kind: "command",
      title: "npm run dev",
      blockId: "tool-2",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: null,
    };
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
      backgroundItems: [backgroundItem, newBackgroundItem],
    });
    expect(harness.handle.store.getState().pendingBackgroundStops).toEqual({
      "task-1": frame.clientActionId,
    });

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
      backgroundItems: [],
    });
    expect(harness.handle.store.getState().pendingBackgroundStops).toEqual({});
  });

  it("sends the session-scoped background stop immediately when no turn is running", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand = gatedCommandItem();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].kind).toBe("stopBackgroundSession");
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({ clientActionId: sent, awaitingTurnEnd: false, turnId: null });
  });

  it("stops the turn first when one is active, then sends the session stop once turnStateChanged reports it settled", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand = gatedCommandItem();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
    });
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: runningActiveTurn(),
      turnInProgress: true,
      backgroundItems: [gatedCommand],
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].kind).toBe("stop");
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sent,
      awaitingTurnEnd: true,
      turnId: "turn-1",
    });

    // The turn settles but the gated command is still running - the
    // session-stop frame dispatches now instead of waiting forever.
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      backgroundItems: [gatedCommand],
    });

    expect(harness.sent).toHaveLength(2);
    const sessionFrame = harness.sent.at(-1);
    if (sessionFrame === undefined || sessionFrame.kind === "ping") {
      throw new Error("Expected stopBackgroundSession frame");
    }
    expect(sessionFrame.kind).toBe("stopBackgroundSession");
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sessionFrame.clientActionId,
      awaitingTurnEnd: false,
      turnId: null,
    });
  });

  it("clears the pending session stop and records an error notice when the host rejects it", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand = gatedCommandItem();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind === "ping") {
      throw new Error("Expected stopBackgroundSession frame");
    }

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: frame.clientActionId,
      action: frame.kind,
      status: "rejected",
      reason: "Session already stopped.",
      code: "NO_ACTIVE_SESSION",
      backgroundStopTaskIds: [],
    });

    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toBeNull();
    expect(harness.handle.store.getState().errorNotices.at(-1)).toMatchObject({
      clientActionId: frame.clientActionId,
      message: "Session already stopped.",
    });
  });

  it("no-ops when no command in the chat needs the session-scoped escalation", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const ungatedCommand: BackgroundItem = {
      taskId: "task-1",
      kind: "command",
      title: "sleep 5",
      blockId: "tool-1",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: null,
    };
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [ungatedCommand],
    });

    expect(harness.handle.store.getState().stopBackgroundSession()).toBeNull();
    expect(harness.sent).toEqual([]);
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toBeNull();
  });

  it("clears a session stop whose phase-two frame died with the connection", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand = gatedCommandItem();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({ clientActionId: sent, awaitingTurnEnd: false, turnId: null });

    // The frame died with the connection before any ack arrived.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
    });

    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toBeNull();
    // Stop all re-enables: re-issuing the escalation works.
    expect(
      harness.handle.store.getState().stopBackgroundSession(),
    ).not.toBeNull();
  });

  it("clears a session stop whose phase-one turn-stop frame died with the connection", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand = gatedCommandItem();
    const activeTurn: ChatActiveTurn = {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId: "turn-1",
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 3,
      updatedAt: 3,
      reasoningEffort: null,
      serviceTier: null,
    };
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
      runStatus: "running",
      activeTurn,
      turnInProgress: true,
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    expect(harness.sent.at(-1)?.kind).toBe("stop");
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sent,
      awaitingTurnEnd: true,
      turnId: "turn-1",
    });

    // The turn-stop frame died with the connection before any ack arrived;
    // the reconnect snapshot still reports the turn as active.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
      runStatus: "running",
      activeTurn,
      turnInProgress: true,
    });

    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toBeNull();
    // No session-stop frame was dispatched off the still-active-turn snapshot.
    expect(harness.sent).toHaveLength(1);
  });

  it("advances a deferred session stop from the reconnect snapshot when the settled turnStateChanged was missed", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand = gatedCommandItem();
    const activeTurn: ChatActiveTurn = {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId: "turn-1",
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 3,
      updatedAt: 3,
      reasoningEffort: null,
      serviceTier: null,
    };
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
      runStatus: "running",
      activeTurn,
      turnInProgress: true,
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    const stopFrame = harness.sent.at(-1);
    if (stopFrame === undefined || stopFrame.kind === "ping") {
      throw new Error("Expected stop frame");
    }

    // The turn-stop ack lands and is accepted - the slot survives, still
    // awaiting the settled frame, and its clientActionId is no longer a
    // pending action (so a later reconnect sweep can't clear it that way).
    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: stopFrame.clientActionId,
      action: stopFrame.kind,
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sent,
      awaitingTurnEnd: true,
      turnId: "turn-1",
    });

    // The connection drops before `turnStateChanged` reports the turn
    // settled; the reconnect snapshot is the only signal that arrives, and
    // it must advance the deferred stop on its own.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
    });

    expect(harness.sent).toHaveLength(2);
    const sessionFrame = harness.sent.at(-1);
    if (sessionFrame === undefined || sessionFrame.kind === "ping") {
      throw new Error("Expected stopBackgroundSession frame");
    }
    expect(sessionFrame.kind).toBe("stopBackgroundSession");
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sessionFrame.clientActionId,
      awaitingTurnEnd: false,
      turnId: null,
    });
  });

  it("releases the escalation when the turn stop is rejected while the turn still runs", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand = gatedCommandItem();
    const activeTurn: ChatActiveTurn = {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId: "turn-1",
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 3,
      updatedAt: 3,
      reasoningEffort: null,
      serviceTier: null,
    };
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
      runStatus: "running",
      activeTurn,
      turnInProgress: true,
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    const stopFrame = harness.sent.at(-1);
    if (stopFrame === undefined || stopFrame.kind === "ping") {
      throw new Error("Expected stop frame");
    }

    // The host rejects the turn stop while the turn is genuinely still
    // running (no NO_ACTIVE_TURN race) - the escalation is dead.
    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: stopFrame.clientActionId,
      action: stopFrame.kind,
      status: "rejected",
      reason: "Turn is still running.",
      code: "TURN_ACTIVE",
      backgroundStopTaskIds: [],
    });

    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toBeNull();
    expect(harness.sent).toHaveLength(1);
  });

  it("still advances when the turn stop's rejection loses the race with the turn's natural end", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand = gatedCommandItem();
    const activeTurn: ChatActiveTurn = {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId: "turn-1",
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 3,
      updatedAt: 3,
      reasoningEffort: null,
      serviceTier: null,
    };
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
      runStatus: "running",
      activeTurn,
      turnInProgress: true,
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    const stopFrame = harness.sent.at(-1);
    if (stopFrame === undefined || stopFrame.kind === "ping") {
      throw new Error("Expected stop frame");
    }

    // The turn ends naturally before the turn-stop's rejected ack arrives -
    // `onTurnStateChanged`'s state-based dispatch already advances to phase
    // two here, ahead of the ack.
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      backgroundItems: [gatedCommand],
    });

    expect(harness.sent).toHaveLength(2);
    const sessionFrame = harness.sent.at(-1);
    if (sessionFrame === undefined || sessionFrame.kind === "ping") {
      throw new Error("Expected stopBackgroundSession frame");
    }
    expect(sessionFrame.kind).toBe("stopBackgroundSession");
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sessionFrame.clientActionId,
      awaitingTurnEnd: false,
      turnId: null,
    });

    // The turn-stop's late rejection targets a clientActionId the slot has
    // already moved past (phase two now), so it changes nothing.
    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: stopFrame.clientActionId,
      action: stopFrame.kind,
      status: "rejected",
      reason: "No active turn.",
      code: "NO_ACTIVE_TURN",
      backgroundStopTaskIds: [],
    });

    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sessionFrame.clientActionId,
      awaitingTurnEnd: false,
      turnId: null,
    });
  });

  it("falls back to graceful per-item stops when the gated command settles on its own during wind-down", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand: BackgroundItem = {
      taskId: "task-gated",
      kind: "command",
      title: "codex exec",
      blockId: "tool-1",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: {
        providerLabel: "Codex",
        minVersion: "0.146.0",
      },
    };
    const ungatedCommand: BackgroundItem = {
      taskId: "task-ungated",
      kind: "command",
      title: "sleep 5",
      blockId: "tool-2",
      parentTaskId: null,
      scheduledFor: null,
      individualStopUnavailable: null,
    };
    const wakeup: BackgroundItem = {
      taskId: "wake-1",
      kind: "wakeup",
      title: "Standup",
      blockId: "wake-tool-1",
      parentTaskId: null,
      scheduledFor: 123456,
    };
    const activeTurn: ChatActiveTurn = {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId: "turn-1",
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 3,
      updatedAt: 3,
      reasoningEffort: null,
      serviceTier: null,
    };
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand, ungatedCommand],
      runStatus: "running",
      activeTurn,
      turnInProgress: true,
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    expect(harness.sent.at(-1)?.kind).toBe("stop");
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sent,
      awaitingTurnEnd: true,
      turnId: "turn-1",
    });

    // The gated command finished on its own during wind-down - the ungated
    // command and a scheduled wakeup remain when the turn settles.
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      backgroundItems: [ungatedCommand, wakeup],
    });

    // No process-kill frame - the reason for one is gone. The confirmed
    // "stop my background work" is honored via per-item stops that leave
    // the wakeup scheduled, matching the confirmation's count.
    expect(
      harness.sent.some((frame) => frame.kind === "stopBackgroundSession"),
    ).toBe(false);
    expect(
      harness.sent.some((frame) => frame.kind === "stopAllBackgroundItems"),
    ).toBe(false);
    const itemStops = harness.sent.filter(
      (frame) => frame.kind === "stopBackgroundItem",
    );
    expect(itemStops.map((frame) => frame.taskId)).toEqual(["task-ungated"]);
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toBeNull();
    expect(
      harness.handle.store.getState().pendingBackgroundStops,
    ).toHaveProperty("task-ungated");
  });

  it("clears the escalation without firing when a different turn is seen active", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand = gatedCommandItem();
    const turnOne: ChatActiveTurn = {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId: "turn-1",
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 3,
      updatedAt: 3,
      reasoningEffort: null,
      serviceTier: null,
    };
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
      runStatus: "running",
      activeTurn: turnOne,
      turnInProgress: true,
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sent,
      awaitingTurnEnd: true,
      turnId: "turn-1",
    });

    // A different turn is now running - a queued send started while the
    // escalation was in flight. Firing at ITS end would stop work the user
    // never confirmed stopping.
    const turnTwo: ChatActiveTurn = {
      ...turnOne,
      turnId: "turn-2",
      userMessageId: "message-2",
    };
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: turnTwo,
      turnInProgress: true,
      backgroundItems: [gatedCommand],
    });

    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toBeNull();
    expect(harness.sent).toHaveLength(1);

    // Turn two settles - the released escalation must not resurrect itself.
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      backgroundItems: [gatedCommand],
    });

    expect(harness.sent).toHaveLength(1);
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toBeNull();
  });

  it("latches the first turn id observed when the escalation was confirmed before the turn had one", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const gatedCommand = gatedCommandItem();
    // The request-to-turn activation window: the host reports a turn in
    // progress before the turn record (and its id) exists.
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: [gatedCommand],
      runStatus: "running",
      activeTurn: null,
      turnInProgress: true,
    });

    const sent = harness.handle.store.getState().stopBackgroundSession();
    expect(sent).not.toBeNull();
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sent,
      awaitingTurnEnd: true,
      turnId: null,
    });

    // The original turn materializes with its id - the slot latches it.
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: runningActiveTurn(),
      turnInProgress: true,
      backgroundItems: [gatedCommand],
    });
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toEqual({
      clientActionId: sent,
      awaitingTurnEnd: true,
      turnId: "turn-1",
    });

    // A queued turn replaces it - the latched id makes it read as different,
    // so the escalation releases instead of firing at turn-2's end.
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: { ...runningActiveTurn(), turnId: "turn-2" },
      turnInProgress: true,
      backgroundItems: [gatedCommand],
    });
    expect(
      harness.handle.store.getState().pendingBackgroundSessionStop,
    ).toBeNull();
    expect(harness.sent).toHaveLength(1);
  });

  it("does not apply an ownerless detached background tool terminal to the active turn", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "text.delta",
        blockId: "active-text",
        timestamp: 4,
        delta: "Active turn",
      },
    });

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "tool_call.completed",
        blockId: "detached-tool",
        timestamp: 5,
        toolName: "Bash",
        agentMessageSend: null,
        backgroundTask: true,
        imageResults: [],
      },
    });

    const blocks = harness.handle.store.getState().liveAssistantMessage?.blocks;
    expect(blocks).toEqual([
      expect.objectContaining({ type: "text", blockId: "active-text" }),
    ]);
  });

  // The codex analogue of the detached tool_call terminal above: codex
  // backgrounds a plain `command` block, and its terminal lands as
  // `command.completed` minutes after the row settled (live-repro: the card
  // ticked forever and only "cleared" when the next send re-derived state).
  it("routes a detached background command's terminal to the settled row that owns it", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [
        {
          role: "assistant",
          messageId: "assistant-settled",
          sender: {
            type: "agent",
            harnessId: "codex",
            agentId: "codex",
            displayName: "Codex",
            reply: { expectsReply: false },
            inReplyTo: null,
          },
          blocks: [
            {
              type: "command",
              blockId: "bg-command",
              status: "streaming",
              timestamp: 2,
              command: "sleep 20 && echo done",
              cwd: "/tmp",
              exitCode: null,
              backgroundTask: true,
              stopped: false,
            },
          ],
          startedAt: 2,
          timestamp: 2,
          turnId: "turn-settled",
          usage: null,
          reasoningEffort: null,
          serviceTier: null,
          imageResolutions: [],
        },
      ],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
    // A NEXT turn is live (raised directly - `startRunningTurn` would emit its
    // own snapshot and wipe the settled row above).
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: runningActiveTurn(),
    });
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "text.delta",
        blockId: "active-text",
        timestamp: 4,
        delta: "Active turn",
      },
    });

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "command.completed",
        blockId: "bg-command",
        timestamp: 30,
        command: "sleep 20 && echo done",
        exitCode: 0,
        backgroundTask: true,
      },
    });

    const state = harness.handle.store.getState();
    const settled = state.messages.find(
      (message) => message.messageId === "assistant-settled",
    );
    if (settled?.role !== "assistant") {
      throw new Error("Expected the settled assistant row");
    }
    expect(settled.blocks).toEqual([
      expect.objectContaining({
        type: "command",
        blockId: "bg-command",
        status: "completed",
        exitCode: 0,
      }),
    ]);
    expect(state.liveAssistantMessage?.blocks).toEqual([
      expect.objectContaining({ type: "text", blockId: "active-text" }),
    ]);
  });

  it("does not apply an ownerless detached background command terminal to the active turn", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "text.delta",
        blockId: "active-text",
        timestamp: 4,
        delta: "Active turn",
      },
    });

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "command.completed",
        blockId: "detached-command",
        timestamp: 5,
        command: "sleep 20 && echo done",
        exitCode: 0,
        backgroundTask: true,
      },
    });

    const blocks = harness.handle.store.getState().liveAssistantMessage?.blocks;
    expect(blocks).toEqual([
      expect.objectContaining({ type: "text", blockId: "active-text" }),
    ]);
  });

  // The live turn's OWN cards, which the detached drop must never eat.
  //
  // "No message owns this block" is the detached test, and it is satisfied by
  // two opposite situations: an evicted owner (drop) and a block that does not
  // exist YET because this very event creates it (keep). The active turn's row
  // is `liveAssistantMessage` until it materializes, and that is not in
  // `state.messages` at all - so on a live turn the ownership scan finds
  // nothing for either one, and reading that as "detached" drops the card at
  // its birth. Everything after it then has no owner either, so nothing about
  // the subagent ever renders.
  it("creates the active turn's own subagent card from its first subagent.started", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);
    emitTextDelta(callbacks, "Active turn", 4);

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "subagent.started",
        blockId: "live-subagent",
        timestamp: 5,
        name: "Explore",
      },
    });

    expect(
      harness.handle.store.getState().liveAssistantMessage?.blocks,
    ).toEqual([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({
        type: "subagent",
        blockId: "live-subagent",
        status: "streaming",
      }),
    ]);
  });

  it("keeps applying progress and completion to the subagent card it created", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);
    const emit = (event: RuntimeEvent): void => {
      callbacks.onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event,
      });
    };
    emit({
      type: "subagent.started",
      blockId: "live-subagent",
      timestamp: 5,
      name: "Explore",
    });
    emit({
      type: "subagent.progress",
      blockId: "live-subagent",
      timestamp: 6,
      update: "reading files",
    });
    emit({
      type: "subagent.completed",
      blockId: "live-subagent",
      timestamp: 7,
      outcome: "completed",
      result: "done",
    });

    expect(
      harness.handle.store.getState().liveAssistantMessage?.blocks,
    ).toEqual([
      expect.objectContaining({
        type: "subagent",
        blockId: "live-subagent",
        status: "completed",
        progressUpdates: ["reading files"],
        result: "done",
      }),
    ]);
  });

  // The widest arm of the same seam: a nested event names its owner through
  // `parentBlockId`, and that owner is MANDATORY - it never falls through. So
  // for a subagent's own tool activity the live row is the only place its
  // parent can be found, and not looking there strands every child of a card
  // the active turn is still building.
  it("nests a live subagent's own tool call under it", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);
    const emit = (event: RuntimeEvent): void => {
      callbacks.onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event,
      });
    };
    emit({
      type: "subagent.started",
      blockId: "live-subagent",
      timestamp: 5,
      name: "Explore",
    });
    emit({
      type: "tool_call.started",
      blockId: "child-tool",
      parentBlockId: "live-subagent",
      timestamp: 6,
      toolName: "Grep",
      agentMessageSend: null,
    });
    emit({
      type: "tool_call.completed",
      blockId: "child-tool",
      parentBlockId: "live-subagent",
      timestamp: 7,
      toolName: "Grep",
      agentMessageSend: null,
      imageResults: [],
    });

    expect(
      harness.handle.store.getState().liveAssistantMessage?.blocks,
    ).toEqual([
      expect.objectContaining({ type: "subagent", blockId: "live-subagent" }),
      expect.objectContaining({
        type: "tool_call",
        blockId: "child-tool",
        parentBlockId: "live-subagent",
        status: "completed",
      }),
    ]);
  });

  // A foreground tool call is the same shape one step over: `tool_call.started`
  // creates the block on the live row, and its terminal names that block by its
  // own id with no `parentBlockId`. If the terminal is read as detached the
  // call spins forever, which is the same defect as the subagent card and not a
  // separate one.
  it("completes the active turn's own foreground tool call", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);
    const emit = (event: RuntimeEvent): void => {
      callbacks.onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event,
      });
    };
    emit({
      type: "tool_call.started",
      blockId: "live-tool",
      timestamp: 5,
      toolName: "Read",
      agentMessageSend: null,
    });
    emit({
      type: "tool_call.completed",
      blockId: "live-tool",
      timestamp: 6,
      toolName: "Read",
      agentMessageSend: null,
      imageResults: [],
    });

    expect(
      harness.handle.store.getState().liveAssistantMessage?.blocks,
    ).toEqual([
      expect.objectContaining({
        type: "tool_call",
        blockId: "live-tool",
        status: "completed",
      }),
    ]);
  });

  // The other half of the seam: an update naming a card that genuinely is not
  // here must still be dropped rather than synthesized under whatever turn is
  // running. `subagent.progress` and `subagent.completed` both BUILD a card
  // when none exists (see the accumulator), which is exactly what makes the
  // fall-through dangerous for them and harmless for `started`.
  it.each([
    [
      "progress",
      {
        type: "subagent.progress",
        blockId: "evicted-subagent",
        timestamp: 5,
        update: "still working",
      } satisfies RuntimeEvent,
    ],
    [
      "completed",
      {
        type: "subagent.completed",
        blockId: "evicted-subagent",
        timestamp: 5,
        outcome: "completed",
        result: "done",
      } satisfies RuntimeEvent,
    ],
  ])(
    "still drops an ownerless subagent %s rather than opening a card for it",
    (_label, event) => {
      const harness = createHarness();
      const callbacks = harness.callbacks();
      startRunningTurn(callbacks);
      emitTextDelta(callbacks, "Active turn", 4);

      callbacks.onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event,
      });

      expect(
        harness.handle.store.getState().liveAssistantMessage?.blocks,
      ).toEqual([expect.objectContaining({ type: "text" })]);
    },
  );

  // `workflow.*` is the same card by another name: all three write the SAME
  // `subagent` block through `makeSubAgentBlock`, addressed by `event.blockId`,
  // and all three build one when none exists - the accumulator's `started`
  // opens, `progress`/`completed` update-or-synthesize, exactly as `subagent.*`
  // does. A Workflow run is a fleet that outlives its spawning turn for the
  // same reason a background subagent does, so it inherits the same hazard and
  // must inherit the same rule.
  it("creates the active turn's own workflow card from its first workflow.started", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);
    emitTextDelta(callbacks, "Active turn", 4);

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "workflow.started",
        blockId: "live-workflow",
        timestamp: 5,
        name: "review-changes",
        intent: "Review changed files across dimensions",
      },
    });

    expect(
      harness.handle.store.getState().liveAssistantMessage?.blocks,
    ).toEqual([
      expect.objectContaining({ type: "text" }),
      expect.objectContaining({
        type: "subagent",
        blockId: "live-workflow",
        status: "streaming",
      }),
    ]);
  });

  it("keeps applying progress and completion to the workflow card it created", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);
    const emit = (event: RuntimeEvent): void => {
      callbacks.onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event,
      });
    };
    emit({
      type: "workflow.started",
      blockId: "live-workflow",
      timestamp: 5,
      name: "review-changes",
      intent: "Review changed files",
    });
    emit({
      type: "workflow.progress",
      blockId: "live-workflow",
      timestamp: 6,
      activity: { kind: "phase", text: "Review" },
      agentsStarted: 3,
      agentsFinished: 1,
    });
    emit({
      type: "workflow.completed",
      blockId: "live-workflow",
      timestamp: 7,
      outcome: "completed",
      result: "3 findings",
    });

    expect(
      harness.handle.store.getState().liveAssistantMessage?.blocks,
    ).toEqual([
      expect.objectContaining({
        type: "subagent",
        blockId: "live-workflow",
        status: "completed",
        progressUpdates: ["Review"],
        result: "3 findings",
      }),
    ]);
  });

  it.each([
    [
      "progress",
      {
        type: "workflow.progress",
        blockId: "evicted-workflow",
        timestamp: 5,
        activity: { kind: "phase", text: "Verify" },
        agentsStarted: 4,
        agentsFinished: 2,
      } satisfies RuntimeEvent,
    ],
    [
      "completed",
      {
        type: "workflow.completed",
        blockId: "evicted-workflow",
        timestamp: 5,
        outcome: "completed",
        result: "done",
      } satisfies RuntimeEvent,
    ],
  ])(
    "still drops an ownerless workflow %s rather than opening a card for it",
    (_label, event) => {
      const harness = createHarness();
      const callbacks = harness.callbacks();
      startRunningTurn(callbacks);
      emitTextDelta(callbacks, "Active turn", 4);

      callbacks.onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event,
      });

      expect(
        harness.handle.store.getState().liveAssistantMessage?.blocks,
      ).toEqual([expect.objectContaining({ type: "text" })]);
    },
  );

  // The door the opens-its-own-card exemption leaves open, and both sides of
  // it. The accumulator deliberately accepts a `subagent.started` re-emitted
  // AFTER its turn completed - Codex resolves the agent nickname
  // asynchronously and re-emits when it lands - so "no row owns this block" can
  // mean an evicted row rather than a new card. Nothing on the wire separates
  // the two: a `blockDelta` carries no turn identity, and the re-emit is the
  // same event shape as the start. Only the session's memory of what it has
  // already opened can, so that is what decides it.
  it.each([
    ["subagent", "subagent.started", "subagent.progress"],
    ["workflow", "workflow.started", "workflow.progress"],
  ])(
    "drops a late %s start re-emit whose card was evicted",
    (_label, startedType, _progressType) => {
      const harness = createHarness();
      const callbacks = harness.callbacks();
      startRunningTurn(callbacks);
      const started: RuntimeEvent =
        startedType === "subagent.started"
          ? {
              type: "subagent.started",
              blockId: "run-1",
              timestamp: 5,
              name: "Explore",
            }
          : {
              type: "workflow.started",
              blockId: "run-1",
              timestamp: 5,
              name: "review",
              intent: "Review",
            };
      const emit = (event: RuntimeEvent): void => {
        callbacks.onBlockDelta({
          kind: "blockDelta",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          event,
        });
      };

      // The genuine first start opens the card on the live turn.
      emit(started);
      expect(
        harness.handle.store.getState().liveAssistantMessage?.blocks,
      ).toEqual([expect.objectContaining({ blockId: "run-1" })]);

      // That turn ends and a new one begins; the old row is not hydrated here,
      // which is exactly what eviction looks like to this reducer.
      settleTurnAndEvictItsRow(callbacks);
      emitTextDelta(callbacks, "Second turn", 20);

      // The nickname resolves and the adapter re-emits the SAME start.
      emit({ ...started, timestamp: 21 });

      // The new turn shows its own text and nothing else: the re-emit did not
      // mint a copy of the old card here.
      expect(
        harness.handle.store.getState().liveAssistantMessage?.blocks,
      ).toEqual([expect.objectContaining({ type: "text" })]);
    },
  );

  it("still opens a card for a DIFFERENT run started on the later turn", () => {
    // The direction the memory must not break. A start whose block id this
    // session has never seen is a first start no matter how many turns have
    // been and gone, so the later turn's own subagent still gets its card.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);
    const emit = (event: RuntimeEvent): void => {
      callbacks.onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event,
      });
    };
    emit({
      type: "subagent.started",
      blockId: "run-1",
      timestamp: 5,
      name: "Explore",
    });

    settleTurnAndEvictItsRow(callbacks);
    emit({
      type: "subagent.started",
      blockId: "run-2",
      timestamp: 21,
      name: "Verify",
    });

    expect(
      harness.handle.store.getState().liveAssistantMessage?.blocks,
    ).toEqual([
      expect.objectContaining({
        type: "subagent",
        blockId: "run-2",
        status: "streaming",
      }),
    ]);
  });

  it("keeps a completed live assistant visible when the next turn starts", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: {
        agentMode: "regular",
        sameTurnSteeringSupported: false,
        turnId: "turn-1",
        status: "running",
        harnessId: "codex",
        model: "gpt-5.4",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 3,
        updatedAt: 3,
        reasoningEffort: null,
        serviceTier: null,
      },
    });
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "text.delta",
        blockId: "block-1",
        timestamp: 4,
        delta: "First answer",
      },
    });
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    expect(harness.handle.store.getState().liveAssistantMessage).toBeNull();
    expect(
      harness.handle.store
        .getState()
        .messages.filter((message) => message.role === "assistant"),
    ).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        blocks: [expect.objectContaining({ text: "First answer" })],
        blocksVersion: 1,
      }),
    ]);

    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: "message-2",
        sender: { type: "user", userId: OWNER_ID },
        message: {
          kind: "user",
          content: CONTENT,
          browserAnnotations: [],
        },
        timestamp: 5,
        sessionAnchor: null,
      },
    });
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: {
        agentMode: "regular",
        sameTurnSteeringSupported: false,
        turnId: "turn-2",
        status: "running",
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        userMessageId: "message-2",
        startedAt: 6,
        updatedAt: 6,
        reasoningEffort: null,
        serviceTier: null,
      },
    });

    const state = harness.handle.store.getState();
    expect(
      state.messages.some(
        (message) =>
          message.role === "assistant" && message.turnId === "turn-1",
      ),
    ).toBe(true);
    expect(state.liveAssistantMessage?.turnId).toBe("turn-2");
    expect(state.liveAssistantMessage?.sender.harnessId).toBe("claude");
  });

  it("moves assistant placeholders when provider turn ids replace local turn ids", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: {
        agentMode: "regular",
        sameTurnSteeringSupported: false,
        turnId: "turn-local",
        status: "starting",
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 3,
        updatedAt: 3,
        reasoningEffort: null,
        serviceTier: null,
      },
    });
    callbacks.onSnapshot({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      snapshot: {
        chat: {
          id: CHAT_ID,
          parentId: null,
          userId: OWNER_ID,
          hostId: "test-host",
          title: "Host Chat",
          createdAt: 1,
          updatedAt: 3,
          isTitleEditedByUser: false,
          settings: null,
          activeSessionChain: null,
          claudePendingWakes: [],
          messages: [
            {
              role: "assistant",
              messageId: "assistant-1",
              sender: {
                type: "agent",
                harnessId: "claude",
                agentId: "claude-sonnet",
                displayName: "claude-sonnet",
                reply: { expectsReply: false },
                inReplyTo: null,
              },
              blocks: [],
              startedAt: 3,
              timestamp: 3,
              turnId: "turn-local",
              usage: null,
              reasoningEffort: null,
              serviceTier: null,
              imageResolutions: [],
            },
          ],
          events: [],
          archivedAt: null,
          pinnedUserProviderHandle: null,
          lastDeliveredRolesDigest: null,
        },
        access: {
          role: "owner",
          ownerUserId: OWNER_ID,
          canAct: true,
        },
        queue: { status: "idle", items: [] },
        runStatus: "running",
        activeTurn: {
          agentMode: "regular",
          sameTurnSteeringSupported: false,
          turnId: "turn-local",
          status: "starting",
          harnessId: "claude",
          model: "claude-sonnet",
          profileId: null,
          userMessageId: "message-1",
          startedAt: 3,
          updatedAt: 3,
          reasoningEffort: null,
          serviceTier: null,
        },
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChanges: [],
        managedCommands: [],
        heldUpdates: [],
      },
    });
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: {
        agentMode: "regular",
        sameTurnSteeringSupported: false,
        turnId: "turn-provider",
        status: "running",
        harnessId: "claude",
        model: "claude-sonnet",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 3,
        updatedAt: 4,
        reasoningEffort: null,
        serviceTier: null,
      },
    });
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "text.delta",
        blockId: "block-1",
        timestamp: 5,
        delta: "I am in the host folder.",
      },
    });

    const state = harness.handle.store.getState();
    const assistantMessages = state.messages.filter(
      (message): message is Extract<Message, { role: "assistant" }> =>
        message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.turnId).toBe("turn-provider");
    expect(assistantMessages[0]?.blocks).toMatchObject([
      { type: "text", text: "I am in the host folder." },
    ]);
    expect(state.liveAssistantMessage).toBeNull();
  });

  it("routes a steer-split carryover block's events to the frozen pre-split row (completes in place, no duplicate)", () => {
    // A steer delivered mid-thinking splits the turn into two assistant rows
    // sharing one turnId, with the reasoning block still STREAMING in the
    // frozen pre-split row. Its remaining deltas + completion must apply to
    // that row (the block finishes in place above the steer bubble); only a
    // genuinely NEW block belongs to the continuation row. Without ownership
    // routing the delta re-materialized the block as a duplicate in the
    // continuation row while the original froze mid-sentence.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const agentSender: Extract<Message, { role: "assistant" }>["sender"] = {
      type: "agent",
      harnessId: "claude",
      agentId: "claude-sonnet",
      displayName: "claude-sonnet",
      reply: { expectsReply: false },
      inReplyTo: null,
    };
    callbacks.onSnapshot({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      snapshot: {
        chat: {
          id: CHAT_ID,
          parentId: null,
          userId: OWNER_ID,
          hostId: "test-host",
          title: "Split Chat",
          createdAt: 1,
          updatedAt: 5,
          isTitleEditedByUser: false,
          settings: null,
          activeSessionChain: null,
          claudePendingWakes: [],
          messages: [
            persistedUserMessage("message-split-run"),
            {
              role: "assistant",
              messageId: "assistant-frozen",
              sender: agentSender,
              blocks: [
                {
                  type: "reasoning",
                  blockId: "think-split",
                  status: "streaming",
                  timestamp: 4,
                  startedAt: 4,
                  content: "The grep search is pulling in fal",
                },
              ],
              startedAt: 3,
              timestamp: 4,
              turnId: "turn-split",
              usage: null,
              reasoningEffort: null,
              serviceTier: null,
              imageResolutions: [],
            },
            persistedUserMessage("message-split-steered"),
            {
              role: "assistant",
              messageId: "assistant-continuation",
              sender: agentSender,
              blocks: [
                {
                  type: "steer",
                  blockId: "steer:queue-split-steered",
                  status: "completed",
                  timestamp: 5,
                  queueItemId: "queue-split-steered",
                  messageId: "message-split-steered",
                  content: CONTENT,
                  mode: "safe_point",
                  sender: null,
                },
              ],
              startedAt: 3,
              timestamp: 5,
              turnId: "turn-split",
              usage: null,
              reasoningEffort: null,
              serviceTier: null,
              imageResolutions: [],
            },
          ],
          events: [],
          archivedAt: null,
          pinnedUserProviderHandle: null,
          lastDeliveredRolesDigest: null,
        },
        access: {
          role: "owner",
          ownerUserId: OWNER_ID,
          canAct: true,
        },
        queue: { status: "idle", items: [] },
        runStatus: "running",
        activeTurn: {
          agentMode: "regular",
          sameTurnSteeringSupported: false,
          turnId: "turn-split",
          status: "running",
          harnessId: "claude",
          model: "claude-sonnet",
          profileId: null,
          userMessageId: "message-split-run",
          startedAt: 3,
          updatedAt: 5,
          reasoningEffort: null,
          serviceTier: null,
        },
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChanges: [],
        managedCommands: [],
        heldUpdates: [],
      },
    });

    // The SAME in-flight reasoning block keeps streaming after the split,
    // then finalizes; a genuinely new text block follows it.
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "reasoning.delta",
        blockId: "think-split",
        timestamp: 6,
        delta: "se positives.",
      },
    });
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "reasoning.completed",
        blockId: "think-split",
        timestamp: 7,
      },
    });
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "text.delta",
        blockId: "text-after-steer",
        timestamp: 8,
        delta: "Continuing after the steer.",
      },
    });

    const state = harness.handle.store.getState();
    const frozen = state.messages.find(
      (message): message is Extract<Message, { role: "assistant" }> =>
        message.role === "assistant" &&
        message.messageId === "assistant-frozen",
    );
    const continuation = state.messages.find(
      (message): message is Extract<Message, { role: "assistant" }> =>
        message.role === "assistant" &&
        message.messageId === "assistant-continuation",
    );
    // The in-flight block completed IN PLACE in the frozen row, whole.
    expect(frozen?.blocks).toMatchObject([
      {
        type: "reasoning",
        blockId: "think-split",
        status: "completed",
        content: "The grep search is pulling in false positives.",
      },
    ]);
    // The frozen row's own timestamp is untouched by carryover routing - only
    // its blocks/blocksVersion change (mirrors the host's carryover writer).
    expect(frozen?.timestamp).toBe(4);
    // The continuation row holds the steer marker and the NEW block only -
    // no duplicate reasoning block below the steer bubble.
    expect(
      continuation?.blocks.filter((block) => block.type === "reasoning"),
    ).toStrictEqual([]);
    expect(continuation?.blocks).toMatchObject([
      { type: "steer", blockId: "steer:queue-split-steered" },
      { type: "text", blockId: "text-after-steer" },
    ]);

    // A CHILD of the frozen block (parentBlockId) also follows its parent
    // into the frozen row, not the continuation row.
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "tool_call.started",
        blockId: "child-of-think-split",
        parentBlockId: "think-split",
        timestamp: 9,
        toolName: "read_file",
        agentMessageSend: null,
      },
    });

    const stateAfterChild = harness.handle.store.getState();
    const frozenAfterChild = stateAfterChild.messages.find(
      (message): message is Extract<Message, { role: "assistant" }> =>
        message.role === "assistant" &&
        message.messageId === "assistant-frozen",
    );
    const continuationAfterChild = stateAfterChild.messages.find(
      (message): message is Extract<Message, { role: "assistant" }> =>
        message.role === "assistant" &&
        message.messageId === "assistant-continuation",
    );
    expect(frozenAfterChild?.blocks).toMatchObject([
      { blockId: "think-split" },
      { blockId: "child-of-think-split", parentBlockId: "think-split" },
    ]);
    expect(
      continuationAfterChild?.blocks.some(
        (block) => block.blockId === "child-of-think-split",
      ),
    ).toBe(false);
  });

  it("tracks live in-flight usage from usage.updated and carries the final value forward through turn.completed", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: {
        agentMode: "regular",
        sameTurnSteeringSupported: false,
        turnId: "turn-1",
        status: "running",
        harnessId: "claude",
        model: "claude-sonnet-4",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 1,
        updatedAt: 1,
        reasoningEffort: null,
        serviceTier: null,
      },
    });

    expect(harness.handle.store.getState().liveTurnUsage).toBeNull();

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "usage.updated",
        blockId: "turn-1",
        timestamp: 2,
        turnId: "turn-1",
        usage: {
          inputTokens: 40_000,
          outputTokens: 0,
          totalTokens: 40_000,
          contextWindow: 200_000,
        },
      },
    });

    expect(harness.handle.store.getState().liveTurnUsage).toMatchObject({
      inputTokens: 40_000,
      contextWindow: 200_000,
    });

    // A later usage.updated overwrites the previous in-flight number so the
    // chip tracks the most recent SDK poll.
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "usage.updated",
        blockId: "turn-1",
        timestamp: 3,
        turnId: "turn-1",
        usage: {
          inputTokens: 60_000,
          outputTokens: 0,
          totalTokens: 60_000,
          contextWindow: 200_000,
        },
      },
    });

    expect(harness.handle.store.getState().liveTurnUsage?.inputTokens).toBe(
      60_000,
    );

    // turn.completed CARRIES the final usage forward (instead of
    // clearing) so the chip doesn't briefly fall back to the prior
    // turn's persisted usage during the post-completion snapshot gap.
    // It will be cleared on the next turn.started or snapshot ingest.
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "turn.completed",
        blockId: "turn-1",
        timestamp: 4,
        turnId: "turn-1",
        usage: {
          inputTokens: 80_000,
          outputTokens: 1_000,
          totalTokens: 81_000,
          contextWindow: 200_000,
        },
      },
    });

    expect(harness.handle.store.getState().liveTurnUsage).toEqual({
      inputTokens: 80_000,
      outputTokens: 1_000,
      totalTokens: 81_000,
      contextWindow: 200_000,
    });
  });

  it("clears stale liveTurnUsage on turn.started so a new turn doesn't show the previous turn's number", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "usage.updated",
        blockId: "turn-1",
        timestamp: 1,
        turnId: "turn-1",
        usage: {
          inputTokens: 40_000,
          outputTokens: 0,
          totalTokens: 40_000,
          contextWindow: 200_000,
        },
      },
    });
    expect(harness.handle.store.getState().liveTurnUsage).not.toBeNull();

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "turn.started",
        blockId: "turn-2",
        timestamp: 2,
        turnId: "turn-2",
      },
    });

    expect(harness.handle.store.getState().liveTurnUsage).toBeNull();
  });

  it("populates worktreeBinding from the chat.subscribe snapshot", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const binding = bindingForEntry("/repo", "running");
    emitSnapshotWithWorktree(callbacks, [], binding);

    expect(harness.handle.store.getState().worktreeBinding).toEqual(binding);
  });

  it("updates worktreeBinding from worktreeStateChanged frames", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotWithWorktree(
      callbacks,
      [],
      bindingForEntry("/repo", "running"),
    );

    const succeeded = bindingForEntry("/repo", "succeeded");
    callbacks.onWorktreeStateChanged({
      kind: "worktreeStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      worktreeBinding: succeeded,
      missingWorktreePaths: [],
    });
    expect(harness.handle.store.getState().worktreeBinding).toEqual(succeeded);

    callbacks.onWorktreeStateChanged({
      kind: "worktreeStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      worktreeBinding: null,
      missingWorktreePaths: [],
    });
    expect(harness.handle.store.getState().worktreeBinding).toBeNull();
  });

  it("refreshMissingWorktreePaths overwrites the missing set from an on-focus recheck", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotWithWorktree(
      callbacks,
      [],
      bindingForEntry("/repo", "succeeded"),
    );
    // Stream reports the bound folder missing on disk (composer disables send).
    callbacks.onWorktreeStateChanged({
      kind: "worktreeStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      worktreeBinding: bindingForEntry("/repo", "succeeded"),
      missingWorktreePaths: ["/repo"],
    });
    expect(harness.handle.store.getState().missingWorktreePaths).toEqual([
      "/repo",
    ]);

    // The chat tile's on-focus `worktree.getBinding` recompute finds the folder
    // restored and syncs the cleared set in — this is what lifts the send
    // disable without a send or reload.
    harness.handle.store.getState().refreshMissingWorktreePaths([]);
    expect(harness.handle.store.getState().missingWorktreePaths).toEqual([]);

    // An unchanged recompute is a no-op (same reference) so steady-state focus
    // refetches don't churn the store / re-render the composer.
    const before = harness.handle.store.getState().missingWorktreePaths;
    harness.handle.store.getState().refreshMissingWorktreePaths([]);
    expect(harness.handle.store.getState().missingWorktreePaths).toBe(before);
  });

  it("ignores worktreeStateChanged frames addressed to another chat", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const binding = bindingForEntry("/repo", "running");
    emitSnapshotWithWorktree(callbacks, [], binding);

    callbacks.onWorktreeStateChanged({
      kind: "worktreeStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: "other-chat",
      worktreeBinding: null,
      missingWorktreePaths: [],
    });
    expect(harness.handle.store.getState().worktreeBinding).toEqual(binding);
  });

  it("appends worktree-aware chat events from eventAppended frames", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotWithWorktree(callbacks, [], null);

    const running = chatEvent("event-1", "setup.running", {
      workspacePath: "/repo",
      terminalSessionId: "term-1",
    });
    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: running,
    });

    expect(harness.handle.store.getState().events).toEqual([running]);
  });

  it("takeSetupFailedRestoration removes a pending entry once and returns the cached content", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const sent = harness.sent.at(-1);
    if (sent === undefined || sent.kind !== "send") {
      throw new Error("expected send frame");
    }
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);

    const restored = harness.handle.store
      .getState()
      .takeSetupFailedRestoration(sent.messageId);
    expect(restored).toEqual(CONTENT);
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);

    // Idempotent: a second call returns null and leaves state untouched so
    // a duplicate `setup.failed` event does not double-restore.
    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toBeNull();
  });

  it("takeSetupFailedRestoration recovers content from acceptedActions after messageAccepted clears pendingUserMessages", () => {
    // Bug guard for the worktree-setup gating restore path. The host
    // accepts the send (`actionAck` + `messageAccepted`) before
    // `startProviderTurn` awaits setup. `messageAccepted` clears
    // `pendingUserMessages`, so the later setup-gating `setup.failed` would
    // otherwise find nothing to restore. The accepted-action record retains the
    // original `restore` slot so the composer can still recover the
    // triggering prompt exactly once.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const sent = harness.sent.at(-1);
    if (sent === undefined || sent.kind !== "send") {
      throw new Error("expected send frame");
    }

    callbacks.onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: sent.clientActionId,
      action: "send",
      status: "accepted",
      reason: null,
      code: null,
      backgroundStopTaskIds: [],
    });
    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: sent.messageId,
        sender: { type: "user", userId: OWNER_ID },
        message: {
          kind: "user",
          content: CONTENT,
          browserAnnotations: [],
        },
        timestamp: 2,
        sessionAnchor: null,
      },
    });

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(
      harness.handle.store.getState().acceptedActions[sent.clientActionId],
    ).toMatchObject({
      action: "send",
      messageId: sent.messageId,
      restore: { content: CONTENT, browserAnnotations: [] },
    });

    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toEqual(CONTENT);

    // The accepted-action record stays in place (so other reconciliation
    // continues to work) but the restore slot is cleared so a
    // duplicate setup.failed cannot double-restore.
    expect(
      harness.handle.store.getState().acceptedActions[sent.clientActionId],
    ).toMatchObject({
      action: "send",
      messageId: sent.messageId,
      restore: null,
    });
    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toBeNull();
  });

  it("takeSetupFailedRestoration recovers content from pendingActions when messageAccepted lands before actionAck", () => {
    // Race coverage: the host may publish `messageAccepted` ahead of
    // the `actionAck`. `messageAccepted` clears `pendingUserMessages`
    // but the still-pending action retains the original
    // `restore` slot, so a setup-gating `setup.failed` arriving in
    // this in-between window must still recover the prompt.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const sent = harness.sent.at(-1);
    if (sent === undefined || sent.kind !== "send") {
      throw new Error("expected send frame");
    }

    callbacks.onMessageAccepted({
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      message: {
        role: "user",
        messageId: sent.messageId,
        sender: { type: "user", userId: OWNER_ID },
        message: {
          kind: "user",
          content: CONTENT,
          browserAnnotations: [],
        },
        timestamp: 2,
        sessionAnchor: null,
      },
    });

    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(
      harness.handle.store.getState().pendingActions[sent.clientActionId],
    ).toMatchObject({
      action: "send",
      messageId: sent.messageId,
      restore: { content: CONTENT, browserAnnotations: [] },
    });

    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toEqual(CONTENT);
    expect(
      harness.handle.store.getState().pendingActions[sent.clientActionId]
        .restore,
    ).toBeNull();
    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toBeNull();
  });

  it("appends the worktree-aware event chain in order", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();

    const running = chatEvent("event-running", "setup.running", {
      workspacePath: "/repo",
      terminalSessionId: "term-1",
    });
    const failed = chatEvent("event-failed", "setup.failed", {
      workspacePath: "/repo",
      setupExitCode: 2,
    });
    const cancelled = chatEvent("event-cancelled", "setup.cancelled", {
      workspacePath: "/repo",
      terminalSessionId: "term-1",
    });
    const missing = chatEvent("event-missing", "worktree.missing", {
      workspacePath: "/repo",
      priorWorktreePath: "/repo-wt",
    });

    emitSnapshotWithWorktree(callbacks, [running], null);
    [failed, cancelled, missing].forEach((event) => {
      callbacks.onEventAppended({
        kind: "eventAppended",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event,
      });
    });

    // The store retains the worktree-aware events in append order; the
    // in-transcript setup card derives its own view-model from this stream
    // (covered in setup-card-rows tests). Missing-worktree send-gating no longer
    // reads this stream — it reads the host-computed `missingWorktreePaths`
    // field (carried on the snapshot + `worktreeStateChanged`).
    expect(
      harness.handle.store.getState().events.map((event) => event.eventId),
    ).toEqual([
      "event-running",
      "event-failed",
      "event-cancelled",
      "event-missing",
    ]);
  });

  it("selectRestorableSetupInterruption surfaces the gating failure even when a transition-only setup.failed lands later", () => {
    // Bug guard for the setup-failure restore ordering bug: the gating
    // path emits `setup.failed` with the queued message id, then the
    // binding-change observer emits a transition-only `setup.failed`
    // (`messageId: null`) for the same `running → failed` step. Walking
    // strictly the latest `setup.failed` would shadow the gating event
    // and break composer restore. The restorable selector keeps the
    // gating event visible regardless of arrival order.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotWithWorktree(callbacks, [], null);

    const gating = chatEvent("event-gating", "setup.failed", {
      workspacePath: "/repo",
      setupExitCode: 2,
      terminalSessionId: "term-gating",
    });
    const gatingWithMessage: ChatEvent = {
      ...gating,
      messageId: "queued-msg-1",
      clientActionId: "send-1",
    };
    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: gatingWithMessage,
    });
    expect(
      selectRestorableSetupInterruption(harness.handle.store.getState()),
    ).toMatchObject({
      messageId: "queued-msg-1",
      clientActionId: "send-1",
      workspacePath: "/repo",
      setupExitCode: 2,
      terminalSessionId: "term-gating",
    });

    const transitionOnly = chatEvent("event-transition", "setup.failed", {
      workspacePath: "/repo",
      setupExitCode: 2,
      terminalSessionId: "term-transition",
    });
    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: transitionOnly,
    });

    // Restorable selector keeps the gating event so Flow 8 restore still
    // fires even after the transition-only emission lands.
    expect(
      selectRestorableSetupInterruption(harness.handle.store.getState()),
    ).toMatchObject({
      eventId: "event-gating",
      messageId: "queued-msg-1",
      clientActionId: "send-1",
    });
  });

  it("selectRestorableSetupInterruption returns null when no setup interruption carries a messageId", () => {
    // A bare binding-transition `setup.failed` (e.g. setup blew up while
    // no message was queued) carries `messageId: null`. There is nothing
    // to restore in that case - the restorable selector must report null.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotWithWorktree(callbacks, [], null);

    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: chatEvent("event-failed", "setup.failed", {
        workspacePath: "/repo",
        setupExitCode: 1,
        terminalSessionId: "term-1",
      }),
    });

    expect(
      selectRestorableSetupInterruption(harness.handle.store.getState()),
    ).toBeNull();
  });

  it("selectRestorableSetupInterruption clears once a retry transitions setup back to running", () => {
    // A `setup.running` for the same workspace means the user (or the
    // orchestrator) has retried setup; the prior gating failure is no
    // longer the active recovery path so the restorable selector must
    // drop it. A fresh gating failure later in the chain re-arms the
    // selector.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotWithWorktree(callbacks, [], null);

    const gating: ChatEvent = {
      ...chatEvent("event-gating-1", "setup.failed", {
        workspacePath: "/repo",
        setupExitCode: 2,
        terminalSessionId: "term-1",
      }),
      messageId: "queued-msg-1",
      clientActionId: "send-1",
    };
    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: gating,
    });
    expect(
      selectRestorableSetupInterruption(harness.handle.store.getState())
        ?.eventId,
    ).toBe("event-gating-1");

    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: chatEvent("event-running-2", "setup.running", {
        workspacePath: "/repo",
        terminalSessionId: "term-2",
      }),
    });
    expect(
      selectRestorableSetupInterruption(harness.handle.store.getState()),
    ).toBeNull();

    const gatingAgain: ChatEvent = {
      ...chatEvent("event-gating-2", "setup.failed", {
        workspacePath: "/repo",
        setupExitCode: 3,
        terminalSessionId: "term-2",
      }),
      messageId: "queued-msg-2",
      clientActionId: "send-2",
    };
    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: gatingAgain,
    });
    expect(
      selectRestorableSetupInterruption(harness.handle.store.getState()),
    ).toMatchObject({
      eventId: "event-gating-2",
      messageId: "queued-msg-2",
    });
  });

  it("selectRestorableSetupInterruption clears a failed setup once setup is cancelled for the same workspace", () => {
    // Cancellation supersedes the gating failure - the message is back
    // on the queue (per `handleSetupGatingError`), so composer restore
    // must not retrigger when a cancel arrives between snapshots.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotWithWorktree(callbacks, [], null);

    const gating: ChatEvent = {
      ...chatEvent("event-gating", "setup.failed", {
        workspacePath: "/repo",
        setupExitCode: 4,
      }),
      messageId: "queued-msg-3",
      clientActionId: "send-3",
    };
    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: gating,
    });
    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: chatEvent("event-cancelled", "setup.cancelled", {
        workspacePath: "/repo",
      }),
    });

    expect(
      selectRestorableSetupInterruption(harness.handle.store.getState()),
    ).toBeNull();
  });

  it("selectRestorableSetupInterruption restores a message-bearing setup cancellation", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotWithWorktree(callbacks, [], null);

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const sent = harness.sent.at(-1);
    if (sent === undefined || sent.kind !== "send") {
      throw new Error("expected send frame");
    }

    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        ...chatEvent("event-cancelled-gating", "setup.cancelled", {
          workspacePath: "/repo",
          terminalSessionId: "term-1",
        }),
        messageId: sent.messageId,
        clientActionId: sent.clientActionId,
      },
    });

    expect(
      selectRestorableSetupInterruption(harness.handle.store.getState()),
    ).toMatchObject({
      eventId: "event-cancelled-gating",
      messageId: sent.messageId,
      clientActionId: sent.clientActionId,
      workspacePath: "/repo",
      terminalSessionId: "term-1",
    });

    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toEqual(CONTENT);
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
  });

  it("keeps a message-bearing setup cancellation restorable after a transition-only cancellation", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshotWithWorktree(callbacks, [], null);

    const gating: ChatEvent = {
      ...chatEvent("event-cancelled-gating", "setup.cancelled", {
        workspacePath: "/repo",
        terminalSessionId: "term-1",
      }),
      messageId: "queued-msg-cancelled",
      clientActionId: "send-cancelled",
    };
    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: gating,
    });
    callbacks.onEventAppended({
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: chatEvent("event-cancelled-transition", "setup.cancelled", {
        workspacePath: "/repo",
        terminalSessionId: "term-transition",
      }),
    });

    expect(
      selectRestorableSetupInterruption(harness.handle.store.getState()),
    ).toMatchObject({
      eventId: "event-cancelled-gating",
      messageId: "queued-msg-cancelled",
      clientActionId: "send-cancelled",
    });
  });

  // ─── On the windowed line the host has already answered ─────────────────
  //
  // The one consumer in the `state.messages` sweep with NO client-side repair.
  // The event this comes from occupies no ordinal, so it is in no row's record
  // set: `sliceTranscriptTail` never carries it and `loadRange` - addressed by
  // ordinal - cannot ask for it. `state.events` never receives it however much
  // the client hydrates, so the scan above is not "degraded over a window", it
  // is permanently blind. It rides the snapshot instead.

  it("takes the host's derived interruption when the events array cannot hold it", () => {
    expect(
      selectRestorableSetupInterruption({
        events: [],
        transcriptWindow: emptyTranscriptWindow(),
        transcriptDerived: {
          latestAssistantUsage: null,
          pinnedTodo: null,
          pinnedTaskTodoItems: [],
          latestForkableAssistantMessageId: null,
          restorableSetupInterruption: {
            eventType: "setup.failed",
            eventId: "event-host-derived",
            workspacePath: "/repo",
            terminalSessionId: null,
            setupExitCode: 1,
            clientActionId: "send-1",
            messageId: "queued-msg",
          },
          interviewAnswerability: [],
          latestAssistantAuthFailureTurnKey: null,
          setupCardWindows: [],
        },
      }),
    ).toMatchObject({
      eventId: "event-host-derived",
      messageId: "queued-msg",
    });
  });

  it("reports the host's null rather than re-running the scan over a window", () => {
    // Not a `??` chain. `restorableSetupInterruption: null` inside a derived
    // payload is an ANSWER - "nothing to restore", the ordinary case - so a
    // stray hydrated event must not override the party that read the whole
    // event log. Falling through here would restore a draft the user never
    // lost, which is the failure this whole selector exists to avoid.
    expect(
      selectRestorableSetupInterruption({
        events: [
          // Carries a `messageId`, so the scan WOULD return it - without that
          // the selector skips it anyway and the assertion proves nothing.
          {
            ...chatEvent("event-hydrated", "setup.failed", {
              workspacePath: "/repo",
            }),
            messageId: "queued-msg-hydrated",
          },
        ],
        // HYDRATED, not live-appended: it is in `events` and NOT in the
        // window's live list, which is the distinction the fold turns on.
        transcriptWindow: emptyTranscriptWindow(),
        transcriptDerived: {
          latestAssistantUsage: null,
          pinnedTodo: null,
          pinnedTaskTodoItems: [],
          latestForkableAssistantMessageId: null,
          restorableSetupInterruption: null,
          interviewAnswerability: [],
          latestAssistantAuthFailureTurnKey: null,
          setupCardWindows: [],
        },
      }),
    ).toBeNull();
  });

  // ─── ... but the host's answer is a snapshot, not a subscription ─────────
  //
  // The derived value states the answer as of the frame it rode in on. A setup
  // failure that happens NEXT reaches this client as an `eventAppended` with no
  // snapshot behind it - `appendLiveRecords` seats a record with no ordinal in
  // `window.liveEvents`, which is exactly the "later than the baseline" set.
  // Without the fold the composer stops restoring drafts for every mid-session
  // failure until something unrelated forces a resnapshot.

  function derivedWith(
    restorableSetupInterruption: RestorableSetupInterruption | null,
  ): ChatTranscriptDerived {
    return {
      latestAssistantUsage: null,
      pinnedTodo: null,
      pinnedTaskTodoItems: [],
      latestForkableAssistantMessageId: null,
      restorableSetupInterruption,
      interviewAnswerability: [],
      latestAssistantAuthFailureTurnKey: null,
      setupCardWindows: [],
    };
  }

  function liveSetupEvent(
    eventId: string,
    type: ChatEvent["type"],
    messageId: string | null,
  ): ChatEvent {
    return {
      ...chatEvent(eventId, type, { workspacePath: "/repo" }),
      messageId,
    };
  }

  it("folds a live-appended interruption over the host's baseline", () => {
    expect(
      selectRestorableSetupInterruption({
        events: [],
        transcriptWindow: {
          ...emptyTranscriptWindow(),
          liveEvents: [
            liveSetupEvent("event-live", "setup.failed", "queued-msg-live"),
          ],
        },
        transcriptDerived: derivedWith(null),
      }),
    ).toMatchObject({
      eventId: "event-live",
      messageId: "queued-msg-live",
    });
  });

  it("clears the host's baseline once a live retry transitions setup back to running", () => {
    expect(
      selectRestorableSetupInterruption({
        events: [],
        transcriptWindow: {
          ...emptyTranscriptWindow(),
          liveEvents: [liveSetupEvent("event-retry", "setup.running", null)],
        },
        transcriptDerived: derivedWith({
          eventType: "setup.failed",
          eventId: "event-host-derived",
          workspacePath: "/repo",
          terminalSessionId: null,
          setupExitCode: 1,
          clientActionId: "send-1",
          messageId: "queued-msg",
        }),
      }),
    ).toBeNull();
  });

  it("keeps the host's baseline when the live appends say nothing about it", () => {
    expect(
      selectRestorableSetupInterruption({
        events: [],
        transcriptWindow: {
          ...emptyTranscriptWindow(),
          // A different workspace's retry must not clear this one.
          liveEvents: [
            {
              ...chatEvent("event-other", "setup.running", {
                workspacePath: "/other",
              }),
              messageId: null,
            },
          ],
        },
        transcriptDerived: derivedWith({
          eventType: "setup.failed",
          eventId: "event-host-derived",
          workspacePath: "/repo",
          terminalSessionId: null,
          setupExitCode: 1,
          clientActionId: "send-1",
          messageId: "queued-msg",
        }),
      }),
    ).toMatchObject({ eventId: "event-host-derived" });
  });
});

interface ManualCoordinator {
  readonly coordinator: StreamFlushCoordinator;
  /** Registered stores that currently hold a buffered, unapplied tail. */
  readonly pendingCount: () => number;
  readonly runAll: () => void;
}

/**
 * Deterministic stand-in for the production coordinator: nothing flushes
 * until `runAll()` (one manual "tick"), mirroring how a single armed frame
 * serves every buffered store.
 */
function createManualCoordinator(): ManualCoordinator {
  const registrations = new Set<StreamFlushRegistrationInput>();
  return {
    coordinator: {
      register: (input) => {
        registrations.add(input);
        return {
          requestFlush: () => {},
          setVisible: () => {},
          unregister: () => {
            registrations.delete(input);
          },
        };
      },
    },
    pendingCount: () =>
      Array.from(registrations).filter((input) => input.hasPending()).length,
    runAll: () => {
      for (const input of registrations) {
        if (input.hasPending()) input.flush();
      }
    },
  };
}

interface CoalesceHarness {
  readonly handle: ChatSessionStoreHandle;
  readonly callbacks: () => ChatStreamCallbacks;
  readonly manual: ManualCoordinator;
}

function createCoalesceHarness(): CoalesceHarness {
  const manual = createManualCoordinator();
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: manual.coordinator,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    manual,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

function gatedCommandItem(): BackgroundItem {
  return {
    taskId: "task-1",
    kind: "command",
    title: "codex exec",
    blockId: "tool-1",
    parentTaskId: null,
    scheduledFor: null,
    individualStopUnavailable: {
      providerLabel: "Codex",
      minVersion: "0.146.0",
    },
  };
}

function runningActiveTurn(): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId: "turn-1",
    status: "running",
    harnessId: "codex",
    model: "gpt-5-codex",
    profileId: null,
    userMessageId: "message-1",
    startedAt: 3,
    updatedAt: 3,
    reasoningEffort: null,
    serviceTier: null,
  };
}

function startRunningTurn(callbacks: ChatStreamCallbacks): void {
  emitSnapshot(callbacks, "owner");
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "running",
    activeTurn: {
      agentMode: "regular",
      sameTurnSteeringSupported: false,
      turnId: "turn-1",
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 3,
      updatedAt: 3,
      reasoningEffort: null,
      serviceTier: null,
    },
  });
}

/**
 * Settle turn 1 into a row, EVICT that row, and start turn 2.
 *
 * Both halves matter and neither can be skipped. Seating the settled row is
 * what releases `liveAssistantMessage` (`liveAssistantCoveredByMessages`
 * matches it by `turnId`); without it the live row is re-stamped onto the new
 * turn and carries its blocks along, so the old card is still owned and the
 * detached path is never reached. Dropping the row on the next snapshot is
 * eviction as this reducer sees it: `state.messages` is what is HYDRATED, and a
 * row outside the retained window is simply not in it.
 */
function settleTurnAndEvictItsRow(callbacks: ChatStreamCallbacks): void {
  const settled: Extract<Message, { role: "assistant" }> = {
    role: "assistant",
    messageId: "assistant-turn-1",
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "codex",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: 5,
    timestamp: 10,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
  emitSnapshotFrame({
    callbacks,
    access: "owner",
    messages: [settled],
    queue: { status: "idle", items: [] },
    pendingFileEditApprovals: [],
  });
  emitSnapshotFrame({
    callbacks,
    access: "owner",
    messages: [],
    queue: { status: "idle", items: [] },
    pendingFileEditApprovals: [],
    runStatus: "running",
    activeTurn: {
      ...runningActiveTurn(),
      turnId: "turn-2",
      userMessageId: "message-2",
      startedAt: 20,
      updatedAt: 20,
    },
    turnInProgress: true,
  });
}

function emitTextDelta(
  callbacks: ChatStreamCallbacks,
  delta: string,
  timestamp: number,
): void {
  callbacks.onBlockDelta({
    kind: "blockDelta",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    event: { type: "text.delta", blockId: "block-1", timestamp, delta },
  });
}

function liveText(handle: ChatSessionStoreHandle): string {
  const live = handle.store.getState().liveAssistantMessage;
  const block = live?.blocks[0];
  return block !== undefined && block.type === "text" ? block.text : "";
}

describe("blockDelta coalescing", () => {
  it("buffers consecutive deltas and applies them in one scheduled flush", () => {
    const harness = createCoalesceHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);

    let notifications = 0;
    const unsubscribe = harness.handle.store.subscribe(() => {
      notifications += 1;
    });

    emitTextDelta(callbacks, "a", 10);
    emitTextDelta(callbacks, "b", 11);
    emitTextDelta(callbacks, "c", 12);

    // Three deltas, one scheduled frame, nothing applied yet.
    expect(harness.manual.pendingCount()).toBe(1);
    expect(liveText(harness.handle)).toBe("");
    expect(notifications).toBe(0);

    harness.manual.runAll();

    // One flush -> one store notification carrying the concatenated text.
    expect(liveText(harness.handle)).toBe("abc");
    expect(notifications).toBe(1);
    expect(harness.manual.pendingCount()).toBe(0);

    unsubscribe();
  });

  it("applies image resolution events to an ordinary live turn", () => {
    const harness = createCoalesceHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);

    const emitResolution = (attachmentHash: string, timestamp: number): void =>
      callbacks.onBlockDelta(
        createImageResolutionUpdatedFrame({
          epicId: EPIC_ID,
          chatId: CHAT_ID,
          event: {
            type: "image_resolution.updated",
            blockId: "assistant-live-1",
            messageId: "assistant-live-1",
            timestamp,
            turnId: "turn-1",
            entry: {
              source: "C:%5Cwork%5Cchart.png",
              canonicalSource: "C:\\work\\chart.png",
              state: "resolved",
              attachmentHash,
              mediaType: "image/png",
              width: null,
              height: null,
            },
          },
        }),
      );

    emitResolution("hash-1", 11);
    harness.manual.runAll();
    let live = harness.handle.store.getState().liveAssistantMessage;
    expect(live?.imageResolutions).toHaveLength(1);
    expect(live?.imageResolutions[0]?.messageId).toBe("assistant-live-1");
    expect(live?.imageResolutions[0]?.entry.attachmentHash).toBe("hash-1");

    callbacks.onBlockDelta(
      createImageResolutionUpdatedFrame({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "image_resolution.updated",
          blockId: "assistant-old-1",
          messageId: "assistant-old-1",
          timestamp: 12,
          turnId: "turn-old",
          entry: {
            source: "C:%5Cwork%5Cold.png",
            canonicalSource: "C:\\work\\old.png",
            state: "resolved",
            attachmentHash: "stale-hash",
            mediaType: "image/png",
            width: null,
            height: null,
          },
        },
      }),
    );
    harness.manual.runAll();
    live = harness.handle.store.getState().liveAssistantMessage;
    expect(live?.imageResolutions).toHaveLength(1);

    emitTextDelta(callbacks, "![chart](C:%5Cwork%5Cchart.png)", 12);
    harness.manual.runAll();
    live = harness.handle.store.getState().liveAssistantMessage;
    expect(live?.blocks).toHaveLength(1);
    expect(live?.imageResolutions).toHaveLength(1);
    expect(live?.imageResolutions[0]?.entry.attachmentHash).toBe("hash-1");
    expect(live?.imageResolutionsVersion).toBe(1);

    emitResolution("hash-2", 13);
    harness.manual.runAll();
    live = harness.handle.store.getState().liveAssistantMessage;
    expect(live?.imageResolutions).toHaveLength(1);
    expect(live?.imageResolutions[0]?.entry.attachmentHash).toBe("hash-2");
    expect(live?.imageResolutionsVersion).toBe(2);
  });

  it("flushes buffered deltas before a consuming frame materializes the turn", () => {
    const harness = createCoalesceHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);

    emitTextDelta(callbacks, "x", 10);
    emitTextDelta(callbacks, "y", 11);
    expect(harness.manual.pendingCount()).toBe(1);

    // Turn ends. onTurnStateChanged must flush the buffered tail BEFORE it
    // materializes the live row, or the turn's final text is lost.
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    const messages = harness.handle.store.getState().messages;
    const assistant = messages.find((message) => message.role === "assistant");
    const block = assistant?.role === "assistant" ? assistant.blocks[0] : null;
    expect(block?.type === "text" ? block.text : "").toBe("xy");
    // The pre-frame flush drained the buffer; the next tick has nothing to do.
    expect(harness.manual.pendingCount()).toBe(0);
  });

  it("drops buffered deltas on dispose without applying them", () => {
    const harness = createCoalesceHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);

    emitTextDelta(callbacks, "a", 10);
    expect(harness.manual.pendingCount()).toBe(1);

    harness.handle.dispose();

    expect(harness.manual.pendingCount()).toBe(0);
    harness.manual.runAll();
    expect(liveText(harness.handle)).toBe("");
  });

  it("drops buffered deltas on retry and ignores stale callbacks", () => {
    const harness = createCoalesceHarness();
    const staleCallbacks = harness.callbacks();
    startRunningTurn(staleCallbacks);

    emitTextDelta(staleCallbacks, "stale", 10);
    expect(harness.manual.pendingCount()).toBe(1);

    harness.handle.store.getState().retry();

    expect(harness.manual.pendingCount()).toBe(0);
    staleCallbacks.onConnectionStatus("open", null);
    expect(harness.handle.store.getState().connectionStatus).toBe("connecting");
    harness.manual.runAll();
    expect(liveText(harness.handle)).toBe("");
  });

  it("publishes a pending interview only once its streaming block is observable", () => {
    // The host emits the interview's `blockDelta` before the
    // `interviewRequested` frame, but the delta sits in the coalescing buffer
    // until the next tick. If the pending id lands first, a host-pending
    // interview is briefly visible with no `streaming` segment - which
    // `findUnanswerableInterviews` reads as permanently stuck and offers to
    // dismiss, cancelling a live question mid-Q&A.
    const harness = createCoalesceHarness();
    const callbacks = harness.callbacks();
    startRunningTurn(callbacks);

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "interview.requested",
        blockId: "interview-1",
        timestamp: 10,
        toolName: "AskUserQuestion",
        questions: [],
      },
    });
    // Still buffered: nothing has reached the store yet.
    expect(harness.manual.pendingCount()).toBe(1);

    callbacks.onInterviewRequested({
      kind: "interviewRequested",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId: "interview-1",
      requestedAt: 10,
    });

    // Read BEFORE any coordinator tick - this is the window the renderer would
    // have rendered the escape hatch in.
    const state = harness.handle.store.getState();
    expect(state.pendingInterviews).toEqual([
      { blockId: "interview-1", requestedAt: 10 },
    ]);
    const streamingInterviewIds = (
      state.liveAssistantMessage?.blocks ?? []
    ).flatMap((block) =>
      block.type === "interview" && block.status === "streaming"
        ? [block.blockId]
        : [],
    );
    expect(streamingInterviewIds).toEqual(["interview-1"]);
    // The consuming frame drained the buffer, so the tick has nothing left.
    expect(harness.manual.pendingCount()).toBe(0);
  });
});

describe("surface visibility rollup", () => {
  it("rolls per-surface reports up to visible-if-any, defaulting to visible", () => {
    const reported: boolean[] = [];
    const coordinator: StreamFlushCoordinator = {
      register: (input) => ({
        requestFlush: () => input.flush(),
        setVisible: (visible) => {
          reported.push(visible);
        },
        unregister: () => {},
      }),
    };
    const handle = createChatSessionStore({
      hostId: "host-a",
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      userId: OWNER_ID,
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: coordinator,
      streamClientFactory: () => ({
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      }),
    });

    handle.setSurfaceVisibility("surface-a", false);
    expect(reported).toEqual([false]);

    // A second visible surface flips the chat visible (visible-if-any).
    handle.setSurfaceVisibility("surface-b", true);
    expect(reported).toEqual([false, true]);

    // Unchanged report is a no-op.
    handle.setSurfaceVisibility("surface-b", true);
    expect(reported).toEqual([false, true]);

    handle.clearSurfaceVisibility("surface-b");
    expect(reported).toEqual([false, true, false]);

    // No reporting surfaces left: default back to visible (never starve).
    handle.clearSurfaceVisibility("surface-a");
    expect(reported).toEqual([false, true, false, true]);

    // Clearing an unknown surface is a no-op.
    handle.clearSurfaceVisibility("surface-a");
    expect(reported).toEqual([false, true, false, true]);
  });
});

describe("in-flight block finalization on stop / steer", () => {
  function startTurn(callbacks: ChatStreamCallbacks, turnId: string): void {
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: {
        agentMode: "regular",
        sameTurnSteeringSupported: false,
        turnId,
        status: "running",
        harnessId: "codex",
        model: "gpt-5-codex",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 3,
        updatedAt: 3,
        reasoningEffort: null,
        serviceTier: null,
      },
    });
  }

  function startToolCall(callbacks: ChatStreamCallbacks): void {
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "tool_call.started",
        blockId: "tc-1",
        timestamp: 10,
        toolName: "read",
        input: {},
        agentMessageSend: null,
      },
    });
  }

  function liveToolStatus(harness: Harness): string | undefined {
    const live = harness.handle.store.getState().liveAssistantMessage;
    return live?.blocks[0]?.status;
  }

  function materializedToolStatus(
    harness: Harness,
    turnId: string,
  ): string | undefined {
    const assistant = harness.handle.store
      .getState()
      .messages.find(
        (message) => message.role === "assistant" && message.turnId === turnId,
      );
    if (assistant === undefined || assistant.role !== "assistant")
      return undefined;
    return assistant.blocks[0]?.status;
  }

  it("marks an in-flight tool call 'interrupted' when a turn.stopped delta arrives", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks, "turn-1");
    startToolCall(callbacks);
    expect(liveToolStatus(harness)).toBe("streaming");

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "turn.stopped",
        blockId: "turn-1",
        timestamp: 20,
        turnId: "turn-1",
      },
    });

    expect(liveToolStatus(harness)).toBe("interrupted");
  });

  it("marks an in-flight tool call 'superseded' on a steer-restart turn.interrupted delta", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks, "turn-1");
    startToolCall(callbacks);

    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "turn.interrupted",
        blockId: "turn-1",
        timestamp: 20,
        turnId: "turn-1",
        reason: "Turn interrupted to run a queued steering request.",
        code: "STEER_RESTART",
        recoverable: true,
      },
    });

    expect(liveToolStatus(harness)).toBe("superseded");
  });

  it("finalizes an in-flight tool call when the turn settles without a terminal delta (no stuck spinner)", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks, "turn-1");
    startToolCall(callbacks);
    expect(liveToolStatus(harness)).toBe("streaming");

    // Turn settles to no active turn WITHOUT a terminal blockDelta - the drop
    // this fix guards against. Materializing the live row must finalize the
    // tool so it never freezes "in progress".
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    expect(harness.handle.store.getState().liveAssistantMessage).toBeNull();
    expect(materializedToolStatus(harness, "turn-1")).toBe("interrupted");
  });

  it("drops a stray non-terminal delta when the turn already settled (activeTurn null) but still finalizes via a terminal delta", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    startTurn(callbacks, "turn-1");
    startToolCall(callbacks);

    // Disconnect: activeTurn is cleared but the live row is kept (not yet
    // materialized). This is the window where a replayed/late delta can arrive.
    callbacks.onConnectionStatus("closed", null);
    expect(harness.handle.store.getState().activeTurn).toBeNull();
    expect(harness.handle.store.getState().liveAssistantMessage).not.toBeNull();
    const versionBefore =
      harness.handle.store.getState().liveAssistantMessage?.blocksVersion;

    // A stray NON-terminal delta (no turnId) must be dropped, not grafted onto
    // the frozen row (which would re-open a spinner).
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "tool_call.started",
        blockId: "tc-stray",
        timestamp: 30,
        toolName: "read",
        input: {},
        agentMessageSend: null,
      },
    });
    expect(
      harness.handle.store.getState().liveAssistantMessage?.blocksVersion,
    ).toBe(versionBefore);
    expect(
      harness.handle.store.getState().liveAssistantMessage?.blocks,
    ).toHaveLength(1);

    // A terminal delta for that turn still finalizes the in-flight tool.
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "turn.stopped",
        blockId: "turn-1",
        timestamp: 40,
        turnId: "turn-1",
      },
    });
    expect(liveToolStatus(harness)).toBe("interrupted");
  });
});

// Non-message pendings (stop / approvalDecision / restoreCheckpoint /
// background stops) are cleared only by their actionAck - which dies with a
// dropped connection. The authoritative post-reconnect snapshot must settle
// them so their controls re-enable and the action can be re-issued; the
// disconnect event itself must settle nothing.
describe("non-message pendings across a missed-ack reconnect", () => {
  function pendingActionKinds(harness: Harness): string[] {
    return Object.values(harness.handle.store.getState().pendingActions).map(
      (pending) => pending.action,
    );
  }

  it("clears stop/approval/restore pendings on the post-reconnect snapshot and allows re-issuing", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");
    const store = harness.handle.store;

    expect(store.getState().stopTurn()).not.toBeNull();
    expect(
      store.getState().approvalDecision("approval-1", { approved: true }),
    ).not.toBeNull();
    expect(
      store.getState().restoreCheckpoint("checkpoint-1", false),
    ).not.toBeNull();
    expect(pendingActionKinds(harness)).toEqual([
      "stop",
      "approvalDecision",
      "restoreCheckpoint",
    ]);

    // The connection drops before any ack arrives; the drop itself settles
    // NOTHING (a transient wobble must not cancel in-flight actions).
    harness.callbacks().onConnectionStatus("reconnecting", null);
    expect(pendingActionKinds(harness)).toEqual([
      "stop",
      "approvalDecision",
      "restoreCheckpoint",
    ]);

    // The reconnect snapshot is the authority: the lost acks can never
    // arrive, so the pendings clear and the controls re-enable.
    emitSnapshot(harness.callbacks(), "owner");
    expect(store.getState().pendingActions).toEqual({});

    // Re-issuing after the reconnect works (nothing is wedged).
    expect(store.getState().stopTurn()).not.toBeNull();
    expect(pendingActionKinds(harness)).toEqual(["stop"]);
  });

  it("clears a stale editUserMessage pending whose ack was lost across a reconnect", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");
    const store = harness.handle.store;

    // An edit's fresh messageId only appears in the snapshot if the host
    // applied it, and it has no composer-restoration path - so a lost frame
    // would previously wedge the edit affordances forever.
    expect(
      store.getState().editUserMessage({
        targetMessageId: "msg-1",
        content: { type: "doc", content: [] },
        sender: { type: "user", userId: OWNER_ID },
        settings: SETTINGS,
        revertFileChanges: false,
        revertArtifacts: false,
      }),
    ).not.toBeNull();
    expect(pendingActionKinds(harness)).toEqual(["editUserMessage"]);

    harness.callbacks().onConnectionStatus("reconnecting", null);
    // The reconnect snapshot does not contain the edit (never applied).
    emitSnapshot(harness.callbacks(), "owner");
    expect(store.getState().pendingActions).toEqual({});
  });

  it("keeps a pending dispatched on the CURRENT connection when its own snapshot arrives", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "owner");

    // Reconnect first, then act on the NEW connection before its snapshot
    // lands - that pending's ack is still live and must survive the sweep.
    harness.callbacks().onConnectionStatus("reconnecting", null);
    harness.callbacks().onConnectionStatus("open", null);
    expect(harness.handle.store.getState().stopTurn()).not.toBeNull();

    emitSnapshot(harness.callbacks(), "owner");
    expect(pendingActionKinds(harness)).toEqual(["stop"]);
  });

  it("makes a background stop whose frame died with the connection retryable, keeping ack-accepted stops disabled", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    const runningTasks: BackgroundItem[] = [
      {
        taskId: "task-lost",
        kind: "command",
        title: "sleep 60",
        blockId: "tool-1",
        parentTaskId: null,
        scheduledFor: null,
        individualStopUnavailable: null,
      },
      {
        taskId: "task-accepted",
        kind: "command",
        title: "sleep 90",
        blockId: "tool-2",
        parentTaskId: null,
        scheduledFor: null,
        individualStopUnavailable: null,
      },
    ];
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: runningTasks,
    });
    const store = harness.handle.store;

    // One stop gets its ack before the drop; the other's frame/ack is lost.
    expect(store.getState().stopBackgroundItem("task-accepted")).not.toBeNull();
    acceptLastAction(harness);
    expect(store.getState().stopBackgroundItem("task-lost")).not.toBeNull();

    // Both tasks are still running when the reconnect snapshot arrives.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      backgroundItems: runningTasks,
    });

    // The lost stop is retryable again; the host-confirmed stop stays
    // disabled until its task actually terminates.
    expect(Object.keys(store.getState().pendingBackgroundStops)).toEqual([
      "task-accepted",
    ]);
    expect(store.getState().stopBackgroundItem("task-lost")).not.toBeNull();
    expect(store.getState().stopBackgroundItem("task-accepted")).toBeNull();
  });

  it("clears a restore slot stranded in-flight by a drop, but not one on the live connection", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    callbacks.onRestoreStarted({
      kind: "restoreStarted",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      checkpointId: "turn-1",
      restoringUserId: OWNER_ID,
      restoringHostId: "host-1",
      startedAt: 2,
    });

    // A snapshot on the SAME connection leaves the live restore alone.
    emitSnapshot(callbacks, "owner");
    expect(harness.handle.store.getState().restore?.kind).toBe("in-flight");

    // After a drop, its restoreCompleted can never arrive - the reconnect
    // snapshot clears the stranded slot instead of spinning forever.
    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");
    expect(harness.handle.store.getState().restore).toBeNull();
  });
});

describe("createChatSessionStore - persisted auth-error provider nudge", () => {
  function authErroredAssistantMessage(
    messageId: string,
    code: string | null,
  ): Extract<Message, { role: "assistant" }> {
    return {
      role: "assistant",
      messageId,
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "codex",
        displayName: "Codex",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks:
        code === null
          ? []
          : [
              {
                type: "error",
                blockId: `error-${messageId}`,
                status: "completed",
                timestamp: 4,
                parentBlockId: null,
                message: "Codex is signed out on this machine.",
                recoverable: true,
                code,
              },
            ],
      startedAt: 4,
      timestamp: 4,
      turnId: `turn-${messageId}`,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      imageResolutions: [],
    };
  }

  interface NudgeHarness {
    readonly handle: ChatSessionStoreHandle;
    callbacks(): ChatStreamCallbacks;
    nudgeCount(): number;
  }

  function createNudgeHarness(): NudgeHarness {
    let nudges = 0;
    let callbacks: ChatStreamCallbacks | null = null;
    const handle = createChatSessionStore({
      hostId: "host-a",
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      userId: OWNER_ID,
      onAuthError: null,
      onProviderAuthError: () => {
        nudges += 1;
      },
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
        callbacks = nextCallbacks;
        return {
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        };
      },
    });
    return {
      handle,
      callbacks: () => {
        if (callbacks === null) throw new Error("Expected callbacks");
        return callbacks;
      },
      nudgeCount: () => nudges,
    };
  }

  function emitMessagesSnapshot(
    callbacks: ChatStreamCallbacks,
    messages: ReadonlyArray<Message>,
  ): void {
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages,
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });
  }

  it("nudges once per persisted auth-error row, even across reconnect re-delivery", () => {
    const harness = createNudgeHarness();
    const authRow = authErroredAssistantMessage("assistant-auth-1", "auth");
    emitMessagesSnapshot(harness.callbacks(), [authRow]);
    expect(harness.nudgeCount()).toBe(1);

    // Reconnect re-delivers the SAME row: no duplicate nudge.
    harness.callbacks().onConnectionStatus("reconnecting", null);
    emitMessagesSnapshot(harness.callbacks(), [authRow]);
    expect(harness.nudgeCount()).toBe(1);
  });

  it("nudges again for a NEW auth failure after the first one recovered", () => {
    const harness = createNudgeHarness();
    emitMessagesSnapshot(harness.callbacks(), [
      authErroredAssistantMessage("assistant-auth-1", "auth"),
    ]);
    expect(harness.nudgeCount()).toBe(1);

    // Recovered: latest assistant row carries no auth error.
    emitMessagesSnapshot(harness.callbacks(), [
      authErroredAssistantMessage("assistant-auth-1", "auth"),
      authErroredAssistantMessage("assistant-ok", null),
    ]);
    expect(harness.nudgeCount()).toBe(1);

    // A second headless failure lands during a disconnect; the reconnect
    // snapshot is its only signal, so the store must nudge again - a
    // store-lifetime latch would leave the provider gate stale here.
    harness.callbacks().onConnectionStatus("reconnecting", null);
    emitMessagesSnapshot(harness.callbacks(), [
      authErroredAssistantMessage("assistant-auth-1", "auth"),
      authErroredAssistantMessage("assistant-ok", null),
      authErroredAssistantMessage("assistant-auth-2", "auth"),
    ]);
    expect(harness.nudgeCount()).toBe(2);
  });

  it("finds the latest assistant row behind a trailing user row", () => {
    const harness = createNudgeHarness();
    emitMessagesSnapshot(harness.callbacks(), [
      authErroredAssistantMessage("assistant-auth-1", "auth"),
      persistedUserMessage("user-after-failure"),
    ]);
    expect(harness.nudgeCount()).toBe(1);
  });

  it("does not nudge for a non-auth error on the latest assistant row", () => {
    const harness = createNudgeHarness();
    emitMessagesSnapshot(harness.callbacks(), [
      authErroredAssistantMessage("assistant-runtime-err", "RUNTIME_THROWN"),
    ]);
    expect(harness.nudgeCount()).toBe(0);
  });

  it("does not double-nudge when a live auth event's turn is later re-delivered by a snapshot", () => {
    const harness = createNudgeHarness();
    const callbacks = harness.callbacks();

    // The live turn fails on auth mid-session: onBlockDelta fires the nudge
    // directly (no persisted row exists yet to read from).
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: {
        agentMode: "regular",
        sameTurnSteeringSupported: false,
        turnId: "turn-live-auth-1",
        status: "running",
        harnessId: "codex",
        model: "gpt-5-codex",
        profileId: null,
        userMessageId: "message-live-1",
        startedAt: 3,
        updatedAt: 3,
        reasoningEffort: null,
        serviceTier: null,
      },
    });
    callbacks.onBlockDelta({
      kind: "blockDelta",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      event: {
        type: "error",
        blockId: "auth-live-1",
        timestamp: 4,
        message: "Codex is signed out on this machine.",
        recoverable: true,
        code: "auth",
      },
    });
    expect(harness.nudgeCount()).toBe(1);

    // The turn's own persisted row (same turnId) then arrives via snapshot -
    // a reconnect, or the same connection catching up. It must NOT re-nudge:
    // it is the SAME failure the live path already reported.
    emitMessagesSnapshot(callbacks, [
      {
        role: "assistant",
        messageId: "assistant-live-auth-1",
        sender: {
          type: "agent",
          harnessId: "codex",
          agentId: "codex",
          displayName: "Codex",
          reply: { expectsReply: false },
          inReplyTo: null,
        },
        blocks: [
          {
            type: "error",
            blockId: "auth-live-1",
            status: "completed",
            timestamp: 4,
            parentBlockId: null,
            message: "Codex is signed out on this machine.",
            recoverable: true,
            code: "auth",
          },
        ],
        startedAt: 3,
        timestamp: 4,
        turnId: "turn-live-auth-1",
        usage: null,
        reasoningEffort: null,
        serviceTier: null,
        imageResolutions: [],
      },
    ]);
    expect(harness.nudgeCount()).toBe(1);
  });
});

describe("turn-settled stranded-send reconciliation", () => {
  it("drops the optimistic user message and restores its content when a stop lands before messageAccepted", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);

    // The pre-turn activation window: the host accepts the send and reports
    // the run as in progress before the message is appended.
    acceptLastAction(harness);
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: null,
      turnInProgress: true,
    });
    // The accepted ack deliberately keeps the optimistic entry alive - the
    // durable messageAccepted frame is what normally clears it.
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);

    // A stop aborts activation: the turn settles without the host ever
    // appending the message - no messageAccepted or rejected ack will arrive.
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
    });

    const state = harness.handle.store.getState();
    expect(state.pendingUserMessages).toEqual([]);
    expect(state.failedSendRestoration).toEqual({
      clientActionId: frame.clientActionId,
      content: CONTENT,
      browserAnnotations: [],
      reason: "The message was not recorded before the turn stopped.",
      displacedReason: "The message was not recorded before the turn stopped.",
      stated: false,
    });
  });

  it("keeps an optimistic entry whose ack is still in flight when an unrelated settle frame arrives", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);

    // e.g. a background task settling broadcasts a turn-settled frame while
    // the fresh send's ack is still on the wire - the entry must survive.
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
    });

    const state = harness.handle.store.getState();
    expect(state.pendingUserMessages).toHaveLength(1);
    expect(state.failedSendRestoration).toBeNull();
  });

  it("heals on an older host via runStatus idle when the frame omits turnInProgress", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");
    acceptLastAction(harness);

    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "idle",
      activeTurn: null,
    });

    const state = harness.handle.store.getState();
    expect(state.pendingUserMessages).toEqual([]);
    expect(state.failedSendRestoration?.clientActionId).toBe(
      frame.clientActionId,
    );
  });

  it("reconciles an accepted-but-unrecorded send from a settled reconnect snapshot", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");
    // The accepted ack removes the pending action but keeps the optimistic
    // entry; the connection then dies before any settling frame arrives.
    acceptLastAction(harness);
    callbacks.onConnectionStatus("reconnecting", null);

    // The reconnect snapshot is the only authoritative settled state: no
    // turn in progress, and the message never reached the transcript.
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    const state = harness.handle.store.getState();
    expect(state.pendingUserMessages).toEqual([]);
    expect(state.failedSendRestoration).toEqual({
      clientActionId: frame.clientActionId,
      content: CONTENT,
      browserAnnotations: [],
      reason: "The message was not recorded before the turn stopped.",
      displacedReason: "The message was not recorded before the turn stopped.",
      stated: false,
    });
  });

  it("clears stale optimistic bookkeeping without restoration when the reconnect snapshot carries the message", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");
    acceptLastAction(harness);
    callbacks.onConnectionStatus("reconnecting", null);

    // The send did land host-side; the lost frame was `messageAccepted`, not
    // the message itself. The persisted row is authoritative - no composer
    // restoration.
    emitSnapshotFrame({
      callbacks,
      access: "owner",
      messages: [persistedUserMessage(frame.messageId)],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
    });

    const state = harness.handle.store.getState();
    expect(state.pendingUserMessages).toEqual([]);
    expect(state.failedSendRestoration).toBeNull();
  });
});

describe("the chat's managed commands", () => {
  function monitor(over: Partial<ManagedCommand>): ManagedCommand {
    return {
      id: "cmd-1",
      monitoring: true,
      description: "deploy watcher",
      command: "tail -f deploy.log",
      cwd: "/work/repo",
      cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
      status: { state: "running", pid: 4410, startedAtMs: 10 },
      chatId: CHAT_ID,
      createdAtMs: 10,
      updatedAtMs: 10,
      ...over,
    };
  }

  function seededHarness(commands: ReadonlyArray<ManagedCommand>): Harness {
    const harness = createHarness();
    emitSnapshotFrame({
      callbacks: harness.callbacks(),
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      managedCommands: commands,
    });
    return harness;
  }

  it("reads as an empty set before the host has said anything", () => {
    const harness = createHarness();

    // Not `undefined`: a host with no managed-command subsystem owns no
    // commands, so there is no "unknown" for a consumer to branch on.
    expect(harness.handle.store.getState().managedCommands).toEqual([]);
    harness.handle.dispose();
  });

  it("takes the set from the snapshot", () => {
    const harness = seededHarness([monitor({ id: "cmd-1" })]);

    expect(
      harness.handle.store.getState().managedCommands.map((c) => c.id),
    ).toEqual(["cmd-1"]);
    harness.handle.dispose();
  });

  it("replaces the whole set on a managedCommandsChanged frame", () => {
    const harness = seededHarness([
      monitor({ id: "cmd-1" }),
      monitor({ id: "cmd-2" }),
    ]);

    harness.callbacks().onManagedCommandsChanged({
      kind: "managedCommandsChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      managedCommands: [monitor({ id: "cmd-3" })],
    });

    // The frame is the set, not a delta: `cmd-1` and `cmd-2` are gone because
    // the host stopped naming them, with no removal frame anywhere.
    expect(
      harness.handle.store.getState().managedCommands.map((c) => c.id),
    ).toEqual(["cmd-3"]);
    harness.handle.dispose();
  });

  it("fills in from a frame after a snapshot that arrived empty", () => {
    // The host's boot window: the subsystem has not enumerated yet, so the
    // snapshot honestly carries nothing and the frame follows. Both are plain
    // assignments - neither needs to know about the other.
    const harness = seededHarness([]);
    expect(harness.handle.store.getState().managedCommands).toEqual([]);

    harness.callbacks().onManagedCommandsChanged({
      kind: "managedCommandsChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      managedCommands: [monitor({ id: "cmd-late" })],
    });

    expect(
      harness.handle.store.getState().managedCommands.map((c) => c.id),
    ).toEqual(["cmd-late"]);
    harness.handle.dispose();
  });

  it("ignores a frame addressed to another chat", () => {
    const harness = seededHarness([monitor({ id: "cmd-1" })]);

    harness.callbacks().onManagedCommandsChanged({
      kind: "managedCommandsChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: "some-other-chat",
      managedCommands: [],
    });

    expect(
      harness.handle.store.getState().managedCommands.map((c) => c.id),
    ).toEqual(["cmd-1"]);
    harness.handle.dispose();
  });
});

describe("the chat's held updates", () => {
  function held(
    over: Partial<HeldManagedCommandUpdate>,
  ): HeldManagedCommandUpdate {
    return {
      commandId: "cmd-1",
      description: "deploy watcher",
      heldAtMs: 10,
      ...over,
    };
  }

  function seededHarness(
    heldUpdates: ReadonlyArray<HeldManagedCommandUpdate>,
  ): Harness {
    const harness = createHarness();
    emitSnapshotFrame({
      callbacks: harness.callbacks(),
      access: "owner",
      messages: [],
      queue: { status: "idle", items: [] },
      pendingFileEditApprovals: [],
      heldUpdates,
    });
    return harness;
  }

  it("reads as an empty set before the host has said anything", () => {
    const harness = createHarness();

    expect(harness.handle.store.getState().heldUpdates).toEqual([]);
    harness.handle.dispose();
  });

  it("takes the set from the snapshot", () => {
    const harness = seededHarness([held({ commandId: "cmd-1" })]);

    expect(
      harness.handle.store.getState().heldUpdates.map((h) => h.commandId),
    ).toEqual(["cmd-1"]);
    harness.handle.dispose();
  });

  it("replaces the whole set on a heldUpdatesChanged frame - a shrink drops the stale row", () => {
    const harness = seededHarness([
      held({ commandId: "cmd-1" }),
      held({ commandId: "cmd-2" }),
    ]);

    harness.callbacks().onHeldUpdatesChanged({
      kind: "heldUpdatesChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      heldUpdates: [held({ commandId: "cmd-2" })],
    });

    // The frame is the set, not a delta: `cmd-1` is gone, and it is gone
    // because the host stopped naming it - no stale row can survive a shrink.
    expect(
      harness.handle.store.getState().heldUpdates.map((h) => h.commandId),
    ).toEqual(["cmd-2"]);
    harness.handle.dispose();
  });

  it("ignores a frame addressed to another chat", () => {
    const harness = seededHarness([held({ commandId: "cmd-1" })]);

    harness.callbacks().onHeldUpdatesChanged({
      kind: "heldUpdatesChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: "some-other-chat",
      heldUpdates: [],
    });

    expect(
      harness.handle.store.getState().heldUpdates.map((h) => h.commandId),
    ).toEqual(["cmd-1"]);
    harness.handle.dispose();
  });

  it("ignores a frame addressed to another epic", () => {
    const harness = seededHarness([held({ commandId: "cmd-1" })]);

    harness.callbacks().onHeldUpdatesChanged({
      kind: "heldUpdatesChanged",
      hasBinaryPayload: false,
      epicId: "some-other-epic",
      chatId: CHAT_ID,
      heldUpdates: [],
    });

    expect(
      harness.handle.store.getState().heldUpdates.map((h) => h.commandId),
    ).toEqual(["cmd-1"]);
    harness.handle.dispose();
  });

  // The chat and epic guards above both pass for a frame from the RIGHT chat
  // on a stream this store has already replaced, which is the one a retry
  // produces: the old client is torn down but its in-flight frames still land.
  // A hold is durable state a human acts on, so a stale set installing rows
  // here would offer a Deliver for holds the new stream never named - or, on a
  // stale empty frame, quietly take a live one off screen.
  it("ignores a held-updates frame from a superseded stream", () => {
    const harness = seededHarness([held({ commandId: "cmd-1" })]);
    const staleCallbacks = harness.callbacks();

    harness.handle.store.getState().retry();

    // The empty frame is the sharp one: a retry cancels nothing, so the hold
    // is still standing, and honouring a stale "nothing is held" would take
    // the Deliver affordance off screen while the hold outlived the socket.
    staleCallbacks.onHeldUpdatesChanged({
      kind: "heldUpdatesChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      heldUpdates: [],
    });
    expect(
      harness.handle.store.getState().heldUpdates.map((h) => h.commandId),
    ).toEqual(["cmd-1"]);

    staleCallbacks.onHeldUpdatesChanged({
      kind: "heldUpdatesChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      heldUpdates: [held({ commandId: "cmd-stale" })],
    });
    expect(
      harness.handle.store.getState().heldUpdates.map((h) => h.commandId),
    ).toEqual(["cmd-1"]);

    // ...and the live stream is still heard, so this is a generation guard
    // rather than a store that stopped listening.
    harness.callbacks().onHeldUpdatesChanged({
      kind: "heldUpdatesChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      heldUpdates: [held({ commandId: "cmd-live" })],
    });

    expect(
      harness.handle.store.getState().heldUpdates.map((h) => h.commandId),
    ).toEqual(["cmd-live"]);
    harness.handle.dispose();
  });
});
