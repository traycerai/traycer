import { z } from "zod";

import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { toolCallFeedbackDraftStampSchema } from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * Host <-> client wire shapes for the feedback-draft card
 * (`chat.feedbackDraft.*`).
 *
 * An agent drafts feedback about Traycer with `traycer_draft_feedback`; the
 * host stamps it on the call's block (`tool_call.feedbackDraft`) and nothing
 * leaves the machine. The card on that block calls these methods:
 *
 * - `chat.feedbackDraft.preview` returns the diagnostics a send with the box
 *   ticked would attach, scrubbed exactly as they would ship, so "View" shows
 *   the real thing. It reads and changes nothing.
 * - `chat.feedbackDraft.decide` is the Send or Skip click. The host checks the
 *   caller may act on the chat, re-reads the block, writes the decision, sends
 *   on Send, and writes the outcome. Only a `pending` or `failed` draft can be
 *   decided; `failed` is how a send that did not arrive is tried again.
 *
 * Two methods, not one with a `preview` decision: a preview is a read with a
 * different answer (text, not a stamp), it may be repeated freely, and it
 * must never be confused with the click that sends.
 *
 * ## Optional capability
 *
 * Registered `degrade: { kind: "unsupported" }` and NOT on the released floor:
 * a host without these methods answers `E_HOST_UNSUPPORTED`, and the card
 * renders read-only, asking for a host update to send.
 */

/** The stamped block a request names. */
const chatFeedbackDraftBlockFields = {
  epicId: lazySchema(() => z.string().min(1)),
  chatId: lazySchema(() => z.string().min(1)),
  blockId: lazySchema(() => z.string().min(1)),
};

/**
 * Why the host refused a request:
 *
 * - `not-draft-block` - the block carries no `feedbackDraft` stamp.
 * - `not-allowed` - the caller may not act on this chat.
 * - `session-unavailable` - this host is not the chat's binding host.
 * - `already-decided` - the draft is `sent` or `skipped`; the response
 *   carries the stamp as it stands.
 */
export const chatFeedbackDraftErrorCodeSchema = lazySchema(() =>
  z.enum([
    "not-draft-block",
    "not-allowed",
    "session-unavailable",
    "already-decided",
  ]),
);
export type ChatFeedbackDraftErrorCode = z.infer<
  typeof chatFeedbackDraftErrorCodeSchema
>;

const chatFeedbackDraftErrorSchema = lazySchema(() =>
  z.object({
    kind: z.literal("error"),
    code: chatFeedbackDraftErrorCodeSchema,
    /** The stamp as it stands, for `already-decided`; `null` otherwise. */
    feedbackDraft: toolCallFeedbackDraftStampSchema.nullable(),
  }),
);

// ─── chat.feedbackDraft.decide ────────────────────────────────────────────

export const chatFeedbackDraftDecisionSchema = lazySchema(() =>
  z.enum(["send", "skip"]),
);
export type ChatFeedbackDraftDecision = z.infer<
  typeof chatFeedbackDraftDecisionSchema
>;

/**
 * `includeDiagnostics` is read only for `send`. `clientActionId` makes a
 * retried click idempotent: a repeat of the click that settled the draft
 * answers `settled` with the same stamp instead of `already-decided`.
 */
export const chatFeedbackDraftDecideRequestSchema = lazySchema(() =>
  z.object({
    ...chatFeedbackDraftBlockFields,
    decision: chatFeedbackDraftDecisionSchema,
    includeDiagnostics: z.boolean(),
    clientActionId: z.string().min(1).max(128),
  }),
);
export type ChatFeedbackDraftDecideRequest = z.infer<
  typeof chatFeedbackDraftDecideRequestSchema
>;

/**
 * `settled` carries the stamp the host wrote: `sent` or `skipped`, or
 * `failed` when the send did not reach Traycer (the card offers Send again).
 */
export const chatFeedbackDraftDecideResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("settled"),
      feedbackDraft: toolCallFeedbackDraftStampSchema,
    }),
    chatFeedbackDraftErrorSchema,
  ]),
);
export type ChatFeedbackDraftDecideResponse = z.infer<
  typeof chatFeedbackDraftDecideResponseSchema
>;

export const chatFeedbackDraftDecideV10 = defineRpcContract({
  method: "chat.feedbackDraft.decide",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatFeedbackDraftDecideRequestSchema,
  responseSchema: chatFeedbackDraftDecideResponseSchema,
});

// ─── chat.feedbackDraft.preview ───────────────────────────────────────────

export const chatFeedbackDraftPreviewRequestSchema = lazySchema(() =>
  z.object({ ...chatFeedbackDraftBlockFields }),
);
export type ChatFeedbackDraftPreviewRequest = z.infer<
  typeof chatFeedbackDraftPreviewRequestSchema
>;

/**
 * What a send with diagnostics would attach: `details` (host version,
 * platform, harness, model, as label/value pairs) and the scrubbed log tail.
 * `logTailTruncated` is true when the tail was cut to its line or byte cap.
 */
export const chatFeedbackDraftPreviewResponseSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("preview"),
      details: z.array(z.object({ label: z.string(), value: z.string() })),
      logTail: z.string(),
      logTailTruncated: z.boolean(),
    }),
    chatFeedbackDraftErrorSchema,
  ]),
);
export type ChatFeedbackDraftPreviewResponse = z.infer<
  typeof chatFeedbackDraftPreviewResponseSchema
>;

export const chatFeedbackDraftPreviewV10 = defineRpcContract({
  method: "chat.feedbackDraft.preview",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatFeedbackDraftPreviewRequestSchema,
  responseSchema: chatFeedbackDraftPreviewResponseSchema,
});
