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
import {
  agentInboxAckRequestSchema,
  agentInboxMessageSchemaV12,
  agentInboxSubscribeServerFrameSchemaV10,
  agentInboxSubscribeServerFrameSchemaV12,
  type AgentInboxMessage,
  type AgentInboxMessageV12,
  type AgentInboxSubscribeServerFrame,
} from "@traycer/protocol/host/agent/inbox";

/**
 * Integration test for the durable inbox envelope lifecycle (Task 7,
 * Phase 0). Composes the REAL wire schemas from `inbox.ts`
 * (`agentInboxMessageSchemaV12`, the `@1.2` subscribe frame tree,
 * `agent.inbox.ack@1.0`) with the reference pure flows from `inbox-spec.ts`
 * (`simulateSubscribeDrain` / `simulateDeliveryAttempt` / `simulateAckFlow`)
 * to prove the full envelope lifecycle — enqueue, deliver, replay, dead-letter,
 * ack, remove — holds across the contract boundary, with no mocks and no host.
 *
 * The reference functions are version-agnostic by design; the delivery
 * guarantee is enforced by the COMPOSITION of the wire schema (whether a
 * frame carries `eventId`) and the resolver rule (server-side auto-ack when
 * it does not), which is exactly what these tests pin together.
 */

const EPIC_ID = "epic-1";
const AGENT_ID = "agent-1";

/** A canonical durable inbox row; overrides fill the fields a scenario varies. */
function makeRow(overrides: Partial<InboxMessageRow>): InboxMessageRow {
  return {
    eventId: "event-1",
    agentId: AGENT_ID,
    epicId: EPIC_ID,
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

/**
 * The projection a host resolver applies when delivering a durable row over
 * `agent.inbox.subscribe@1.2`: row fields map onto
 * `agentInboxMessageSchemaV12`, with the `reply` discriminator derived from
 * `expectReply` / `responseId`. A reply-bearing row always carries a
 * broker-minted thread id, so `expectReply: true` with a null `responseId`
 * is not wire-representable.
 */
function rowToWireMessage(row: InboxMessageRow): AgentInboxMessageV12 {
  return {
    reply:
      row.expectReply && row.responseId !== null
        ? { expectsReply: true, responseId: row.responseId }
        : { expectsReply: false },
    fromAgentId: row.fromAgentId,
    senderTitle: row.senderTitle,
    senderHarnessId: row.senderHarnessId,
    epicId: row.epicId,
    prompt: row.prompt,
    enqueuedAt: row.enqueuedAt,
    eventId: row.eventId,
  };
}

/** Wrap a row's wire message in the real @1.2 server "message" frame. */
function rowToMessageFrame(row: InboxMessageRow): {
  kind: "message";
  hasBinaryPayload: false;
  item: AgentInboxMessageV12;
} {
  return {
    kind: "message",
    hasBinaryPayload: false,
    item: rowToWireMessage(row),
  };
}

/**
 * Narrow a parsed `agent.inbox.subscribe` frame to its "message" member so
 * TypeScript sees `item`; a frame of any other kind here is a test failure.
 */
function expectMessageFrame(
  frame: AgentInboxSubscribeServerFrame,
): AgentInboxMessageV12 {
  if (frame.kind !== "message") {
    throw new Error(`expected a message frame, got kind "${frame.kind}"`);
  }
  return frame.item;
}

describe("Scenario 1 — enqueue → deliver → ack → remove", () => {
  it("carries one envelope through the real wire schemas and retires it by eventId", () => {
    // Enqueue: the canonical stored row validates against the row schema.
    const row = inboxMessageRowSchema.parse(
      makeRow({ eventId: "event-abc", prompt: "peer message body" }),
    );

    // Deliver: the resolver projects the row onto the @1.2 wire message and
    // serializes the full server frame through the real contract schema.
    const deliveredItem = expectMessageFrame(
      agentInboxSubscribeServerFrameSchemaV12.parse(rowToMessageFrame(row)),
    );
    expect(deliveredItem).toEqual(rowToWireMessage(row));
    expect(deliveredItem.eventId).toBe("event-abc");

    // The delivery is counted on the durable row, but the row is NOT retired
    // until acked — at-least-once.
    const attempted = simulateDeliveryAttempt([row], ["event-abc"], 2_000);
    expect(attempted.rows[0]?.deliveryCount).toBe(1);
    expect(attempted.rows[0]?.lastDeliveredAt).toBe(2_000);

    // Ack: the monitor echoes the wire eventId back through the real
    // `agent.inbox.ack@1.0` request schema, and the reference flow retires it.
    const ackRequest = agentInboxAckRequestSchema.parse({
      epicId: EPIC_ID,
      agentId: AGENT_ID,
      eventIds: [deliveredItem.eventId],
    });
    const acked = simulateAckFlow(attempted.rows, ackRequest.eventIds);
    expect(acked.removed).toEqual(["event-abc"]);
    expect(acked.remaining).toEqual([]);
    expect(acked.deadLetter).toEqual([]);
  });

  it("projects a reply-free row onto the wire with no responseId", () => {
    const row = makeRow({
      eventId: "event-noreply",
      expectReply: false,
      responseId: null,
    });
    const parsed = agentInboxMessageSchemaV12.parse(rowToWireMessage(row));
    expect(parsed.reply).toEqual({ expectsReply: false });
    expect(parsed.eventId).toBe("event-noreply");
  });

  it("keeps the broker-minted thread id on the wire for reply-bearing rows", () => {
    const row = makeRow({
      eventId: "event-reply",
      expectReply: true,
      responseId: "thread-9",
    });
    const parsed = agentInboxMessageSchemaV12.parse(rowToWireMessage(row));
    expect(parsed.reply).toEqual({
      expectsReply: true,
      responseId: "thread-9",
    });
  });
});

describe("Scenario 2 — subscribe drain replay", () => {
  it("replays unacked rows oldest-first and skips expired + dead-lettered rows", () => {
    const now = 10_000;
    const rows = [
      makeRow({
        eventId: "e-dead",
        enqueuedAt: 1_000,
        deliveryCount: INBOX_MAX_DELIVERY_ATTEMPTS,
      }),
      makeRow({ eventId: "e-expired", enqueuedAt: 2_000, expiresAt: 5_000 }),
      makeRow({
        eventId: "e-delivered-unacked",
        enqueuedAt: 3_000,
        deliveryCount: 1,
        lastDeliveredAt: 9_000,
      }),
      makeRow({ eventId: "e-oldest", enqueuedAt: 1_500 }),
      makeRow({ eventId: "e-newest", enqueuedAt: 4_000 }),
    ];

    const { deliverable, deadLetter, expired } = simulateSubscribeDrain(
      rows,
      now,
    );

    // Unacknowledged rows replay oldest-first by enqueuedAt; a row that was
    // delivered but never acked still replays (at-least-once); expired and
    // dead-lettered rows are skipped into their audit buckets.
    expect(deliverable.map((row) => row.eventId)).toEqual([
      "e-oldest",
      "e-delivered-unacked",
      "e-newest",
    ]);
    expect(deadLetter.map((row) => row.eventId)).toEqual(["e-dead"]);
    expect(expired.map((row) => row.eventId)).toEqual(["e-expired"]);

    // Every replayed row is representable on the real @1.2 wire frame, and
    // the frame carries the row key the monitor would ack.
    for (const row of deliverable) {
      const item = expectMessageFrame(
        agentInboxSubscribeServerFrameSchemaV12.parse(rowToMessageFrame(row)),
      );
      expect(item.eventId).toBe(row.eventId);
    }
  });
});

describe("Scenario 3 — delivery count → dead-letter", () => {
  it("dead-letters a row on the 5th attempt, skips it on drains, and lets an ack retire it", () => {
    let state = [makeRow({ eventId: "e-doomed", deliveryCount: 4 })];

    // Attempt 5: deliveryCount 4 → 5, crossing the cap. The 5th attempt IS a
    // real delivery, so the resolver reports the row in both `delivered` and
    // `deadLetter` so it can move it to the audit set.
    const attempt = simulateDeliveryAttempt(state, ["e-doomed"], 10_000);
    state = attempt.rows;
    expect(attempt.delivered[0]?.deliveryCount).toBe(
      INBOX_MAX_DELIVERY_ATTEMPTS,
    );
    expect(attempt.deadLetter.map((row) => row.eventId)).toEqual(["e-doomed"]);

    // A fresh subscribe skips the dead-lettered row entirely.
    const drain = simulateSubscribeDrain(state, 20_000);
    expect(drain.deliverable).toEqual([]);
    expect(drain.deadLetter.map((row) => row.eventId)).toEqual(["e-doomed"]);
    expect(drain.expired).toEqual([]);

    // The row is retained for audit, but an ack still retires it — acked
    // dead-lettered rows are removed, not kept.
    const acked = simulateAckFlow(state, ["e-doomed"]);
    expect(acked.removed).toEqual(["e-doomed"]);
    expect(acked.remaining).toEqual([]);
    expect(acked.deadLetter).toEqual([]);
  });
});

describe("Scenario 4 — batch ack (max 500)", () => {
  it("retires exactly 500 rows from a 600-row inbox in one ack call", () => {
    const rows = Array.from({ length: 600 }, (_, index) =>
      makeRow({ eventId: `e-${index}`, enqueuedAt: index }),
    );
    const firstBatch = rows
      .slice(0, INBOX_MAX_ACK_BATCH_SIZE)
      .map((row) => row.eventId);

    // The batch validates against the real `agent.inbox.ack@1.0` wire schema —
    // the cap the pure flow delegates to the wire (`simulateAckFlow` does not
    // re-validate the batch itself).
    const ackRequest = agentInboxAckRequestSchema.parse({
      epicId: EPIC_ID,
      agentId: AGENT_ID,
      eventIds: firstBatch,
    });
    expect(ackRequest.eventIds).toHaveLength(INBOX_MAX_ACK_BATCH_SIZE);

    const result = simulateAckFlow(rows, ackRequest.eventIds);
    expect(result.removed).toHaveLength(INBOX_MAX_ACK_BATCH_SIZE);
    expect(result.remaining).toHaveLength(100);
    expect(result.deadLetter).toEqual([]);
  });

  it("rejects a 501-id batch at the wire schema — the spec constant's twin", () => {
    const overCap = Array.from(
      { length: INBOX_MAX_ACK_BATCH_SIZE + 1 },
      (_, index) => `e-${index}`,
    );
    expect(
      agentInboxAckRequestSchema.safeParse({
        epicId: EPIC_ID,
        agentId: AGENT_ID,
        eventIds: overCap,
      }).success,
    ).toBe(false);
    expect(INBOX_MAX_ACK_BATCH_SIZE).toBe(500);
  });
});

/**
 * Scenario 5 — at-least-once (@1.2+ monitors) vs at-most-once (<@1.2).
 *
 * A `@1.2`+ monitor negotiates `agentInboxMessageSchemaV12`, which carries
 * `eventId`. Its deliveries are AT-LEAST-ONCE: a delivered-but-unacked row
 * survives host restart and monitor reconnect, and the resolver replays it
 * on the next `agent.inbox.subscribe` open. The monitor retires the row
 * exactly once by echoing the `eventId` back through `agent.inbox.ack`.
 *
 * A `<@1.2` monitor negotiates the older frozen frame tree, which has NO
 * `eventId` field at all, so it structurally cannot call `agent.inbox.ack`.
 * Rather than leave the durable row queued forever for an ack that can never
 * arrive, the resolver applies a SERVER-SIDE compatibility ack immediately
 * after a successful send, retiring the row itself — AT-MOST-ONCE, the
 * pre-durable-inbox behavior those monitors were always built against.
 *
 * The reference functions do not know about protocol minors: the guarantee
 * is enforced by the composition of the wire schema (whether a frame carries
 * `eventId`) and the resolver rule (auto-ack when it does not), which these
 * tests simulate with the pure flows.
 */
describe("Scenario 5 — at-least-once vs at-most-once semantics", () => {
  it("@1.2+: an unacked delivery survives and replays on the next subscribe", () => {
    const row = makeRow({ eventId: "e-survivor", prompt: "must not be lost" });
    const delivered = simulateDeliveryAttempt([row], ["e-survivor"], 5_000);
    expect(delivered.rows[0]?.deliveryCount).toBe(1);

    // No ack arrives — the durable row is the source of truth, so a
    // reconnect (or host restart) replays it.
    const replay = simulateSubscribeDrain(delivered.rows, 9_999);
    expect(replay.deliverable.map((replayed) => replayed.eventId)).toEqual([
      "e-survivor",
    ]);

    // The replayed frame still carries eventId, so the monitor can ack it.
    const survivor = replay.deliverable[0];
    expect(survivor?.eventId).toBe("e-survivor");
    if (survivor) {
      const item = expectMessageFrame(
        agentInboxSubscribeServerFrameSchemaV12.parse(
          rowToMessageFrame(survivor),
        ),
      );
      expect(item.eventId).toBe("e-survivor");
    }

    // Once acked, the row is gone and the next subscribe finds nothing.
    const acked = simulateAckFlow(replay.deliverable, ["e-survivor"]);
    const afterAck = simulateSubscribeDrain(acked.remaining, 10_000);
    expect(afterAck.deliverable).toEqual([]);
  });

  it("<@1.2: the older frame tree has no eventId, so the server auto-acks and never replays", () => {
    const row = makeRow({
      eventId: "e-legacy",
      prompt: "legacy body",
      expectReply: false,
      responseId: null,
    });

    // The same bytes parse through the frozen @1.0 frame tree: zod is
    // non-strict, so the extra `eventId` is silently stripped. A <@1.2
    // monitor literally cannot see the durable row key.
    const legacyFrame = agentInboxSubscribeServerFrameSchemaV10.parse(
      rowToMessageFrame(row),
    );
    if (legacyFrame.kind !== "message") {
      throw new Error("expected a message frame");
    }
    const legacyItem: AgentInboxMessage = legacyFrame.item;
    expect(legacyItem).not.toHaveProperty("eventId");

    // Because the monitor cannot ack, the resolver applies the server-side
    // compatibility ack right after a successful send...
    const acked = simulateAckFlow([row], [row.eventId]);
    expect(acked.removed).toEqual(["e-legacy"]);
    expect(acked.remaining).toEqual([]);

    // ...so a later subscribe (even after a restart) replays nothing: the
    // legacy monitor sees at-most-once delivery, exactly as before the
    // durable inbox existed.
    const replay = simulateSubscribeDrain(acked.remaining, 9_999);
    expect(replay.deliverable).toEqual([]);
    expect(replay.deadLetter).toEqual([]);
    expect(replay.expired).toEqual([]);
  });
});
