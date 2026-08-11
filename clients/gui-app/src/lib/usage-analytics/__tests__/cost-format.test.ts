import { describe, expect, it } from "vitest";
import {
  describeCostHeadline,
  formatUsd,
  servedByScopeNote,
  usageCostTooltip,
  type UsageCostCoverage,
  type UsageSummaryTotals,
} from "@/lib/usage-analytics/cost-format";

const ZERO_PROVENANCE_SPLIT: UsageSummaryTotals["provenanceSplit"] = {
  providerReported: { costUsd: 0, factCount: 0, tokenCount: 0 },
  modelPriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
  unpriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
};

function totals(overrides: Partial<UsageSummaryTotals>): UsageSummaryTotals {
  return {
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
    costProvenance: "providerReported",
    provenanceSplit: ZERO_PROVENANCE_SPLIT,
    ...overrides,
  };
}

function coverage(overrides: Partial<UsageCostCoverage>): UsageCostCoverage {
  return {
    pricedFactCount: 1,
    unpricedFactCount: 0,
    pricedTokenCount: 0,
    unpricedTokenCount: 0,
    ...overrides,
  };
}

describe("describeCostHeadline", () => {
  it("reports the no-usage sentence, with no footnote, for an empty window", () => {
    const result = describeCostHeadline(
      totals({ factCount: 0 }),
      coverage({ pricedFactCount: 0 }),
    );
    expect(result).toEqual({
      amount: "No usage in this window",
      footnote: null,
    });
  });

  it("appends the asterisk to every priced figure, with the exact five-word footnote", () => {
    const result = describeCostHeadline(
      totals({ factCount: 5, knownCostUsd: 12.34 }),
      coverage({ pricedFactCount: 5, unpricedFactCount: 0 }),
    );
    expect(result.amount).toBe("$12.34*");
    expect(result.footnote).toBe("* if billed at full API rate");
  });

  it("appends '· N turns not counted' ONLY while unpriced turns exist - the one standing exception", () => {
    const result = describeCostHeadline(
      totals({ factCount: 5, knownCostUsd: 12.34 }),
      coverage({ pricedFactCount: 2, unpricedFactCount: 3 }),
    );
    expect(result.amount).toBe("$12.34*");
    expect(result.footnote).toBe(
      "* if billed at full API rate · 3 turns not counted",
    );
  });

  it("uses singular 'turn' for exactly one unpriced fact", () => {
    const result = describeCostHeadline(
      totals({ factCount: 2, knownCostUsd: 1 }),
      coverage({ pricedFactCount: 1, unpricedFactCount: 1 }),
    );
    expect(result.footnote).toBe(
      "* if billed at full API rate · 1 turn not counted",
    );
  });
});

describe("usageCostTooltip", () => {
  it("never uses the banned words provenance/modeled/unpriced", () => {
    const tooltip = usageCostTooltip(
      totals({
        factCount: 5,
        knownCostUsd: 12.34,
        provenanceSplit: {
          providerReported: { costUsd: 10, factCount: 3, tokenCount: 100 },
          modelPriced: { costUsd: 2.34, factCount: 1, tokenCount: 20 },
          unpriced: { costUsd: 0, factCount: 1, tokenCount: 5 },
        },
      }),
      coverage({ pricedFactCount: 4, unpricedFactCount: 1 }),
    );
    expect(tooltip.toLowerCase()).not.toMatch(/provenance|modeled|unpriced/);
  });

  it("states the estimate-at-list-prices framing and that subscriptions bill separately", () => {
    const tooltip = usageCostTooltip(totals({}), coverage({}));
    expect(tooltip).toMatch(/estimate based on public list prices/i);
    expect(tooltip).toMatch(/subscription plan bills separately/i);
  });

  it("carries the exact-vs-estimate split with amounts", () => {
    const tooltip = usageCostTooltip(
      totals({
        provenanceSplit: {
          providerReported: { costUsd: 10, factCount: 3, tokenCount: 100 },
          modelPriced: { costUsd: 2.5, factCount: 1, tokenCount: 20 },
          unpriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
        },
      }),
      coverage({}),
    );
    expect(tooltip).toContain("$10.00");
    expect(tooltip).toContain("$2.50");
  });

  it("carries the not-counted detail only while unpriced turns exist", () => {
    const withUnpriced = usageCostTooltip(
      totals({}),
      coverage({ unpricedFactCount: 2 }),
    );
    expect(withUnpriced).toMatch(/2 turns had no pricing available/i);

    const withoutUnpriced = usageCostTooltip(
      totals({}),
      coverage({ unpricedFactCount: 0 }),
    );
    expect(withoutUnpriced).not.toMatch(/had no pricing available/i);
  });
});

describe("servedByScopeNote", () => {
  it("is null for an unfiltered cloud-served response - the account total needs no qualifier", () => {
    expect(servedByScopeNote("cloud", null)).toBeNull();
  });

  it("names the picked host when a cloud-served response was filtered to one", () => {
    const note = servedByScopeNote("cloud", "Studio Mac");
    expect(note).not.toBeNull();
    expect(note).toMatch(/Studio Mac/);
    expect(note).toMatch(/other hosts/i);
  });

  it("states the this-machine-only scope for a local-served response", () => {
    const note = servedByScopeNote("local", null);
    expect(note).not.toBeNull();
    expect(note).toMatch(/this machine/i);
  });

  it("keeps the local-plane wording even under a host filter - the plane, not the pick, is what bounds it", () => {
    // On the local plane the filter is pinned rather than chosen, and what
    // limits the number is that the plane cannot see another machine at all.
    // Saying "other hosts aren't included" there would imply a cross-device
    // read that was merely narrowed.
    expect(servedByScopeNote("local", "Studio Mac")).toMatch(/this machine/i);
  });
});

describe("formatUsd", () => {
  it("formats zero as a reported value, not blank", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formats a fractional amount to two decimals", () => {
    expect(formatUsd(12.3)).toBe("$12.30");
  });

  it("marks a real sub-half-cent amount rather than rounding it to $0.00", () => {
    // A short or heavily cached turn lands here, and "$0.00" reads as free.
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.0000001)).toBe("<$0.01");
  });

  it("still rounds normally from half a cent up", () => {
    expect(formatUsd(0.005)).toBe("$0.01");
    expect(formatUsd(0.014)).toBe("$0.01");
  });
});
