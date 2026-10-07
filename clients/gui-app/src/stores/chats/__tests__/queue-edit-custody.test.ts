import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { AccountContext } from "@traycer/protocol/common/schemas";
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
  accountForQueueEdits,
  foldQueueEditAck,
  hasUnconfirmedQueueEdit,
  queueEditContentMatches,
  queueEditRecordsInCustody,
  queueItemsInFlight,
  withoutReturnedQueueEditsForRow,
  type QueueEditEvidence,
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

const PERSONAL: AccountContext = { type: "PERSONAL" };
const TEAM: AccountContext = { type: "TEAM", teamId: "team-1" };

function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** A paragraph of text followed by one image node per entry, in order. */
function imagesDoc(
  text: string,
  images: ReadonlyArray<{
    readonly hash: string | null;
    readonly inline: boolean;
  }>,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text },
          ...images.map((image, index): JsonContent => ({
            type: "imageAttachment",
            attrs: {
              id: `img-${index}`,
              fileName: "shot.png",
              mimeType: "image/png",
              size: 4,
              ...(image.hash === null ? {} : { hash: image.hash }),
              ...(image.inline ? { data: "AQIDBA==" } : {}),
            },
          })),
        ],
      },
    ],
  };
}

function hashedImages(...hashes: ReadonlyArray<string>): JsonContent {
  return imagesDoc(
    "look",
    hashes.map((hash) => ({ hash, inline: false })),
  );
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
    accountContext: PERSONAL,
    followUpIsNoOp: false,
    requestedChanges: [],
    editActionId: EDIT_ACTION_ID,
    followUpActionId: FOLLOW_UP_ACTION_ID,
    edit: "pending",
    followUp: "pending",
    followUpReason: null,
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
    accountContext: PERSONAL,
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

function rowHolding(
  content: JsonContent,
  overrides: Partial<ChatQueuedPromptItem>,
): ChatQueuedPromptItem {
  return row({
    message: { kind: "user", content, browserAnnotations: [] },
    ...overrides,
  });
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

function evidence(input: {
  readonly items: ReadonlyArray<ChatQueuedPromptItem>;
  readonly messages: ReadonlyArray<Message>;
}): QueueEditEvidence {
  return {
    queue: queueOf(input.items),
    messages: input.messages,
    settingsEqual: (a, b) => a.model === b.model,
    accountContextEqual: (a, b) =>
      a.type === b.type &&
      (a.type !== "TEAM" || b.type !== "TEAM" || a.teamId === b.teamId),
  };
}

const BOTH_SWEPT: ReadonlySet<string> = new Set([
  EDIT_ACTION_ID,
  FOLLOW_UP_ACTION_ID,
]);
const NONE_SWEPT: ReadonlySet<string> = new Set();

describe("foldQueueEditAck", () => {
  it("returns the edited content as a refusal, keeps the record for the pending follow-up, then settles nothing more when the follow-up is refused", () => {
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
        wireContent: EDITED,
        cause: "refused",
        hostReason: "The queued prompt is no longer pending.",
      },
    ]);
    expect(first.records[EDIT_ACTION_ID]?.contentReturned).toBe(true);
    expect(first.records[EDIT_ACTION_ID]?.edit).toBe("rejected");
    expect(first.records[EDIT_ACTION_ID]?.followUp).toBe("pending");

    const second = foldQueueEditAck(first.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "The queued prompt is no longer pending.",
    });
    expect(second.settlements).toEqual([]);
    expect(second.records).toEqual({});
  });

  it("settles a partial exactly once, with the submission and the host's reason, when the edit was accepted and the follow-up refused", () => {
    const afterEdit = foldQueueEditAck(recordsOf(record({}, "steer")), {
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
        restore: RESTORE,
        requestedChanges: [],
        refused: true,
        hostReason: "Steering is unavailable.",
      },
    ]);
    expect(afterFollowUp.records).toEqual({});
  });

  it("carries the record's requested changes onto the partial (finding 6, addendum)", () => {
    const accepted = foldQueueEditAck(
      recordsOf(record({ requestedChanges: ["model gpt-x"] }, "save")),
      { clientActionId: EDIT_ACTION_ID, status: "accepted", reason: null },
    );
    const fold = foldQueueEditAck(accepted.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "no",
    });
    expect(fold.settlements).toHaveLength(1);
    expect(fold.settlements[0]).toMatchObject({
      kind: "partial",
      requestedChanges: ["model gpt-x"],
    });
  });

  it("keeps a follow-up's refusal reason when it is answered BEFORE the edit's acceptance (finding 5e)", () => {
    const afterFollowUp = foldQueueEditAck(recordsOf(record({}, "save")), {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "Settings are locked.",
    });
    // Nothing to say yet: the text's own answer is still to come.
    expect(afterFollowUp.settlements).toEqual([]);
    expect(afterFollowUp.records[EDIT_ACTION_ID]?.followUp).toBe("rejected");
    expect(afterFollowUp.records[EDIT_ACTION_ID]?.followUpReason).toBe(
      "Settings are locked.",
    );

    const afterEdit = foldQueueEditAck(afterFollowUp.records, {
      clientActionId: EDIT_ACTION_ID,
      status: "accepted",
      reason: null,
    });
    expect(afterEdit.settlements).toEqual([
      {
        kind: "partial",
        clientActionId: FOLLOW_UP_ACTION_ID,
        intent: "save",
        restore: RESTORE,
        requestedChanges: [],
        refused: true,
        hostReason: "Settings are locked.",
      },
    ]);
    expect(afterEdit.records).toEqual({});
  });

  it("settles nothing and removes the record when both frames are accepted", () => {
    const afterEdit = foldQueueEditAck(recordsOf(record({}, "save")), {
      clientActionId: EDIT_ACTION_ID,
      status: "accepted",
      reason: null,
    });
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

describe("withoutReturnedQueueEditsForRow", () => {
  it("drops a returned record for the row", () => {
    const returned = record(
      { edit: "unconfirmed", contentReturned: true },
      "save",
    );
    const next = withoutReturnedQueueEditsForRow(
      recordsOf(returned),
      QUEUE_ITEM_ID,
    );
    expect(next).toEqual({});
  });

  it("keeps a record for the same row whose text is not returned", () => {
    const inCustody = record(
      { edit: "pending", contentReturned: false },
      "save",
    );
    const records = recordsOf(inCustody);
    const next = withoutReturnedQueueEditsForRow(records, QUEUE_ITEM_ID);
    expect(Object.keys(next)).toEqual([EDIT_ACTION_ID]);
    expect(next).toBe(records);
  });

  it("keeps a returned record for a different row and returns the same object when nothing is dropped", () => {
    const records = recordsOf(
      record(
        {
          queueItemId: "another-row",
          edit: "unconfirmed",
          contentReturned: true,
        },
        "save",
      ),
    );
    const next = withoutReturnedQueueEditsForRow(records, QUEUE_ITEM_ID);
    expect(Object.keys(next)).toEqual([EDIT_ACTION_ID]);
    expect(next).toBe(records);
  });
});

describe("a refused follow-up that asked for nothing (followUpIsNoOp)", () => {
  const NO_OP = { followUpIsNoOp: true } as const;

  it("lands whole, with no settlement on either ack, when the edit is accepted and the no-op follow-up refused", () => {
    const afterEdit = foldQueueEditAck(recordsOf(record(NO_OP, "save")), {
      clientActionId: EDIT_ACTION_ID,
      status: "accepted",
      reason: null,
    });
    // The edit alone does not finish the record (the path ran).
    expect(Object.keys(afterEdit.records)).toEqual([EDIT_ACTION_ID]);
    expect(afterEdit.settlements).toEqual([]);

    const afterFollowUp = foldQueueEditAck(afterEdit.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "The queued prompt is no longer pending.",
    });
    expect(afterFollowUp.settlements).toEqual([]);
    expect(afterFollowUp.records).toEqual({});
  });

  it("lands whole in the other order too: the no-op follow-up refused first, then the edit accepted", () => {
    const afterFollowUp = foldQueueEditAck(recordsOf(record(NO_OP, "save")), {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "The queued prompt is no longer pending.",
    });
    expect(Object.keys(afterFollowUp.records)).toEqual([EDIT_ACTION_ID]);
    expect(afterFollowUp.settlements).toEqual([]);

    const afterEdit = foldQueueEditAck(afterFollowUp.records, {
      clientActionId: EDIT_ACTION_ID,
      status: "accepted",
      reason: null,
    });
    expect(afterEdit.settlements).toEqual([]);
    expect(afterEdit.records).toEqual({});
  });

  it("control: the same sequence with followUpIsNoOp false emits one refused partial", () => {
    // Also pinned, in a steer variant, by "settles a partial exactly once…".
    const afterEdit = foldQueueEditAck(
      recordsOf(record({ followUpIsNoOp: false }, "save")),
      { clientActionId: EDIT_ACTION_ID, status: "accepted", reason: null },
    );
    const afterFollowUp = foldQueueEditAck(afterEdit.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "The queued prompt is no longer pending.",
    });
    expect(afterFollowUp.settlements).toHaveLength(1);
    expect(afterFollowUp.settlements[0]).toMatchObject({
      kind: "partial",
      refused: true,
    });
    expect(afterFollowUp.records).toEqual({});
  });

  it("returns the text once and nothing else when both frames of a no-op record are refused", () => {
    const afterEdit = foldQueueEditAck(recordsOf(record(NO_OP, "save")), {
      clientActionId: EDIT_ACTION_ID,
      status: "rejected",
      reason: "gone",
    });
    const afterFollowUp = foldQueueEditAck(afterEdit.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "gone",
    });
    const kinds = [...afterEdit.settlements, ...afterFollowUp.settlements].map(
      (entry) => entry.kind,
    );
    expect(kinds).toEqual(["content_returned"]);
    expect(afterFollowUp.records).toEqual({});
  });
});

describe("follow_up_alone (edit refused, follow-up applied)", () => {
  const CHANGES = ["model gpt-x"];
  const ALONE = {
    kind: "follow_up_alone",
    clientActionId: FOLLOW_UP_ACTION_ID,
    intent: "save",
    requestedChanges: CHANGES,
  };

  it("emits content_returned on the edit refusal and exactly one follow_up_alone on the follow-up's acceptance, then drops the record", () => {
    const first = foldQueueEditAck(
      recordsOf(record({ requestedChanges: CHANGES }, "save")),
      { clientActionId: EDIT_ACTION_ID, status: "rejected", reason: "gone" },
    );
    expect(first.settlements).toHaveLength(1);
    expect(first.settlements[0]).toMatchObject({ kind: "content_returned" });

    const second = foldQueueEditAck(first.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "accepted",
      reason: null,
    });
    expect(second.settlements).toEqual([ALONE]);
    expect(second.records).toEqual({});
  });

  it("emits both settlements on the second ack when the follow-up is accepted first", () => {
    const first = foldQueueEditAck(
      recordsOf(record({ requestedChanges: CHANGES }, "save")),
      {
        clientActionId: FOLLOW_UP_ACTION_ID,
        status: "accepted",
        reason: null,
      },
    );
    expect(first.settlements).toEqual([]);

    const second = foldQueueEditAck(first.records, {
      clientActionId: EDIT_ACTION_ID,
      status: "rejected",
      reason: "gone",
    });
    expect(second.settlements.map((entry) => entry.kind)).toEqual([
      "content_returned",
      "follow_up_alone",
    ]);
    expect(second.settlements[1]).toEqual(ALONE);
    expect(second.records).toEqual({});
  });

  it("emits no follow_up_alone when the follow-up was a no-op", () => {
    const first = foldQueueEditAck(
      recordsOf(record({ followUpIsNoOp: true }, "save")),
      { clientActionId: EDIT_ACTION_ID, status: "rejected", reason: "gone" },
    );
    const second = foldQueueEditAck(first.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "accepted",
      reason: null,
    });
    // The record was answered (it is gone) and said nothing more.
    expect(second.records).toEqual({});
    expect(second.settlements).toEqual([]);
  });

  it("emits no follow_up_alone when both frames are refused: one content_returned and nothing else", () => {
    const first = foldQueueEditAck(recordsOf(record({}, "save")), {
      clientActionId: EDIT_ACTION_ID,
      status: "rejected",
      reason: "gone",
    });
    const second = foldQueueEditAck(first.records, {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "gone",
    });
    expect(first.settlements).toHaveLength(1);
    expect(second.settlements).toEqual([]);
    expect(second.records).toEqual({});
  });
});

describe("second-frame evidence kept while the text is unknown", () => {
  const CHANGES = ["model gpt-5-mini"];
  const STEER_TAKEN = {
    status: "steer_requested",
    delivery: "same_turn",
    targetTurnId: "turn-1",
    steerRequest: {
      mode: "safe_point",
      targetTurnId: "turn-1",
      requestedAt: 1,
    },
  } as const;

  function firstPass(
    intent: QueueEditIntent,
    rowOverrides: Partial<ChatQueuedPromptItem>,
  ) {
    return accountForQueueEdits({
      records: recordsOf(
        record({ settings: OTHER_SETTINGS, requestedChanges: CHANGES }, intent),
      ),
      sweptActionIds: BOTH_SWEPT,
      evidence: evidence({
        items: [rowHolding(ORIGINAL, rowOverrides)],
        messages: [],
      }),
    });
  }

  function secondPass(
    records: QueueEditRecords,
    content: JsonContent,
    rowItems: ReadonlyArray<ChatQueuedPromptItem>,
  ) {
    return accountForQueueEdits({
      records,
      sweptActionIds: NONE_SWEPT,
      evidence: evidence({
        items: rowItems,
        messages:
          rowItems.length === 0 ? [userMessage(MESSAGE_ID, content)] : [],
      }),
    });
  }

  it("a: keeps followUp accepted on the retained record, then reports follow_up_alone when the message proves the text was not saved", () => {
    const first = firstPass("save", { settings: OTHER_SETTINGS });
    expect(first.settlements).toHaveLength(1);
    expect(first.settlements[0]).toMatchObject({
      kind: "content_returned",
      cause: "unconfirmed",
    });
    const kept = first.records[EDIT_ACTION_ID];
    expect(kept?.followUp).toBe("accepted");
    expect(kept?.edit).toBe("unconfirmed");
    expect(kept?.contentReturned).toBe(true);

    const second = secondPass(first.records, ORIGINAL, []);
    expect(second.settlements).toEqual([
      {
        kind: "follow_up_alone",
        clientActionId: FOLLOW_UP_ACTION_ID,
        intent: "save",
        requestedChanges: CHANGES,
      },
    ]);
    expect(second.records).toEqual({});
  });

  it("b: the same for a steer the host took", () => {
    const first = firstPass("steer", STEER_TAKEN);
    expect(first.records[EDIT_ACTION_ID]?.followUp).toBe("accepted");

    const second = secondPass(first.records, ORIGINAL, []);
    expect(second.settlements).toEqual([
      {
        kind: "follow_up_alone",
        clientActionId: FOLLOW_UP_ACTION_ID,
        intent: "steer",
        requestedChanges: CHANGES,
      },
    ]);
    expect(second.records).toEqual({});
  });

  it("c: control - settings that differ show nothing applied, so the follow-up stays unconfirmed and no follow_up_alone is emitted", () => {
    const first = firstPass("save", { settings: SETTINGS });
    expect(first.records[EDIT_ACTION_ID]?.followUp).toBe("unconfirmed");

    const second = secondPass(first.records, ORIGINAL, []);
    expect(second.settlements).toEqual([]);
    expect(second.records).toEqual({});
  });

  it("d: the saved-after-all path is undisturbed - the edited row gives one saved_after_return with followUpApplied", () => {
    const first = firstPass("save", { settings: OTHER_SETTINGS });
    const second = secondPass(first.records, EDITED, [
      rowHolding(EDITED, { settings: OTHER_SETTINGS }),
    ]);
    expect(second.settlements).toEqual([
      {
        kind: "saved_after_return",
        clientActionId: FOLLOW_UP_ACTION_ID,
        intent: "save",
        followUpApplied: true,
        followUpRefused: false,
        hostReason: null,
      },
    ]);
    expect(second.records).toEqual({});
  });
});

describe("a sent document that cannot be compared (inlined image, no hash)", () => {
  function editedWithImage(
    attrs: Readonly<Record<string, string | number>>,
  ): JsonContent {
    return {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "edited text" },
            { type: "imageAttachment", attrs },
          ],
        },
      ],
    };
  }

  function sweepWithOriginalMessage(wireContent: JsonContent) {
    return accountForQueueEdits({
      records: recordsOf(record({ wireContent }, "save")),
      sweptActionIds: BOTH_SWEPT,
      evidence: evidence({
        items: [],
        messages: [userMessage(MESSAGE_ID, ORIGINAL)],
      }),
    });
  }

  it("reads an unhashed (inlined) image document against a differing message as unconfirmed, and retains the record", () => {
    // Built as production inlines it: `b64content` and no `hash` key at all.
    const fold = sweepWithOriginalMessage(
      editedWithImage({
        id: "img-1",
        fileName: "shot.png",
        mimeType: "image/png",
        size: 4,
        b64content: "AQIDBA==",
      }),
    );
    expect(fold.settlements).toHaveLength(1);
    expect(fold.settlements[0]).toMatchObject({
      kind: "content_returned",
      cause: "unconfirmed",
    });
    const kept = fold.records[EDIT_ACTION_ID];
    expect(kept?.edit).toBe("unconfirmed");
    expect(kept?.contentReturned).toBe(true);
  });

  it("control: the same evidence against a hashed-image document is not_applied and drops the record", () => {
    const fold = sweepWithOriginalMessage(
      editedWithImage({
        id: "img-1",
        fileName: "shot.png",
        mimeType: "image/png",
        size: 4,
        hash: HASH_A,
      }),
    );
    expect(fold.settlements).toHaveLength(1);
    expect(fold.settlements[0]).toMatchObject({
      kind: "content_returned",
      cause: "not_applied",
    });
    expect(fold.records).toEqual({});
  });
});

describe("a message that cannot be compared on either side", () => {
  it("reads a hashed sent document against a message carrying an unhashed image as unconfirmed, and retains the record", () => {
    const messageWithInlinedImage: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "something else entirely" },
            {
              type: "imageAttachment",
              attrs: {
                id: "img-1",
                fileName: "shot.png",
                mimeType: "image/png",
                size: 4,
                b64content: "AQIDBA==",
              },
            },
          ],
        },
      ],
    };
    const fold = accountForQueueEdits({
      records: recordsOf(record({ wireContent: hashedImages(HASH_A) }, "save")),
      sweptActionIds: BOTH_SWEPT,
      evidence: evidence({
        items: [],
        messages: [userMessage(MESSAGE_ID, messageWithInlinedImage)],
      }),
    });
    expect(fold.settlements).toHaveLength(1);
    expect(fold.settlements[0]).toMatchObject({
      kind: "content_returned",
      cause: "unconfirmed",
    });
    expect(fold.records[EDIT_ACTION_ID]?.edit).toBe("unconfirmed");
    expect(fold.records[EDIT_ACTION_ID]?.contentReturned).toBe(true);
  });
});

describe("saved after return with a follow-up the host refused", () => {
  it("carries the refusal and its reason when the follow-up was refused before the edit became unconfirmed", () => {
    const refused = foldQueueEditAck(recordsOf(record({}, "save")), {
      clientActionId: FOLLOW_UP_ACTION_ID,
      status: "rejected",
      reason: "The queued prompt is already being submitted.",
    });
    expect(refused.settlements).toEqual([]);

    const handedBack = accountForQueueEdits({
      records: refused.records,
      sweptActionIds: new Set([EDIT_ACTION_ID]),
      evidence: evidence({ items: [row({})], messages: [] }),
    });
    expect(handedBack.settlements).toHaveLength(1);
    expect(handedBack.settlements[0]).toMatchObject({
      kind: "content_returned",
      cause: "unconfirmed",
    });
    const kept = handedBack.records[EDIT_ACTION_ID];
    expect(kept?.followUp).toBe("rejected");
    expect(kept?.edit).toBe("unconfirmed");

    const saved = accountForQueueEdits({
      records: handedBack.records,
      sweptActionIds: NONE_SWEPT,
      evidence: evidence({ items: [rowHolding(EDITED, {})], messages: [] }),
    });
    expect(saved.settlements).toEqual([
      {
        kind: "saved_after_return",
        clientActionId: FOLLOW_UP_ACTION_ID,
        intent: "save",
        followUpApplied: false,
        followUpRefused: true,
        hostReason: "The queued prompt is already being submitted.",
      },
    ]);
    expect(saved.records).toEqual({});
  });
});

describe("queue-edit record predicates", () => {
  it("queueEditRecordsInCustody names every record whose text has not been handed back, including saved text with a pending follow-up, and not a returned one", () => {
    const pending = record({ editActionId: "pending" }, "save");
    const returned = record(
      { editActionId: "returned", edit: "unconfirmed", contentReturned: true },
      "save",
    );
    const savedAwaitingFollowUp = record(
      { editActionId: "saved", edit: "accepted", followUp: "pending" },
      "save",
    );
    const holding = queueEditRecordsInCustody({
      pending,
      returned,
      saved: savedAwaitingFollowUp,
    });
    expect(holding.map((entry) => entry.editActionId).sort()).toEqual([
      "pending",
      "saved",
    ]);
  });

  it("hasUnconfirmedQueueEdit is true only for a record with an unconfirmed frame", () => {
    expect(
      hasUnconfirmedQueueEdit(
        recordsOf(record({ edit: "unconfirmed" }, "save")),
      ),
    ).toBe(true);
    expect(
      hasUnconfirmedQueueEdit(
        recordsOf(record({ followUp: "unconfirmed" }, "save")),
      ),
    ).toBe(true);
    expect(hasUnconfirmedQueueEdit(recordsOf(record({}, "save")))).toBe(false);
  });
});

describe("accountForQueueEdits", () => {
  it("leaves a record whose ids were not swept untouched even though its row is absent", () => {
    const records = recordsOf(record({}, "save"));
    const fold = accountForQueueEdits({
      records,
      sweptActionIds: new Set(["some-other-action"]),
      evidence: evidence({ items: [], messages: [] }),
    });
    expect(fold.records).toBe(records);
    expect(fold.settlements).toEqual([]);
  });

  it("settles nothing, and drops the record, when the swept row carries the edited text and the follow-up is a no-op", () => {
    const fold = accountForQueueEdits({
      records: recordsOf(record({ followUpIsNoOp: true }, "save")),
      sweptActionIds: BOTH_SWEPT,
      evidence: evidence({
        items: [rowHolding(EDITED, {})],
        messages: [],
      }),
    });
    expect(fold.settlements).toEqual([]);
    expect(fold.records).toEqual({});
  });

  it("returns the text as unconfirmed, and RETAINS the record, when a swept row still holds the original (finding 2)", () => {
    const fold = accountForQueueEdits({
      records: recordsOf(record({}, "save")),
      sweptActionIds: BOTH_SWEPT,
      evidence: evidence({
        items: [row({})],
        messages: [],
      }),
    });
    expect(fold.settlements).toEqual([
      {
        kind: "content_returned",
        clientActionId: EDIT_ACTION_ID,
        restore: RESTORE,
        wireContent: EDITED,
        cause: "unconfirmed",
        hostReason: null,
      },
    ]);
    const kept = fold.records[EDIT_ACTION_ID];
    expect(kept?.edit).toBe("unconfirmed");
    expect(kept?.contentReturned).toBe(true);
  });

  it("settles saved_after_return exactly once when a later review finds the edited text on the row, and drops the record", () => {
    const first = accountForQueueEdits({
      records: recordsOf(record({ followUpIsNoOp: true }, "save")),
      sweptActionIds: BOTH_SWEPT,
      evidence: evidence({
        items: [row({})],
        messages: [],
      }),
    });
    expect(first.settlements).toHaveLength(1);

    const review = accountForQueueEdits({
      records: first.records,
      sweptActionIds: NONE_SWEPT,
      evidence: evidence({
        items: [rowHolding(EDITED, {})],
        messages: [],
      }),
    });
    expect(review.settlements).toEqual([
      {
        kind: "saved_after_return",
        clientActionId: FOLLOW_UP_ACTION_ID,
        intent: "save",
        followUpApplied: true,
        followUpRefused: false,
        hostReason: null,
      },
    ]);
    expect(review.records).toEqual({});

    // A further review has nothing left to say.
    const again = accountForQueueEdits({
      records: review.records,
      sweptActionIds: NONE_SWEPT,
      evidence: evidence({
        items: [rowHolding(EDITED, {})],
        messages: [],
      }),
    });
    expect(again.settlements).toEqual([]);
  });

  describe("a transcript body this client has not loaded (finding 3)", () => {
    it("reads an absent message on an row that is gone as unknown: hand-back as unconfirmed, record retained", () => {
      const fold = accountForQueueEdits({
        records: recordsOf(record({}, "save")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [],
          messages: [],
        }),
      });
      expect(fold.settlements).toHaveLength(1);
      expect(fold.settlements[0]).toMatchObject({
        kind: "content_returned",
        cause: "unconfirmed",
        hostReason: null,
      });
      expect(fold.records[EDIT_ACTION_ID]?.edit).toBe("unconfirmed");
      expect(fold.records[EDIT_ACTION_ID]?.contentReturned).toBe(true);
    });

    it("then reads the hydrated message: edited document -> saved_after_return", () => {
      const first = accountForQueueEdits({
        records: recordsOf(record({}, "save")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [],
          messages: [],
        }),
      });
      const review = accountForQueueEdits({
        records: first.records,
        sweptActionIds: NONE_SWEPT,
        evidence: evidence({
          items: [],
          messages: [userMessage(MESSAGE_ID, EDITED)],
        }),
      });
      expect(review.settlements).toEqual([
        {
          kind: "saved_after_return",
          clientActionId: FOLLOW_UP_ACTION_ID,
          intent: "save",
          // The row is gone and the follow-up was not a no-op: nothing shows it.
          followUpApplied: false,
          followUpRefused: false,
          hostReason: null,
        },
      ]);
      expect(review.records).toEqual({});
    });

    it("or the hydrated message holding the ORIGINAL -> record dropped, no further settlement", () => {
      const first = accountForQueueEdits({
        records: recordsOf(record({}, "save")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [],
          messages: [],
        }),
      });
      expect(Object.keys(first.records)).toEqual([EDIT_ACTION_ID]);
      const review = accountForQueueEdits({
        records: first.records,
        sweptActionIds: NONE_SWEPT,
        evidence: evidence({
          items: [],
          messages: [userMessage(MESSAGE_ID, ORIGINAL)],
        }),
      });
      expect(review.settlements).toEqual([]);
      expect(review.records).toEqual({});
    });

    it("never reads an absent message as an answer: a message for another id leaves the verdict unknown and the record retained", () => {
      const fold = accountForQueueEdits({
        records: recordsOf(record({}, "save")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [],
          messages: [userMessage("a-different-message", EDITED)],
        }),
      });
      expect(fold.settlements).toHaveLength(1);
      expect(fold.settlements[0]).toMatchObject({
        kind: "content_returned",
        cause: "unconfirmed",
      });
      expect(fold.records[EDIT_ACTION_ID]?.edit).toBe("unconfirmed");
      expect(fold.records[EDIT_ACTION_ID]?.contentReturned).toBe(true);
    });

    it("reads not_applied only from a message for the record's id that holds something else", () => {
      const fold = accountForQueueEdits({
        records: recordsOf(record({}, "save")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [],
          messages: [userMessage(MESSAGE_ID, ORIGINAL)],
        }),
      });
      expect(fold.settlements).toEqual([
        {
          kind: "content_returned",
          clientActionId: EDIT_ACTION_ID,
          restore: RESTORE,
          wireContent: EDITED,
          cause: "not_applied",
          hostReason: null,
        },
      ]);
      expect(fold.records).toEqual({});
    });
  });

  describe("follow-up evidence (finding 5)", () => {
    it("5a: an edit confirmed by the transcript with the row gone, and a follow-up that changed settings, is a partial and never a silent acceptance", () => {
      const fold = accountForQueueEdits({
        records: recordsOf(
          record({ settings: OTHER_SETTINGS, followUpIsNoOp: false }, "save"),
        ),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [],
          messages: [userMessage(MESSAGE_ID, EDITED)],
        }),
      });
      expect(fold.settlements).toEqual([
        {
          kind: "partial",
          clientActionId: FOLLOW_UP_ACTION_ID,
          intent: "save",
          restore: RESTORE,
          requestedChanges: [],
          refused: false,
          hostReason: null,
        },
      ]);
      expect(fold.records).toEqual({});
    });

    it("5b: a steer is not read as applied from a paused row, and is from a row the host has taken", () => {
      const paused = accountForQueueEdits({
        records: recordsOf(record({}, "steer")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [rowHolding(EDITED, { status: "paused" })],
          messages: [],
        }),
      });
      expect(paused.settlements).toHaveLength(1);
      expect(paused.settlements[0]).toMatchObject({
        kind: "partial",
        intent: "steer",
        refused: false,
      });

      const taken = accountForQueueEdits({
        records: recordsOf(record({}, "steer")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [
            rowHolding(EDITED, {
              status: "steer_requested",
              delivery: "same_turn",
              targetTurnId: "turn-1",
              steerRequest: {
                mode: "safe_point",
                targetTurnId: "turn-1",
                requestedAt: 1,
              },
            }),
          ],
          messages: [],
        }),
      });
      expect(taken.settlements).toEqual([]);
      expect(taken.records).toEqual({});
    });

    it("5c: matching settings with a DIFFERENT account context are not applied; the same account is", () => {
      const differentAccount = accountForQueueEdits({
        records: recordsOf(record({ accountContext: PERSONAL }, "save")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [rowHolding(EDITED, { accountContext: TEAM })],
          messages: [],
        }),
      });
      expect(differentAccount.settlements).toHaveLength(1);
      expect(differentAccount.settlements[0]).toMatchObject({
        kind: "partial",
        refused: false,
      });

      const sameAccount = accountForQueueEdits({
        records: recordsOf(record({ accountContext: PERSONAL }, "save")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [rowHolding(EDITED, { accountContext: PERSONAL })],
          messages: [],
        }),
      });
      expect(sameAccount.settlements).toEqual([]);
      expect(sameAccount.records).toEqual({});
    });

    it("5d: a no-op follow-up settles silently once the edit is confirmed, even with the row gone", () => {
      const fold = accountForQueueEdits({
        records: recordsOf(record({ followUpIsNoOp: true }, "save")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [],
          messages: [userMessage(MESSAGE_ID, EDITED)],
        }),
      });
      expect(fold.settlements).toEqual([]);
      expect(fold.records).toEqual({});
    });
  });

  describe("a stale no-op flag (round 4)", () => {
    it("does not honour followUpIsNoOp before the row is read: edited text with DIFFERENT settings is a partial", () => {
      const fold = accountForQueueEdits({
        records: recordsOf(record({ followUpIsNoOp: true }, "save")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [rowHolding(EDITED, { settings: OTHER_SETTINGS })],
          messages: [],
        }),
      });
      expect(fold.settlements).toEqual([
        {
          kind: "partial",
          clientActionId: FOLLOW_UP_ACTION_ID,
          intent: "save",
          restore: RESTORE,
          requestedChanges: [],
          refused: false,
          hostReason: null,
        },
      ]);
      expect(fold.records).toEqual({});
    });

    it("control: the same record with the row's settings equal to the record's settles silently", () => {
      const fold = accountForQueueEdits({
        records: recordsOf(record({ followUpIsNoOp: true }, "save")),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [rowHolding(EDITED, { settings: SETTINGS })],
          messages: [],
        }),
      });
      expect(fold.settlements).toEqual([]);
      expect(fold.records).toEqual({});
    });
  });

  describe("attachment order (finding 4)", () => {
    it("does not read a swept edit that only reorders images as accepted when the row still shows the old order", () => {
      const sent = hashedImages(HASH_B, HASH_A);
      const held = hashedImages(HASH_A, HASH_B);
      const fold = accountForQueueEdits({
        records: recordsOf(
          record({ wireContent: sent, followUpIsNoOp: true }, "save"),
        ),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [rowHolding(held, {})],
          messages: [],
        }),
      });
      expect(fold.settlements).toHaveLength(1);
      expect(fold.settlements[0]).toMatchObject({
        kind: "content_returned",
        cause: "unconfirmed",
      });
      expect(fold.records[EDIT_ACTION_ID]?.edit).toBe("unconfirmed");

      // The control: the same record against the SAME order is accepted.
      const matched = accountForQueueEdits({
        records: recordsOf(
          record({ wireContent: sent, followUpIsNoOp: true }, "save"),
        ),
        sweptActionIds: BOTH_SWEPT,
        evidence: evidence({
          items: [rowHolding(sent, {})],
          messages: [],
        }),
      });
      expect(matched.settlements).toEqual([]);
      expect(matched.records).toEqual({});
    });
  });
});

describe("queueEditContentMatches", () => {
  it("is false for the same text with images A,B against B,A", () => {
    expect(
      queueEditContentMatches(
        hashedImages(HASH_A, HASH_B),
        hashedImages(HASH_B, HASH_A),
      ),
    ).toBe(false);
    // The control: identical order matches, so the line above is about order.
    expect(
      queueEditContentMatches(
        hashedImages(HASH_A, HASH_B),
        hashedImages(HASH_A, HASH_B),
      ),
    ).toBe(true);
  });

  it("is false for one image against the same image twice", () => {
    expect(
      queueEditContentMatches(
        hashedImages(HASH_A),
        hashedImages(HASH_A, HASH_A),
      ),
    ).toBe(false);
  });

  it("is true when the only difference is inline bytes against hash-only for the same hash in the same position", () => {
    expect(
      queueEditContentMatches(
        imagesDoc("look", [{ hash: HASH_A, inline: true }]),
        imagesDoc("look", [{ hash: HASH_A, inline: false }]),
      ),
    ).toBe(true);
    expect(
      queueEditContentMatches(
        imagesDoc("look", [{ hash: HASH_A, inline: true }]),
        imagesDoc("look again", [{ hash: HASH_A, inline: false }]),
      ),
    ).toBe(false);
  });

  it("is false when either side has an image with no hash, even for identical documents", () => {
    const unhashed = imagesDoc("look", [{ hash: null, inline: true }]);
    expect(queueEditContentMatches(unhashed, unhashed)).toBe(false);
    expect(queueEditContentMatches(unhashed, hashedImages(HASH_A))).toBe(false);
    expect(queueEditContentMatches(hashedImages(HASH_A), unhashed)).toBe(false);
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
