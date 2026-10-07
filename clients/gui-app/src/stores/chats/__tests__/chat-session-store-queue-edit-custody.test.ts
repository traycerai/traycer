import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedPromptItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { SEND_NOT_RECORDED_NOTICE_CODE } from "@/stores/chats/chat-queue-reconciler";
import {
  QUEUE_EDIT_PARTIAL_NOTICE_CODE,
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { queueItemsInFlight } from "@/stores/chats/queue-edit-custody";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * traycerai/traycer#2418. A queue edit goes out as TWO independent frames and
 * the composer clears the moment both are dispatched. These cases drive the
 * host's answers (and the connection's death) through the real stream
 * callbacks and read the store, so what is proven is the custody the store
 * keeps, not a helper called in isolation.
 */

const EPIC_ID = "epic-queue-edit";
const CHAT_ID = "chat-queue-edit";
const OWNER_ID = "owner-queue-edit";
const HOST_ID = "host-a";
const QUEUE_ITEM_ID = "queue-item-1";
const MESSAGE_ID = "queued-message-1";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const ORIGINAL = textDoc("original queued text");
const EDITED = textDoc("the corrected text");

function queuedRow(content: JsonContent): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: QUEUE_ITEM_ID,
    messageId: MESSAGE_ID,
    message: { kind: "user", content, browserAnnotations: [] },
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
    hostId: HOST_ID,
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

function emitSnapshot(
  harness: Harness,
  items: ReadonlyArray<ChatQueuedPromptItem>,
): void {
  harness.callbacks().onSnapshot({
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: HOST_ID,
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
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [...items] },
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

/** Open the stream and seat a snapshot whose queue holds the ORIGINAL row. */
function openWithQueuedRow(): Harness {
  const harness = createHarness();
  harness.callbacks().onConnectionStatus("open", null, null);
  emitSnapshot(harness, [queuedRow(ORIGINAL)]);
  return harness;
}

function reconnectWithItems(
  harness: Harness,
  items: ReadonlyArray<ChatQueuedPromptItem>,
): void {
  const callbacks = harness.callbacks();
  callbacks.onConnectionStatus("closed", null, null);
  callbacks.onConnectionStatus("open", null, null);
  emitSnapshot(harness, items);
}

interface EditFrames {
  readonly editActionId: string;
  readonly followUpActionId: string;
}

function submitEdit(harness: Harness, intent: "save" | "steer"): EditFrames {
  const editActionId = harness.handle.store.getState().submitQueueEdit({
    queueItemId: QUEUE_ITEM_ID,
    content: EDITED,
    restore: { content: EDITED, browserAnnotations: [] },
    settings: SETTINGS,
    intent,
  });
  if (editActionId === null) throw new Error("expected the edit to dispatch");
  const edit = harness.sent.at(-2);
  const followUp = harness.sent.at(-1);
  if (edit?.kind !== "queueEdit") throw new Error("expected a queueEdit frame");
  const expectedFollowUp =
    intent === "save" ? "queueSettingsUpdate" : "queueSteerNow";
  if (followUp?.kind !== expectedFollowUp) {
    throw new Error(`expected a ${expectedFollowUp} frame`);
  }
  expect(edit.clientActionId).toBe(editActionId);
  return {
    editActionId,
    followUpActionId: followUp.clientActionId,
  };
}

function ack(
  harness: Harness,
  input: {
    readonly clientActionId: string;
    readonly action:
      | "queueEdit"
      | "queueSettingsUpdate"
      | "queueSteerNow"
      | "queueAbortSteer"
      | "queueReorder";
    readonly status: "accepted" | "rejected";
  },
): void {
  harness.callbacks().onActionAck({
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    clientActionId: input.clientActionId,
    action: input.action,
    status: input.status,
    reason:
      input.status === "rejected"
        ? "The queued prompt is no longer pending."
        : null,
    code: input.status === "rejected" ? "QUEUE_ITEM_NOT_FOUND" : null,
    backgroundStopTaskIds: [],
    token: null,
  });
}

function sendFrameCount(harness: Harness): number {
  return harness.sent.filter((frame) => frame.kind === "send").length;
}

let harness: Harness | null = null;

afterEach(() => {
  harness?.handle.dispose();
  harness = null;
});

describe("a queued-prompt edit stays in custody until the host answers", () => {
  it("hands the EDITED text back, with no generic notice and no send, when the host refuses both frames (the #2418 sequence)", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(harness, "save");

    // Before ANY ack: both frames carry the row, and the edited text is held.
    const before = harness.handle.store.getState();
    expect(before.pendingActions[editActionId]?.queueItemId).toBe(
      QUEUE_ITEM_ID,
    );
    expect(before.pendingActions[followUpActionId]?.queueItemId).toBe(
      QUEUE_ITEM_ID,
    );
    expect(before.queueEditRecords[editActionId]?.restore.content).toEqual(
      EDITED,
    );

    ack(harness, {
      clientActionId: editActionId,
      action: "queueEdit",
      status: "rejected",
    });
    ack(harness, {
      clientActionId: followUpActionId,
      action: "queueSettingsUpdate",
      status: "rejected",
    });

    const after = harness.handle.store.getState();
    // CONTENT CONSERVATION: the corrected text is the unsent draft, not the
    // original and not nothing.
    expect(after.failedSendRestoration?.content).toEqual(EDITED);
    expect(after.failedSendRestoration?.content).not.toEqual(ORIGINAL);
    expect(after.failedSendRestoration?.messageId).toBeNull();
    // The refusal is narrated by the hand-back, not by two generic notices.
    expect(
      after.errorNotices.filter((n) => n.code === "QUEUE_ITEM_NOT_FOUND"),
    ).toEqual([]);
    expect(after.queueEditRecords).toEqual({});
    // NO DUPLICATE SEND: the only frames that ever left are the two queue
    // frames - nothing re-sent the original or the edit as a new message.
    expect(harness.sent.map((frame) => frame.kind)).toEqual([
      "queueEdit",
      "queueSettingsUpdate",
    ]);
    expect(sendFrameCount(harness)).toBe(0);
  });

  it("keeps the edited text as a last-copy prompt, and the slot's occupant, when the restoration slot is taken", () => {
    harness = openWithQueuedRow();
    // Occupy the slot with a refused send's restoration.
    harness.handle.store.getState().sendMessage({
      content: textDoc("an earlier draft"),
      sender: { type: "user", userId: OWNER_ID },
      settings: SETTINGS,
      attachments: [],
      deliveryPolicy: "auto",
      restore: {
        content: textDoc("an earlier draft"),
        browserAnnotations: [],
      },
    });
    const sendFrame = harness.sent.at(-1);
    if (sendFrame?.kind !== "send") throw new Error("expected a send frame");
    harness.callbacks().onActionAck({
      kind: "actionAck",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      clientActionId: sendFrame.clientActionId,
      action: "send",
      status: "rejected",
      reason: "The host refused the message.",
      code: "SEND_REFUSED",
      backgroundStopTaskIds: [],
      token: null,
    });
    const occupant = harness.handle.store.getState().failedSendRestoration;
    expect(occupant?.content).toEqual(textDoc("an earlier draft"));

    const { editActionId } = submitEdit(harness, "save");
    ack(harness, {
      clientActionId: editActionId,
      action: "queueEdit",
      status: "rejected",
    });

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration?.clientActionId).toBe(
      occupant?.clientActionId,
    );
    expect(state.failedSendRestoration?.content).toEqual(
      textDoc("an earlier draft"),
    );
    const lastCopy = state.lastCopyPrompts[editActionId];
    expect(lastCopy).toBeDefined();
    expect(lastCopy.content).toEqual(EDITED);
    const stated = state.errorNotices.filter(
      (notice) => notice.clientActionId === editActionId,
    );
    expect(stated).toHaveLength(1);
    expect(stated[0]?.code).toBe(SEND_NOT_RECORDED_NOTICE_CODE);
  });

  it("states a partial save, and restores nothing, when the edit is accepted and the follow-up refused", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(harness, "steer");

    ack(harness, {
      clientActionId: editActionId,
      action: "queueEdit",
      status: "accepted",
    });
    ack(harness, {
      clientActionId: followUpActionId,
      action: "queueSteerNow",
      status: "rejected",
    });

    const state = harness.handle.store.getState();
    const partial = state.errorNotices.filter(
      (notice) => notice.code === QUEUE_EDIT_PARTIAL_NOTICE_CODE,
    );
    expect(partial).toHaveLength(1);
    expect(
      partial[0]?.message.startsWith(
        "Text saved; settings/steering were not applied",
      ),
    ).toBe(true);
    expect(state.failedSendRestoration).toBeNull();
    expect(state.queueEditRecords).toEqual({});
    expect(sendFrameCount(harness)).toBe(0);
  });

  it("hands the edited text back after a reconnect whose snapshot row still holds the ORIGINAL", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(harness, "save");
    expect(Object.keys(harness.handle.store.getState().pendingActions)).toEqual(
      expect.arrayContaining([editActionId, followUpActionId]),
    );

    reconnectWithItems(harness, [queuedRow(ORIGINAL)]);

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration?.content).toEqual(EDITED);
    expect(state.queueEditRecords).toEqual({});
    // The sweep did run: the ids the record named are gone from pending.
    expect(state.pendingActions[editActionId]).toBeUndefined();
    expect(state.pendingActions[followUpActionId]).toBeUndefined();
    expect(sendFrameCount(harness)).toBe(0);
  });

  it("hands nothing back after a reconnect whose snapshot row already holds the EDITED text", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(harness, "save");

    reconnectWithItems(harness, [queuedRow(EDITED)]);

    const state = harness.handle.store.getState();
    // The same sweep ran (positive) and accounted for the record...
    expect(state.pendingActions[editActionId]).toBeUndefined();
    expect(state.pendingActions[followUpActionId]).toBeUndefined();
    expect(state.queueEditRecords).toEqual({});
    // ...and the evidence said the edit landed, so no copy was returned.
    expect(state.failedSendRestoration).toBeNull();
    expect(sendFrameCount(harness)).toBe(0);
  });

  it("keeps the record and both pending frames when a SAME-connection snapshot lacks the row", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(harness, "save");

    emitSnapshot(harness, []);

    const state = harness.handle.store.getState();
    expect(state.queueEditRecords[editActionId]).toBeDefined();
    expect(state.pendingActions[editActionId]).toBeDefined();
    expect(state.pendingActions[followUpActionId]).toBeDefined();
    expect(state.failedSendRestoration).toBeNull();
    // The snapshot was really applied: the row is gone from the queue.
    expect(state.queue.items).toEqual([]);
  });

  it("marks a row in flight from the pending action and clears it on the ack, for steer, abort-steer and reorder", () => {
    harness = openWithQueuedRow();
    const store = harness.handle.store;

    const steerId = store.getState().queueSteerNow(QUEUE_ITEM_ID, SETTINGS);
    if (steerId === null) throw new Error("expected a steer frame");
    expect(store.getState().pendingActions[steerId]?.queueItemId).toBe(
      QUEUE_ITEM_ID,
    );
    expect(
      queueItemsInFlight(store.getState().pendingActions).get(QUEUE_ITEM_ID),
    ).toBe("requesting_steer");
    ack(harness, {
      clientActionId: steerId,
      action: "queueSteerNow",
      status: "accepted",
    });
    expect(
      queueItemsInFlight(store.getState().pendingActions).has(QUEUE_ITEM_ID),
    ).toBe(false);

    const abortId = store.getState().queueAbortSteer(QUEUE_ITEM_ID);
    if (abortId === null) throw new Error("expected an abort frame");
    expect(
      queueItemsInFlight(store.getState().pendingActions).get(QUEUE_ITEM_ID),
    ).toBe("cancelling");
    ack(harness, {
      clientActionId: abortId,
      action: "queueAbortSteer",
      status: "accepted",
    });
    expect(
      queueItemsInFlight(store.getState().pendingActions).has(QUEUE_ITEM_ID),
    ).toBe(false);

    const reorderId = store.getState().queueReorder(QUEUE_ITEM_ID, null);
    if (reorderId === null) throw new Error("expected a reorder frame");
    expect(
      queueItemsInFlight(store.getState().pendingActions).get(QUEUE_ITEM_ID),
    ).toBe("saving");
    ack(harness, {
      clientActionId: reorderId,
      action: "queueReorder",
      status: "accepted",
    });
    expect(
      queueItemsInFlight(store.getState().pendingActions).has(QUEUE_ITEM_ID),
    ).toBe(false);
  });

  it("returns null, dispatches no frame and records nothing for a row that is not in the queue", () => {
    harness = createHarness();
    harness.callbacks().onConnectionStatus("open", null, null);
    emitSnapshot(harness, []);
    const framesBefore = harness.sent.length;

    const result = harness.handle.store.getState().submitQueueEdit({
      queueItemId: "no-such-row",
      content: EDITED,
      restore: { content: EDITED, browserAnnotations: [] },
      settings: SETTINGS,
      intent: "save",
    });

    expect(result).toBeNull();
    expect(harness.sent.length).toBe(framesBefore);
    expect(harness.handle.store.getState().queueEditRecords).toEqual({});
  });
});
