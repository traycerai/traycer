import { z } from "zod";

/**
 * Wire mirror of `@traycerai/common`'s `UsageSummary` shapes (the shared
 * aggregator's output) - `@traycer/protocol` is an OSS package and must not
 * depend on the internal `@traycerai/common` package, so these are
 * independently declared here, the same way `usageAnalyticsIngestFactV1Schema`
 * mirrors the host's fact enums without importing them.
 */

export const usageSummaryOutcomeSchema = z.enum([
  "completed",
  "stopped",
  "interrupted",
  "abnormal_exit",
]);

export const usageSummaryCompletenessSchema = z.enum([
  "measured",
  "partial",
  "absent",
]);

/** Weakest-first ladder from the pricing artifact; `null` never rides the wire - the aggregator already folds a legacy-`null` fact into `unpriced`. */
export const usageSummaryCostProvenanceSchema = z.enum([
  "unpriced",
  "modelPriced",
  "providerReported",
]);

const nonNegativeIntSchema = z.number().int().nonnegative();

export const usageSummaryTokenTotalsSchema = z.object({
  uncachedInputTokens: nonNegativeIntSchema,
  cacheReadInputTokens: nonNegativeIntSchema,
  cacheCreationTokens: nonNegativeIntSchema,
  outputTokens: nonNegativeIntSchema,
});

/**
 * The aggregator's grouping key: a local calendar day in the request's
 * timezone, `YYYY-MM-DD` (what `en-CA` numeric formatting emits). Shaped
 * rather than merely length-bounded because this key is parsed, sorted and
 * decremented as a calendar date on the client - a `"2026-1-1"` would pass
 * a length check and then mis-sort and mis-label.
 */
const usageDayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const usageSummaryBucketSchema = z.object({
  day: usageDayKeySchema,
  harnessId: z.string().min(1).max(64),
  model: z.string().min(1).max(255),
  factCount: nonNegativeIntSchema,
  tokens: usageSummaryTokenTotalsSchema,
  knownCostUsd: z.number().finite(),
  /** Sum of every non-null `cacheSavingsUsd` in this bucket. */
  knownCacheSavingsUsd: z.number().finite(),
  /** Sum of every non-null `reasoningTokens` in this bucket - informational only, never folded into `tokens`. */
  knownReasoningTokens: nonNegativeIntSchema,
  costProvenance: usageSummaryCostProvenanceSchema,
});

export const usageSummaryWindowBoundsSchema = z.object({
  timezone: z.string().min(1).max(100),
  windowDays: z.number().int().positive(),
  startAtInclusive: nonNegativeIntSchema,
  endAtExclusive: nonNegativeIntSchema,
});

/** Cost + fact count + token count for one provenance rung - ticket 10's per-provenance cost split. */
export const usageProvenanceSplitEntrySchema = z.object({
  costUsd: z.number().finite(),
  factCount: nonNegativeIntSchema,
  tokenCount: nonNegativeIntSchema,
});

export const usageProvenanceSplitSchema = z.object({
  unpriced: usageProvenanceSplitEntrySchema,
  modelPriced: usageProvenanceSplitEntrySchema,
  providerReported: usageProvenanceSplitEntrySchema,
});

export const usageSummaryTotalsSchema = z.object({
  factCount: nonNegativeIntSchema,
  tokens: usageSummaryTokenTotalsSchema,
  knownCostUsd: z.number().finite(),
  /** Sum of every non-null `cacheSavingsUsd` in the window. */
  knownCacheSavingsUsd: z.number().finite(),
  /** Sum of every non-null `reasoningTokens` in the window - informational only, never folded into `tokens`. */
  knownReasoningTokens: nonNegativeIntSchema,
  costProvenance: usageSummaryCostProvenanceSchema.nullable(),
  /** Cost/fact-count/token-count split by the fact's OWN provenance (not the weakest-wins bucket label). */
  provenanceSplit: usageProvenanceSplitSchema,
});

/** One chat's totals within the window - the per-chat grouping alongside the day×harness×model `buckets`. */
export const usageSummaryChatBucketSchema = z.object({
  chatId: z.string().min(1).max(191),
  epicId: z.string().min(1).max(191),
  factCount: nonNegativeIntSchema,
  tokens: usageSummaryTokenTotalsSchema,
  knownCostUsd: z.number().finite(),
  knownCacheSavingsUsd: z.number().finite(),
  knownReasoningTokens: nonNegativeIntSchema,
  costProvenance: usageSummaryCostProvenanceSchema,
});

/**
 * One host's totals within the window - the per-host grouping alongside
 * `chatBuckets`, same shape discipline (identity key + the four "known" sums
 * + weakest-wins provenance).
 *
 * No host NAME rides the wire. A display name is directory state that
 * changes without the fact changing, and only the client holds the directory
 * - so the client joins names by `hostId` and renders a truncated id for one
 * it does not recognize, rather than the host guessing at a name.
 */
export const usageSummaryHostBucketSchema = z.object({
  /** Matches `usageAnalyticsIngestFactV1Schema.hostId`'s bound, not the 191-char identifier bound. */
  hostId: z.string().min(1).max(36),
  factCount: nonNegativeIntSchema,
  tokens: usageSummaryTokenTotalsSchema,
  knownCostUsd: z.number().finite(),
  knownCacheSavingsUsd: z.number().finite(),
  knownReasoningTokens: nonNegativeIntSchema,
  costProvenance: usageSummaryCostProvenanceSchema,
});

/** One logical-execution fact, shaped for the chat-scoped per-turn drill-down. */
export const usageTurnRowSchema = z.object({
  factId: z.string().min(1).max(191),
  occurredAt: nonNegativeIntSchema,
  harnessId: z.string().min(1).max(64),
  model: z.string().min(1).max(255),
  outcome: usageSummaryOutcomeSchema,
  usageCompleteness: usageSummaryCompletenessSchema,
  tokens: usageSummaryTokenTotalsSchema,
  reasoningTokens: nonNegativeIntSchema.nullable(),
  costUsd: z.number().finite().nullable(),
  costProvenance: usageSummaryCostProvenanceSchema.nullable(),
  cacheSavingsUsd: z.number().finite().nullable(),
  toolCallCount: nonNegativeIntSchema,
  toolCallErrorCount: nonNegativeIntSchema,
});

/** Newest-first-capped chat-scoped per-turn rows - see `USAGE_TURN_ROWS_MAX` on the host/server side. */
export const USAGE_TURN_ROWS_MAX = 500;

export const usageSummaryOutcomeBreakdownSchema = z.object({
  completed: nonNegativeIntSchema,
  stopped: nonNegativeIntSchema,
  interrupted: nonNegativeIntSchema,
  abnormal_exit: nonNegativeIntSchema,
});

export const usageSummaryCompletenessBreakdownSchema = z.object({
  measured: nonNegativeIntSchema,
  partial: nonNegativeIntSchema,
  absent: nonNegativeIntSchema,
});

export const usageSummarySchema = z.object({
  window: usageSummaryWindowBoundsSchema,
  epicId: z.string().min(1).max(191).nullable(),
  /** The requested `chatId` filter echoed back; `null` = no chat scoping. */
  chatId: z.string().min(1).max(191).nullable(),
  totals: usageSummaryTotalsSchema,
  buckets: z.array(usageSummaryBucketSchema),
  /** Sorted by `chatId`. Groups BY chat regardless of whether the request filtered to one chat. */
  chatBuckets: z.array(usageSummaryChatBucketSchema),
  /**
   * Sorted by `hostId`. Groups BY host regardless of whether the request
   * filtered to one, exactly like `chatBuckets`. `servedBy: "local"` always
   * answers with at most a single self-entry - that plane holds only its own
   * host's facts.
   */
  hostBuckets: z.array(usageSummaryHostBucketSchema),
  distinctEpicCount: nonNegativeIntSchema,
  distinctChatCount: nonNegativeIntSchema,
  outcomeBreakdown: usageSummaryOutcomeBreakdownSchema,
  usageCompletenessBreakdown: usageSummaryCompletenessBreakdownSchema,
  /**
   * Chat-scoped per-turn drill-down rows - populated only when the request
   * carried a `chatId` filter (chat-scope-only by design). The cap is part
   * of the contract, not just host-side policy: `turnRowsTruncated` is how
   * an over-cap window is meant to be reported, so an uncapped array is a
   * host bug the wire should catch rather than an unbounded list for the
   * drill-down to render.
   */
  turnRows: z.array(usageTurnRowSchema).max(USAGE_TURN_ROWS_MAX).nullable(),
  /** `true` when `turnRows` was capped and older turns were omitted. Always `false` when `turnRows` is `null`. */
  turnRowsTruncated: z.boolean(),
});

export const usageCostCoverageSchema = z.object({
  pricedFactCount: nonNegativeIntSchema,
  unpricedFactCount: nonNegativeIntSchema,
  pricedTokenCount: nonNegativeIntSchema,
  unpricedTokenCount: nonNegativeIntSchema,
});

export const hostUsageSummaryRequestSchemaV10 = z
  .object({
    timezone: z.string().min(1).max(100),
    windowDays: z.number().int().positive(),
    epicId: z.string().min(1).max(191).nullable(),
    /**
     * Ticket 10 addition - `.optional()` (unlike the original fields above,
     * which are required-but-nullable) so a client built against the
     * original v1.0 shape (no chat filter) still validates: the key can be
     * absent entirely, not merely `null`. Chat implies its epic - not
     * required alongside `epicId`. Host-side, the chat must belong to the
     * authenticated caller.
     */
    chatId: z.string().min(1).max(191).nullable().optional(),
    /**
     * Ticket 10 addition, same `.optional()` compatibility reasoning as
     * `chatId`. Absent = the original `windowDays`-bounded behavior.
     * `"epic"` is valid only alongside a non-null `epicId`/`chatId` -
     * bounded by that epic/chat's own fact span, never a general unbounded
     * query.
     */
    window: z.enum(["epic"]).optional(),
    /**
     * Ticket 13 addition, same `.optional()` compatibility reasoning as
     * `chatId`. Absent or `null` = every host on the account - the global
     * dashboard's "All hosts" default. Only ever a NARROWING: the host
     * resolves the plane and the owner itself, so this cannot widen a read
     * past the authenticated caller, and on the local plane a host id other
     * than that host's own simply matches zero facts.
     */
    hostId: z.string().min(1).max(36).nullable().optional(),
  })
  .strict();
export type HostUsageSummaryRequestV10 = z.infer<
  typeof hostUsageSummaryRequestSchemaV10
>;

/**
 * `servedBy` names which bounded reader answered the request - see the
 * replication-and-read-path artifact's "one implementation, two bounded
 * readers". Never a client-side choice: the host resolves the plane from
 * the account's cloud-sync capability.
 */
export const hostUsageSummaryResponseSchemaV10 = z.object({
  servedBy: z.enum(["local", "cloud"]),
  summary: usageSummarySchema,
  coverage: usageCostCoverageSchema,
});
export type HostUsageSummaryResponseV10 = z.infer<
  typeof hostUsageSummaryResponseSchemaV10
>;
