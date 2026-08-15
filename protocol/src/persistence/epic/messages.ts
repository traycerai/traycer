import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/versioned-record";
import {
  contentBlockSchema,
  contentBlockSchemaPreImage,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { tokenUsageSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  imageDimensionSchema,
  imageSha256HexSchema,
  supportedImageMediaTypeSchema,
} from "@traycer/protocol/persistence/epic/images";
import {
  agentSenderSchema,
  agentSenderSchemaPreInReplyTo,
  chatSessionAnchorSchema,
  chatSessionAnchorSchemaPreTurnTail,
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

// Terminal outcome of one markdown-referenced image the host tried to
// resolve. `resolved` ⇒ `attachmentHash`/`mediaType` are present; every other
// state renders a chip (consent/error) and carries no attachment.
export const imageResolutionStateSchema = z.enum([
  "resolved",
  "blocked",
  "consent-required",
  "oversized",
  "not-found",
]);
export type ImageResolutionState = z.infer<typeof imageResolutionStateSchema>;

const imageResolutionEntryBaseFields = {
  source: z.string(),
  canonicalSource: z.string(),
  width: imageDimensionSchema.default(null),
  height: imageDimensionSchema.default(null),
} as const;

const nonResolvedImageResolutionStateSchema = z.enum([
  "blocked",
  "consent-required",
  "oversized",
  "not-found",
]);

/**
 * One entry in an assistant message's durable image resolution record - the
 * host's authoritative answer for one markdown-referenced image (`![alt](src)`
 * in the assistant's text) found while streaming/persisting that message. The
 * GUI renders purely from this record (hash present ⇒ blob-cache render;
 * any non-resolved state ⇒ terminal failure text) rather than re-deriving
 * resolution client-side, so background
 * turns, re-opened chats, and multi-window rendering stay deterministic.
 * `canonicalSource` is the normalized identity; `source` is the raw markdown
 * reference as authored.
 *
 * State-discriminated so the invariant is structural, not just documented:
 * `resolved` REQUIRES a non-null `attachmentHash`/`mediaType` (there is
 * nothing to render otherwise), and every other state FORCES them to `null`
 * (a blocked/consent-required/error entry must never carry renderable
 * attachment data).
 */
export const imageResolutionEntrySchema = z.discriminatedUnion("state", [
  z.object({
    ...imageResolutionEntryBaseFields,
    state: z.literal("resolved"),
    attachmentHash: imageSha256HexSchema,
    mediaType: supportedImageMediaTypeSchema,
  }),
  z.object({
    ...imageResolutionEntryBaseFields,
    state: nonResolvedImageResolutionStateSchema,
    attachmentHash: z.null().default(null),
    mediaType: z.null().default(null),
  }),
]);
export type ImageResolutionEntry = z.infer<typeof imageResolutionEntrySchema>;

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
  /**
   * Durable image resolution record for this message's markdown-referenced
   * images (`chat.subscribe@1.7`), one entry per distinct `canonicalSource`.
   * Defaulted so messages persisted before image support existed parse
   * cleanly - a pre-1.7 message has no record, and its images render as
   * consent chips (see `imageResolutionEntrySchema`).
   */
  imageResolutions: z.array(imageResolutionEntrySchema).default([]),
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
  blocks: z.array(contentBlockSchemaPreImage),
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

// ── Wire-freeze variant (pre-image) ─────────────────────────────────────────
// Hand-frozen copy of `assistantMessageSchema` from before image support
// existed, with `blocks` swapped for the frozen `contentBlockSchemaPreImage`
// union. Bound to every released `chat.subscribe@1.0-1.6` minor (via the
// frozen chat-tree schemas) so those lines structurally match the shipped
// wire and can never observe `imageResults`/the image resolution record.
// `sender` reuses the LIVE (`inReplyTo`-bearing) shape - `1.4` is the minor
// that introduced it, and every minor this freeze binds (1.0-1.6) already
// shipped after that point except 1.0-1.3, which bind their own
// `assistantMessageSchemaPreInReplyTo` above instead. Field-for-field hand
// copy, NOT `.omit()`, so a future message field cannot silently leak onto a
// released wire line.
export const assistantMessageSchemaPreImage = z.object({
  role: z.literal("assistant"),
  messageId: z.string().min(1),
  sender: agentSenderSchema,
  blocks: z.array(contentBlockSchemaPreImage),
  startedAt: z.number().nullable().default(null),
  blocksVersion: z.number().int().nonnegative().optional(),
  timestamp: z.number(),
  turnId: z.string().nullable(),
  usage: tokenUsageSchema.nullable(),
  reasoningEffort: z.string().nullable().default(null),
  serviceTier: z.string().nullable().default(null),
});

// Wire-freeze copy of `userMessageSchema` with `sessionAnchor` swapped for
// its pre-`turnTailUuid` freeze (see `claudeChatSessionAnchorSchemaPreTurnTail`).
// Bound to the released `chat.subscribe@1.6` line - snapshot frames via
// `messageSchemaPreImage` below, `messageAccepted` frames via the
// pre-turn-tail common frame bundle in `subscribe.ts` - whose surface is
// frozen EXACTLY, so it can never observe the Claude anchor's `turnTailUuid`.
// Field-for-field hand copy, NOT `.omit()`/`.extend()` off the live shape.
export const userMessageSchemaPreTurnTail = z
  .object({
    role: z.literal("user"),
    messageId: z.string(),
    sender: userMessageSenderSchema,
    message: userMessagePayloadSchema,
    timestamp: z.number(),
    sessionAnchor: chatSessionAnchorSchemaPreTurnTail.nullable(),
  })
  .superRefine((message, ctx) => {
    if (message.sender.type === message.message.kind) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["message", "kind"],
      message: "User message sender.type must match message.kind.",
    });
  });

// The user branch is the pre-turn-tail freeze, not the live `userMessageSchema`:
// user messages carry no image fields (nothing changed for them at the
// image-freeze point), but their `sessionAnchor` gained `turnTailUuid` after
// `chat.subscribe@1.6` shipped, and this union is bound to that exactly-frozen
// line via the frozen chat trees.
export const messageSchemaPreImage = z.discriminatedUnion("role", [
  userMessageSchemaPreTurnTail,
  assistantMessageSchemaPreImage,
]);
