/**
 * `epic.communicationGraph.subscribe@1.0` - versioned streaming-RPC contract
 * for the per-epic communication event log that backs the Communication Graph
 * tile (agent nodes, A2A edges, playback timeline).
 *
 * Shape follows the established `chat.subscribe` / `agent.inbox.subscribe`
 * stream pattern: the client opens with `{ epicId, sinceCursor }`, the host
 * emits exactly one `snapshot` frame, then `event` frames for as long as the
 * subscription is open.
 *
 * WHAT THE STREAM GUARANTEES - the delivery contract is about ORDER and
 * COMPLETENESS, not about which frame kind a row arrives in:
 *
 *   1. Rows are delivered strictly `id`-ASCENDING per subscription, across
 *      both frame kinds - the snapshot's last row precedes the first `event`.
 *   2. Delivery is EXACTLY-ONCE and GAP-FREE relative to the client's cursor,
 *      for every WIRE-REPRESENTABLE row: each row above `sinceCursor` whose
 *      `kind` this contract version can represent arrives exactly once, in
 *      order, with nothing skipped.
 *
 * That is the whole contract. `snapshot` is a transport batching optimization
 * (see its frame doc below), NOT a claim that the backlog is complete, so a
 * client that treats "snapshot ended" as "caught up to now" is relying on
 * something the host never promised.
 *
 * THE REPRESENTABILITY EXCEPTION to clause 2 - deliberate, and the one case
 * where an `id` legitimately never reaches the client. A stored row whose
 * `kind` the SERVING host cannot represent in this contract version (a
 * hand-edited database; a value written by a newer host build sharing the same
 * log) is SKIPPED, and the cursor advances past it. It is not held back, not
 * retried, and not surfaced.
 *
 * Skipping is the point: holding such a row would wedge the subscription
 * forever behind one corrupt or foreign row, taking the whole epic's graph
 * down with it, and a client cannot act on a row it has no schema for anyway.
 * The cost is a silent hole - `id` gaps are therefore NOT evidence of loss and
 * a client must never treat them as such (no "missing row" retry, no
 * re-request of a lower cursor; both would loop forever).
 *
 * This is a HOST-SIDE REPRESENTABILITY POLICY, not a client-visible signal:
 * nothing on the wire says a skip happened, by design, because the alternative
 * shapes - a placeholder frame or a fallback `kind` - would hand clients a row
 * they cannot render and invite exactly the guesswork this contract avoids
 * elsewhere. If a genuinely new event kind ever ships, the remedy is to grow
 * `epicCommunicationGraphEventKindSchema` in a NEW MINOR so both peers agree
 * on it; the skip is the interim behaviour that keeps an old client working
 * against a newer host, not a substitute for that minor.
 *
 * FRAME KIND CARRIES NO ACTIVITY SEMANTICS. An `event` frame does NOT mean
 * "something just happened": it is equally how a reconnect gap-fill and how
 * snapshot overflow (pre-existing backlog past the snapshot's bound) reach the
 * client. Newness - what to animate, what to badge, where to park a live
 * cursor - MUST be derived from row content (`timestamp`) and the client's own
 * state, never from the frame kind that carried the row. This was already
 * unavoidable for the multi-host merge below, where frames from several
 * subscriptions interleave and no single stream's framing means anything
 * globally; the bounded snapshot only makes it explicit.
 *
 * Delivery model:
 *
 *   - The host's capture points (broker A2A delivery, inactivity notices)
 *     write an append-only row to the host's SQLite event log. Rows are never
 *     updated or deleted.
 *   - The row's autoincrement `id` is BOTH the primary key and the RPC cursor,
 *     so the log is totally ordered per host and the wire needs no separate
 *     sequence number.
 *   - After the write, capture points wake an in-process per-epic emitter that
 *     fans out to open subscriptions. The write is the source of truth; the
 *     emitter is purely a wake-up, so a dropped notification costs at most a
 *     reconnect, never an event.
 *
 * Resume: on reconnect the client passes the highest `id` it has already
 * applied as `sinceCursor` and receives only the rows ABOVE it - the gap, not
 * the whole log. Because ids are monotonic and rows are immutable, that makes
 * resume dedup-free: the client never sees a row twice and never has to
 * reconcile a re-sent snapshot. The gap arrives as a snapshot batch followed
 * by however many `event` frames the rest of it needs; the split point is not
 * meaningful and the client should not read anything into it.
 *
 * Multi-host epics: A2A is host-local (cross-host sends are rejected), so
 * per-host event sets are DISJOINT. The tile opens one subscription per host referenced by the
 * epic and merges frames client-side by `timestamp`; no dedup is needed and no
 * host-side merge exists. Wall clocks can skew between hosts, but both ends of
 * any conversation live on one host, so message-passing causality is never
 * violated - only unrelated exchanges can misorder relative to each other.
 *
 * COMPAT POSTURE - additive, post-v1.0.0 OPTIONAL stream method. A host that
 * predates this method simply does not advertise it in its `/stream` manifest.
 * Stream compatibility is checked PER METHOD at subscribe time
 * (`checkStreamMethodCompatibility`), not across the union of both manifests,
 * so an old host is not handshake-fatal here: the client's subscription
 * resolves to `onMethodSupport(method, "unsupported")` and the tile renders
 * that host's agents with a "no edge data" affordance while every other host
 * in the same epic keeps streaming. This is the `resources.subscribe`
 * precedent, and it is why the method must never be added to the unary
 * released floor (`released-floor.ts`), which is fail-closed on the name set.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";

const textFrameFields = {
  hasBinaryPayload: z.literal(false),
} as const;

/**
 * Event classes captured at the host's choke points:
 *
 * - `a2a_message`   - one delivered agent→agent message (every surface combo,
 *   including TUI↔TUI, where this row is the ONLY durable record).
 * - `a2a_notice`    - a broker inactivity/stalled-receiver notice. In-memory
 *   only today, so the row is likewise the only durable record.
 * - `agent_created` - one agent creating another (`agent.create` / fork with
 *   an agent sender). This is what puts the lineage edge on the canvas at
 *   birth instead of only after the first message crosses it.
 *
 * CLOSED enum, unlike the open-string `noticeReason`. The asymmetry is
 * deliberate: that field annotates a row that is fully renderable without it,
 * so an unknown value degrades to "show the raw string", whereas
 * `kind` decides WHICH FIELDS on the row mean anything - a client handed an
 * unknown kind has no way to render it at all. A stored row whose kind the
 * serving host cannot represent here is therefore skipped outright (see the
 * representability exception in the module doc), and adding a kind is a NEW
 * MINOR, never a silent widening.
 */
export const epicCommunicationGraphEventKindSchema = z.enum([
  "a2a_message",
  "a2a_notice",
  "agent_created",
]);
export type EpicCommunicationGraphEventKind = z.infer<
  typeof epicCommunicationGraphEventKindSchema
>;

/**
 * Where the event can be re-opened in the product, so a timeline entry can
 * jump to its exact source:
 *
 * - `gui_block` / `gui_message` - a GUI chat transcript anchor; `originChatId`
 *   is the chat and `originRefId` the block/message id to scroll to.
 * - `tui_session`              - a terminal-agent session; opening the session
 *   is the whole behavior (there is no in-transcript anchor).
 */
export const epicCommunicationGraphOriginKindSchema = z.enum([
  "gui_block",
  "gui_message",
  "tui_session",
]);
export type EpicCommunicationGraphOriginKind = z.infer<
  typeof epicCommunicationGraphOriginKindSchema
>;

/**
 * One row of the host's append-only event log, on the wire.
 *
 * Deliberately FLAT with nullable per-kind fields rather than a
 * `kind`-discriminated union: it mirrors the SQLite row one-for-one, so the
 * host resolver projects a row to a frame with no reshaping and the client's
 * merged timeline array is a single uniform type. Which fields are populated
 * follows from `kind`:
 *
 * - `a2a_message` - `senderAgentId`, `receiverAgentId`, `responseId`,
 *   `expectReply`, `messageText`; `inReplyTo` set when the message answers an
 *   earlier request (this is what distinguishes a reply edge from a new-request
 *   edge, and what makes an open thread derivable: an `expectReply` send with
 *   no later row carrying its `responseId` in `inReplyTo`).
 * - `a2a_notice`  - the same A2A identity fields, plus `noticeReason` (WHY the
 *   broker gave up on the thread) with `messageText` carrying the notice
 *   detail verbatim. `noticeReason` is populated for this kind ONLY.
 * - `agent_created` - `senderAgentId` is the CREATOR, `receiverAgentId` the
 *   agent it brought into the epic. Every other per-kind field is null: the
 *   row is pure lineage, and the created agent's current identity (name,
 *   surface) is the epic projection's to answer, not a snapshot to go stale
 *   here.
 *
 * `messageText` carries the FULL message body, never a truncation or a
 * summary: for TUI-received and TUI↔TUI messages nothing else durable exists,
 * so truncating here would silently destroy the record.
 */
export const epicCommunicationGraphEventSchema = z.object({
  /**
   * Autoincrement row id. Monotonic per host and doubles as the resume cursor
   * (`sinceCursor`). Not comparable across hosts.
   */
  id: z.number().int().positive(),
  kind: epicCommunicationGraphEventKindSchema,
  /** Host wall clock at capture, epoch millis. Ordering key for the timeline. */
  timestamp: z.number().int(),
  /** The sending agent. */
  senderAgentId: z.string().nullable(),
  /** The receiving agent. */
  receiverAgentId: z.string().nullable(),
  /** The broker thread id (reused across a directed pair). */
  responseId: z.string().nullable(),
  /**
   * The `responseId` this message answers, or null for a new request. Drives
   * reply-vs-request edge styling and open-thread detection.
   */
  inReplyTo: z.string().nullable(),
  /** Whether the sender asked for a reply. */
  expectReply: z.boolean().nullable(),
  /** The FULL message or notice text. */
  messageText: z.string().nullable(),
  /**
   * `a2a_notice` ONLY: why the broker gave up on the thread (`turn-ended`,
   * `errored`, `awaiting-input`, ...). Null on every other kind.
   *
   * Deliberately an open `string`, NOT the closed `reason` enum on
   * `agentInboxNoticeSchema`: that enum belongs to the live broker and has
   * grown before, and this log is HISTORICAL - a row captured today must still
   * parse years later, and a reason added after this minor froze must not make
   * old rows unreadable or force a new minor. Consumers should switch on the
   * values they know and fall back to showing the raw string.
   */
  noticeReason: z.string().nullable(),
  /** Origin ref: surface the event can be re-opened on, or null if unknown. */
  originKind: epicCommunicationGraphOriginKindSchema.nullable(),
  /** Origin ref: owning chat / terminal-agent id. */
  originChatId: z.string().nullable(),
  /** Origin ref: block or message id to anchor on within `originChatId`. */
  originRefId: z.string().nullable(),
});
export type EpicCommunicationGraphEvent = z.infer<
  typeof epicCommunicationGraphEventSchema
>;

export const epicCommunicationGraphSubscribeOpenRequestSchema = z.object({
  epicId: z.string(),
  /**
   * Highest event `id` the client has already applied FOR THIS HOST, or null
   * for a first open. Only rows strictly above it are delivered - beginning
   * with the `snapshot` batch and continuing as `event` frames until the gap
   * is drained. Required-and-nullable rather than optional so the resume
   * intent is always explicit on the wire - "start from the beginning" and
   * "I forgot to send a cursor" are not the same request.
   */
  sinceCursor: z.number().int().nonnegative().nullable(),
});
export type EpicCommunicationGraphSubscribeOpenRequest = z.infer<
  typeof epicCommunicationGraphSubscribeOpenRequestSchema
>;

export const epicCommunicationGraphSubscribeServerFrameSchema =
  z.discriminatedUnion("kind", [
    /**
     * Exactly one per subscription, emitted first: the INITIAL BATCH of rows
     * above the open's `sinceCursor`, ordered by `id` ascending.
     *
     * BOUNDED, and therefore NOT a completeness claim. The host caps how many
     * rows one snapshot carries (an implementation-defined limit it may change
     * without a schema version), so on a large backlog this frame is a prefix
     * of the gap, not the whole gap - the remainder follows as `event` frames.
     * The bound exists because an unbounded snapshot would let one enormous
     * epic starve the connection and balloon host memory. Treat this frame as
     * a transport batching optimization - "here are the first N rows in one
     * message instead of N messages" - and nothing more.
     *
     * Consequences a consumer must respect:
     *
     *   - Do NOT treat the end of the snapshot as "caught up to now". A
     *     quiescent epic with a long backlog legally delivers pre-existing
     *     rows as `event` frames long after the snapshot lands.
     *   - Do NOT gate first paint on it if you need the full history; gate on
     *     row content instead.
     *
     * Empty when there is nothing above the cursor - either a caught-up resume
     * or an epic with no captured events (one that predates the feature stays
     * empty; there is no backfill).
     */
    z.object({
      kind: z.literal("snapshot"),
      epicId: z.string(),
      events: z.array(epicCommunicationGraphEventSchema),
      /**
       * Highest row id this host's log held when the subscription OPENED, or
       * null when the log was empty. This - not the snapshot's own last row -
       * is the arrival boundary: because the snapshot is bounded, backlog
       * PAST its bound legally arrives as `event` frames, and a client that
       * classes "id above the snapshot's last row" as new would animate that
       * day-old overflow as live traffic. Rows at or below `headId` are
       * history the client is merely learning, however they were framed;
       * rows above it were captured after the subscription opened.
       */
      headId: z.number().int().positive().nullable(),
      ...textFrameFields,
    }),
    /**
     * One row, delivered after the snapshot, continuing the same strictly
     * `id`-ascending sequence. Never a replay and never a correction: rows are
     * immutable, so a client applies these by appending, never by reconciling.
     *
     * NOT a liveness signal. A row arrives here for any of three reasons the
     * client cannot tell apart and must not try to:
     *
     *   - it was just captured (genuinely live);
     *   - it is backlog past the snapshot's bound (pre-existing, possibly
     *     hours or days old);
     *   - it is a reconnect gap-fill.
     *
     * So "animate on `event`" is wrong - it would flash a day-old backlog as
     * if the agents were working right now. Drive newness off `timestamp` and
     * the client's own notion of where its cursor sits.
     */
    z.object({
      kind: z.literal("event"),
      epicId: z.string(),
      event: epicCommunicationGraphEventSchema,
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type EpicCommunicationGraphSubscribeServerFrame = z.infer<
  typeof epicCommunicationGraphSubscribeServerFrameSchema
>;

export const epicCommunicationGraphSubscribeClientFrameSchema =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);
export type EpicCommunicationGraphSubscribeClientFrame = z.infer<
  typeof epicCommunicationGraphSubscribeClientFrameSchema
>;

export const epicCommunicationGraphSubscribeV10 = defineStreamRpcContract({
  method: "epic.communicationGraph.subscribe",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: epicCommunicationGraphSubscribeOpenRequestSchema,
  serverFrameSchema: epicCommunicationGraphSubscribeServerFrameSchema,
  clientFrameSchema: epicCommunicationGraphSubscribeClientFrameSchema,
});
