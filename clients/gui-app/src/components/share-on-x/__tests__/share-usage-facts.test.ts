import { describe, expect, it } from "vitest";
import { shareUsageFacts } from "@/components/share-on-x/share-usage-facts";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";

type Bucket = UsageSummaryResponse["summary"]["buckets"][number];
type HostBucket = UsageSummaryResponse["summary"]["hostBuckets"][number];

function bucket(day: string, harnessId: string, tokens: number): Bucket {
  return {
    day,
    harnessId,
    model: "model",
    factCount: 1,
    tokens: {
      uncachedInputTokens: tokens - 10,
      cacheReadInputTokens: 4,
      cacheCreationTokens: 1,
      outputTokens: 5,
    },
    knownCostUsd: 0,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "modelPriced",
  };
}

function host(hostId: string): HostBucket {
  return {
    hostId,
    factCount: 1,
    tokens: {
      uncachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
    },
    knownCostUsd: 0,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "modelPriced",
  };
}

function response(
  buckets: Bucket[],
  hostBuckets: HostBucket[],
): UsageSummaryResponse {
  const empty = { costUsd: 0, factCount: 0, tokenCount: 0 };
  return {
    servedBy: "local",
    summary: {
      // Three days ending on 2026-11-04 in UTC.
      window: {
        timezone: "UTC",
        windowDays: 3,
        startAtInclusive: Date.UTC(2026, 10, 2),
        endAtExclusive: Date.UTC(2026, 10, 5),
      },
      epicId: "epic-1",
      chatId: null,
      totals: {
        factCount: buckets.length,
        tokens: {
          uncachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
        },
        knownCostUsd: 0,
        knownCacheSavingsUsd: 0,
        knownReasoningTokens: 0,
        costProvenance: null,
        provenanceSplit: {
          providerReported: empty,
          modelPriced: empty,
          unpriced: empty,
        },
      },
      buckets,
      chatBuckets: [],
      hostBuckets,
      distinctEpicCount: 1,
      distinctChatCount: 4,
      outcomeBreakdown: {
        completed: 0,
        stopped: 0,
        interrupted: 0,
        abnormal_exit: 0,
      },
      usageCompletenessBreakdown: { measured: 0, partial: 0, absent: 0 },
      turnRows: null,
      turnRowsTruncated: false,
    },
    coverage: {
      pricedFactCount: 0,
      unpricedFactCount: 0,
      pricedTokenCount: 0,
      unpricedTokenCount: 0,
    },
  };
}

describe("shareUsageFacts", () => {
  it("folds the buckets into days and agents, most tokens first", () => {
    const facts = shareUsageFacts(
      response(
        [
          bucket("2026-11-02", "codex", 100),
          bucket("2026-11-04", "claude", 300),
          bucket("2026-11-04", "codex", 100),
          bucket("2026-11-04", "some-new-agent", 500),
        ],
        [host("host-a"), host("host-b")],
      ),
    );

    expect(facts).toEqual({
      rangeLabel: "Nov 2 – Nov 4, 2026",
      totalTokens: 1_000,
      chatCount: 4,
      machineCount: 2,
      days: [
        { day: "2026-11-02", tokens: 100 },
        { day: "2026-11-03", tokens: 0 },
        { day: "2026-11-04", tokens: 900 },
      ],
      agents: [
        {
          id: "some-new-agent",
          name: "some-new-agent",
          tokens: 500,
          share: 0.5,
        },
        { id: "claude", name: "Claude Code", tokens: 300, share: 0.3 },
        { id: "codex", name: "Codex", tokens: 200, share: 0.2 },
      ],
    });
  });
});
