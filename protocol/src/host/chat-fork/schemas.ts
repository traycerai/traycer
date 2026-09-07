import { z } from "zod";

/**
 * Host <-> client wire shapes for ticket 07's fork event.
 * `diagnostic` is the ONE place machine provenance appears, worded as a cause ("a copied or restored host directory is the usual cause"), never as an identity.
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
   * The local chat identity: authoritative for UI, option lookup, and settlement on the publisher that raised the notice.
   * It never changes when a losing lineage is redirected.
   */
  chatId: z.string().min(1),
  /** The cloud row whose lineage, repair, and fork occurrence are being arbitrated. */
  publicationChatId: z.string().min(1),
  /**
   * The chat's human name, as the host's registry holds it.
   * A fork notice is the one place a surface has nothing else to identify a chat with: it is host-global, it can name chats in epics the reader has never opened, and the local id it carries is a uuid.
   */
  chatTitle: z.string(),
  /** The head the cloud holds - the lineage that would continue by default. */
  incumbent: chatForkCandidateSummarySchema,
  /** This host's own candidate, quarantined at detection. */
  candidate: chatForkCandidateSummarySchema.nullable(),
  /** This CHAT's own repair era at detection, not the episode's. */
  repairEpoch: z.number().int().nonnegative(),
  /** The host-minted identity of THIS fork occurrence. */
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
