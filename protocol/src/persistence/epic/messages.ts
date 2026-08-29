import { commonRecordRegistry } from "@traycer/protocol/common/registry";
import { getRecordSchema } from "@traycer/protocol/framework/versioned-record";
import {
  contentBlockSchema,
  contentBlockSchemaPreImage,
  contentBlockSchemaPreReasonix,
  contentBlockSchemaPreSettlement,
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
  agentSenderSchemaPreReasonix,
  chatSessionAnchorSchema,
  chatSessionAnchorSchemaPreReasonix,
  userMessageSenderSchema,
  userMessageSenderSchemaPreInReplyTo,
  userMessageSenderSchemaPreReasonix,
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

/**
 * Browser-annotations ticket 05. One attached annotation bundle: structured
 * fields only (no pixels). The crop rides the existing `imageAttachment`
 * content atom, paired by `imageFileName` / `annotationId`.
 *
 * Lives on its own array (`browserAnnotations`) rather than folded into
 * `content`. Adding a new content-block kind would be a breaking persist
 * change and would leak onto every frozen `chat.subscribe` send/snapshot
 * line.
 */
export const browserAnnotationCountsSchema = z.object({
  elements: z.number().int().nonnegative(),
  regions: z.number().int().nonnegative(),
  strokes: z.number().int().nonnegative(),
});
export type BrowserAnnotationCounts = z.infer<
  typeof browserAnnotationCountsSchema
>;

export const browserViewElementBoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
  left: z.number(),
});
export type BrowserViewElementBoundingBox = z.infer<
  typeof browserViewElementBoundingBoxSchema
>;

export const browserViewElementAttributeSchema = z.object({
  name: z.string(),
  value: z.string(),
});
export type BrowserViewElementAttribute = z.infer<
  typeof browserViewElementAttributeSchema
>;

export const browserViewElementStyleSchema = z.object({
  property: z.string(),
  value: z.string(),
});
export type BrowserViewElementStyle = z.infer<
  typeof browserViewElementStyleSchema
>;

export const browserViewElementCaptureSchema = z.object({
  selector: z.string(),
  tagName: z.string(),
  elementId: z.string().nullable(),
  classNames: z.array(z.string()),
  attributes: z.array(browserViewElementAttributeSchema),
  outerHtml: z.string(),
  outerHtmlTruncated: z.boolean(),
  textPreview: z.string().nullable(),
  ariaRole: z.string().nullable(),
  accessibleName: z.string().nullable(),
  boundingBox: browserViewElementBoundingBoxSchema,
  computedStyles: z.array(browserViewElementStyleSchema),
});
export type BrowserViewElementCapture = z.infer<
  typeof browserViewElementCaptureSchema
>;

export const browserAnnotationRecordSchema = z.object({
  kind: z.literal("browser-annotation"),
  annotationId: z.string().min(1),
  tabId: z.string().min(1),
  sessionId: z.string().min(1),
  origin: z.string(),
  pageUrl: z.string(),
  pageTitle: z.string(),
  capturedAt: z.number(),
  comment: z.string(),
  counts: browserAnnotationCountsSchema,
  elements: z.array(browserViewElementCaptureSchema),
  imageFileName: z.string().min(1),
  imageHash: z.string().min(1),
  // Element marks outlined on the crop that did not survive capture-budget
  // trim. 0 when every marked element was delivered. Live 1.7 only.
  // `.default(0)` so records written before this field parse cleanly.
  droppedElementCount: z.number().int().nonnegative().default(0),
});
export type BrowserAnnotationRecord = z.infer<
  typeof browserAnnotationRecordSchema
>;

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

const userAuthoredMessagePreTicket13Fields = {
  kind: z.literal("user"),
  content: jsonContentSchema,
} as const;

/**
 * Frozen user-authored payload as shipped on `chat.subscribe@1.0–1.6`
 * (main's 1.6 freeze). Ticket 05's `browserAnnotations` is live-1.7-only: it
 * must not leak onto a released snapshot / `messageAccepted` / queue item.
 */
export const userAuthoredMessageSchemaPreAnnotation = z.object(
  userAuthoredMessagePreTicket13Fields,
);

export const userAuthoredMessageSchema = z.object({
  ...userAuthoredMessagePreTicket13Fields,
  /**
   * Browser-annotations ticket 05. Empty for every message before this
   * shipped and for one with no annotation attached. `.default([])` so
   * already-persisted records parse cleanly.
   *
   * Persisted here rather than kept as transient send-time state (contrast
   * `worktreeIntent`, a wire-only "send" field the host consumes and
   * discards): a queued send re-derives its prompt from THIS persisted
   * message at drain time, not from the original `send` frame, so dropping
   * the field here would silently lose the user's annotation for any
   * message that sits in the queue before its turn starts.
   *
   * Wire: live `chat.subscribe@1.7` only. Frozen 1.0–1.6 copies omit it.
   */
  browserAnnotations: z.array(browserAnnotationRecordSchema).default([]),
});

export const userMessagePayloadSchemaPreAnnotation = z.discriminatedUnion(
  "kind",
  [userAuthoredMessageSchemaPreAnnotation, agentUserMessageSchema],
);

export const userMessagePayloadSchema = z.discriminatedUnion("kind", [
  userAuthoredMessageSchema,
  agentUserMessageSchema,
]);
export type UserMessagePayload = z.infer<typeof userMessagePayloadSchema>;
export type AgentUserMessage = z.infer<typeof agentUserMessageSchema>;

const userMessageSenderKindRefine = (
  message: { sender: { type: string }; message: { kind: string } },
  ctx: z.RefinementCtx,
): void => {
  if (message.sender.type === message.message.kind) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["message", "kind"],
    message: "User message sender.type must match message.kind.",
  });
};

export const userMessageSchema = z
  .object({
    role: z.literal("user"),
    messageId: z.string(),
    sender: userMessageSenderSchema,
    message: userMessagePayloadSchema,
    timestamp: z.number(),
    sessionAnchor: chatSessionAnchorSchema.nullable(),
  })
  .superRefine(userMessageSenderKindRefine);
export type UserMessage = z.infer<typeof userMessageSchema>;

/**
 * Live sender/anchor, pre-annotation payload. Bound to
 * `chat.subscribe@1.4–1.5` `messageAccepted` / common frames so those
 * released lines never declare `browserAnnotations`.
 */
export const userMessageSchemaPreAnnotation = z
  .object({
    role: z.literal("user"),
    messageId: z.string(),
    sender: userMessageSenderSchema,
    message: userMessagePayloadSchemaPreAnnotation,
    timestamp: z.number(),
    sessionAnchor: chatSessionAnchorSchema.nullable(),
  })
  .superRefine(userMessageSenderKindRefine);

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
   * NAME of the environment variable whose credential authenticated this turn
   * (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`); `null` when the turn ran
   * on the profile the user signed into.
   *
   * Recorded, not derived. The provider CLI prefers an env key/token over its
   * own signed-in store, so "which account did this turn actually run on?" has
   * an answer the displayed profile label alone gets WRONG - and the answer is
   * knowable only at spawn time. It is stamped from the adapter's `turn.started`
   * and never recomputed; a renderer that re-derived it at display time would
   * answer for today's environment, not this turn's.
   *
   * `null` IS the claim "the profile sign-in was used", so the field carries
   * meaning in both states. Defaulted so turns persisted before it existed parse
   * cleanly - those legacy rows read as `null` and therefore make that claim
   * without evidence, which is why the renderer shows the annotation only on a
   * POSITIVE value and never renders a "signed in normally" badge from absence.
   *
   * The name only, never the value: this record replicates cross-host.
   */
  envCredentialVar: z.string().nullable().default(null),
  /**
   * Durable image resolution record for this message's markdown-referenced
   * images (`chat.subscribe@1.6`), one entry per distinct `canonicalSource`.
   * Defaulted so messages persisted before image support existed parse
   * cleanly - a pre-1.6 message has no record, and its images render as
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

// ── Wire-freeze variants (pre-Reasonix, LIVE shape) ─────────────────────────
// Hand-frozen copies of the LIVE message schemas — every field the live shapes
// carry, including `imageResolutions` and the `turnTailUuid`-bearing anchor —
// with only the harness-bearing leaves swapped for their pre-Reasonix copies.
// Bound to `chat.subscribe@1.6`, which shipped that whole shape at 19 harness
// ids. The `1.0–1.5` copies above additionally freeze shape; these freeze the
// enum alone. Field-for-field hand copies, NOT `.extend()` off the live shape.
export const userMessageSchemaPreReasonix = z
  .object({
    role: z.literal("user"),
    messageId: z.string(),
    sender: userMessageSenderSchemaPreReasonix,
    // Pre-annotation payload: `browserAnnotations` is live-1.7-only, minted
    // after these lines shipped, so a released peer's wire never carries it.
    // This freeze now also serves the `1.4`/`1.5` chat trees that the removed
    // pre-turnTailUuid copy used to, and those are host->client slots - a
    // consumer reading the key there would find it undefined.
    message: userMessagePayloadSchemaPreAnnotation,
    timestamp: z.number(),
    sessionAnchor: chatSessionAnchorSchemaPreReasonix.nullable(),
  })
  .superRefine((message, ctx) => {
    if (message.sender.type === message.message.kind) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["message", "kind"],
      message: "User message sender.type must match message.kind.",
    });
  });

/**
 * Exact user-message branch released on `chat.subscribe@1.6`: live session
 * anchors, but neither Reasonix sender ids nor browser payload fields.
 */
export const userMessageSchemaV16 = z
  .object({
    role: z.literal("user"),
    messageId: z.string(),
    sender: userMessageSenderSchemaPreReasonix,
    message: userMessagePayloadSchemaPreAnnotation,
    timestamp: z.number(),
    sessionAnchor: chatSessionAnchorSchemaPreReasonix.nullable(),
  })
  .superRefine(userMessageSenderKindRefine);

export const assistantMessageSchemaPreReasonix = z.object({
  role: z.literal("assistant"),
  messageId: z.string().min(1),
  sender: agentSenderSchemaPreReasonix,
  blocks: z.array(contentBlockSchemaPreReasonix),
  startedAt: z.number().nullable().default(null),
  blocksVersion: z.number().int().nonnegative().optional(),
  timestamp: z.number(),
  turnId: z.string().nullable(),
  usage: tokenUsageSchema.nullable(),
  reasoningEffort: z.string().nullable().default(null),
  serviceTier: z.string().nullable().default(null),
  imageResolutions: z.array(imageResolutionEntrySchema).default([]),
});

export const messageSchemaPreReasonix = z.discriminatedUnion("role", [
  userMessageSchemaPreReasonix,
  assistantMessageSchemaPreReasonix,
]);

// ── Wire-freeze variants (pre-inReplyTo) ────────────────────────────────────
// Hand-frozen copies of the message schemas with the sender leaf swapped for
// its pre-`inReplyTo` freeze (see `agentSenderSchemaPreInReplyTo`). Bound to the
// released `chat.subscribe@1.0–1.3` serverFrames so those lines structurally
// match the shipped wire and strip `inReplyTo` for older peers. Field-for-field
// hand copies, NOT `.omit()`/`.extend()` off the live shape — a future message
// field must not silently leak onto the frozen wire. Non-sender fields reuse the
// live sub-schemas except the session anchor: released peers must also stay on
// the pre-Reasonix anchor union, otherwise a new host can emit a discriminant
// their installed schema does not know.
export const userMessageSchemaPreInReplyTo = z
  .object({
    role: z.literal("user"),
    messageId: z.string(),
    sender: userMessageSenderSchemaPreInReplyTo,
    message: userMessagePayloadSchemaPreAnnotation,
    timestamp: z.number(),
    // Pre-Reasonix, NOT a pre-`turnTailUuid` copy: the released baseline
    // proves `1.0–1.3` SHIPPED the Claude anchor's `turnTailUuid` (the minors
    // composed the then-live union at release), so a transcription without it
    // is a retroactive narrowing - the exact silent field-strip the
    // released-line-narrowing test exists to catch.
    sessionAnchor: chatSessionAnchorSchemaPreReasonix.nullable(),
  })
  .superRefine(userMessageSenderKindRefine);

export const assistantMessageSchemaPreInReplyTo = z.object({
  role: z.literal("assistant"),
  messageId: z.string().min(1),
  sender: agentSenderSchemaPreInReplyTo,
  // Pre-Reasonix block union: `plan`, `text.providerNotice` and `steer.sender`
  // all carry a harness id onto this released line.
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
// union. Bound to every released `chat.subscribe@1.0-1.5` minor (via the
// frozen chat-tree schemas) so those lines structurally match the shipped
// wire and can never observe `imageResults`/the image resolution record.
// `sender` reuses the LIVE (`inReplyTo`-bearing) shape - `1.4` is the minor
// that introduced it, and every minor this freeze binds (1.0-1.5) already
// shipped after that point except 1.0-1.3, which bind their own
// `assistantMessageSchemaPreInReplyTo` above instead. Field-for-field hand
// copy, NOT `.omit()`, so a future message field cannot silently leak onto a
// released wire line.
export const assistantMessageSchemaPreImage = z.object({
  role: z.literal("assistant"),
  messageId: z.string().min(1),
  // Pre-Reasonix sender + block union. `1.4`/`1.5` shipped `inReplyTo`, so the
  // sender keeps that field and freezes only the harness enum.
  sender: agentSenderSchemaPreReasonix,
  blocks: z.array(contentBlockSchemaPreImage),
  startedAt: z.number().nullable().default(null),
  blocksVersion: z.number().int().nonnegative().optional(),
  timestamp: z.number(),
  turnId: z.string().nullable(),
  usage: tokenUsageSchema.nullable(),
  reasoningEffort: z.string().nullable().default(null),
  serviceTier: z.string().nullable().default(null),
});

// The user branch is the pre-Reasonix freeze, not the live `userMessageSchema`:
// user messages carry no image fields (nothing changed for them at the
// image-freeze point), but their sender/anchor harness ENUM must stay frozen
// for the released `chatSchemaV14`/`chatSchemaV15` trees this union serves.
// An earlier revision bound a hand-frozen "pre-turnTailUuid" anchor copy here
// on the belief that `1.4`/`1.5` shipped before the field existed; the
// released baseline disproved that (those minors composed the then-live
// anchor union at release, `turnTailUuid` included), so the copy was a
// retroactive narrowing and was removed.
export const messageSchemaPreImage = z.discriminatedUnion("role", [
  userMessageSchemaPreReasonix,
  assistantMessageSchemaPreImage,
]);

// ── Wire-freeze variant (pre-interview-settlement, `chat.subscribe@1.6`) ────
// Hand-frozen copy of `assistantMessageSchema` as the `host-v1.2.0-rc.1` `1.6`
// line shipped it: the image fields ARE present (that is the minor that added
// them), and only `blocks` is swapped for the frozen
// `contentBlockSchemaPreSettlement` union so a `1.6` peer never observes
// canonical interview settlement or answer selection evidence.
//
// `sender` additionally takes its pre-Reasonix freeze: `1.6` is released with a
// nineteen-id harness enum, so the assistant row's `harnessId` - stamped
// per-turn off the chat's settings and never rewritten - must not carry an id
// that cohort cannot decode.
//
// Field-for-field hand copy, NOT `.omit()`/`.extend()` - see
// `assistantMessageSchemaPreImage` for why a released line must not follow the
// live shape by reference.
export const assistantMessageSchemaPreSettlement = z.object({
  role: z.literal("assistant"),
  messageId: z.string().min(1),
  sender: agentSenderSchemaPreReasonix,
  blocks: z.array(contentBlockSchemaPreSettlement),
  startedAt: z.number().nullable().default(null),
  blocksVersion: z.number().int().nonnegative().optional(),
  timestamp: z.number(),
  turnId: z.string().nullable(),
  usage: tokenUsageSchema.nullable(),
  reasoningEffort: z.string().nullable().default(null),
  serviceTier: z.string().nullable().default(null),
  imageResolutions: z.array(imageResolutionEntrySchema).default([]),
});

// The user branch keeps every live field EXCEPT the harness enum: the Claude
// anchor's `turnTailUuid` predates the `1.6` cut so a real `1.6` peer does
// observe it, but that peer's `sessionAnchor` union has no Reasonix variant and
// its A2A sender enum has no Reasonix id. Browser payload fields also arrived
// after 1.6, so the user branch binds the exact combined freeze.
export const messageSchemaPreSettlement = z.discriminatedUnion("role", [
  userMessageSchemaV16,
  assistantMessageSchemaPreSettlement,
]);
