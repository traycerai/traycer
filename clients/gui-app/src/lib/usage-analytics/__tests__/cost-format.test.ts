import { describe, expect, it } from "vitest";
import {
  describeCostCoverage,
  formatUsd,
  servedByScopeNote,
  type UsageCostCoverage,
  type UsageSummaryTotals,
} from "@/lib/usage-analytics/cost-format";

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
    costProvenance: "providerReported",
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

describe("describeCostCoverage", () => {
  it("reports a bare number when the window has no usage at all", () => {
    const result = describeCostCoverage(
      totals({ factCount: 0 }),
      coverage({ pricedFactCount: 0 }),
    );
    expect(result).toEqual({
      headline: "No usage in this window",
      coverageNote: null,
    });
  });

  it("reports a clean dollar figure when every fact is priced", () => {
    const result = describeCostCoverage(
      totals({ factCount: 5, knownCostUsd: 12.34 }),
      coverage({ pricedFactCount: 5, unpricedFactCount: 0 }),
    );
    expect(result.headline).toBe("$12.34");
    expect(result.coverageNote).toBeNull();
  });

  it("NEVER renders a bare number when coverage is incomplete - always the priced-subtotal + unpriced-turns phrasing", () => {
    const result = describeCostCoverage(
      totals({ factCount: 5, knownCostUsd: 12.34 }),
      coverage({ pricedFactCount: 2, unpricedFactCount: 3 }),
    );
    expect(result.headline).toBe("$12.34 priced subtotal");
    expect(result.coverageNote).toBe("+ 3 unpriced turns");
  });

  it("uses singular 'turn' for exactly one unpriced fact", () => {
    const result = describeCostCoverage(
      totals({ factCount: 2, knownCostUsd: 1 }),
      coverage({ pricedFactCount: 1, unpricedFactCount: 1 }),
    );
    expect(result.coverageNote).toBe("+ 1 unpriced turn");
  });
});

describe("servedByScopeNote", () => {
  it("is null for a cloud-served response", () => {
    expect(servedByScopeNote("cloud")).toBeNull();
  });

  it("states the this-machine-only scope for a local-served response", () => {
    const note = servedByScopeNote("local");
    expect(note).not.toBeNull();
    expect(note).toMatch(/this machine/i);
  });
});

describe("formatUsd", () => {
  it("formats zero as a reported value, not blank", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formats a fractional amount to two decimals", () => {
    expect(formatUsd(12.3)).toBe("$12.30");
  });
});
