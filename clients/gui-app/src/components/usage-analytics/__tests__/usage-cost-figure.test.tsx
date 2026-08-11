import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageCostFigure } from "@/components/usage-analytics/usage-cost-figure";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";

afterEach(cleanup);

type Totals = UsageSummaryResponse["summary"]["totals"];
type Coverage = UsageSummaryResponse["coverage"];

const ZERO_PROVENANCE_SPLIT: Totals["provenanceSplit"] = {
  providerReported: { costUsd: 0, factCount: 0, tokenCount: 0 },
  modelPriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
  unpriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
};

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
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
    provenanceSplit: ZERO_PROVENANCE_SPLIT,
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

function renderFigure(props: {
  readonly totals: Totals;
  readonly coverage: Coverage;
  readonly servedBy: UsageSummaryResponse["servedBy"];
  readonly hostScopeName: string | null;
}): void {
  render(
    <TooltipProvider>
      <UsageCostFigure
        totals={props.totals}
        coverage={props.coverage}
        servedBy={props.servedBy}
        hostScopeName={props.hostScopeName}
        size="default"
      />
    </TooltipProvider>,
  );
}

describe("UsageCostFigure", () => {
  it("fixup-01: every priced figure carries its own asterisk and the exact five-word footnote", () => {
    renderFigure({
      totals: totals({ knownCostUsd: 10 }),
      coverage: coverage({}),
      servedBy: "cloud",
      hostScopeName: null,
    });
    expect(screen.getByText("$10.00*")).not.toBeNull();
    expect(screen.getByTestId("usage-cost-footnote").textContent).toBe(
      "* if billed at full API rate",
    );
  });

  it("appends the '· N turns not counted' suffix ONLY while unpriced turns exist - no other standing coverage text", () => {
    renderFigure({
      totals: totals({ factCount: 4, knownCostUsd: 10 }),
      coverage: coverage({ pricedFactCount: 1, unpricedFactCount: 3 }),
      servedBy: "cloud",
      hostScopeName: null,
    });
    expect(screen.getByText("$10.00*")).not.toBeNull();
    expect(screen.getByTestId("usage-cost-footnote").textContent).toBe(
      "* if billed at full API rate · 3 turns not counted",
    );
    // The old "priced subtotal" / "+ N unpriced turns" standing phrasing is gone.
    expect(screen.queryByText(/priced subtotal/i)).toBeNull();
  });

  it("carries the full explanation in a tooltip on the figure, not as standing text", () => {
    renderFigure({
      totals: totals({
        knownCostUsd: 10,
        provenanceSplit: {
          providerReported: { costUsd: 7, factCount: 2, tokenCount: 50 },
          modelPriced: { costUsd: 3, factCount: 1, tokenCount: 20 },
          unpriced: { costUsd: 0, factCount: 1, tokenCount: 5 },
        },
      }),
      coverage: coverage({ unpricedFactCount: 1 }),
      servedBy: "cloud",
      hostScopeName: null,
    });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(screen.getByText("$10.00*"));

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toMatch(
      /estimate based on public list prices/i,
    );
    expect(tooltip.textContent).toContain("$7.00");
    expect(tooltip.textContent).toContain("$3.00");
    expect(tooltip.textContent).toMatch(/1 turn had no pricing available/i);
    expect(tooltip.textContent).not.toMatch(/provenance|modeled|unpriced/i);
  });

  it("states the this-machine-only scope for servedBy: local", () => {
    renderFigure({
      totals: totals({}),
      coverage: coverage({}),
      servedBy: "local",
      hostScopeName: null,
    });
    expect(
      screen.getByTestId("usage-served-by-local-note").textContent,
    ).toMatch(/this machine/i);
  });

  it("omits the local-scope note when servedBy is cloud", () => {
    renderFigure({
      totals: totals({}),
      coverage: coverage({}),
      servedBy: "cloud",
      hostScopeName: null,
    });
    expect(screen.queryByTestId("usage-served-by-local-note")).toBeNull();
  });

  it("renders the no-usage sentence, not a bare $0.00 or asterisk, for an empty window", () => {
    renderFigure({
      totals: totals({ factCount: 0, knownCostUsd: 0 }),
      coverage: coverage({ pricedFactCount: 0 }),
      servedBy: "cloud",
      hostScopeName: null,
    });
    expect(screen.getByText("No usage in this window")).not.toBeNull();
    expect(screen.queryByTestId("usage-cost-footnote")).toBeNull();
  });

  it("has no cost-quality panel and no provenance chip anywhere on the figure", () => {
    renderFigure({
      totals: totals({}),
      coverage: coverage({}),
      servedBy: "cloud",
      hostScopeName: null,
    });
    expect(screen.queryByTestId("usage-cost-quality-panel")).toBeNull();
    expect(screen.queryByText(/provenance/i)).toBeNull();
  });
});
