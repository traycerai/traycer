import { describe, expect, it } from "vitest";
import {
  chatEventSchema,
  queuedPreparationFailureFromEventMetadata,
  queuedPreparationFailureMetadataSchema,
} from "@traycer/protocol/persistence/epic/chat-events";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** The bag the host writes, `notificationAnchor` marker included. */
function writtenMetadata(): Record<string, unknown> {
  return {
    code: "MISSING_ATTACHMENT_BYTES",
    queueItemId: "queue-item-1",
    messageId: "message-1",
    missingHashes: [HASH_A, HASH_B],
    notificationAnchor: true,
  };
}

describe("queuedPreparationFailureFromEventMetadata - present", () => {
  it("parses the bag the host writes", () => {
    expect(
      queuedPreparationFailureFromEventMetadata(writtenMetadata()),
    ).toEqual({
      code: "MISSING_ATTACHMENT_BYTES",
      queueItemId: "queue-item-1",
      messageId: "message-1",
      missingHashes: [HASH_A, HASH_B],
    });
  });

  it("strips notificationAnchor rather than rejecting it", () => {
    // The GUI's inline error row anchors on that marker, so the host keeps
    // writing it. A `.strict()` schema here would reject the whole bag over a
    // key that is none of this contract's business.
    const parsed = queuedPreparationFailureFromEventMetadata(writtenMetadata());
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("notificationAnchor");
  });

  it("accepts an empty missingHashes - a preparation code that names none", () => {
    // The writer supplies `[]` for such a code, which is what keeps `null`
    // meaning only "not a queued preparation failure, or malformed". If this
    // returned null, every non-attachment preparation failure would be
    // indistinguishable from a malformed bag.
    expect(
      queuedPreparationFailureFromEventMetadata({
        code: "WORKTREE_SETUP_FAILED",
        queueItemId: "queue-item-1",
        messageId: "message-1",
        missingHashes: [],
      }),
    ).toEqual({
      code: "WORKTREE_SETUP_FAILED",
      queueItemId: "queue-item-1",
      messageId: "message-1",
      missingHashes: [],
    });
  });

  it("accepts any code string - the contract must not recognise only its newest member", () => {
    const parsed = queuedPreparationFailureFromEventMetadata({
      ...writtenMetadata(),
      code: "SOME_FUTURE_CODE",
    });
    expect(parsed?.code).toBe("SOME_FUTURE_CODE");
  });
});

describe("queuedPreparationFailureFromEventMetadata - absent", () => {
  it("returns null for a null bag", () => {
    expect(queuedPreparationFailureFromEventMetadata(null)).toBeNull();
  });

  it("returns null for an empty bag", () => {
    expect(queuedPreparationFailureFromEventMetadata({})).toBeNull();
  });

  it("returns null for the pre-contract bag an older host writes", () => {
    // Exactly what `reportQueuedPromptSendFailure` wrote before this contract:
    // a code and the anchor marker, no ids and no hashes.
    expect(
      queuedPreparationFailureFromEventMetadata({
        code: "MISSING_ATTACHMENT_BYTES",
        notificationAnchor: true,
      }),
    ).toBeNull();
  });
});

describe("queuedPreparationFailureFromEventMetadata - malformed", () => {
  it.each([
    ["an uppercase hex hash", { missingHashes: ["A".repeat(64)] }],
    ["a short hash", { missingHashes: ["ab"] }],
    ["a non-string hash", { missingHashes: [1] }],
    ["missingHashes not an array", { missingHashes: HASH_A }],
    ["an empty code", { code: "" }],
    ["an empty queueItemId", { queueItemId: "" }],
    ["an empty messageId", { messageId: "" }],
    ["a non-string queueItemId", { queueItemId: 7 }],
  ])("returns null for %s", (_label, override) => {
    expect(
      queuedPreparationFailureFromEventMetadata({
        ...writtenMetadata(),
        ...override,
      }),
    ).toBeNull();
  });

  it("never throws on a hostile bag", () => {
    expect(() =>
      queuedPreparationFailureFromEventMetadata({
        code: { nested: true },
        queueItemId: [],
        messageId: null,
        missingHashes: { not: "an array" },
      }),
    ).not.toThrow();
  });
});

describe("chatEventSchema.metadata still admits the shape", () => {
  it("a send.failed event carrying the bag parses, and round-trips through the parser", () => {
    // The half a parser test cannot see on its own: this contract is only
    // reachable if the EVENT schema still admits the bag. `metadata` is
    // `z.record(z.string(), z.unknown()).nullable()`, so it does - but that is
    // the fact the whole design rests on, and it belongs in a test rather than
    // in a reader's assumption.
    const event = chatEventSchema.parse({
      eventId: "event-1",
      type: "send.failed",
      timestamp: 1000,
      clientActionId: null,
      actor: { type: "user", userId: "user-1" },
      message: "Could not find the uploaded image.",
      turnId: null,
      messageId: "message-1",
      queueItemId: "queue-item-1",
      approvalId: null,
      blockId: null,
      severity: "warning",
      metadata: writtenMetadata(),
    });

    expect(event.metadata).not.toBeNull();
    const failure = queuedPreparationFailureFromEventMetadata(event.metadata);
    expect(failure?.missingHashes).toEqual([HASH_A, HASH_B]);
    expect(failure?.queueItemId).toBe(event.queueItemId);
  });

  it("parses even when the event's own messageId is null - they are different facts", () => {
    // NOT a duplicate of the top-level field, and this is the case that proves
    // it. A preparation that fails before the queued message is persisted
    // writes `messageId: null` on the EVENT - that field answers "is there a
    // message row to anchor to". The bag's `messageId` comes from the QUEUED
    // ITEM, which always has one. Had the bag simply mirrored the event, this
    // whole class of preparation failure would parse as `null` and be
    // invisible to the reader that has to act on it.
    const event = chatEventSchema.parse({
      eventId: "event-2",
      type: "send.failed",
      timestamp: 1000,
      clientActionId: null,
      actor: { type: "user", userId: "user-1" },
      message: "The selected model does not support image attachments.",
      turnId: null,
      messageId: null,
      queueItemId: "queue-item-1",
      approvalId: null,
      blockId: null,
      severity: "warning",
      metadata: {
        code: "UNSUPPORTED_IMAGES",
        queueItemId: "queue-item-1",
        messageId: "message-1",
        missingHashes: [],
        notificationAnchor: true,
      },
    });

    expect(event.messageId).toBeNull();
    const failure = queuedPreparationFailureFromEventMetadata(event.metadata);
    expect(failure).not.toBeNull();
    expect(failure?.messageId).toBe("message-1");
    expect(failure?.queueItemId).toBe(event.queueItemId);
  });
});

describe("the queued-membership invariant is the WRITER's, and unrecoverable here", () => {
  it("gives the SAME answer for the seeded drain and the headless probe, whose queueItemIds are identical", () => {
    // The `"initial:"` prefix is AMBIGUOUS BY CONSTRUCTION. It marks "this item
    // came from a create's initial message" - not "this item is synthetic" -
    // and the host mints it at two sites that mean opposite things:
    //
    //   `seedInitialQueueItem` (chat-session-manager.ts:55379) builds a durable
    //   `queue.added` op. That item IS hydrated into `queue.items` and drained
    //   by `startNextQueuedPrompt` - it is the seeded-create landing case this
    //   whole feature exists for, and it MUST carry the bag.
    //
    //   `startHeadlessTurnPrepared` (:14003) passes an inline literal straight
    //   into preparation. It is never appended and never enters the queue, so
    //   it pauses nothing and leaves no row, and it must NOT carry the bag.
    //
    // For the same `messageId` those two mint the byte-identical id, which is
    // what this case fixes: both bags below are the same object, so the two
    // parses cannot differ even in principle. No parser can separate them.
    // Queue MEMBERSHIP is the only discriminator, and the host checks it at the
    // append (`failQueuedPromptPreparation`), which is the only place that
    // knows.
    //
    // So do not "harden" this parser by filtering the prefix. The immediate
    // cost is not a someday-regression: filtering `"initial:"` here would
    // suppress the bag for the SEEDED DRAIN - the primary case - starting at
    // once, while leaving the probe exactly as broken as before.
    const seededDrain = queuedPreparationFailureFromEventMetadata({
      ...writtenMetadata(),
      queueItemId: "initial:message-1",
    });
    const headlessProbe = queuedPreparationFailureFromEventMetadata({
      ...writtenMetadata(),
      queueItemId: "initial:message-1",
    });

    expect(seededDrain).not.toBeNull();
    expect(seededDrain).toEqual(headlessProbe);
    expect(seededDrain?.queueItemId).toBe("initial:message-1");
  });
});

describe("queuedPreparationFailureMetadataSchema", () => {
  it("is the instance the parser uses", () => {
    expect(
      queuedPreparationFailureMetadataSchema.safeParse(writtenMetadata())
        .success,
    ).toBe(true);
  });
});
