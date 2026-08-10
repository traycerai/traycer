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

export const usageSummaryBucketSchema = z.object({
  day: z.string().min(1).max(10),
  harnessId: z.string().min(1).max(64),
  model: z.string().min(1).max(255),
  factCount: nonNegativeIntSchema,
  tokens: usageSummaryTokenTotalsSchema,
  knownCostUsd: z.number().finite(),
  costProvenance: usageSummaryCostProvenanceSchema,
});

export const usageSummaryWindowBoundsSchema = z.object({
  timezone: z.string().min(1).max(100),
  windowDays: z.number().int().positive(),
  startAtInclusive: nonNegativeIntSchema,
  endAtExclusive: nonNegativeIntSchema,
});

export const usageSummaryTotalsSchema = z.object({
  factCount: nonNegativeIntSchema,
  tokens: usageSummaryTokenTotalsSchema,
  knownCostUsd: z.number().finite(),
  costProvenance: usageSummaryCostProvenanceSchema.nullable(),
});

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
  totals: usageSummaryTotalsSchema,
  buckets: z.array(usageSummaryBucketSchema),
  distinctEpicCount: nonNegativeIntSchema,
  distinctChatCount: nonNegativeIntSchema,
  outcomeBreakdown: usageSummaryOutcomeBreakdownSchema,
  usageCompletenessBreakdown: usageSummaryCompletenessBreakdownSchema,
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
