import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UsageDailyChart } from "@/components/usage-analytics/usage-daily-chart";
import {
  buildUsageChartColumns,
  type UsageBucket,
} from "@/lib/usage-analytics/usage-chart-data";
import { buildUsageSeriesScale } from "@/lib/usage-analytics/usage-series-scale";

afterEach(() => {
  cleanup();
});

function bucket(overrides: Partial<UsageBucket>): UsageBucket {
  return {
    day: "2026-08-01",
    harnessId: "claude",
    model: "claude-sonnet-5",
    factCount: 1,
    tokens: {
      uncachedInputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
    },
    knownCostUsd: 1,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
    ...overrides,
  };
}

describe("<UsageDailyChart /> legend filter", () => {
  const scale = buildUsageSeriesScale(["claude", "codex"]);
  const columns = buildUsageChartColumns(
    ["2026-08-01"],
    [
      bucket({ harnessId: "claude", knownCostUsd: 3 }),
      bucket({ harnessId: "codex", knownCostUsd: 5 }),
    ],
    scale,
    "cost",
  );

  it("renders a pressed chip per series by default", () => {
    render(<UsageDailyChart columns={columns} scale={scale} metric="cost" />);
    const claudeChip = screen.getByTestId(
      "usage-daily-chart-legend-chip-claude",
    );
    const codexChip = screen.getByTestId("usage-daily-chart-legend-chip-codex");
    expect(claudeChip.getAttribute("aria-pressed")).toBe("true");
    expect(codexChip.getAttribute("aria-pressed")).toBe("true");
  });

  it("toggles a series off on click without disturbing the other chip", () => {
    render(<UsageDailyChart columns={columns} scale={scale} metric="cost" />);
    const codexChip = screen.getByTestId("usage-daily-chart-legend-chip-codex");
    fireEvent.click(codexChip);
    expect(codexChip.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen
        .getByTestId("usage-daily-chart-legend-chip-claude")
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("toggles a hidden series back on when clicked again", () => {
    render(<UsageDailyChart columns={columns} scale={scale} metric="cost" />);
    const codexChip = screen.getByTestId("usage-daily-chart-legend-chip-codex");
    fireEvent.click(codexChip);
    fireEvent.click(codexChip);
    expect(codexChip.getAttribute("aria-pressed")).toBe("true");
  });
});
