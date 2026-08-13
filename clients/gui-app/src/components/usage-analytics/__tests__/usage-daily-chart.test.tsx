import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LineSeriesOption } from "echarts/charts";
import {
  clearEChartsMockInstances,
  getEChartsMockInstances,
} from "../../../../__tests__/test-browser-apis";
import { UsageDailyChart } from "@/components/usage-analytics/usage-daily-chart";
import {
  buildUsageChartColumns,
  type UsageBucket,
} from "@/lib/usage-analytics/usage-chart-data";
import type { UsageChartOption } from "@/lib/usage-analytics/usage-chart-option";
import { buildUsageSeriesScale } from "@/lib/usage-analytics/usage-series-scale";

beforeEach(() => {
  clearEChartsMockInstances();
});

afterEach(() => {
  cleanup();
});

/** The option the mocked chart instance most recently received. */
function latestChartOption(): UsageChartOption {
  const instance = getEChartsMockInstances().at(-1);
  const option = instance?.options.at(-1);
  if (option === undefined) throw new Error("no ECharts option captured");
  return option as UsageChartOption;
}

function seriesByName(
  option: UsageChartOption,
  name: string,
): LineSeriesOption {
  const raw = option.series ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  const found = list.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`series ${name} not in option`);
  return found;
}

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
    // The chip updating is not enough - the chart must actually receive an
    // option with the hidden series zeroed (still PRESENT, so the slot and
    // color never shift) and the other series untouched.
    const option = latestChartOption();
    expect(seriesByName(option, "codex").data).toEqual([0]);
    expect(seriesByName(option, "claude").data).toEqual([3]);
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

  it("exposes every plotted value without a pointer, via a screen-reader table", () => {
    // The bar version made each day a focusable button; ECharts draws one
    // opaque graphic whose values live only in a pointer-triggered tooltip.
    // In the epic dialog the companion table is grouped by CHAT, so this is
    // the only non-pointer path to the per-day numbers there.
    render(<UsageDailyChart columns={columns} scale={scale} metric="cost" />);
    const table = screen.getByTestId("usage-daily-chart-data-table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Day", "claude", "codex"]);
    const row = within(table).getByRole("row", { name: /Aug 1/ });
    expect(row.textContent).toContain("$3.00");
    expect(row.textContent).toContain("$5.00");
  });

  it("drops a filtered series from the accessible table too", () => {
    render(<UsageDailyChart columns={columns} scale={scale} metric="cost" />);
    fireEvent.click(screen.getByRole("button", { name: "codex" }));
    const table = screen.getByTestId("usage-daily-chart-data-table");
    // The table is the same view by another means - it must not contradict
    // what the chart draws.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Day", "claude"]);
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
