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
 * @1.1 (minor 1) does exactly that: it adds four event kinds - `tool_call`,
 * `approval`, `lifecycle`, `resource_event` - to the closed set, plus the
 * nullable per-kind fields that carry them. Compat is the standard stream
 * minor story, with the representability skip applied by NEGOTIATED VERSION
 * rather than by schema failure:
 *
 *   - The `@1.0` schema tree stays FROZEN and INSTALLED (a `@1.0` peer must
 *     keep rejecting the new kinds - that rejection is what the resolver
 *     keys on). The `@1.1` schema is purely additive at the DATA level:
 *     every `@1.0` row upgrades to a valid `@1.1` row by filling the new
 *     fields with null, and the host emits each connection the frozen shape
 *     of the minor it negotiated - a `@1.0` peer never receives a `@1.1`
 *     frame and a `@1.1` peer always does (the required-nullable convention
 *     pins this, exactly like `git.subscribeStatus@1.1`).
 *   - The resolver projects each subscription to the minor it negotiated: a
 *     `@1.0` peer receives only the three original kinds, with the `@1.1`
 *     fields stripped (the downgrade below); a `@1.1` peer receives
 *     everything. A new-kind row is never "downgraded" into an old kind -
 *     it is skipped for the `@1.0` peer, exactly as the representability
 *     policy dictates for rows the peer has no schema for.
 *
 * Streams have no version bridges (see `framework/versioned-stream-rpc.ts`:
 * compat is installed-minor negotiation + resolver-side projection, the
 * `git.subscribeStatus@1.1` precedent), so the @1.0↔@1.1 row transforms
 * live in this module as plain typed helpers
 * (`upgradeEpicCommunicationGraphEventV10ToV11` /
 * `downgradeEpicCommunicationGraphEventV11ToV10`) for the resolver to call
 * during projection. They are NOT registered with the framework - there is
 * no bridge slot in the stream registry to register them in.
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
 * MINOR, never a silent widening. `@1.1` does that in
 * `epicCommunicationGraphEventKindSchemaV11` below; this `@1.0` set must
 * stay frozen so a `@1.0` peer keeps rejecting the new kinds.
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
 * `@1.1` kind set - the frozen `@1.0` set plus the four kinds Phase 0 adds:
 *
 * - `tool_call`      - an agent invoked a tool (captured at the host's tool
 *   dispatch choke point). `senderAgentId` is the invoking agent.
 * - `approval`       - an approval was requested or resolved (granted /
 *   denied). `senderAgentId` is the REQUESTER.
 * - `lifecycle`      - an agent's lifecycle state changed (created, forked,
 *   stopped, archived, errored).
 * - `resource_event` - a host resource-pressure reading crossed a threshold
 *   (CPU, memory, disk, rate-limit).
 *
 * Closed, exactly like the `@1.0` set: `kind` still decides which fields on
 * the row mean anything, so a client handed an unknown kind cannot render
 * it at all. This is a NEW enum object, never a mutation of the frozen
 * `@1.0` schema - a `@1.0` peer must keep rejecting the new kinds so the
 * resolver can project by negotiated version (see the module doc). If the
 * set ever grows again, it grows in yet another minor, never by widening
 * this one.
 */
export const epicCommunicationGraphEventKindSchemaV11 = z.enum([
  "a2a_message",
  "a2a_notice",
  "agent_created",
  "tool_call",
  "approval",
  "lifecycle",
  "resource_event",
]);
export type EpicCommunicationGraphEventKindV11 = z.infer<
  typeof epicCommunicationGraphEventKindSchemaV11
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

/**
 * `@1.1` row shape - the frozen `@1.0` object plus the nullable per-kind
 * fields Phase 0 adds. Same flat single-object discipline as `@1.0`: no
 * discriminated union per row, one uniform type for the client's merged
 * timeline, and the resolver projects a stored row to the negotiated
 * minor's shape (see the module doc). Which of the new fields are populated
 * follows from `kind`:
 *
 * - `tool_call`      - `toolName`, `toolInput` (summary/ref; the full input
 *   lives in the chat transcript), `durationMs`, `success`, `tokenCost`.
 * - `approval`       - `approvalId`, `status` (`pending` | `granted` |
 *   `denied`), `targetAction`.
 * - `lifecycle`      - `agentId` (the agent whose state transitioned),
 *   `previousState`, `newState`, `trigger` (`user` | `auto` | `timeout` |
 *   `error`).
 * - `resource_event` - `hostId` (the host that reported the reading),
 *   `resourceType` (`cpu` | `memory` | `disk` | `rate-limit`),
 *   `metricValue`, `threshold`, `breach`.
 *
 * `status`, `trigger`, and `resourceType` are deliberately open `string`s,
 * NOT closed enums - the same historical-log argument as `noticeReason`
 * above: a value added after this minor froze must not make old rows
 * unreadable. Consumers switch on the values they know and fall back to
 * showing the raw string. Every new kind also uses the existing
 * `originKind`/`originChatId`/`originRefId` fields for source traceability.
 *
 * Built with `.extend()` over the frozen `@1.0` object (the `agentInbox`
 * `@1.2` precedent) so the shared fields cannot drift.
 */
export const epicCommunicationGraphEventSchemaV11 =
  epicCommunicationGraphEventSchema.extend({
    kind: epicCommunicationGraphEventKindSchemaV11,
    /** `tool_call` ONLY: the tool the agent invoked (e.g. `read_file`). */
    toolName: z.string().nullable(),
    /** `tool_call` ONLY: summary or reference to the tool input. The full
     * payload lives in the chat transcript / session log; this log carries
     * metadata, never the payload. */
    toolInput: z.string().nullable(),
    /** `tool_call` ONLY: elapsed wall time of the invocation, millis. */
    durationMs: z.number().nonnegative().nullable(),
    /** `tool_call` ONLY: whether the invocation completed successfully. */
    success: z.boolean().nullable(),
    /** `tool_call` ONLY: token cost of the invocation, when the host can
     * attribute it. */
    tokenCost: z.number().nonnegative().nullable(),
    /** `approval` ONLY: the broker-minted approval request id. */
    approvalId: z.string().nullable(),
    /** `approval` ONLY: `pending` | `granted` | `denied`. Open string (see
     * the schema doc above for why). */
    status: z.string().nullable(),
    /** `approval` ONLY: the action the approval gates (e.g. `agent.create`,
     * `agent.stop`). */
    targetAction: z.string().nullable(),
    /** `lifecycle` ONLY: the agent whose state transitioned. */
    agentId: z.string().nullable(),
    /** `lifecycle` ONLY: the state the agent left. */
    previousState: z.string().nullable(),
    /** `lifecycle` ONLY: the state the agent entered. */
    newState: z.string().nullable(),
    /** `lifecycle` ONLY: `user` | `auto` | `timeout` | `error`. Open string
     * (see the schema doc above for why). */
    trigger: z.string().nullable(),
    /** `resource_event` ONLY: the host that reported the pressure reading. */
    hostId: z.string().nullable(),
    /** `resource_event` ONLY: `cpu` | `memory` | `disk` | `rate-limit`.
     * Open string (see the schema doc above for why). */
    resourceType: z.string().nullable(),
    /** `resource_event` ONLY: the measured value of the metric. */
    metricValue: z.number().nullable(),
    /** `resource_event` ONLY: the threshold the reading is compared against. */
    threshold: z.number().nullable(),
    /** `resource_event` ONLY: true when the reading crossed the threshold. */
    breach: z.boolean().nullable(),
  });
export type EpicCommunicationGraphEventV11 = z.infer<
  typeof epicCommunicationGraphEventSchemaV11
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

/**
 * `@1.1` server frames - the identical snapshot/event/pong shape with the
 * `@1.1` row schema inside. The open request and client frames are the
 * `@1.0` schemas VERBATIM (the `git.subscribeStatus@1.1` precedent): there
 * is no client knob to add - the host always computes the full row and the
 * resolver projects each frame to the connection's negotiated minor.
 */
export const epicCommunicationGraphSubscribeServerFrameSchemaV11 =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot"),
      epicId: z.string(),
      events: z.array(epicCommunicationGraphEventSchemaV11),
      headId: z.number().int().positive().nullable(),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("event"),
      epicId: z.string(),
      event: epicCommunicationGraphEventSchemaV11,
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type EpicCommunicationGraphSubscribeServerFrameV11 = z.infer<
  typeof epicCommunicationGraphSubscribeServerFrameSchemaV11
>;

/**
 * `epic.communicationGraph.subscribe@1.1` - additive minor that grows the
 * closed event-kind set to include `tool_call`, `approval`, `lifecycle`,
 * and `resource_event`, plus their nullable per-kind fields. Registered
 * alongside the FROZEN `@1.0` contract in the stream registry: a peer that
 * negotiated `@1.0` receives resolver-projected rows of the three original
 * kinds only (new-kind rows are skipped per the representability policy),
 * and a `@1.1` peer receives everything. Streams have no version bridges -
 * see the module doc and `git-contracts.ts` - so compat is negotiation +
 * projection, with the row transforms below as the projection primitives.
 */
export const epicCommunicationGraphSubscribeV11 = defineStreamRpcContract({
  method: "epic.communicationGraph.subscribe",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: epicCommunicationGraphSubscribeOpenRequestSchema,
  serverFrameSchema: epicCommunicationGraphSubscribeServerFrameSchemaV11,
  clientFrameSchema: epicCommunicationGraphSubscribeClientFrameSchema,
});

/**
 * True when `kind` is representable in the frozen `@1.0` set. The resolver
 * uses this to decide whether a stored row may be projected down for a
 * `@1.0` peer - a new-kind row fails the guard and is SKIPPED under the
 * representability policy, never relabelled into an old kind.
 */
export function isEpicCommunicationGraphEventKindV10(
  kind: EpicCommunicationGraphEventKindV11,
): kind is EpicCommunicationGraphEventKind {
  return epicCommunicationGraphEventKindSchema.safeParse(kind).success;
}

/**
 * Result of projecting a `@1.1` row down to the `@1.0` shape.
 * `unrepresentable-kind` means the row's `kind` has no `@1.0` meaning at
 * all - the resolver must SKIP it for that peer, not fail the stream.
 */
export type EpicCommunicationGraphEventV11ToV10Result =
  | { ok: true; value: EpicCommunicationGraphEvent }
  | { ok: false; reason: "unrepresentable-kind" };

/**
 * `@1.0` → `@1.1` row transform: the `@1.1` schema is purely additive, so
 * every `@1.0` row upgrades by filling the new per-kind fields with null.
 * (Streams have no framework bridges - this is the resolver projection
 * primitive, not a registered upgrade path; see the module doc.)
 */
export function upgradeEpicCommunicationGraphEventV10ToV11(
  event: EpicCommunicationGraphEvent,
): EpicCommunicationGraphEventV11 {
  return {
    ...event,
    toolName: null,
    toolInput: null,
    durationMs: null,
    success: null,
    tokenCost: null,
    approvalId: null,
    status: null,
    targetAction: null,
    agentId: null,
    previousState: null,
    newState: null,
    trigger: null,
    hostId: null,
    resourceType: null,
    metricValue: null,
    threshold: null,
    breach: null,
  };
}

/**
 * `@1.1` → `@1.0` row transform: for a row whose kind the `@1.0` set can
 * represent, strip the `@1.1`-only fields (a `@1.0` peer must never see
 * them - its schema rejects the new kinds and ignores unknown fields, and
 * the resolver must not rely on either). For a new-kind row, return
 * `{ ok: false, reason: "unrepresentable-kind" }` so the resolver skips it
 * per the representability policy.
 */
export function downgradeEpicCommunicationGraphEventV11ToV10(
  event: EpicCommunicationGraphEventV11,
): EpicCommunicationGraphEventV11ToV10Result {
  if (!isEpicCommunicationGraphEventKindV10(event.kind)) {
    return { ok: false, reason: "unrepresentable-kind" };
  }
  return {
    ok: true,
    value: {
      id: event.id,
      kind: event.kind,
      timestamp: event.timestamp,
      senderAgentId: event.senderAgentId,
      receiverAgentId: event.receiverAgentId,
      responseId: event.responseId,
      inReplyTo: event.inReplyTo,
      expectReply: event.expectReply,
      messageText: event.messageText,
      noticeReason: event.noticeReason,
      originKind: event.originKind,
      originChatId: event.originChatId,
      originRefId: event.originRefId,
    },
  };
}

/**
 * `host.communicationGraph.subscribe@1.0` - the CLOUD-relayed
 * counterpart of `epic.communicationGraph.subscribe` above: a per-epic
 * Communication Graph feed sourced from Traycer Cloud (any host the user is
 * signed into, not just the one that captured the rows) rather than this
 * host's own local event log.
 *
 * Shape follows `epic.communicationGraph.subscribe`'s cursor/snapshot/event
 * pattern, NOT `host.notifications.cloudFeed.subscribe`'s whole-snapshot
 * pattern: the cloud graph is a per-epic append-only log the same way the
 * local one is, so resuming above a retained cursor - never re-reading the
 * whole feed on every open - is both possible and required (a head change
 * must never become a bootstrap/full read; see the governing plan's design
 * invariants). The two differences from the local contract:
 *
 *   - the cursor is the cloud's compound `{ ingestVersion, eventId }` pair,
 *     not a local autoincrement id - it names a position in the CLOUD's
 *     ingestion order, which can differ from any row's own capture time (an
 *     old event uploaded late still lands above the cursor it arrives at,
 *     never below);
 *   - the cloud relay is one more hop than a direct local read (host to
 *     server to host to client) and can go transiently unavailable
 *     independent of the local host - `connectionState: "reconnecting"`
 *     communicates that without tearing down the client's retained graph or
 *     cursor, mirroring `host.notifications.cloudFeed.subscribe`'s frame of
 *     the same name.
 *
 * `historicalUpload` on each event is carried straight from the cloud row
 * (see `CommunicationGraphReadEventV1` in `@traycerai/common`): true for a
 * row uploaded as backlog, false for one captured by an already-caught-up
 * replication lane. Only a `false` row is eligible for a live pulse - a
 * `historicalUpload: true` row is inserted into the timeline and model but
 * must never become the client's "just happened" arrival, regardless of
 * which frame kind carries it (frame kind carries no activity semantics
 * here either, for the same reason as the local contract above).
 *
 * COMPAT POSTURE - additive, post-v1.0.0 OPTIONAL stream method, same
 * posture as `epic.communicationGraph.subscribe`: a host that predates it
 * (or was built without cloud replication) simply does not advertise it, a
 * client's subscription resolves to `onMethodSupport(method, "unsupported")`,
 * and this must never be added to the unary released floor
 * (`released-floor.ts`), which is fail-closed on the name set.
 */
export const hostCommunicationGraphCloudFeedCursorSchema = z.object({
  ingestVersion: z.number().int().nonnegative(),
  eventId: z.string().min(1).max(191),
});
export type HostCommunicationGraphCloudFeedCursor = z.infer<
  typeof hostCommunicationGraphCloudFeedCursorSchema
>;

/**
 * One cloud-ingested row on the wire. Reuses the same closed `kind` /
 * `originKind` enums as the local contract above - both describe events
 * captured at the same host choke points, and a cloud row whose `kind` this
 * contract version cannot represent is skipped under the identical
 * representability policy (see the local contract's module doc), never
 * held back or surfaced as a placeholder.
 */
export const hostCommunicationGraphCloudFeedEventSchema = z.object({
  /** The cloud's globally stable identity for this event; opaque to the client. */
  eventId: z.string().min(1).max(191),
  /** Which host originally captured this event - display/navigation metadata,
   * not authorization. A source jump to an offline origin host is disabled,
   * never redirected. */
  originHostId: z.string().min(1),
  /** The origin host's own per-host local sequence at capture time. */
  originSequence: z.number().int().nonnegative(),
  /** The cloud's ingestion-order position for this row; half of its cursor. */
  ingestVersion: z.number().int().nonnegative(),
  kind: epicCommunicationGraphEventKindSchema,
  /** Origin host wall clock at capture, epoch millis. */
  capturedAt: z.number().int(),
  senderAgentId: z.string().nullable(),
  receiverAgentId: z.string().nullable(),
  responseId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  expectReply: z.boolean().nullable(),
  messageText: z.string().nullable(),
  noticeReason: z.string().nullable(),
  originKind: epicCommunicationGraphOriginKindSchema.nullable(),
  originChatId: z.string().nullable(),
  originRefId: z.string().nullable(),
  /** True for backlog uploaded by a lane that had not yet caught up when this
   * row was captured; false for a row captured by an already-live lane. Only
   * `false` is eligible for a live pulse - see the module doc above. */
  historicalUpload: z.boolean(),
});
export type HostCommunicationGraphCloudFeedEvent = z.infer<
  typeof hostCommunicationGraphCloudFeedEventSchema
>;

export const hostCommunicationGraphCloudFeedSubscribeOpenRequestSchemaV10 =
  z.object({
    epicId: z.string(),
    /**
     * Highest cursor the client has already applied FOR THE CLOUD FEED, or
     * null for a first open / no retained checkpoint. Required-and-nullable
     * for the same reason as the local contract's `sinceCursor`: "start from
     * the beginning" and "I forgot to send a cursor" must never be the same
     * request on the wire.
     */
    sinceCursor: hostCommunicationGraphCloudFeedCursorSchema.nullable(),
  });
export type HostCommunicationGraphCloudFeedSubscribeOpenRequestV10 = z.infer<
  typeof hostCommunicationGraphCloudFeedSubscribeOpenRequestSchemaV10
>;

export const hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10 =
  z.discriminatedUnion("kind", [
    /**
     * Host-authoritative confirmation that this stream serves the cloud
     * plane. The renderer never derives this verdict from subscription,
     * entitlement, or free-tier state itself. Relay failures use
     * `connectionState`; terminal refusals close the stream with a typed code.
     */
    z.object({
      kind: z.literal("availability"),
      availability: z.literal("available"),
      ...textFrameFields,
    }),
    /**
     * The first frame of this kind in an available-authority epoch is the
     * bounded initial batch above the retained cursor. A later cloud read may
     * send another snapshot in the SAME epoch when its deletion frontier
     * changes. Such a later snapshot is cursor-continuing: it neither starts
     * a new authority/history epoch nor resets the retained cursor or arrival
     * boundary. No availability frame in this contract revokes the plane or
     * starts another epoch; a later subscription resumes from the cursor the
     * client supplies.
     */
    z.object({
      kind: z.literal("snapshot"),
      epicId: z.string(),
      events: z.array(hostCommunicationGraphCloudFeedEventSchema),
      /**
       * On the initial snapshot, the cloud's headVersion as of the first read:
       * the arrival boundary, exactly like the local contract's `headId`. On a
       * later frontier-bearing snapshot, the headVersion is THAT current
       * read's boundary; it does not revise the epoch's established arrival
       * boundary or reset the cursor. Never negative; a graph with nothing
       * ingested yet reports 0, not null, because the cloud's version is a
       * counter, not a "last row" pointer.
       */
      headVersion: z.number().int().nonnegative(),
      /** Optional retained-row deletion boundary. Rows below it are obsolete. */
      frontier: z.number().int().nonnegative().optional(),
      ...textFrameFields,
    }),
    /** One row, continuing the same cursor-ascending sequence after the
     * initial snapshot and across any later frontier-bearing snapshots. Same
     * "not a liveness signal" caveat as the local contract. */
    z.object({
      kind: z.literal("event"),
      epicId: z.string(),
      event: hostCommunicationGraphCloudFeedEventSchema,
      ...textFrameFields,
    }),
    /**
     * Explicit proof that every cloud row through `headVersion` has been
     * accounted for, including rows the serving host skipped because this
     * wire version cannot represent them. `cursor` is the exact raw cloud
     * resume position after that accounting; it may therefore advance beyond
     * the last event frame visible to this client.
     */
    z.object({
      kind: z.literal("caughtUp"),
      epicId: z.string(),
      headVersion: z.number().int().nonnegative(),
      cursor: hostCommunicationGraphCloudFeedCursorSchema.nullable(),
      ...textFrameFields,
    }),
    /**
     * The relay could not currently reach the cloud feed (transient HTTP
     * failure, or the relay has not yet re-authenticated). The client keeps
     * its retained graph and cursor untouched and waits for either a later
     * `event`/`snapshot` frame or a reconnect - never a reason to discard
     * state or fall back to a bootstrap read.
     */
    z.object({
      kind: z.literal("connectionState"),
      connectionState: z.literal("reconnecting"),
      ...textFrameFields,
    }),
    z.object({
      kind: z.literal("pong"),
      ...textFrameFields,
    }),
  ]);
export type HostCommunicationGraphCloudFeedSubscribeServerFrameV10 = z.infer<
  typeof hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10
>;

export const hostCommunicationGraphCloudFeedSubscribeClientFrameSchemaV10 =
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ping"),
      ...textFrameFields,
    }),
  ]);
export type HostCommunicationGraphCloudFeedSubscribeClientFrameV10 = z.infer<
  typeof hostCommunicationGraphCloudFeedSubscribeClientFrameSchemaV10
>;

export const hostCommunicationGraphCloudFeedSubscribeV10 =
  defineStreamRpcContract({
    method: "host.communicationGraph.subscribe",
    schemaVersion: { major: 1, minor: 0 } as const,
    openRequestSchema:
      hostCommunicationGraphCloudFeedSubscribeOpenRequestSchemaV10,
    serverFrameSchema:
      hostCommunicationGraphCloudFeedSubscribeServerFrameSchemaV10,
    clientFrameSchema:
      hostCommunicationGraphCloudFeedSubscribeClientFrameSchemaV10,
  });
