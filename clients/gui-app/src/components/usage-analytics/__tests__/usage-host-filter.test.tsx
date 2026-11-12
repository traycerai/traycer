import { buildUsageHostFilterOptions } from "@/lib/usage-analytics/usage-host-split";
/**
 * The trigger stays a standard select and may truncate. The selected host's
 * full name is the row under it, and it wraps. The sentence under the amount
 * names the narrowing and does not repeat the name.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageCostFigure } from "@/components/usage-analytics/usage-cost-figure";
import { UsageHostFilter } from "@/components/usage-analytics/usage-host-filter";
import { USAGE_EXPORT_REDACT_ATTRIBUTE } from "@/lib/usage-analytics/usage-export-image";
import type { UsageSummaryResponse } from "@/hooks/usage-analytics/use-usage-summary-query";

afterEach(cleanup);

const HOST_NAME =
  "Northwind Observatory Workstation beside the east window of the studio";

const SELECTED_HOST_NOTE =
  "Selected host only — your other hosts aren't included.";

type Totals = UsageSummaryResponse["summary"]["totals"];
type Coverage = UsageSummaryResponse["coverage"];

const ZERO_PROVENANCE_SPLIT: Totals["provenanceSplit"] = {
  providerReported: { costUsd: 0, factCount: 0, tokenCount: 0 },
  modelPriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
  unpriced: { costUsd: 0, factCount: 0, tokenCount: 0 },
};

function totals(): Totals {
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
  };
}

function coverage(): Coverage {
  return {
    pricedFactCount: 1,
    unpricedFactCount: 0,
    pricedTokenCount: 0,
    unpricedTokenCount: 0,
  };
}

function renderFilter(
  hostId: string | null,
  hostScopeName: string | null,
): void {
  render(
    <TooltipProvider>
      <UsageHostFilter
        options={[
          { hostId: "host-long", name: HOST_NAME, nameIsFallback: false },
        ]}
        hostId={hostId}
        onChange={() => undefined}
        pinnedToHostName={null}
      />
      <UsageCostFigure
        totals={totals()}
        coverage={coverage()}
        servedBy="cloud"
        hostScopeName={hostScopeName}
        size="default"
      />
    </TooltipProvider>,
  );
}

describe("UsageHostFilter", () => {
  it("names the selected unnamed computer distinctly from another unnamed option", () => {
    const options = buildUsageHostFilterOptions({
      hostNames: new Map(),
      hostIdsWithUsage: ["unnamed-a", "unnamed-b"],
      selectedHostId: "unnamed-b",
    });
    render(
      <TooltipProvider>
        <UsageHostFilter
          options={options}
          hostId="unnamed-b"
          onChange={() => undefined}
          pinnedToHostName={null}
        />
      </TooltipProvider>,
    );
    expect(
      screen.getByRole("combobox", { name: "Unnamed computer 2" }),
    ).toBeTruthy();
  });

  it("names the unfiltered choice All computers", () => {
    renderFilter(null, null);

    const trigger = screen.getByTestId("usage-host-filter");
    expect(trigger.textContent).toContain("All computers");
    expect(trigger.getAttribute("aria-label")).toContain("All computers");
    expect(screen.queryByTestId("usage-host-filter-selected-name")).toBeNull();
    expect(trigger.hasAttribute(USAGE_EXPORT_REDACT_ATTRIBUTE)).toBe(false);
    expect(screen.queryByTestId("usage-served-by-local-note")).toBeNull();
  });

  it("shows the full host name once, wrapping, under the standard trigger", () => {
    renderFilter("host-long", HOST_NAME);

    const trigger = screen.getByRole("combobox", { name: HOST_NAME });
    expect(trigger.className).toContain("max-w-48");
    expect(trigger.className).toContain("whitespace-nowrap");
    expect(trigger.className).not.toContain("whitespace-normal");
    expect(trigger.className).not.toContain("line-clamp-none");
    expect(trigger.className).not.toContain("data-[size=sm]:h-auto");

    const name = screen.getByTestId("usage-host-filter-selected-name");
    expect(name.textContent).toBe(HOST_NAME);
    expect(name.className).toContain("whitespace-normal");
    expect(name.className).not.toContain("truncate");
    expect(name.getAttribute("aria-hidden")).toBe("true");

    const note = screen.getByTestId("usage-served-by-local-note");
    expect(note.textContent).toBe(SELECTED_HOST_NOTE);
    expect(note.textContent).not.toContain(HOST_NAME);
    expect(note.hasAttribute(USAGE_EXPORT_REDACT_ATTRIBUTE)).toBe(false);
  });
});
