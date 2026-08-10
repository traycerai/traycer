import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UsageCostFigure } from "@/components/usage-analytics/usage-cost-figure";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";

afterEach(cleanup);

type Totals = UsageSummaryResponse["summary"]["totals"];
type Coverage = UsageSummaryResponse["coverage"];

function totals(overrides: Partial<Totals>): Totals {
  return {
    factCount: 1,
    tokens: {
      uncachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
    },
    knownCostUsd: 10,
    costProvenance: "providerReported",
    ...overrides,
  };
}

function coverage(overrides: Partial<Coverage>): Coverage {
  return {
    pricedFactCount: 1,
    unpricedFactCount: 0,
    pricedTokenCount: 0,
    unpricedTokenCount: 0,
    ...overrides,
  };
}

describe("UsageCostFigure", () => {
  it("every dollar figure carries the full-API-rate qualifier", () => {
    render(
      <UsageCostFigure
        totals={totals({ knownCostUsd: 10 })}
        coverage={coverage({})}
        servedBy="cloud"
        size="default"
      />,
    );
    expect(screen.getByText("$10.00")).not.toBeNull();
    expect(screen.getByText(/if billed at full API rate/i)).not.toBeNull();
  });

  it("never shows a bare number when cost coverage is incomplete", () => {
    render(
      <UsageCostFigure
        totals={totals({ factCount: 4, knownCostUsd: 10 })}
        coverage={coverage({ pricedFactCount: 1, unpricedFactCount: 3 })}
        servedBy="cloud"
        size="default"
      />,
    );
    expect(screen.getByText("$10.00 priced subtotal")).not.toBeNull();
    expect(screen.getByText("+ 3 unpriced turns")).not.toBeNull();
    // The exact figure never appears on its own, unqualified.
    expect(screen.queryByText("$10.00")).toBeNull();
  });

  it("states the this-machine-only scope for servedBy: local", () => {
    render(
      <UsageCostFigure
        totals={totals({})}
        coverage={coverage({})}
        servedBy="local"
        size="default"
      />,
    );
    expect(
      screen.getByTestId("usage-served-by-local-note").textContent,
    ).toMatch(/this machine/i);
  });

  it("omits the local-scope note when servedBy is cloud", () => {
    render(
      <UsageCostFigure
        totals={totals({})}
        coverage={coverage({})}
        servedBy="cloud"
        size="default"
      />,
    );
    expect(screen.queryByTestId("usage-served-by-local-note")).toBeNull();
  });

  it("renders the no-usage sentence, not a bare $0.00, for an empty window", () => {
    render(
      <UsageCostFigure
        totals={totals({ factCount: 0, knownCostUsd: 0 })}
        coverage={coverage({ pricedFactCount: 0 })}
        servedBy="cloud"
        size="default"
      />,
    );
    expect(screen.getByText("No usage in this window")).not.toBeNull();
  });
});
