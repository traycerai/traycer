import { z } from "zod";
import {
  userMessageSenderSchema,
  userMessageSenderSchemaPreInReplyTo,
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

// Wire-freeze copy with `actor` swapped for the pre-`inReplyTo` sender freeze,
// bound to `chat.subscribe@1.0–1.3` serverFrames (`eventAppended` + snapshot
// `chat.events`). Hand-frozen, not derived from the live shape. See
// `agentSenderSchemaPreInReplyTo`.
export const chatEventSchemaPreInReplyTo = z.object({
  eventId: z.string(),
  type: chatEventTypeSchema,
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
