import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedPromptItem,
  ChatRunSettings,
  ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import { SEND_NOT_RECORDED_NOTICE_CODE } from "@/stores/chats/chat-queue-reconciler";
import { QUEUE_EDIT_SAVED_AFTER_RETURN_NOTICE_CODE } from "@/stores/chats/chat-queue-reconciler";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { queueItemsInFlight } from "@/stores/chats/queue-edit-custody";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  isDraftBlobConfirmed,
  putDraftBlobs,
  resetDraftBlobTransportForTests,
  type DraftBlobClient,
} from "@/lib/drafts/draft-blob-transport";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * traycerai/traycer#2418. A queue edit goes out as TWO independent frames and
 * the composer clears the moment both are dispatched. These cases drive the
 * host's answers (and the connection's death) through the real stream
 * callbacks and read the store, so what is proven is the custody the store
 * keeps, not a helper called in isolation.
 */

vi.mock("@/lib/composer/landing-image-store", () => ({
  getImageBytes: (hash: string) =>
    Promise.resolve(
      hash === "d".repeat(64) ? new Uint8Array([1, 2, 3, 4]) : undefined,
    ),
  putImageBytesAtHash: () => Promise.resolve(true),
  ensureMeasuredImageSizes: () => Promise.resolve(),
}));

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

const ANNOTATION: BrowserAnnotationRecord = {
  kind: "browser-annotation",
  annotationId: "annotation-1",
  tabId: "tab-1",
  sessionId: "session-1",
  origin: "https://example.test",
  pageUrl: "https://example.test/page",
  pageTitle: "Example",
  capturedAt: 1,
  comment: "this button",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: "crop.png",
  imageHash: "c".repeat(64),
  droppedElementCount: 0,
};

const OTHER_SETTINGS: ChatRunSettings = { ...SETTINGS, model: "gpt-5-mini" };

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

function submitEdit(
  harness: Harness,
  intent: "save" | "steer",
  settings: ChatRunSettings,
  browserAnnotations: ReadonlyArray<BrowserAnnotationRecord>,
): EditFrames {
  const editActionId = harness.handle.store.getState().submitQueueEdit({
    queueItemId: QUEUE_ITEM_ID,
    content: EDITED,
    restore: { content: EDITED, browserAnnotations },
    settings,
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

beforeEach(() => {
  // A blob confirmation is recorded and read PER ACCOUNT, and a null owner
  // confirms nothing: without an identity the `toBe(false)` below would read
  // "signed out" rather than "the refusal retracted the memo".
  useAuthStore.setState({
    contextMetadata: { userId: OWNER_ID, username: OWNER_ID },
  });
  resetDraftBlobTransportForTests();
});

afterEach(() => {
  useAuthStore.setState({ contextMetadata: null });
  harness?.handle.dispose();
  harness = null;
  resetDraftBlobTransportForTests();
});

describe("a queued-prompt edit stays in custody until the host answers", () => {
  it("hands the EDITED text back, with no generic notice and no send, when the host refuses both frames (the #2418 sequence)", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(
      harness,
      "save",
      SETTINGS,
      [],
    );

    // Before ANY ack: both frames carry the row, and the edited text is held.
    const before = harness.handle.store.getState();
    expect(before.pendingActions[editActionId].queueItemId).toBe(QUEUE_ITEM_ID);
    expect(before.pendingActions[followUpActionId].queueItemId).toBe(
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

    const { editActionId } = submitEdit(harness, "save", SETTINGS, []);
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
    expect(stated[0].code).toBe(SEND_NOT_RECORDED_NOTICE_CODE);
  });

  it("keeps the whole submission as a last-copy record, quoting the text, and restores nothing, when the edit is accepted and the follow-up refused (finding 6)", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(
      harness,
      "steer",
      SETTINGS,
      [ANNOTATION],
    );

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
    const kept = state.lastCopyPrompts[followUpActionId];
    expect(kept).toBeDefined();
    expect(kept.content).toEqual(EDITED);
    expect(kept.browserAnnotations).toEqual([ANNOTATION]);
    const stated = state.errorNotices.filter(
      (notice) => notice.clientActionId === followUpActionId,
    );
    expect(stated).toHaveLength(1);
    expect(stated[0].code).toBe(SEND_NOT_RECORDED_NOTICE_CODE);
    expect(stated[0].message).toContain(
      "Text saved; settings/steering were not applied",
    );
    expect(stated[0].message).toContain("the corrected text");
    expect(stated[0].message).toContain("do not send it again");
    expect(state.failedSendRestoration).toBeNull();
    expect(state.queueEditRecords).toEqual({});
    expect(sendFrameCount(harness)).toBe(0);
  });

  it("names what the submission asked for in the partial notice when the settings differed from the row's (finding 6, addendum)", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(
      harness,
      "save",
      OTHER_SETTINGS,
      [],
    );

    ack(harness, {
      clientActionId: editActionId,
      action: "queueEdit",
      status: "accepted",
    });
    ack(harness, {
      clientActionId: followUpActionId,
      action: "queueSettingsUpdate",
      status: "rejected",
    });

    const stated = harness.handle.store
      .getState()
      .errorNotices.filter(
        (notice) => notice.clientActionId === followUpActionId,
      );
    expect(stated).toHaveLength(1);
    expect(stated[0].message).toContain(
      "Text saved; settings/steering were not applied",
    );
    expect(stated[0].message).toContain("You asked for");
    expect(stated[0].message).toContain("gpt-5-mini");
  });

  it("does not claim a requested change when the submission's settings equal the row's (steer rejected)", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(
      harness,
      "steer",
      SETTINGS,
      [],
    );

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

    const stated = harness.handle.store
      .getState()
      .errorNotices.filter(
        (notice) => notice.clientActionId === followUpActionId,
      );
    // The partial really was stated (the path ran)...
    expect(stated).toHaveLength(1);
    expect(stated[0].message).toContain(
      "Text saved; settings/steering were not applied",
    );
    // ...and there was nothing to name.
    expect(stated[0].message).not.toContain("You asked for");
  });

  it("hands the edited text back as UNCONFIRMED after a reconnect whose snapshot row still holds the ORIGINAL, and retains the record (finding 2)", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(
      harness,
      "save",
      SETTINGS,
      [],
    );
    expect(Object.keys(harness.handle.store.getState().pendingActions)).toEqual(
      expect.arrayContaining([editActionId, followUpActionId]),
    );

    reconnectWithItems(harness, [queuedRow(ORIGINAL)]);

    const state = harness.handle.store.getState();
    expect(state.failedSendRestoration?.content).toEqual(EDITED);
    expect(state.failedSendRestoration?.reason).toContain(
      "could not be confirmed after reconnecting",
    );
    // Retained, because a row still showing the old text is no proof the host
    // is not about to install the edit.
    const kept = state.queueEditRecords[editActionId];
    expect(kept?.edit).toBe("unconfirmed");
    expect(kept?.contentReturned).toBe(true);
    // The sweep did run: the ids the record named are gone from pending.
    expect(state.pendingActions[editActionId]).toBeUndefined();
    expect(state.pendingActions[followUpActionId]).toBeUndefined();
    expect(sendFrameCount(harness)).toBe(0);
  });

  it("tells the user ONCE that an unconfirmed edit was saved after all, drops the record, and does not award the slot again (finding 2)", () => {
    harness = openWithQueuedRow();
    const { editActionId } = submitEdit(harness, "save", SETTINGS, []);
    reconnectWithItems(harness, [queuedRow(ORIGINAL)]);
    const slotBefore = harness.handle.store.getState().failedSendRestoration;
    expect(slotBefore?.content).toEqual(EDITED);

    // The host finishes the handler it had started: the row now holds the edit.
    harness.callbacks().onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: { status: "idle", items: [queuedRow(EDITED)] },
    });

    const state = harness.handle.store.getState();
    const told = state.errorNotices.filter(
      (notice) => notice.code === QUEUE_EDIT_SAVED_AFTER_RETURN_NOTICE_CODE,
    );
    expect(told).toHaveLength(1);
    expect(told[0].clientActionId).toBe(editActionId);
    expect(state.queueEditRecords).toEqual({});
    expect(state.failedSendRestoration).toBe(slotBefore);
    expect(sendFrameCount(harness)).toBe(0);

    // A later, identical queue change has nothing left to say.
    harness.callbacks().onQueueChanged({
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      queue: { status: "idle", items: [queuedRow(EDITED)] },
    });
    expect(
      harness.handle.store
        .getState()
        .errorNotices.filter(
          (notice) => notice.code === QUEUE_EDIT_SAVED_AFTER_RETURN_NOTICE_CODE,
        ),
    ).toHaveLength(1);
  });

  it("hands nothing back after a reconnect whose snapshot row already holds the EDITED text", () => {
    harness = openWithQueuedRow();
    const { editActionId, followUpActionId } = submitEdit(
      harness,
      "save",
      SETTINGS,
      [],
    );

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
    const { editActionId, followUpActionId } = submitEdit(
      harness,
      "save",
      SETTINGS,
      [],
    );

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
    expect(store.getState().pendingActions[steerId].queueItemId).toBe(
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

describe("a refused queue edit retracts this host's blob acks (finding 8)", () => {
  const WIRE_HASH = "d".repeat(64);
  const ACK_CLIENT: DraftBlobClient = {
    request: (() =>
      Promise.resolve({})) as HostRequester<HostRpcRegistry>["request"],
    requestWithOptions: (() =>
      Promise.resolve({
        ok: true,
      })) as HostRequester<HostRpcRegistry>["requestWithOptions"],
  };
  const WIRE_ONLY_IMAGE: JsonContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "img-1",
              fileName: "crop.png",
              mimeType: "image/png",
              size: 4,
              hash: WIRE_HASH,
            },
          },
          { type: "text", text: "the corrected text" },
        ],
      },
    ],
  };

  it("forgets a hash present only in the frame's document, not in the composer's", async () => {
    await putDraftBlobs(HOST_ID, ACK_CLIENT, [WIRE_HASH], OWNER_ID);
    expect(isDraftBlobConfirmed(HOST_ID, WIRE_HASH, OWNER_ID)).toBe(true);

    harness = openWithQueuedRow();
    // The composer's own document names no image; the frame's does (an
    // annotation crop is added on the way out).
    const editActionId = harness.handle.store.getState().submitQueueEdit({
      queueItemId: QUEUE_ITEM_ID,
      content: WIRE_ONLY_IMAGE,
      restore: { content: EDITED, browserAnnotations: [] },
      settings: SETTINGS,
      intent: "save",
    });
    if (editActionId === null) throw new Error("expected the edit to dispatch");
    // Nothing is forgotten by submitting.
    expect(isDraftBlobConfirmed(HOST_ID, WIRE_HASH, OWNER_ID)).toBe(true);

    ack(harness, {
      clientActionId: editActionId,
      action: "queueEdit",
      status: "rejected",
    });

    // The refusal really handed the text back (the path ran)...
    expect(
      harness.handle.store.getState().failedSendRestoration?.content,
    ).toEqual(EDITED);
    // ...and the wire-only hash is no longer believed to be on this host.
    expect(isDraftBlobConfirmed(HOST_ID, WIRE_HASH, OWNER_ID)).toBe(false);
  });
});
