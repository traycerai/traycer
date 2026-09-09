import { z } from "zod";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
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
