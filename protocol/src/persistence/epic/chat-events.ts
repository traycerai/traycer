import { z } from "zod";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
import { sha256HexSchema } from "@traycer/protocol/persistence/chat-sync/version";
import {
  userMessageSenderSchema,
  userMessageSenderSchemaPreInReplyTo,
  userMessageSenderSchemaPreReasonix,
} from "@traycer/protocol/persistence/epic/senders";

/**
 * Durable chat event log - append-only record of state transitions a
 * chat went through, captured outside the streaming text envelope so
 * cloud-replicated history can render past activity without replaying
 * the runtime stream.
 */

export const chatEventTypeSchema = z.enum([
  "send.accepted",
  "send.failed",
  "queue.added",
  "queue.edited",
  "queue.reordered",
  "queue.cancelled",
  "queue.steerRequested",
  "queue.steerAborted",
  "queue.paused",
  "queue.resumed",
  "queue.started",
  "queue.steered",
  "queue.fallback",
  "turn.started",
  "turn.completed",
  "turn.stopped",
  "turn.interrupted",
  "approval.requested",
  "approval.resolved",
  "approval.denied",
  "approval.abandoned",
  "interview.requested",
  "interview.resolved",
  "interview.errored",
  "checkpoint.captured",
  "checkpoint.restoreStarted",
  "checkpoint.restored",
  "permission.blocked",
  "harness.error",
  "history.deleted",
  "chat.forked",
  "chat.imported",
  "setup.creating",
  "setup.running",
  "setup.succeeded",
  "setup.failed",
  "setup.cancelled",
  "worktree.missing",
]);
export type ChatEventType = z.infer<typeof chatEventTypeSchema>;

export const chatEventSeveritySchema = z.enum(["info", "warning", "error"]);
export type ChatEventSeverity = z.infer<typeof chatEventSeveritySchema>;

export const chatEventSchema = z.object({
  eventId: z.string(),
  type: chatEventTypeSchema,
  timestamp: z.number(),
  clientActionId: z.string().nullable(),
  actor: userMessageSenderSchema.nullable(),
  message: z.string().nullable(),
  turnId: z.string().nullable(),
  messageId: z.string().nullable(),
  queueItemId: z.string().nullable(),
  approvalId: z.string().nullable(),
  blockId: z.string().nullable(),
  severity: chatEventSeveritySchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type ChatEvent = z.infer<typeof chatEventSchema>;

/**
 * Wire-freeze copy of the event-type enum WITHOUT `chat.imported`, bound to
 * every released `chat.subscribe` line (`1.0`–`1.5`).
 *
 * A `z.enum` is strict on both sides, so an added value is not additive on a
 * released host→client slot the way a nullable field is: a shipped client
 * parsing a chat that carries `chat.imported` would fail the WHOLE snapshot,
 * losing the transcript rather than one row. Session import ships on `1.6`, so
 * the released lines keep the enum they were released with and simply never
 * observe the event - which is correct, not merely safe: a client that cannot
 * render an import provenance row has nothing to do with the value anyway.
 *
 * Hand-frozen and NOT derived from `chatEventTypeSchema`, for the reason
 * `chatSchemaV14` gives: a released line that follows a live schema by
 * reference silently inherits every later addition.
 */
export const chatEventTypeSchemaPreImported = z.enum([
  "send.accepted",
  "send.failed",
  "queue.added",
  "queue.edited",
  "queue.reordered",
  "queue.cancelled",
  "queue.steerRequested",
  "queue.steerAborted",
  "queue.paused",
  "queue.resumed",
  "queue.started",
  "queue.steered",
  "queue.fallback",
  "turn.started",
  "turn.completed",
  "turn.stopped",
  "turn.interrupted",
  "approval.requested",
  "approval.resolved",
  "approval.denied",
  "approval.abandoned",
  "interview.requested",
  "interview.resolved",
  "interview.errored",
  "checkpoint.captured",
  "checkpoint.restoreStarted",
  "checkpoint.restored",
  "permission.blocked",
  "harness.error",
  "history.deleted",
  "chat.forked",
  "setup.creating",
  "setup.running",
  "setup.succeeded",
  "setup.failed",
  "setup.cancelled",
  "worktree.missing",
]);

// Wire-freeze copy with `actor` swapped for the pre-`inReplyTo` sender freeze,
// bound to `chat.subscribe@1.0–1.3` serverFrames (`eventAppended` + snapshot
// `chat.events`). Hand-frozen, not derived from the live shape. See
// `agentSenderSchemaPreInReplyTo`.
export const chatEventSchemaPreInReplyTo = z.object({
  eventId: z.string(),
  type: chatEventTypeSchemaPreImported,
  timestamp: z.number(),
  clientActionId: z.string().nullable(),
  actor: userMessageSenderSchemaPreInReplyTo.nullable(),
  message: z.string().nullable(),
  turnId: z.string().nullable(),
  messageId: z.string().nullable(),
  queueItemId: z.string().nullable(),
  approvalId: z.string().nullable(),
  blockId: z.string().nullable(),
  severity: chatEventSeveritySchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

// Wire-freeze copy bound to `chat.subscribe@1.4`/`@1.5` serverFrames
// (`eventAppended` + snapshot `chat.events`), frozen on BOTH axes a released
// peer's strict schema pins: `actor` on the pre-Reasonix sender (those lines
// shipped after `inReplyTo`, so that field stays) and `type` on the
// pre-`chat.imported` enum - the released lines predate both additions, and
// either one alone would let `eventAppended` carry a value a released client
// rejects. Hand-frozen, not derived.
export const chatEventSchemaPreReasonix = z.object({
  eventId: z.string(),
  type: chatEventTypeSchemaPreImported,
  timestamp: z.number(),
  clientActionId: z.string().nullable(),
  actor: userMessageSenderSchemaPreReasonix.nullable(),
  message: z.string().nullable(),
  turnId: z.string().nullable(),
  messageId: z.string().nullable(),
  queueItemId: z.string().nullable(),
  approvalId: z.string().nullable(),
  blockId: z.string().nullable(),
  severity: chatEventSeveritySchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

/**
 * The pre-`chat.imported` event shape on the LIVE sender tree: only the type
 * enum is pinned. This is the epic RECORD's freeze (`chatSchemaPreImported`),
 * which deliberately keeps following every other chat change - unlike the
 * wire freezes above, which pin the actor axis too because their released
 * peers' strict schemas do.
 */
export const chatEventSchemaPreImported = z.object({
  eventId: z.string(),
  type: chatEventTypeSchemaPreImported,
  timestamp: z.number(),
  clientActionId: z.string().nullable(),
  actor: userMessageSenderSchema.nullable(),
  message: z.string().nullable(),
  turnId: z.string().nullable(),
  messageId: z.string().nullable(),
  queueItemId: z.string().nullable(),
  approvalId: z.string().nullable(),
  blockId: z.string().nullable(),
  severity: chatEventSeveritySchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

/**
 * Typed reading of a `chat.imported` event's `metadata` bag.
 *
 * The event marks a chat that was materialized from a session the user ran in
 * a vendor CLI before Traycer ever saw it (session import). It is the chat's
 * only provenance record: the wizard writes it once as the chat's first event,
 * the transcript renders a system row from it, and the host's first-turn
 * context guard keys off it rather than off any resume-vs-fresh branch.
 *
 * `metadata` on `chatEventSchema` is an untyped bag on the wire (like every
 * other event's), so this schema is the parse contract both writer and readers
 * agree on rather than a wire shape. `sourceCwd` is the native session's own
 * working directory, kept even when that folder no longer exists - it is what
 * the row shows a user asking "where did this come from".
 *
 * `sourceCwd` is non-empty for the same reason it is here at all: the marker
 * discloses the source directory through a tooltip, and a tooltip with an
 * empty label renders nothing, so an empty path would leave a provenance row
 * that names no provenance. A folderless import does not produce one either -
 * the session's path survives the folder it named.
 */
export const chatImportedMetadataSchema = z.object({
  sourceProvider: guiHarnessIdSchema,
  nativeSessionId: z.string().min(1),
  importedAt: z.number(),
  sourceCwd: z.string().min(1),
});
export type ChatImportedMetadata = z.infer<typeof chatImportedMetadataSchema>;

/**
 * A chat's import provenance, or `null` for a chat Traycer created itself.
 *
 * Lives beside the schema because both sides read it: the host's first-turn
 * context guard and the renderer's provenance row and composer seeding all have
 * to agree on what "this chat came from somewhere else" means, and a second
 * reading of the same bag is how they would drift apart.
 *
 * Keyed off the EVENT rather than any session state - the event is appended
 * once, as the chat's first, and the log is append-only, so unlike a session
 * chain or an anchor this fact cannot be edited, trimmed, or rewound away.
 *
 * Returns `null` for a `chat.imported` event whose metadata does not parse
 * rather than throwing: the caller's question is "was this imported, and from
 * what", and a malformed bag cannot answer the second half. Degrading to "not
 * imported" costs a provenance row; throwing would cost the whole transcript.
 */
export function importedProvenance(
  events: readonly ChatEvent[],
): ChatImportedMetadata | null {
  for (const event of events) {
    if (event.type !== "chat.imported") continue;
    const parsed = chatImportedMetadataSchema.safeParse(event.metadata);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Typed reading of a `send.failed` event's `metadata` bag when that failure was
 * a QUEUED item's preparation failing - the host could not assemble what the
 * turn needs, so the item will not run and the queue is paused.
 *
 * Same shape of contract as `chatImportedMetadataSchema` above, for the same
 * reason: `metadata` is an untyped bag on the wire, so this schema is the parse
 * contract the writer and every reader agree on rather than a wire shape.
 * Nothing about the WIRE changes to carry this - the event, its broadcast and
 * its snapshot replay all already exist. What did not exist is one definition
 * of what the bag holds.
 *
 * `code` is deliberately an open `string` and NOT an enum. This bag already
 * carries the host's other preparation-failure codes, so a closed enum here
 * would make every existing one fail the parse - a contract that recognises
 * only the newest member is worse than the untyped bag it replaced. Readers
 * compare against the literal they care about (`"MISSING_ATTACHMENT_BYTES"`).
 *
 * `missingHashes` is REQUIRED, and the writer supplies `[]` for a code that
 * names no hashes. That is what keeps `null` meaning exactly one thing - *not a
 * queued preparation failure, or malformed* - instead of also meaning "a
 * preparation failure whose code happens not to carry hashes". An optional key
 * would have collapsed those two into one answer.
 *
 * `queueItemId` and `messageId` look like duplicates of fields the EVENT
 * already carries at top level. They are not, and the difference is load-
 * bearing: BOTH come from the QUEUED ITEM, which always has them
 * (`ChatQueuedPromptItem.messageId` is `z.string()`), whereas the event's
 * top-level `messageId` is `string | null` and answers a different question -
 * *is there a persisted message row to anchor this event to*. A preparation
 * that fails before the queued message is persisted writes `null` there and
 * still has a perfectly good item id to name.
 *
 * So these are the ITEM's identity, and carrying them makes the function
 * TOTAL: either you have a complete, actionable failure or you have `null`,
 * with no nullable field in between for a caller to narrow before it can
 * re-upload bytes or resume a queue. Taking both from the same `item` is also
 * what keeps them consistent with each other by construction. A reader that
 * only wants to key a transcript row should still prefer the event's own
 * fields - that is what they are for.
 */
export const queuedPreparationFailureMetadataSchema = z.object({
  code: z.string().min(1),
  queueItemId: z.string().min(1),
  messageId: z.string().min(1),
  // The persistence layer's content-address vocabulary, shared with the draft
  // tier's own schemas - the host's `draftBlobSha256Schema` is its twin over
  // the same regex. A second hash shape is how the "which bytes are missing"
  // set and the blob address space drift apart.
  missingHashes: z.array(sha256HexSchema),
});
export type QueuedPreparationFailureMetadata = z.infer<
  typeof queuedPreparationFailureMetadataSchema
>;

/**
 * The queued-preparation failure a `send.failed` event describes, or `null`.
 *
 * Takes the bag rather than the event because both callers already hold one and
 * the discrimination they need is on the CONTENT: a `send.failed` may come from
 * any number of paths, and only the ones written through
 * {@link queuedPreparationFailureMetadataSchema} are this. Check
 * `event.type === "send.failed"` yourself before calling if that matters to you.
 *
 * NEVER THROWS. `null` covers the bag being absent, the keys being missing, and
 * any value being malformed, with no way to tell those apart - by design, and
 * the same degrade `importedProvenance` makes one paragraph up. The caller's
 * question is "is there an actionable preparation failure here, and what is
 * missing", and every one of those cases answers it the same way: no. Throwing
 * would cost the whole transcript to report a bag the host wrote badly.
 *
 * SO `null` MEANS, CONCRETELY: not a preparation failure at all - a refusal
 * that REMOVED the item, or a speculative preparation on a synthetic item that
 * was never queued (the headless landing probe, the received-agent interrupt
 * restart, Steer Now's temporary item) - or a malformed bag. A `send.failed`
 * carrying `MISSING_ATTACHMENT_BYTES` and an ACTIONABLE preparation failure are
 * NOT the same set, and the headless probe is exactly the seeded-create landing
 * flow hash-only attachments are about, so this is not a corner.
 *
 * THE INVARIANT A READER MAY RELY ON, and it is an APPEND-TIME one: a NON-NULL
 * parse means that WHEN THE EVENT WAS APPENDED the named `queueItemId` was in
 * the queue and the queue was paused. It says nothing about now. This event is
 * durable and replayed in every snapshot, so a reader meets it again on each
 * resnapshot and reconnect, by which time the user may have cancelled the row
 * or resumed the queue by hand.
 *
 * So a reader acting on a non-null parse must re-check the LIVE queue state -
 * the item is still present, the queue is still paused - before acting, AND
 * AGAIN AFTER ANY `await`. The second half is the one that gets skipped: an
 * upload is a round trip, and the state this parse describes can change while
 * it is in flight, so a check performed only before the await has expired by
 * the time its result is used. Treat a non-null parse as "this is the failure
 * that happened", never as "this is what the queue looks like".
 *
 * That invariant is the WRITER's to keep and cannot be recovered here - a bag
 * for an unqueued item is byte-identical to one for a queued item, so no
 * amount of parsing distinguishes them. The host gates on queue membership at
 * the append (`failQueuedPromptPreparation`), which is the only place that
 * knows. Do not try to re-derive it in this function or in a reader; a
 * `queueItemId`-shaped heuristic here would be a second, weaker decider for a
 * question already answered correctly upstream.
 *
 * Concretely, because the obvious heuristic is worse than no heuristic: the
 * host's `"initial:"` id prefix is AMBIGUOUS BY CONSTRUCTION. It means "this
 * item came from a create's initial message", NOT "this item is synthetic" -
 * the durable seeded queue item and the headless probe mint the byte-identical
 * id for the same message. Filtering that prefix here would suppress the bag
 * for the seeded drain, which is the primary case this contract serves, while
 * doing nothing about the probe.
 */
export function queuedPreparationFailureFromEventMetadata(
  metadata: Record<string, unknown> | null,
): QueuedPreparationFailureMetadata | null {
  const parsed = queuedPreparationFailureMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}
