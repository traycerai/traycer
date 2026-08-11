import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageActivityHeatmap } from "@/components/usage-analytics/usage-activity-heatmap";
import { buildUsageActivityCalendar } from "@/lib/usage-analytics/usage-activity";
import type { UsageBucket } from "@/lib/usage-analytics/usage-chart-data";

afterEach(() => {
  cleanup();
  restoreScrollWidth?.();
  restoreScrollWidth = null;
});

/**
 * jsdom does no layout, so `scrollWidth` is 0 everywhere and an
 * "anchored to the end" assertion would pass against a scroller that was
 * never touched. Stub a real content width so the assertion can only pass
 * if the component actually drove `scrollLeft`.
 */
const YEAR_GRID_WIDTH = 650;
let restoreScrollWidth: (() => void) | null = null;
function stubScrollWidth(): void {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => YEAR_GRID_WIDTH,
  });
  restoreScrollWidth = () => {
    if (original === undefined) {
      delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      return;
    }
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", original);
  };
}

function bucket(day: string, knownCostUsd: number): UsageBucket {
  return {
    day,
    harnessId: "claude",
    model: "claude-sonnet-5",
    factCount: 1,
    tokens: {
      uncachedInputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
    },
    knownCostUsd,
    knownCacheSavingsUsd: 0,
    knownReasoningTokens: 0,
    costProvenance: "providerReported",
  };
}

// 2026-08-02 (Sunday) .. 2026-08-08 (Saturday): one full week.
const DAYS = [
  "2026-08-02",
  "2026-08-03",
  "2026-08-04",
  "2026-08-05",
  "2026-08-06",
  "2026-08-07",
  "2026-08-08",
];

describe("<UsageActivityHeatmap />", () => {
  const calendar = buildUsageActivityCalendar(
    DAYS,
    [bucket("2026-08-03", 5)],
    "cost",
  );

  it("renders one focusable tile per day with its intensity level", () => {
    render(
      <TooltipProvider>
        <UsageActivityHeatmap calendar={calendar} metric="cost" />
      </TooltipProvider>,
    );
    // Role query, not a test id: each tile is a real button whose
    // accessible name carries the day and its value.
    const tiles = screen.getAllByRole("button");
    expect(tiles).toHaveLength(7);
    const active = tiles.find(
      (tile) => tile.getAttribute("data-day") === "2026-08-03",
    );
    expect(active?.getAttribute("data-level")).toBe("4");
    // Identity is not color-alone: every tile names its day and exact value.
    expect(active?.getAttribute("aria-label")).toBe("2026-08-03: $5.00");
    const empty = tiles.find(
      (tile) => tile.getAttribute("data-day") === "2026-08-02",
    );
    expect(empty?.getAttribute("data-level")).toBe("0");
    expect(empty?.getAttribute("aria-label")).toBe("2026-08-02: No usage");
  });

  it("opens on the most recent weeks, not the oldest", () => {
    // The year grid is wider than a narrow Settings pane. A fresh scroller
    // sits at scrollLeft 0 - the OLDEST weeks - so the current period, the
    // reason to open this at all, would hide behind a scrollbar.
    stubScrollWidth();
    render(
      <TooltipProvider>
        <UsageActivityHeatmap calendar={calendar} metric="cost" />
      </TooltipProvider>,
    );
    const scroller = screen.getByTestId("usage-activity-scroller");
    expect(scroller.scrollLeft).toBe(YEAR_GRID_WIDTH);
  });

  it("shows the stat row computed from the same calendar", () => {
    render(
      <TooltipProvider>
        <UsageActivityHeatmap calendar={calendar} metric="cost" />
      </TooltipProvider>,
    );
    expect(screen.getByText("Aug 3, 2026")).toBeTruthy();
    expect(screen.getByText("Aug 2026")).toBeTruthy();
  });
});
