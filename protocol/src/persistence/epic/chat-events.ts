import { z } from "zod";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  userMessageSenderSchema,
  userMessageSenderSchemaPreInReplyTo,
  userMessageSenderSchemaPreReasonix,
} from "@traycer/protocol/persistence/epic/senders";


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
 * Wire-freeze copy of the event-type enum WITHOUT `chat.imported`, bound to every released `chat.subscribe` line (`1.0`-`1.5`).
 * Hand-frozen and NOT derived from `chatEventTypeSchema`, for the reason `chatSchemaV14` gives: a released line that follows a live schema by reference silently inherits every later addition.
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

// Wire-freeze copy with `actor` swapped for the pre-`inReplyTo` sender freeze, bound to `chat.subscribe@1.0-1.3` serverFrames (`eventAppended` + snapshot `chat.events`).
// Hand-frozen, not derived from the live shape.
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

// Wire-freeze copy bound to `chat.subscribe@1.4`/`@1.5` serverFrames (`eventAppended` + snapshot `chat.events`), frozen on BOTH axes a released peer's strict schema pins: `actor` on the pre-Reasonix sender (those lines.
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
 * The pre-`chat.imported` event shape on the LIVE sender tree: only the type enum is pinned.
 * This is the epic RECORD's freeze (`chatSchemaPreImported`), which deliberately keeps following every other chat change - unlike the wire freezes above, which pin the actor axis too because their released peers' strict.
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

/** Typed reading of a `chat.imported` event's `metadata` bag. */
export const chatImportedMetadataSchema = z.object({
  sourceProvider: guiHarnessIdSchema,
  nativeSessionId: z.string().min(1),
  importedAt: z.number(),
  sourceCwd: z.string().min(1),
});
export type ChatImportedMetadata = z.infer<typeof chatImportedMetadataSchema>;

/**
 * A chat's import provenance, or `null` for a chat Traycer created itself.
 * Returns `null` for a `chat.imported` event whose metadata does not parse rather than throwing: the caller's question is "was this imported, and from what", and a malformed bag cannot answer the second half.
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
