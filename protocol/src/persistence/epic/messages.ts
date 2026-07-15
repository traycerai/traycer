import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/versioned-record";
import { contentBlockSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import { tokenUsageSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  agentSenderSchema,
  agentSenderSchemaPreInReplyTo,
  chatSessionAnchorSchema,
  userMessageSenderSchema,
  userMessageSenderSchemaPreInReplyTo,
} from "@traycer/protocol/persistence/epic/senders";
import { z } from "zod";

/**
 * Materialized chat-message shapes. The on-disk Y.Array of messages is
 * versioned as the plain-JSON projection used here.
 */

const jsonContentSchema = getRecordSchema(
  commonRecordRegistry,
  "json-content",
  "latest",
);

export const agentUserMessageSchema = z.object({
  kind: z.literal("agent"),
  content: jsonContentSchema,
  fromAgentId: z.string(),
  senderTitle: z.string().nullable(),
  senderHarnessId: z.string().nullable(),
  reply: z.discriminatedUnion("expectsReply", [
    z.object({
      expectsReply: z.literal(true),
      responseId: z.string(),
    }),
    z.object({
      expectsReply: z.literal(false),
    }),
  ]),
});

export const userAuthoredMessageSchema = z.object({
  kind: z.literal("user"),
  content: jsonContentSchema,
});

export const userMessagePayloadSchema = z.discriminatedUnion("kind", [
  userAuthoredMessageSchema,
  agentUserMessageSchema,
]);
export type UserMessagePayload = z.infer<typeof userMessagePayloadSchema>;
export type AgentUserMessage = z.infer<typeof agentUserMessageSchema>;

export const userMessageSchema = z
  .object({
    role: z.literal("user"),
    messageId: z.string(),
    sender: userMessageSenderSchema,
    message: userMessagePayloadSchema,
    timestamp: z.number(),
    sessionAnchor: chatSessionAnchorSchema.nullable(),
  })
  .superRefine((message, ctx) => {
    if (message.sender.type === message.message.kind) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["message", "kind"],
      message: "User message sender.type must match message.kind.",
    });
  });
export type UserMessage = z.infer<typeof userMessageSchema>;

export const assistantMessageSchema = z.object({
  role: z.literal("assistant"),
  /**
   * Stable, unique id for this assistant row, minted once at creation and never
   * changed. The flat chat storage keys on it directly (`a:{messageId}`), so it
   * must be unique per row - unlike `startedAt`/`turnId`, which two distinct
   * assistant rows can share (a safe-point steering continuation reuses the
   * turn's `startedAt`/`turnId`; a multi-message provider turn shares one
   * `turnId`). Live turns mint a UUID; reconciled rows carry the provider
   * message id; migrated legacy rows are assigned one.
   */
  messageId: z.string().min(1),
  sender: agentSenderSchema,
  blocks: z.array(contentBlockSchema),
  /**
   * Wall-clock the turn began (ms). Set once at turn-start and never
   * overwritten; distinct from `timestamp` which the host rewrites on every
   * streaming delta. Nullable + default-null so already-persisted records
   * written before this field existed parse cleanly (missing key → null)
   * instead of rejecting the whole snapshot.
   */
  startedAt: z.number().nullable().default(null),
  blocksVersion: z.number().int().nonnegative().optional(),
  timestamp: z.number(),
  turnId: z.string().nullable(),
  usage: tokenUsageSchema.nullable(),
  /**
   * Reasoning/thinking effort the turn ran with (harness-specific id, e.g.
   * "high"). `null` when the harness/model exposes no effort control.
   */
  reasoningEffort: z.string().nullable().default(null),
  /**
   * Service / speed tier the turn ran with (e.g. Codex `"priority"` for the
   * Fast upgrade). `null` when the run used the harness default tier.
   */
  serviceTier: z.string().nullable().default(null),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const messageSchema = z.discriminatedUnion("role", [
  userMessageSchema,
  assistantMessageSchema,
]);
export type Message = z.infer<typeof messageSchema>;

// ── Wire-freeze variants (pre-inReplyTo) ────────────────────────────────────
// Hand-frozen copies of the message schemas with the sender leaf swapped for
// its pre-`inReplyTo` freeze (see `agentSenderSchemaPreInReplyTo`). Bound to the
// released `chat.subscribe@1.0–1.3` serverFrames so those lines structurally
// match the shipped wire and strip `inReplyTo` for older peers. Field-for-field
// hand copies, NOT `.omit()`/`.extend()` off the live shape — a future message
// field must not silently leak onto the frozen wire. Non-sender fields reuse the
// live sub-schemas (same convention as the frozen `chatSnapshotSchemaV1x`).
export const userMessageSchemaPreInReplyTo = z
  .object({
    role: z.literal("user"),
    messageId: z.string(),
    sender: userMessageSenderSchemaPreInReplyTo,
    message: userMessagePayloadSchema,
    timestamp: z.number(),
    sessionAnchor: chatSessionAnchorSchema.nullable(),
  })
  .superRefine((message, ctx) => {
    if (message.sender.type === message.message.kind) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["message", "kind"],
      message: "User message sender.type must match message.kind.",
    });
  });

export const assistantMessageSchemaPreInReplyTo = z.object({
  role: z.literal("assistant"),
  messageId: z.string().min(1),
  sender: agentSenderSchemaPreInReplyTo,
  blocks: z.array(contentBlockSchema),
  startedAt: z.number().nullable().default(null),
  blocksVersion: z.number().int().nonnegative().optional(),
  timestamp: z.number(),
  turnId: z.string().nullable(),
  usage: tokenUsageSchema.nullable(),
  reasoningEffort: z.string().nullable().default(null),
  serviceTier: z.string().nullable().default(null),
});

export const messageSchemaPreInReplyTo = z.discriminatedUnion("role", [
  userMessageSchemaPreInReplyTo,
  assistantMessageSchemaPreInReplyTo,
]);
