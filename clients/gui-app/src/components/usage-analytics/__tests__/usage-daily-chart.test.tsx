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
    const claudeChip = screen.getByRole("button", { name: "claude" });
    const codexChip = screen.getByRole("button", { name: "codex" });
    expect(claudeChip.getAttribute("aria-pressed")).toBe("true");
    expect(codexChip.getAttribute("aria-pressed")).toBe("true");
  });

  it("toggles a series off on click without disturbing the other chip", () => {
    render(<UsageDailyChart columns={columns} scale={scale} metric="cost" />);
    const codexChip = screen.getByRole("button", { name: "codex" });
    fireEvent.click(codexChip);
    expect(codexChip.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "claude" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps the legend reachable when a refetch narrows the window to the hidden series", () => {
    // `hiddenSeries` outlives a prop change, so a response that drops every
    // other harness would otherwise leave a chart of zeroed bars with no
    // control to un-hide the one series left.
    const { rerender } = render(
      <UsageDailyChart columns={columns} scale={scale} metric="cost" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "codex" }));

    const codexOnly = buildUsageSeriesScale(["codex"]);
    rerender(
      <UsageDailyChart
        columns={buildUsageChartColumns(
          ["2026-08-01"],
          [bucket({ harnessId: "codex", knownCostUsd: 5 })],
          codexOnly,
          "cost",
        )}
        scale={codexOnly}
        metric="cost"
      />,
    );

    // Every bar is zeroed right now, so the chip is the only way back - it
    // has to still be on screen even though one series alone would normally
    // suppress the legend.
    const chip = screen.getByRole("button", { name: "codex" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chip);

    // Nothing is filtered any more, so the single-series suppression applies
    // again - the legend going away IS the proof the series came back.
    expect(screen.queryByTestId("usage-daily-chart-legend")).toBeNull();
  });

  it("hides the legend for a single series that is not filtered out", () => {
    const soloScale = buildUsageSeriesScale(["claude"]);
    render(
      <UsageDailyChart
        columns={buildUsageChartColumns(
          ["2026-08-01"],
          [bucket({ harnessId: "claude" })],
          soloScale,
          "cost",
        )}
        scale={soloScale}
        metric="cost"
      />,
    );
    expect(screen.queryByTestId("usage-daily-chart-legend")).toBeNull();
  });

  it("toggles a hidden series back on when clicked again", () => {
    render(<UsageDailyChart columns={columns} scale={scale} metric="cost" />);
    const codexChip = screen.getByRole("button", { name: "codex" });
    fireEvent.click(codexChip);
    fireEvent.click(codexChip);
    expect(codexChip.getAttribute("aria-pressed")).toBe("true");
  });
});
