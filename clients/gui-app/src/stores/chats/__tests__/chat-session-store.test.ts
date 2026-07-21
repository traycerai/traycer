import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatEvent,
  ClaudePendingWake,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  BackgroundItem,
  ChatFileEditApprovalState,
  ChatPendingInterviewState,
  ChatQueueState,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  ACCEPTED_CHAT_ACTION_RETENTION_MS,
  MAX_ACCEPTED_CHAT_ACTION_RECORDS,
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  IMMEDIATE_STREAM_FLUSH_COORDINATOR,
  type StreamFlushCoordinator,
  type StreamFlushRegistrationInput,
} from "@/stores/chats/stream-flush-coordinator";
import { selectRestorableSetupInterruption } from "@/stores/chats/chat-session-selectors";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { interviewDraftKey } from "@/lib/persist";
import {
  readInterviewDraftSnapshot,
  useInterviewDraftStore,
} from "@/stores/composer/interview-draft-store";
import { isOptimisticQueuedItem } from "@/stores/chats/optimistic-queue";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const OWNER_ID = "owner-1";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
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

function createHarness(): Harness {
  const sent: ChatSubscribeClientFrame[] = [];
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
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
  readonly claudePendingWakes?: ReadonlyArray<ClaudePendingWake>;
}

function emitSnapshotFrame(input: SnapshotFrameInput): void {
  input.callbacks.onConnectionStatus("open", null);
  input.callbacks.onSnapshot({
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
        settings: input.settings ?? null,
        activeSessionChain: null,
        claudePendingWakes: [...(input.claudePendingWakes ?? [])],
        messages: [...input.messages],
        events: [],
      },
      access: {
        role: input.access,
        ownerUserId: OWNER_ID,
        canAct: input.access === "owner",
      },
      queue: input.queue,
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [...(input.pendingInterviews ?? [])],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [...input.pendingFileEditApprovals],
      accumulatedFileChanges: [],
      ...(input.backgroundItems === undefined
        ? {}
        : { backgroundItems: [...input.backgroundItems] }),
    },
  });
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
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
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
    },
    timestamp: 4,
    sessionAnchor: null,
  };
}

describe("createChatSessionStore", () => {
  // The worktree intent staging store is a module-global Zustand store; a test
  // that leaves a staged (or restored-on-reject) intent behind would make later
  // tests order-dependent. Reset it after every test so each starts clean.
  // Interview drafts share the same module-global risk across lifecycle tests.
  afterEach(() => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    useInterviewDraftStore.setState({ draftsByChat: {} });
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

  it("retry re-subscribes and clears the fatal close", () => {
    let factoryCalls = 0;
    let lastCallbacks: ChatStreamCallbacks | null = null;
    let closeCalls = 0;
    const handle = createChatSessionStore({
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
          close: () => undefined,
        };
      },
    });
    const callbacks = (): ChatStreamCallbacks => {
      if (lastCallbacks === null) throw new Error("Expected callbacks");
      return lastCallbacks;
    };
    const staleCallbacks = callbacks();

    handle.store.getState().retry();

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

  it("tracks send actions until actionAck and accepts host messages", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    const clientActionId = harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);

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

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);

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
      useWorktreeIntentMemoryStore.getState().getEpicIntent(EPIC_ID),
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

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);

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

  it("does not restore a rejected worktree intent after a newer explicit clear", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
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

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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

    const result = harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);

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
    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    callbacks.onConnectionStatus("reconnecting", null);
    emitSnapshot(callbacks, "owner");

    expect(harness.handle.store.getState().pendingActions).toEqual({});
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
    expect(harness.handle.store.getState().failedSendRestoration).toEqual({
      clientActionId: frame.clientActionId,
      content: CONTENT,
      reason: "Message was not confirmed after reconnect.",
    });
  });

  it("clears a pending send when reconnect snapshot contains the accepted message", () => {
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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

    const sent = harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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
            queueItemId: "queue-1",
            messageId: frame.messageId,
            message: {
              kind: "user",
              content: CONTENT,
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

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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
      activeTurn: {
        turnId: "turn-1",
        status: "running",
        harnessId: "codex",
        model: "gpt-5-codex",
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 3,
        updatedAt: 3,
        reasoningEffort: null,
        serviceTier: null,
      },
    });

    harness.handle.store
      .getState()
      .sendMessage(IMAGE_CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
    const frame = harness.sent[0];
    if (frame.kind !== "send") throw new Error("Expected send frame");

    const state = harness.handle.store.getState();
    expect(state.pendingUserMessages).toEqual([]);
    expect(Object.keys(state.pendingActions)).toEqual([frame.clientActionId]);
    expect(state.queue.status).toBe("running");
    expect(state.queue.items).toHaveLength(1);
    const item = state.queue.items[0];
    expect(isOptimisticQueuedItem(item)).toBe(true);
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

    harness.handle.store
      .getState()
      .sendMessage(IMAGE_CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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
      activeTurn: {
        turnId: "turn-1",
        status: "running",
        harnessId: "codex",
        model: "gpt-5-codex",
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 3,
        updatedAt: 3,
        reasoningEffort: null,
        serviceTier: null,
      },
    });

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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
            queueItemId: "queue-1",
            messageId: "reminted-message",
            message: {
              kind: "user",
              content: CONTENT,
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
      activeTurn: {
        turnId: "turn-1",
        status: "running",
        harnessId: "codex",
        model: "gpt-5-codex",
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 3,
        updatedAt: 3,
        reasoningEffort: null,
        serviceTier: null,
      },
    });

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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
            queueItemId: "queue-1",
            messageId: frame.messageId,
            message: {
              kind: "user",
              content: CONTENT,
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
      activeTurn: {
        turnId: "turn-1",
        status: "running",
        harnessId: "codex",
        model: "gpt-5-codex",
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 3,
        updatedAt: 3,
        reasoningEffort: null,
        serviceTier: null,
      },
    });

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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
            queueItemId: "queue-1",
            messageId: "reminted-message",
            message: {
              kind: "user",
              content: CONTENT,
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

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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

  it("does not send owner actions for read-only viewers", () => {
    const harness = createHarness();
    emitSnapshot(harness.callbacks(), "viewer");

    const clientActionId = harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);

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
      useWorktreeIntentMemoryStore.getState().getEpicIntent(EPIC_ID),
    ).toEqual(intent);
  });

  it("does not restore a rejected edit intent over a newer selection", () => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");
    const key: WorktreeStagingKey = {
      surface: "owner",
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
      useWorktreeIntentMemoryStore.getState().getEpicIntent(EPIC_ID),
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
      queueItemId,
      messageId: `m-${queueItemId}`,
      message: {
        kind: "user" as const,
        content: CONTENT,
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
      .interviewError("question-skip", "Skipped by user");

    expect(answerActionId).not.toBeNull();
    expect(skipActionId).not.toBeNull();
    expect(harness.sent.map((frame) => frame.kind)).toEqual([
      "interviewAnswer",
      "interviewError",
    ]);
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
      .interviewError(blockId, "Skipped by user");
    if (actionId === null) {
      throw new Error("expected interviewError action");
    }

    callbacks.onInterviewErrored({
      kind: "interviewErrored",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      blockId,
      reason: "Skipped by user",
      resolvedAt: 5,
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
            queueItemId: "queue-1",
            messageId: "message-queue-1",
            message: {
              kind: "user",
              content: CONTENT,
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
      activeTurn: {
        turnId: "turn-1",
        status: "running",
        harnessId: "codex",
        model: "gpt-5-codex",
        agentMode: "regular",
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
      },
    });

    const blocks = harness.handle.store.getState().liveAssistantMessage?.blocks;
    expect(blocks).toEqual([
      expect.objectContaining({ type: "text", blockId: "active-text" }),
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
        turnId: "turn-1",
        status: "running",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
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
        turnId: "turn-2",
        status: "running",
        harnessId: "claude",
        model: "claude-sonnet",
        agentMode: "regular",
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
        turnId: "turn-local",
        status: "starting",
        harnessId: "claude",
        model: "claude-sonnet",
        agentMode: "regular",
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
            },
          ],
          events: [],
        },
        access: {
          role: "owner",
          ownerUserId: OWNER_ID,
          canAct: true,
        },
        queue: { status: "idle", items: [] },
        runStatus: "running",
        activeTurn: {
          turnId: "turn-local",
          status: "starting",
          harnessId: "claude",
          model: "claude-sonnet",
          agentMode: "regular",
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
      },
    });
    callbacks.onTurnStateChanged({
      kind: "turnStateChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      runStatus: "running",
      activeTurn: {
        turnId: "turn-provider",
        status: "running",
        harnessId: "claude",
        model: "claude-sonnet",
        agentMode: "regular",
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
            },
          ],
          events: [],
        },
        access: {
          role: "owner",
          ownerUserId: OWNER_ID,
          canAct: true,
        },
        queue: { status: "idle", items: [] },
        runStatus: "running",
        activeTurn: {
          turnId: "turn-split",
          status: "running",
          harnessId: "claude",
          model: "claude-sonnet",
          agentMode: "regular",
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
        turnId: "turn-1",
        status: "running",
        harnessId: "claude",
        model: "claude-sonnet-4",
        agentMode: "regular",
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

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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
    // original `restoreContent` so the composer can still recover the
    // triggering prompt exactly once.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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
      restoreContent: CONTENT,
    });

    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toEqual(CONTENT);

    // The accepted-action record stays in place (so other reconciliation
    // continues to work) but the restoreContent slot is cleared so a
    // duplicate setup.failed cannot double-restore.
    expect(
      harness.handle.store.getState().acceptedActions[sent.clientActionId],
    ).toMatchObject({
      action: "send",
      messageId: sent.messageId,
      restoreContent: null,
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
    // `restoreContent`, so a setup-gating `setup.failed` arriving in
    // this in-between window must still recover the prompt.
    const harness = createHarness();
    const callbacks = harness.callbacks();
    emitSnapshot(callbacks, "owner");

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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
      restoreContent: CONTENT,
    });

    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toEqual(CONTENT);
    expect(
      harness.handle.store.getState().pendingActions[sent.clientActionId]
        .restoreContent,
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
      event: { eventId: "event-gating" },
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
      selectRestorableSetupInterruption(harness.handle.store.getState())?.event
        .eventId,
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
      event: { eventId: "event-gating-2" },
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

    harness.handle.store
      .getState()
      .sendMessage(CONTENT, { type: "user", userId: OWNER_ID }, SETTINGS);
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
      event: { eventId: "event-cancelled-gating" },
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
      event: { eventId: "event-cancelled-gating" },
      messageId: "queued-msg-cancelled",
      clientActionId: "send-cancelled",
    });
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
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: manual.coordinator,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return { sendAction: () => undefined, close: () => undefined };
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

function startRunningTurn(callbacks: ChatStreamCallbacks): void {
  emitSnapshot(callbacks, "owner");
  callbacks.onTurnStateChanged({
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    runStatus: "running",
    activeTurn: {
      turnId: "turn-1",
      status: "running",
      harnessId: "codex",
      model: "gpt-5-codex",
      agentMode: "regular",
      profileId: null,
      userMessageId: "message-1",
      startedAt: 3,
      updatedAt: 3,
      reasoningEffort: null,
      serviceTier: null,
    },
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
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      userId: OWNER_ID,
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: coordinator,
      streamClientFactory: () => ({
        sendAction: () => undefined,
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
        turnId,
        status: "running",
        harnessId: "codex",
        model: "gpt-5-codex",
        agentMode: "regular",
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
      },
      {
        taskId: "task-accepted",
        kind: "command",
        title: "sleep 90",
        blockId: "tool-2",
        parentTaskId: null,
        scheduledFor: null,
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
