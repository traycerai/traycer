import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueueDeliveryPolicy,
  ChatQueuedPromptItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import type { UserMessageSender } from "@traycer/protocol/persistence/epic/schemas";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
  type SentChatMessageAction,
} from "@/stores/chats/chat-session-store";
import { buildAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useAccountContextStore } from "@/stores/auth/account-context-store";

const EPIC_ID = "epic-seeded-send";
const CHAT_ID = "chat-seeded-send";
const OWNER_ID = "owner-seeded-send";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const INTENT: WorktreeIntent = {
  entries: [
    {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat-seeded",
        source: "main",
        carryUncommittedChanges: false,
      },
    },
  ],
};

/**
 * A DIFFERENT pick, standing for the choice a user makes in the chat's own
 * workspace selector while the handoff is still waiting (on image recovery or
 * on the connection). Same folder, different branch - the shape that would
 * compare equal under any comparison looser than structural.
 */
const NEWER_INTENT: WorktreeIntent = {
  entries: [
    {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat-user-picked-later",
        source: "main",
        carryUncommittedChanges: false,
      },
    },
  ],
};

const STAGING_KEY: WorktreeStagingKey = {
  surface: "owner",
  hostId: "host-a",
  epicId: EPIC_ID,
  ownerKind: "chat",
  ownerId: CHAT_ID,
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
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: (frame) => {
          sent.push(frame);
        },
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
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

function emitOwnerSnapshot(callbacks: ChatStreamCallbacks): void {
  callbacks.onConnectionStatus("open", null, null);
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
        hostId: "host-a",
        title: "Host Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: SETTINGS,
        activeSessionChain: null,
        claudePendingWakes: [],
        messages: [],
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
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
    },
  });
}

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

function promptItem(messageId: string): ChatQueuedPromptItem {
  return {
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
    sentFromHostId: null,
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  useWorktreeIntentStagingStore.getState().resetForTests();
  useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
});

describe("takeSetupFailedRestoration queued guard", () => {
  it("restores nothing while the message is still in queue.items and leaves the optimistic echo", () => {
    const harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
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

    harness.handle.store.setState({
      queue: {
        status: "running",
        items: [promptItem(sent.messageId)],
      },
    });

    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toBeNull();
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);
    expect(
      harness.handle.store.getState().pendingUserMessages[0]?.messageId,
    ).toBe(sent.messageId);
  });

  it("restores as before once the row has left the queue", () => {
    const harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
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

    harness.handle.store.setState({
      queue: {
        status: "running",
        items: [promptItem(sent.messageId)],
      },
    });
    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toBeNull();

    harness.handle.store.setState({
      queue: { status: "idle", items: [] },
    });
    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toEqual(CONTENT);
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
  });

  it("still restores a rejected send's setup.failed that never entered the queue", () => {
    const harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
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
    expect(harness.handle.store.getState().queue.items).toEqual([]);
    expect(harness.handle.store.getState().pendingUserMessages).toHaveLength(1);

    expect(
      harness.handle.store
        .getState()
        .takeSetupFailedRestoration(sent.messageId),
    ).toEqual(CONTENT);
    expect(harness.handle.store.getState().pendingUserMessages).toEqual([]);
  });
});

describe("sendSeededUserMessage carrying the intent", () => {
  it("puts the handoff intent on the frame and both pending-action copies, and leaves pendingUserMessages restoreWorktreeIntent null", () => {
    const harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    harness.handle.store.getState().sendSeededUserMessage({
      messageId: "seeded-msg",
      clientActionId: "seeded-action",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      worktreeIntent: INTENT,
    });

    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("expected send frame");
    }
    expect(frame.worktreeIntent).toEqual(INTENT);

    const pending =
      harness.handle.store.getState().pendingActions["seeded-action"];
    expect(pending.restoreWorktreeIntent).toEqual(INTENT);
    expect(pending.displayWorktreeIntent).toEqual(INTENT);

    const echo = harness.handle.store.getState().pendingUserMessages[0];
    expect(echo.messageId).toBe("seeded-msg");
    expect(echo.restoreWorktreeIntent).toBeNull();
  });

  it("restores the composer with the intent on a WORKTREE_CREATE_FAILED rejection of that send", () => {
    const harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    harness.handle.store.getState().sendSeededUserMessage({
      messageId: "seeded-msg",
      clientActionId: "seeded-action",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      worktreeIntent: INTENT,
    });

    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: "seeded-action",
      action: "send",
      status: "rejected",
      reason: "git worktree add failed",
      code: "WORKTREE_CREATE_FAILED",
      backgroundStopTaskIds: [],
      token: null,
    });

    expect(
      useWorktreeIntentStagingStore.getState().intentByKey[
        worktreeStagingKeyString(STAGING_KEY)
      ],
    ).toEqual(INTENT);
  });
});

/**
 * The handoff's intent and the staging slot are two different sources, and the
 * handoff can sit for a long time between being registered and being sent -
 * long enough for the user to pick something else in the chat's own workspace
 * selector, which stays enabled throughout (`chat-tile.tsx`, `disabled={false}`).
 *
 * A send that consumed the slot unconditionally would take that newer pick with
 * it: gone on success, and - because the consume writes the mark that
 * authorizes a hand-back - overwritten by the OLDER handoff intent on a
 * rejection. The claim is therefore conditional, and these three cases pin the
 * partition: no competing pick (consume), the send's own pick (consume), a
 * different pick (leave it entirely alone).
 */
describe("sendSeededUserMessage against a slot the user moved", () => {
  function sendSeeded(harness: Harness): void {
    harness.handle.store.getState().sendSeededUserMessage({
      messageId: "seeded-msg",
      clientActionId: "seeded-action",
      content: CONTENT,
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      worktreeIntent: INTENT,
    });
  }

  function stagedIntent(): WorktreeIntent | undefined {
    return useWorktreeIntentStagingStore.getState().intentByKey[
      worktreeStagingKeyString(STAGING_KEY)
    ];
  }

  function ackSeeded(harness: Harness, status: "accepted" | "rejected"): void {
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: "seeded-action",
      action: "send",
      status,
      reason: status === "rejected" ? "git worktree add failed" : null,
      code: status === "rejected" ? "WORKTREE_CREATE_FAILED" : null,
      backgroundStopTaskIds: [],
      token: null,
    });
  }

  function consumptionMarkActionId(): string | undefined {
    return useWorktreeIntentStagingStore.getState().consumedForDispatchByKey[
      worktreeStagingKeyString(STAGING_KEY)
    ]?.clientActionId;
  }

  /**
   * An EMPTY slot is not an unowned one.
   *
   * The user picked a newer worktree and SENT it while the handoff was still
   * waiting, so that send took the pick and left its consumption mark behind.
   * The slot now reads empty with no visible pick to protect - and a seeded send
   * that claimed it there would write its own `clientActionId` over that mark.
   * There is one mark per slot, so the earlier send would silently lose the
   * right to hand its worktree back on its own rejection, which is the moment it
   * needs the slot most.
   */
  it("leaves another pending dispatch's consumption mark alone, so that dispatch can still restore on rejection", () => {
    const harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, NEWER_INTENT);

    // The user's own send takes the pick and the mark with it.
    sendTestMessage(
      harness.handle.store,
      CONTENT,
      { type: "user", userId: OWNER_ID },
      { settings: SETTINGS, deliveryPolicy: "auto" },
    );
    const userSend = harness.sent.at(-1);
    if (userSend === undefined || userSend.kind !== "send") {
      throw new Error("expected the user's send frame");
    }
    expect(stagedIntent()).toBeUndefined();
    expect(consumptionMarkActionId()).toBe(userSend.clientActionId);

    // The handoff lands afterwards. It still sends its own intent...
    sendSeeded(harness);
    const seededFrame = harness.sent.at(-1);
    if (seededFrame === undefined || seededFrame.kind !== "send") {
      throw new Error("expected the seeded send frame");
    }
    expect(seededFrame.worktreeIntent).toEqual(INTENT);
    // ...and leaves the mark where it found it.
    expect(consumptionMarkActionId()).toBe(userSend.clientActionId);

    // So the user's send can still hand its own worktree back.
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: userSend.clientActionId,
      action: "send",
      status: "rejected",
      reason: "git worktree add failed",
      code: "WORKTREE_CREATE_FAILED",
      backgroundStopTaskIds: [],
      token: null,
    });
    expect(stagedIntent()).toEqual(NEWER_INTENT);
  });

  it("sends its own intent and leaves a newer staged pick in place through an accepted ack", () => {
    const harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, NEWER_INTENT);

    sendSeeded(harness);

    // The message still goes out against the intent it was WRITTEN for - the
    // newer pick was never part of this prompt.
    const frame = harness.sent.at(-1);
    if (frame === undefined || frame.kind !== "send") {
      throw new Error("expected send frame");
    }
    expect(frame.worktreeIntent).toEqual(INTENT);
    // ...and the pick the user made during the wait is untouched, so it is
    // still what their NEXT send runs against.
    expect(stagedIntent()).toEqual(NEWER_INTENT);

    ackSeeded(harness, "accepted");
    expect(stagedIntent()).toEqual(NEWER_INTENT);
  });

  it("does not restore its own intent over a newer staged pick on a WORKTREE_CREATE_FAILED rejection", () => {
    const harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(STAGING_KEY, NEWER_INTENT);

    sendSeeded(harness);
    ackSeeded(harness, "rejected");

    // No mark was written, so the hand-back has no claim on the slot. The
    // user's own choice survives the rejection.
    expect(stagedIntent()).toEqual(NEWER_INTENT);
  });

  it("still consumes and restores when the slot holds this send's own pick", () => {
    const harness = createHarness();
    emitOwnerSnapshot(harness.callbacks());
    useWorktreeIntentStagingStore.getState().setIntent(STAGING_KEY, INTENT);

    sendSeeded(harness);
    // Consumed: the slot is this dispatch's now, exactly as before the guard.
    expect(stagedIntent()).toBeUndefined();

    ackSeeded(harness, "rejected");
    expect(stagedIntent()).toEqual(INTENT);
  });
});
