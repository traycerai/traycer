import { z } from "zod";

/**
 * Host <-> client wire shapes for ticket 07's fork event and its resolution.
 *
 * ## Verbatim pass-through
 *
 * The event schemas here are a wire-shape mirror of
 * `traycer-host/src/domain/chat-publish/chat-fork-event.ts`'s `ChatForkEvent`
 * and its nested types - one for one, field for field, deliberately. That file
 * says so about itself: "ticket 09 should be able to pass this through
 * verbatim." Nothing here re-derives, summarizes, or adds interpretation the
 * host did not already compute; a renderer that needed something not present
 * (a message excerpt, say) was a signal to extend the host's payload, not to
 * grow this file into a second opinion about what a fork looks like.
 *
 * ## Candidates are described by content, never by device
 *
 * The settled UX ruling (decision log, "Fork-resolution prompt", 2026-08-02):
 * a candidate is `throughRecordSeq` / `capturedAt` / `partCount` - "when, how
 * far, how much" - never a host id or a device name. `diagnostic` is the ONE
 * place machine provenance appears, worded as a cause ("a copied or restored
 * host directory is the usual cause"), never as an identity.
 *
 * The challenger side does NOT get a raw-content read: the user ruled it only
 * needs to be IDENTIFIED, not inspected, so this same "when / how far / how
 * much" summary IS the whole comparison for both sides - the published side
 * additionally has a full readable view through the ordinary cloud-chat
 * reader, since it is simply the chat's current head.
 *
 * ## Both RPCs here are optional capabilities
 *
 * `get` and `resolve` are registered as a SET (`degrade: { kind:
 * "unsupported" }`, not on the released floor): a host predating this surface
 * answers `E_HOST_UNSUPPORTED` for both, and the client's contract is to
 * degrade to no fork surface at all rather than a broken dialog - the chat
 * simply halts exactly as it always did, silently to the renderer, safely to
 * the data.
 */

// ---- The fork event, mirrored from chat-fork-event.ts verbatim --------- //

/** Mirrors `ChatForkCause` (`chat-publication-continuity.ts`) - a routing key, not prose. */
export const chatForkCauseSchema = z.enum([
  "sibling-of-receipt",
  "unrelated-lineage",
  "indeterminate",
]);
export type ChatForkCause = z.infer<typeof chatForkCauseSchema>;

/** Lowercase hex sha256 - the only form a content address is written in. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Mirrors `ChatForkCandidateSummary`. */
export const chatForkCandidateSummarySchema = z.object({
  headSha256: sha256HexSchema,
  /** The lineage this head extends, or null when it starts one. */
  parentHeadSha256: sha256HexSchema.nullable(),
  throughRecordSeq: z.number().int().nonnegative(),
  /** Wall-clock ms the head was serialized by whoever wrote it. */
  capturedAt: z.number(),
  /** Parts the head names. A rough size, and cheap - no part is fetched. */
  partCount: z.number().int().nonnegative(),
});
export type ChatForkCandidateSummary = z.infer<
  typeof chatForkCandidateSummarySchema
>;

/** Mirrors `ChatForkChatNotice`. */
export const chatForkChatNoticeSchema = z.object({
  taskId: z.string().min(1),
  chatId: z.string().min(1),
  /** The head the cloud holds - the lineage that would continue by default. */
  incumbent: chatForkCandidateSummarySchema,
  /**
   * This host's own candidate, quarantined at detection. Null when it could
   * not be composed - the episode is still real and still halts; there is
   * simply one side to inspect rather than two.
   */
  candidate: chatForkCandidateSummarySchema.nullable(),
  /**
   * This CHAT's own repair era at detection, not the episode's. An episode
   * can bundle several chats at different eras; `resolve` fences each one
   * against exactly this value rather than a single episode-level scalar.
   */
  repairEpoch: z.number().int().nonnegative(),
  /**
   * The host-minted identity of THIS fork occurrence. Not renderer content -
   * nothing displays it - but mirrored like every other field, because the
   * host reads it back off its own held event when `resolve` fans out, and
   * this schema is that event's one shape.
   */
  forkOccurrenceId: z.string().min(1),
});
export type ChatForkChatNotice = z.infer<typeof chatForkChatNoticeSchema>;

/** Mirrors `ChatForkDecisionOption`. */
export const chatForkDecisionOptionSchema = z.object({
  /** `winningHeadSha256` per chat, keyed by chatId. Absent = not covered by this option. */
  winners: z.record(z.string(), sha256HexSchema),
  label: z.enum(["keep-cloud-lineage", "keep-this-host-lineage"]),
  detail: z.string(),
});
export type ChatForkDecisionOption = z.infer<
  typeof chatForkDecisionOptionSchema
>;

/** Mirrors `ChatForkEvent`. */
export const chatForkEventSchema = z.object({
  kind: z.literal("chat-publication-fork"),
  /** Stable for the episode's life. A consumer seeing the same id twice knows it is a redelivery. */
  episodeId: z.string().min(1),
  detectedAt: z.number(),
  cause: chatForkCauseSchema,
  /** The same thing in a sentence - the only place machine provenance appears. */
  diagnostic: z.string(),
  chats: z.array(chatForkChatNoticeSchema),
  options: z.array(chatForkDecisionOptionSchema),
});
export type ChatForkEvent = z.infer<typeof chatForkEventSchema>;

// ---- host.chatFork.get --------------------------------------------------- //

export const chatForkGetRequestSchema = z.object({});
export type ChatForkGetRequest = z.infer<typeof chatForkGetRequestSchema>;

export const chatForkGetResponseSchema = z.object({
  /** Host-global, not epic-scoped: a fork episode can span chats across tasks. */
  event: chatForkEventSchema.nullable(),
});
export type ChatForkGetResponse = z.infer<typeof chatForkGetResponseSchema>;

// ---- host.chatFork.resolve ------------------------------------------------ //

/**
 * `episodeId` + `label` rather than an echoed winners map: the host holds the
 * authoritative current event (the same one `get` just answered), so it looks
 * up `option.winners` itself. That is what makes a stale submission - the
 * episode already closed, a new one opened - detectable server-side instead
 * of trusted from the request.
 */
export const chatForkResolveRequestSchema = z.object({
  episodeId: z.string().min(1),
  label: z.enum(["keep-cloud-lineage", "keep-this-host-lineage"]),
});
export type ChatForkResolveRequest = z.infer<
  typeof chatForkResolveRequestSchema
>;

/**
 * Three outcomes per chat, not a boolean - each needs a different render:
 *
 * - `resolved` - a decision covers this chat; show the clone mapping.
 * - `stale` - THIS chat's repair era raced (a delayed submission, a fork that
 *   moved on since the episode was fetched). Distinct from the top-level
 *   `outcome: "stale"` above: that means the whole episode view is stale;
 *   this means one chat's server-side resolve specifically lost a race. The
 *   client's contract is the same either way - re-fetch via `get`.
 * - `not-ready` - the host detected this fork and surfaced it, but its
 *   durable report has not reached the server yet. Never collapsed into
 *   `resolved`: a caller that did would tell the owner "recorded" for a
 *   decision the server has nowhere to act on yet.
 */
export const chatForkResolveChatOutcomeSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      taskId: z.string().min(1),
      chatId: z.string().min(1),
      status: z.literal("resolved"),
      repairEpoch: z.number().int().nonnegative(),
      cloneChatId: z.string().nullable(),
    }),
    z.object({
      taskId: z.string().min(1),
      chatId: z.string().min(1),
      status: z.literal("stale"),
    }),
    z.object({
      taskId: z.string().min(1),
      chatId: z.string().min(1),
      status: z.literal("not-ready"),
    }),
  ],
);
export type ChatForkResolveChatOutcome = z.infer<
  typeof chatForkResolveChatOutcomeSchema
>;

export const chatForkResolveResponseSchema = z.object({
  /**
   * `stale` when `episodeId` no longer matches the currently open episode - it
   * was already decided, or a genuinely new fork opened. `results` is empty in
   * that case; the client's contract is to re-fetch via `get` rather than
   * retry the same submission.
   */
  outcome: z.enum(["resolved", "stale"]),
  results: z.array(chatForkResolveChatOutcomeSchema),
});
export type ChatForkResolveResponse = z.infer<
  typeof chatForkResolveResponseSchema
>;
