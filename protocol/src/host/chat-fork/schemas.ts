import { z } from "zod";

/**
 * Host <-> client wire shapes for ticket 07's fork event.
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
 * ## `get` is a READ, and the only RPC here
 *
 * There was a `host.chatFork.resolve` beside it, and its deletion is the whole
 * point of this surface's revision (decision log, 2026-08-07, "Fork
 * resolution: detect everywhere, arbitrate nowhere, destroy nothing"): the
 * host now submits the deterministic decision ITSELF, through the server's
 * existing resolve transaction, at detection. Nothing arbitrates from the
 * client, so a client-facing resolve verb has no caller - and freezing one in
 * a release would have carried a dead arbitration shape forever.
 *
 * What survives is the read: an open episode is a real, observable host state
 * (it is what drives the per-chat `pendingFork` indicator) for the seconds
 * between detection and adoption, and after a filing failure for as long as
 * the report is undelivered. `get` is registered optional (`degrade: { kind:
 * "unsupported" }`, not on the released floor): a host predating it answers
 * `E_HOST_UNSUPPORTED` and the client degrades to no fork surface at all.
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
  /**
   * The local chat identity: authoritative for UI, option lookup, and
   * settlement on the publisher that raised the notice. It never changes when
   * a losing lineage is redirected.
   */
  chatId: z.string().min(1),
  /**
   * The cloud row whose lineage, repair, and fork occurrence are being
   * arbitrated. Always populated; equals `chatId` before any redirect and
   * differs after the local lineage publishes through a fork clone.
   */
  publicationChatId: z.string().min(1),
  /**
   * The chat's human name, as the host's registry holds it.
   *
   * Carried on the notice rather than joined by whoever renders it. A fork
   * notice is the one place a surface has nothing else to identify a chat
   * with: it is host-global, it can name chats in epics the reader has never
   * opened, and the local id it carries is a uuid. Every surface that renders
   * one without this field renders a uuid, which is what the auto-fork
   * notification exists not to do.
   *
   * Empty string when the registry row could not be read. Not nullable: a
   * consumer choosing copy has one falsy check either way, and "" degrades to
   * the same fallback a null would without adding a second absent-value shape
   * to a schema that already has `candidate: null` meaning something else.
   */
  chatTitle: z.string(),
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
   * can bundle several chats at different eras; the host's own auto-submission
   * fences each one against exactly this value rather than against a single
   * episode-level scalar.
   */
  repairEpoch: z.number().int().nonnegative(),
  /**
   * The host-minted identity of THIS fork occurrence. Not renderer content -
   * nothing displays it - but mirrored like every other field, because this
   * schema is a verbatim mirror of the host event by contract, and the
   * occurrence is what the server matches an auto-submitted decision against.
   */
  forkOccurrenceId: z.string().min(1),
});
export type ChatForkChatNotice = z.infer<typeof chatForkChatNoticeSchema>;

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
