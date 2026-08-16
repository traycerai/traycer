import { describe, expect, it } from "vitest";
import {
  INBOX_MAX_ACK_BATCH_SIZE,
  INBOX_MAX_DELIVERY_ATTEMPTS,
  inboxMessageRowSchema,
  simulateAckFlow,
  simulateDeliveryAttempt,
  simulateSubscribeDrain,
  type InboxMessageRow,
} from "@traycer/protocol/host/agent/inbox-spec";

/**
 * Reference tests for the durable inbox wire-format specification (Task 5,
 * Phase 0). They pin the canonical `InboxMessageRow` schema and the delivery
 * semantics a host must match: at-least-once replay for `@1.2`+ monitors,
 * dead-lettering after `INBOX_MAX_DELIVERY_ATTEMPTS`, expiry without counting
 * an attempt, oldest-first drain, and ack-by-`eventId` retirement.
 */

function makeRow(overrides: Partial<InboxMessageRow>): InboxMessageRow {
  return {
    eventId: "event-1",
    agentId: "agent-1",
    epicId: "epic-1",
    fromAgentId: "agent-2",
    prompt: "hello",
    responseId: "thread-1",
    expectReply: true,
    senderTitle: "Agent Two",
    senderHarnessId: "claude",
    enqueuedAt: 1_000,
    deliveryCount: 0,
    lastDeliveredAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("InboxMessageRow reference schema", () => {
  it("parses a fully-populated row with all documented columns", () => {
    const row = makeRow({});
    const parsed = inboxMessageRowSchema.parse(row);
    expect(parsed).toEqual(row);
    expect(parsed.deliveryCount).toBe(0);
    expect(parsed.enqueuedAt).toBeTypeOf("number");
    expect(parsed.expectReply).toBe(true);
  });

  it("accepts null for every nullable column and a reply-free message", () => {
    const row = makeRow({
      responseId: null,
      senderTitle: null,
      senderHarnessId: null,
      lastDeliveredAt: null,
      expiresAt: null,
      expectReply: false,
    });
    expect(inboxMessageRowSchema.parse(row)).toEqual(row);
  });

  it("rejects rows missing required columns", () => {
    const row = makeRow({});
    for (const key of [
      "eventId",
      "agentId",
      "epicId",
      "fromAgentId",
      "prompt",
      "expectReply",
      "enqueuedAt",
      "deliveryCount",
    ] as const) {
      const { [key]: _omitted, ...without } = row;
      expect(inboxMessageRowSchema.safeParse(without).success).toBe(false);
    }
  });

  it("rejects non-integer epoch fields and negative delivery counts", () => {
    expect(
      inboxMessageRowSchema.safeParse(makeRow({ enqueuedAt: 1.5 })).success,
    ).toBe(false);
    expect(
      inboxMessageRowSchema.safeParse(makeRow({ lastDeliveredAt: 1.5 }))
        .success,
    ).toBe(false);
    expect(
      inboxMessageRowSchema.safeParse(makeRow({ deliveryCount: -1 })).success,
    ).toBe(false);
  });

  it("pins the contract constants the wire layer depends on", () => {
    // agentInboxAckRequestSchema caps eventIds at 500; the spec constant is
    // that same cap, so a future schema change cannot drift from the spec.
    expect(INBOX_MAX_ACK_BATCH_SIZE).toBe(500);
    expect(INBOX_MAX_DELIVERY_ATTEMPTS).toBe(5);
  });
});

describe("simulateSubscribeDrain — replay on subscribe", () => {
  it("drains unacknowledged rows oldest-first by enqueuedAt", () => {
    const rows = [
      makeRow({ eventId: "e-newer", enqueuedAt: 3_000 }),
      makeRow({ eventId: "e-older", enqueuedAt: 1_000 }),
      makeRow({ eventId: "e-middle", enqueuedAt: 2_000 }),
    ];
    const { deliverable } = simulateSubscribeDrain(rows, 9_999);
    expect(deliverable.map((row) => row.eventId)).toEqual([
      "e-older",
      "e-middle",
      "e-newer",
    ]);
  });

  it("skips dead-lettered rows (deliveryCount >= 5) but retains them for audit", () => {
    const active = makeRow({ eventId: "e-active" });
    const dead = makeRow({
      eventId: "e-dead",
      deliveryCount: INBOX_MAX_DELIVERY_ATTEMPTS,
    });
    const { deliverable, deadLetter } = simulateSubscribeDrain(
      [dead, active],
      9_999,
    );
    expect(deliverable.map((row) => row.eventId)).toEqual(["e-active"]);
    expect(deadLetter.map((row) => row.eventId)).toEqual(["e-dead"]);
  });

  it("skips expired rows without counting a delivery attempt", () => {
    const expired = makeRow({
      eventId: "e-expired",
      expiresAt: 500,
      deliveryCount: 2,
    });
    const live = makeRow({ eventId: "e-live", expiresAt: 2_000 });
    const { deliverable, expired: expiredRows } = simulateSubscribeDrain(
      [expired, live],
      1_000,
    );
    expect(deliverable.map((row) => row.eventId)).toEqual(["e-live"]);
    expect(expiredRows).toEqual([expired]);
    // Skipped, not counted: the row's deliveryCount is untouched and the
    // drain does not report it as delivered.
    expect(expiredRows[0]?.deliveryCount).toBe(2);
  });

  it("treats expiresAt === null as no TTL and expiresAt === now as still live", () => {
    const noTtl = makeRow({ eventId: "e-no-ttl", expiresAt: null });
    const atBoundary = makeRow({
      eventId: "e-boundary",
      expiresAt: 1_000,
    });
    const { deliverable, expired } = simulateSubscribeDrain(
      [noTtl, atBoundary],
      1_000,
    );
    expect(deliverable.map((row) => row.eventId)).toEqual([
      "e-no-ttl",
      "e-boundary",
    ]);
    expect(expired).toEqual([]);
  });

  it("dead-letter wins over expiry: a dead-lettered row stays in the audit bucket", () => {
    const deadAndExpired = makeRow({
      eventId: "e-dead-expired",
      deliveryCount: INBOX_MAX_DELIVERY_ATTEMPTS,
      expiresAt: 100,
    });
    const { deliverable, deadLetter, expired } = simulateSubscribeDrain(
      [deadAndExpired],
      1_000,
    );
    expect(deliverable).toEqual([]);
    expect(deadLetter).toEqual([deadAndExpired]);
    expect(expired).toEqual([]);
  });
});

describe("simulateDeliveryAttempt — count incrementing and dead-lettering", () => {
  it("increments deliveryCount and stamps lastDeliveredAt without mutating input", () => {
    const before = makeRow({ eventId: "e-1" });

    const { rows, delivered } = simulateDeliveryAttempt(
      [before],
      ["e-1"],
      2_000,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.deliveryCount).toBe(1);
    expect(rows[0]?.lastDeliveredAt).toBe(2_000);
    expect(delivered.map((item) => item.eventId)).toEqual(["e-1"]);
    // Pure: the input row is unchanged.
    expect(before.deliveryCount).toBe(0);
    expect(before.lastDeliveredAt).toBeNull();
  });

  it("leaves non-target rows untouched and ignores unknown eventIds", () => {
    const target = makeRow({ eventId: "e-target", deliveryCount: 1 });
    const other = makeRow({ eventId: "e-other", deliveryCount: 3 });
    const { rows, delivered } = simulateDeliveryAttempt(
      [target, other],
      ["e-target", "e-unknown"],
      2_000,
    );
    expect(rows.find((item) => item.eventId === "e-other")?.deliveryCount).toBe(
      3,
    );
    expect(delivered.map((item) => item.eventId)).toEqual(["e-target"]);
  });

  it("dead-letters a row on the 5th delivery attempt (count 4 -> 5)", () => {
    let state = [makeRow({ eventId: "e-1", deliveryCount: 3 })];
    const deliveredCounts: number[] = [];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = simulateDeliveryAttempt(state, ["e-1"], 1_000 + attempt);
      state = result.rows;
      deliveredCounts.push(result.delivered[0]?.deliveryCount ?? -1);
    }

    // Attempt 4 lands on count 4 (still live), attempt 5 lands on count 5.
    expect(deliveredCounts).toEqual([4, 5]);

    const { deliverable, deadLetter } = simulateSubscribeDrain(state, 9_999);
    expect(deliverable).toEqual([]);
    expect(deadLetter.map((item) => item.eventId)).toEqual(["e-1"]);
    expect(deadLetter[0]?.deliveryCount).toBe(INBOX_MAX_DELIVERY_ATTEMPTS);
  });
});

describe("simulateAckFlow — agent.inbox.ack@1.0", () => {
  it("removes acked rows by eventId and keeps the rest in remaining", () => {
    const rows = [
      makeRow({ eventId: "e-ack" }),
      makeRow({ eventId: "e-keep" }),
    ];
    const result = simulateAckFlow(rows, ["e-ack"]);
    expect(result.removed).toEqual(["e-ack"]);
    expect(result.remaining.map((row) => row.eventId)).toEqual(["e-keep"]);
    expect(result.deadLetter).toEqual([]);
  });

  it("an empty ack retires nothing and returns every row as remaining", () => {
    const rows = [makeRow({ eventId: "e-1" }), makeRow({ eventId: "e-2" })];
    const result = simulateAckFlow(rows, []);
    expect(result.removed).toEqual([]);
    expect(result.remaining).toHaveLength(2);
    expect(result.deadLetter).toEqual([]);
  });

  it("ignores unknown eventIds", () => {
    const rows = [makeRow({ eventId: "e-1" })];
    const result = simulateAckFlow(rows, ["e-unknown"]);
    expect(result.removed).toEqual([]);
    expect(result.remaining.map((row) => row.eventId)).toEqual(["e-1"]);
  });

  it("separates dead-lettered rows (skipped but retained) from remaining", () => {
    const rows = [
      makeRow({ eventId: "e-active" }),
      makeRow({
        eventId: "e-dead",
        deliveryCount: INBOX_MAX_DELIVERY_ATTEMPTS,
      }),
    ];
    const result = simulateAckFlow(rows, []);
    expect(result.remaining.map((row) => row.eventId)).toEqual(["e-active"]);
    expect(result.deadLetter.map((row) => row.eventId)).toEqual(["e-dead"]);
  });

  it("an ack retires a dead-lettered row instead of retaining it", () => {
    const rows = [
      makeRow({
        eventId: "e-dead",
        deliveryCount: INBOX_MAX_DELIVERY_ATTEMPTS,
      }),
    ];
    const result = simulateAckFlow(rows, ["e-dead"]);
    expect(result.removed).toEqual(["e-dead"]);
    expect(result.deadLetter).toEqual([]);
    expect(result.remaining).toEqual([]);
  });

  it("is pure: the input row set and rows are not mutated", () => {
    const rows = [
      makeRow({ eventId: "e-1" }),
      makeRow({ eventId: "e-dead", deliveryCount: 5 }),
    ];
    const before = rows.map((row) => ({ ...row }));
    simulateAckFlow(rows, ["e-1"]);
    expect(rows).toEqual(before);
  });

  it("accepts up to the wire cap of 500 eventIds in one call", () => {
    const eventIds = Array.from(
      { length: INBOX_MAX_ACK_BATCH_SIZE },
      (_, index) => `e-${index}`,
    );
    const rows = eventIds.map((eventId) => makeRow({ eventId }));
    const result = simulateAckFlow(rows, eventIds);
    expect(result.removed).toHaveLength(INBOX_MAX_ACK_BATCH_SIZE);
    expect(result.remaining).toEqual([]);
  });
});
