/**
 * Canonical REFERENCE SPECIFICATION for the durable agent inbox — the wire
 * format, stored row shape, and delivery semantics a Traycer host
 * implementer must match when building the closed-source broker's durable
 * inbox. This module is a typed document, not a migration and not host code:
 * it defines the canonical row (`InboxMessageRow`), the delivery contract,
 * and pure functions that simulate the drain / attempt / ack flows so the
 * semantics are provable end-to-end without a host (the same pattern as
 * `host/policy/defaults.ts` and `host/policy/registry.ts`).
 *
 * Wire surface this spec pins down (all in `inbox.ts`):
 *
 *   - `agent.inbox.subscribe@1.2` — "message" frames carry `eventId` from
 *     `agentInboxMessageSchemaV12`, the durable row key the monitor echoes
 *     back in `agent.inbox.ack`.
 *   - `agent.inbox.ack@1.0` — batch ack by `eventId`; the wire schema caps
 *     the batch at {@link INBOX_MAX_ACK_BATCH_SIZE} entries per call.
 *   - `agent.inbox.read@2.0` — cursor-paged durable-inbox reads; the `after`
 *     cursor `{ createdAt, eventId }` maps onto the row's
 *     `enqueuedAt` / `eventId` so paging follows the same oldest-first order
 *     as replay.
 *
 * Delivery guarantees:
 *
 *   - **At-least-once for `@1.2`+ monitors.** A row that is delivered but not
 *     acknowledged survives host restart and monitor reconnect; the resolver
 *     replays unacknowledged rows on every subscribe open. A monitor should
 *     ack promptly after it has safely surfaced a message to the agent (e.g.
 *     after printing it), and the row is retired exactly once the ack
 *     arrives. The durable row is the source of truth for
 *     `agent.inbox.subscribe`, not the in-memory queue.
 *   - **At-most-once for `<@1.2` monitors.** A monitor that negotiated below
 *     `@1.2` has no `eventId` field at all and structurally cannot call
 *     `agent.inbox.ack`. Rather than leave the durable row queued forever for
 *     an ack that can never arrive, the resolver applies a SERVER-SIDE
 *     compatibility ack: immediately after successfully sending a "message"
 *     frame to such a connection, it retires the row itself. This mirrors the
 *     pre-durable-inbox behavior those monitors were always built against —
 *     no regression, no replay for them.
 *   - **Replay on subscribe.** On `agent.inbox.subscribe@1.2` open, the
 *     resolver drains unacknowledged rows ordered by `enqueuedAt` ASC
 *     (oldest first), skipping rows that are expired or dead-lettered (see
 *     {@link simulateSubscribeDrain}).
 *   - **Dead-lettering.** After {@link INBOX_MAX_DELIVERY_ATTEMPTS} (5)
 *     delivery attempts — `deliveryCount >= 5` — a row is skipped by every
 *     future drain, but retained for audit. It is never deleted by the
 *     delivery path itself; only an ack (or host-side TTL cleanup) removes
 *     it. See {@link simulateAckFlow} and {@link simulateSubscribeDrain}.
 *   - **Expiry.** A row with `expiresAt < now` is skipped without counting as
 *     a delivery attempt; `expiresAt === null` means no TTL. Expired rows are
 *     returned alongside the drain for audit and host-side cleanup.
 *   - **Ack.** `agent.inbox.ack@1.0` removes rows by `eventId` (max
 *     {@link INBOX_MAX_ACK_BATCH_SIZE} per call). Acked rows are gone — not
 *     retained, not dead-lettered. Acking an already-dead-lettered row also
 *     retires it.
 *
 * Canonical stored row (typed reference schema — NOT a SQL migration):
 *
 * | Column            | Type     | Nullable | Meaning                                    |
 * |-------------------|----------|----------|--------------------------------------------|
 * | `eventId`         | string   | no       | Broker-minted uuid; durable row PK.        |
 * | `agentId`         | string   | no       | Receiver of the message.                   |
 * | `epicId`          | string   | no       | Epic the receiver belongs to.              |
 * | `fromAgentId`     | string   | no       | Sender of the message.                     |
 * | `prompt`          | string   | no       | Full message body.                         |
 * | `responseId`      | string   | yes      | Broker-minted thread id for reply-bearing  |
 * |                   |          |          | messages; null otherwise.                  |
 * | `expectReply`     | boolean  | no       | Whether the sender expects a reply.        |
 * | `senderTitle`     | string   | yes      | Sender display title, when known.          |
 * | `senderHarnessId` | string   | yes      | Sender harness id (claude/codex/…), when   |
 * |                   |          |          | bound.                                     |
 * | `enqueuedAt`      | number   | no       | Epoch millis the broker received it.       |
 * | `deliveryCount`   | number   | no       | Delivery attempts so far; starts at 0.     |
 * | `lastDeliveredAt` | number   | yes      | Epoch millis of the most recent attempt.   |
 * | `expiresAt`       | number   | yes      | Epoch millis TTL; null = no expiry.        |
 */
import { z } from "zod";

/** Delivery attempts before a row is dead-lettered (`deliveryCount >= 5`). */
export const INBOX_MAX_DELIVERY_ATTEMPTS = 5;

/** Max `eventId`s accepted by one `agent.inbox.ack@1.0` call. */
export const INBOX_MAX_ACK_BATCH_SIZE = 500;

/**
 * Reference schema for one durable inbox row. This is the canonical stored
 * shape — the broker's SQLite table is an implementation of it, not the other
 * way around. The wire schemas in `inbox.ts` carry the *delivered* projection
 * (`agentInboxMessageSchemaV12` plus the `reply` discriminator); this row adds
 * the delivery bookkeeping (`deliveryCount`, `lastDeliveredAt`, `expiresAt`)
 * that the resolver uses to enforce the contract.
 */
export const inboxMessageRowSchema = z.object({
  /**
   * Broker-minted uuid, the durable row's primary key. Surfaced to `@1.2`+
   * monitors as `agentInboxMessageSchemaV12.eventId` and echoed back in
   * `agent.inbox.ack`.
   */
  eventId: z.string(),
  /** Receiver the message is addressed to (the inbox owner). */
  agentId: z.string(),
  /** Epic the receiver belongs to. */
  epicId: z.string(),
  /** Sender of the message. */
  fromAgentId: z.string(),
  /** Full message body (the same body `agent.sendMessage` carried). */
  prompt: z.string(),
  /**
   * Broker-minted thread id the receiver must echo back when replying.
   * Null for messages sent without `expectReply` — those carry no thread.
   */
  responseId: z.string().nullable(),
  /** Whether the sender expects a reply (drives the inactivity watchdog). */
  expectReply: z.boolean(),
  /** Sender's display title (chat or TUI title), or null when unknown. */
  senderTitle: z.string().nullable(),
  /** Sender's harness id (claude/codex/cursor/opencode), or null when unbound. */
  senderHarnessId: z.string().nullable(),
  /** Epoch millis the broker received the envelope. Replay order key. */
  enqueuedAt: z.number().int(),
  /**
   * Delivery attempts so far, starting at 0. A row with
   * `deliveryCount >= INBOX_MAX_DELIVERY_ATTEMPTS` is dead-lettered: skipped
   * by every drain, retained for audit.
   */
  deliveryCount: z.number().int().min(0),
  /** Epoch millis of the most recent delivery attempt, or null before any. */
  lastDeliveredAt: z.number().int().nullable(),
  /**
   * Epoch millis TTL. Once `expiresAt < now` the row is skipped without
   * counting as a delivery attempt. Null means the row never expires.
   */
  expiresAt: z.number().int().nullable(),
});
export type InboxMessageRow = z.infer<typeof inboxMessageRowSchema>;

/**
 * Replay-on-subscribe projection: the rows the resolver would hand to a
 * `@1.2`+ monitor on `agent.inbox.subscribe` open, and the rows it skips.
 *
 * Delivery order is `enqueuedAt` ASC — oldest first, matching
 * `agent.inbox.read@2.0` paging. A row is excluded from `deliverable` if:
 *
 *   - `deliveryCount >= INBOX_MAX_DELIVERY_ATTEMPTS` → dead-lettered: skipped
 *     but retained for audit (reported in `deadLetter`). Dead-letter wins over
 *     expiry so a dead-lettered row stays in the dead-letter audit bucket even
 *     after its TTL passes.
 *   - `expiresAt !== null && expiresAt < now` → expired: skipped WITHOUT
 *     counting as a delivery attempt (reported in `expired`).
 *
 * Pure: input rows are never mutated; ordering happens on a new array.
 */
export function simulateSubscribeDrain(
  rows: readonly InboxMessageRow[],
  now: number,
): {
  /** Rows the resolver would deliver now, oldest `enqueuedAt` first. */
  deliverable: InboxMessageRow[];
  /** Rows with `deliveryCount >= INBOX_MAX_DELIVERY_ATTEMPTS`, retained for audit. */
  deadLetter: InboxMessageRow[];
  /** Rows past `expiresAt`, skipped without counting as an attempt. */
  expired: InboxMessageRow[];
} {
  const deliverable: InboxMessageRow[] = [];
  const deadLetter: InboxMessageRow[] = [];
  const expired: InboxMessageRow[] = [];

  for (const row of rows) {
    if (row.deliveryCount >= INBOX_MAX_DELIVERY_ATTEMPTS) {
      deadLetter.push(row);
    } else if (row.expiresAt !== null && row.expiresAt < now) {
      expired.push(row);
    } else {
      deliverable.push(row);
    }
  }

  deliverable.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  return { deliverable, deadLetter, expired };
}

/**
 * Pure projection of one delivery attempt: increments `deliveryCount` and
 * stamps `lastDeliveredAt` on exactly the rows whose `eventId` is in
 * `eventIds` (the rows the resolver actually sent this cycle). Returns the
 * next inbox state as a NEW array — the input is never mutated.
 *
 * A row that crosses `deliveryCount >= INBOX_MAX_DELIVERY_ATTEMPTS` on this
 * attempt WAS delivered (the 5th attempt is real) and is also reported in
 * `deadLetter` so the caller can move it out of the live drain and into the
 * audit/retention set. Unknown `eventIds` are ignored.
 */
export function simulateDeliveryAttempt(
  rows: readonly InboxMessageRow[],
  eventIds: readonly string[],
  now: number,
): {
  /** The full next inbox state (new array). */
  rows: InboxMessageRow[];
  /** The rows delivered this attempt, post-increment. */
  delivered: InboxMessageRow[];
  /** Delivered rows that crossed the dead-letter cap this attempt. */
  deadLetter: InboxMessageRow[];
} {
  const target = new Set(eventIds);
  const next: InboxMessageRow[] = [];
  const delivered: InboxMessageRow[] = [];
  const deadLetter: InboxMessageRow[] = [];

  for (const row of rows) {
    if (!target.has(row.eventId)) {
      next.push(row);
      continue;
    }
    const attempted: InboxMessageRow = {
      ...row,
      deliveryCount: row.deliveryCount + 1,
      lastDeliveredAt: now,
    };
    next.push(attempted);
    delivered.push(attempted);
    if (attempted.deliveryCount >= INBOX_MAX_DELIVERY_ATTEMPTS) {
      deadLetter.push(attempted);
    }
  }

  return { rows: next, delivered, deadLetter };
}

/**
 * Pure simulation of the `agent.inbox.ack@1.0` flow over a durable row set:
 * retires the rows whose `eventId` is in `ackEventIds`, partitions the rest
 * into still-active rows and dead-lettered rows, and leaves the input
 * untouched.
 *
 * Semantics (a host implements these in SQL):
 *
 *   - `removed` — every `eventId` that was acked, whether the row was active
 *     or already dead-lettered. Acked rows are gone, not retained.
 *   - `remaining` — rows still eligible for delivery: unacked and not
 *     dead-lettered (`deliveryCount < INBOX_MAX_DELIVERY_ATTEMPTS`).
 *   - `deadLetter` — unacked rows with `deliveryCount >=
 *     INBOX_MAX_DELIVERY_ATTEMPTS`: skipped by every future drain, retained
 *     for audit.
 *
 * The `INBOX_MAX_ACK_BATCH_SIZE` cap is a WIRE constraint enforced by
 * `agentInboxAckRequestSchema` (`.max(500)`), so this function does not
 * re-validate the batch — it simulates the flow for whatever ids it is given.
 */
export function simulateAckFlow(
  rows: readonly InboxMessageRow[],
  ackEventIds: readonly string[],
): {
  /** Unacked, non-dead-lettered rows still in the live inbox. */
  remaining: InboxMessageRow[];
  /** `eventId`s retired by this ack, in row order. */
  removed: string[];
  /** Unacked dead-lettered rows, retained for audit. */
  deadLetter: InboxMessageRow[];
} {
  const acked = new Set(ackEventIds);
  const remaining: InboxMessageRow[] = [];
  const removed: string[] = [];
  const deadLetter: InboxMessageRow[] = [];

  for (const row of rows) {
    if (acked.has(row.eventId)) {
      removed.push(row.eventId);
    } else if (row.deliveryCount >= INBOX_MAX_DELIVERY_ATTEMPTS) {
      deadLetter.push(row);
    } else {
      remaining.push(row);
    }
  }

  return { remaining, removed, deadLetter };
}
