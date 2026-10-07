import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedPromptItem,
  ChatQueueState,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type {
  ChatSendRestore,
  PendingChatAction,
} from "@/stores/chats/chat-session-store";
import {
  foldQueueEditAck,
  queueEditContentMatches,
  queueItemsInFlight,
  settleQueueEditsForSnapshot,
  type QueueEditIntent,
  type QueueEditRecord,
  type QueueEditRecords,
} from "@/stores/chats/queue-edit-custody";

const OWNER_ID = "owner-1";
const QUEUE_ITEM_ID = "queue-item-1";
const MESSAGE_ID = "message-1";
const EDIT_ACTION_ID = "edit-action";
const FOLLOW_UP_ACTION_ID = "follow-up-action";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const OTHER_SETTINGS: ChatRunSettings = { ...SETTINGS, model: "gpt-5-mini" };

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function imageDoc(
  text: string,
  hash: string,
  inlineBytes: boolean,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "imageAttachment",
            attrs: {
              id: "img-1",
              fileName: "shot.png",
              mimeType: "image/png",
              size: 4,
              byHashEligible: true,
              hash,
              ...(inlineBytes ? { data: "AQIDBA==" } : {}),
            },
          },
          { type: "text", text },
        ],
      },
    ],
  };
}

const ORIGINAL = textDoc("original text");
const EDITED = textDoc("edited text");

const RESTORE: ChatSendRestore = {
  content: EDITED,
  browserAnnotations: [],
};

function record(
  overrides: Partial<QueueEditRecord>,
  intent: QueueEditIntent,
): QueueEditRecord {
  return {
    queueItemId: QUEUE_ITEM_ID,
    messageId: MESSAGE_ID,
    intent,
    restore: RESTORE,
    wireContent: EDITED,
    settings: SETTINGS,
    editActionId: EDIT_ACTION_ID,
    followUpActionId: FOLLOW_UP_ACTION_ID,
    edit: "pending",
    followUp: "pending",
    contentReturned: false,
    dispatchedAt: 0,
    ...overrides,
  };
}

function recordsOf(entry: QueueEditRecord): QueueEditRecords {
  return { [entry.editActionId]: entry };
}

function row(overrides: Partial<ChatQueuedPromptItem>): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: QUEUE_ITEM_ID,
    messageId: MESSAGE_ID,
    message: { kind: "user", content: ORIGINAL, browserAnnotations: [] },
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
    ...overrides,
  };
}

function queueOf(items: ReadonlyArray<ChatQueuedPromptItem>): ChatQueueState {
  return { status: "idle", items: [...items] };
}

function userMessage(messageId: string, content: JsonContent): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: OWNER_ID },
    message: { kind: "user", content, browserAnnotations: [] },
    timestamp: 1,
    sessionAnchor: null,
  };
}

function settingsEqual(a: ChatRunSettings, b: ChatRunSettings): boolean {
  return a.model === b.model;
}

const NO_MESSAGES: ReadonlyArray<Message> = [];

describe("foldQueueEditAck", () => {
  it("returns the edited content on a refused edit, keeps the record for the pending follow-up, then settles nothing more when the follow-up is refused", () => {
    const start = recordsOf(record({}, "save"));

    const first = foldQueueEditAck(start, {
      clientActionId: EDIT_ACTION_ID,
      status: "rejected",
      reason: "The queued prompt is no longer pending.",
    });
    expect(first.settlements).toEqual([
      {
        kind: "content_returned",
        clientActionId: EDIT_ACTION_ID,
        restore: RESTORE,
        hostReason: "The queued prompt is no longer pending.",
      },
    ]);
    // Kept, flagged as already handed back, while the follow-up is pending.
    expect(first.records[EDIT_ACTION_ID]?.contentReturned).toBe(true);
    expect(first.records[EDIT_ACTION_ID]?.edit).toBe("rejected");
    expect(first.records[EDIT_ACTION_ID]?.followUp).toBe("pending");

    const second = foldQueueEditAck(first.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "The queued prompt is no longer pending.",
    });
    // The record WAS still there to be answered (positive), and now goes
    // without a second settlement.
    expect(Object.keys(first.records)).toEqual([EDIT_ACTION_ID]);
    expect(second.settlements).toEqual([]);
    expect(second.records).toEqual({});
  });

  it("settles a partial exactly once when the edit was accepted and the follow-up refused", () => {
    const start = recordsOf(record({}, "steer"));
    const afterEdit = foldQueueEditAck(start, {
      clientActionId: EDIT_ACTION_ID,
      status: "accepted",
      reason: null,
    });
    expect(afterEdit.settlements).toEqual([]);
    expect(afterEdit.records[EDIT_ACTION_ID]?.edit).toBe("accepted");

    const afterFollowUp = foldQueueEditAck(afterEdit.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "Steering is unavailable.",
    });
    expect(afterFollowUp.settlements).toEqual([
      {
        kind: "partial",
        clientActionId: FOLLOW_UP_ACTION_ID,
        intent: "steer",
        hostReason: "Steering is unavailable.",
      },
    ]);
    expect(afterFollowUp.records).toEqual({});
  });

  it("settles nothing and removes the record when both frames are accepted", () => {
    const afterEdit = foldQueueEditAck(recordsOf(record({}, "save")), {
      clientActionId: EDIT_ACTION_ID,
      status: "accepted",
      reason: null,
    });
    // The first ack alone must not have removed it (the path ran).
    expect(Object.keys(afterEdit.records)).toEqual([EDIT_ACTION_ID]);
    const afterBoth = foldQueueEditAck(afterEdit.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "accepted",
      reason: null,
    });
    expect(afterBoth.settlements).toEqual([]);
    expect(afterBoth.records).toEqual({});
  });

  it("returns the same records reference for an ack naming neither frame", () => {
    const records = recordsOf(record({}, "save"));
    const fold = foldQueueEditAck(records, {
      clientActionId: "unrelated-action",
      status: "rejected",
      reason: "nope",
    });
    expect(fold.records).toBe(records);
    expect(fold.settlements).toEqual([]);
  });
});

describe("settleQueueEditsForSnapshot", () => {
  const bothSwept = new Set([EDIT_ACTION_ID, FOLLOW_UP_ACTION_ID]);

  it("leaves a record whose ids were not swept untouched even though its row is absent", () => {
    const records = recordsOf(record({}, "save"));
    const fold = settleQueueEditsForSnapshot({
      records,
      sweptActionIds: new Set(["some-other-action"]),
      queue: queueOf([]),
      messages: NO_MESSAGES,
      settingsEqual,
    });
    expect(fold.records).toBe(records);
    expect(fold.settlements).toEqual([]);
  });

  it("settles nothing when the swept row carries the edited content and matching settings", () => {
    const fold = settleQueueEditsForSnapshot({
      records: recordsOf(record({}, "save")),
      sweptActionIds: bothSwept,
      queue: queueOf([
        row({
          message: { kind: "user", content: EDITED, browserAnnotations: [] },
        }),
      ]),
      messages: NO_MESSAGES,
      settingsEqual,
    });
    expect(fold.settlements).toEqual([]);
    // Settled, so accounted for and gone - not merely skipped.
    expect(fold.records).toEqual({});
  });

  it("returns the content with a null reason when the swept row still holds the original", () => {
    const fold = settleQueueEditsForSnapshot({
      records: recordsOf(record({}, "save")),
      sweptActionIds: bothSwept,
      queue: queueOf([row({})]),
      messages: NO_MESSAGES,
      settingsEqual,
    });
    expect(fold.settlements).toEqual([
      {
        kind: "content_returned",
        clientActionId: EDIT_ACTION_ID,
        restore: RESTORE,
        hostReason: null,
      },
    ]);
    expect(fold.records).toEqual({});
  });

  it("settles nothing when the row is gone and the transcript message holds the edited content", () => {
    const fold = settleQueueEditsForSnapshot({
      records: recordsOf(record({}, "save")),
      sweptActionIds: bothSwept,
      queue: queueOf([]),
      messages: [userMessage(MESSAGE_ID, EDITED)],
      settingsEqual,
    });
    expect(fold.settlements).toEqual([]);
    expect(fold.records).toEqual({});
  });

  it("returns the content when the row is gone and the transcript holds nothing for the message", () => {
    const fold = settleQueueEditsForSnapshot({
      records: recordsOf(record({}, "save")),
      sweptActionIds: bothSwept,
      queue: queueOf([]),
      messages: [userMessage("a-different-message", EDITED)],
      settingsEqual,
    });
    expect(fold.settlements).toEqual([
      {
        kind: "content_returned",
        clientActionId: EDIT_ACTION_ID,
        restore: RESTORE,
        hostReason: null,
      },
    ]);
    expect(fold.records).toEqual({});
  });

  it("settles a partial with a null reason when the edit was accepted and the swept row still shows other settings", () => {
    const fold = settleQueueEditsForSnapshot({
      records: recordsOf(record({ edit: "accepted" }, "save")),
      sweptActionIds: new Set([FOLLOW_UP_ACTION_ID]),
      queue: queueOf([
        row({
          message: { kind: "user", content: EDITED, browserAnnotations: [] },
          settings: OTHER_SETTINGS,
        }),
      ]),
      messages: NO_MESSAGES,
      settingsEqual,
    });
    expect(fold.settlements).toEqual([
      {
        kind: "partial",
        clientActionId: FOLLOW_UP_ACTION_ID,
        intent: "save",
        hostReason: null,
      },
    ]);
    expect(fold.records).toEqual({});
  });

  it("reads a steer as applied when the row is steer_requested, and as not applied while it is still a plain pending next-turn row", () => {
    const applied = settleQueueEditsForSnapshot({
      records: recordsOf(record({ edit: "accepted" }, "steer")),
      sweptActionIds: new Set([FOLLOW_UP_ACTION_ID]),
      queue: queueOf([
        row({
          message: { kind: "user", content: EDITED, browserAnnotations: [] },
          status: "steer_requested",
        }),
      ]),
      messages: NO_MESSAGES,
      settingsEqual,
    });
    expect(applied.settlements).toEqual([]);
    expect(applied.records).toEqual({});

    // The control: the same record against a row that never moved IS partial,
    // so the line above passed because of the status, not by default.
    const notApplied = settleQueueEditsForSnapshot({
      records: recordsOf(record({ edit: "accepted" }, "steer")),
      sweptActionIds: new Set([FOLLOW_UP_ACTION_ID]),
      queue: queueOf([
        row({
          message: { kind: "user", content: EDITED, browserAnnotations: [] },
        }),
      ]),
      messages: NO_MESSAGES,
      settingsEqual,
    });
    expect(notApplied.settlements).toEqual([
      {
        kind: "partial",
        clientActionId: FOLLOW_UP_ACTION_ID,
        intent: "steer",
        hostReason: null,
      },
    ]);
  });
});

describe("queueEditContentMatches", () => {
  const HASH =
    "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

  it("matches the same text and image hashes when only one side carries inline bytes", () => {
    expect(
      queueEditContentMatches(
        imageDoc("look", HASH, true),
        imageDoc("look", HASH, false),
      ),
    ).toBe(true);
  });

  it("does not match different text", () => {
    expect(
      queueEditContentMatches(
        imageDoc("look", HASH, true),
        imageDoc("look again", HASH, true),
      ),
    ).toBe(false);
  });
});

describe("queueItemsInFlight", () => {
  function pending(
    clientActionId: string,
    action: PendingChatAction["action"],
    queueItemId: string | null,
  ): PendingChatAction {
    return {
      clientActionId,
      action,
      queueItemId,
      checkpointId: null,
      revertArtifacts: null,
      interviewBlockId: null,
      interviewDeliveryRetry: null,
      messageId: null,
      restore: null,
      sentContentHashes: null,
      sender: null,
      settings: null,
      accountContext: null,
      sentFromHostId: null,
      deliveryPolicy: null,
      restoreWorktreeIntent: null,
      displayWorktreeIntent: null,
      messageConfirmedByHost: false,
      hashOnlyRetry: false,
      wireContent: null,
      createdAt: 0,
      connectionEpoch: 0,
    };
  }

  function mapOf(
    entries: ReadonlyArray<PendingChatAction>,
  ): Record<string, PendingChatAction> {
    return Object.fromEntries(
      entries.map((entry) => [entry.clientActionId, entry]),
    );
  }

  it("maps each mutation kind to its stage, one row each", () => {
    const inFlight = queueItemsInFlight(
      mapOf([
        pending("a1", "queueEdit", "row-edit"),
        pending("a2", "queueSettingsUpdate", "row-settings"),
        pending("a3", "queueReorder", "row-reorder"),
        pending("a4", "queueSteerNow", "row-steer"),
        pending("a5", "queueCancel", "row-cancel"),
        pending("a6", "queueAbortSteer", "row-abort"),
      ]),
    );
    expect(Object.fromEntries(inFlight)).toEqual({
      "row-edit": "saving",
      "row-settings": "saving",
      "row-reorder": "saving",
      "row-steer": "requesting_steer",
      "row-cancel": "cancelling",
      "row-abort": "cancelling",
    });
  });

  it("reports a save-and-steer pair on one row as requesting_steer whichever order they were dispatched in", () => {
    const editFirst = queueItemsInFlight(
      mapOf([
        pending("a1", "queueEdit", "row"),
        pending("a2", "queueSteerNow", "row"),
      ]),
    );
    const steerFirst = queueItemsInFlight(
      mapOf([
        pending("a2", "queueSteerNow", "row"),
        pending("a1", "queueEdit", "row"),
      ]),
    );
    expect(editFirst.get("row")).toBe("requesting_steer");
    expect(steerFirst.get("row")).toBe("requesting_steer");
  });

  it("contributes nothing for an action with a null queueItemId", () => {
    const inFlight = queueItemsInFlight(
      mapOf([
        pending("a1", "queueEdit", null),
        pending("a2", "queueEdit", "row"),
      ]),
    );
    // The sibling with an id proves the scan ran; only it appears.
    expect([...inFlight.keys()]).toEqual(["row"]);
  });
});
