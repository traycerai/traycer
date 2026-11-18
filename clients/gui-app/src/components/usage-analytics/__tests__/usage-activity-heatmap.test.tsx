import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

  it("renders one tile per day at its intensity level", () => {
    render(
      <TooltipProvider>
        <UsageActivityHeatmap calendar={calendar} metric="cost" />
      </TooltipProvider>,
    );
    const tiles = screen.getAllByTestId("usage-activity-day");
    expect(tiles).toHaveLength(7);
    const active = tiles.find(
      (tile) => tile.getAttribute("data-day") === "2026-08-03",
    );
    expect(active?.getAttribute("data-level")).toBe("4");
    const empty = tiles.find(
      (tile) => tile.getAttribute("data-day") === "2026-08-02",
    );
    expect(empty?.getAttribute("data-level")).toBe("0");
  });

  it("keeps 365 marks out of the tab order and states the values in a table instead", () => {
    // Each tile as a tab stop made the calendar a keyboard trap: the first
    // Tab landed a year back (DOM is oldest-first, the scroller is anchored
    // right), dragged the scroll position with it, and the stats below were
    // hundreds of presses away.
    render(
      <TooltipProvider>
        <UsageActivityHeatmap calendar={calendar} metric="cost" />
      </TooltipProvider>,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    const table = screen.getByTestId("usage-activity-data-table");
    // Only days WITH usage earn a row - a year of "No usage" is noise.
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("2026-08-03");
    expect(rows[0]?.textContent).toContain("$5.00");
    expect(rows[0]?.textContent).toContain("10");
  });

  it("hovering a tile states the day's cost AND tokens, whichever metric colors it", async () => {
    // The tile is colored by one metric, but a reader comparing days wants
    // both numbers in one hover - not a metric-picker round trip. Rendered
    // under the Tokens metric so the cost line can only come from the
    // cell's own cost field, not from `value`.
    render(
      <TooltipProvider delayDuration={0}>
        <UsageActivityHeatmap
          calendar={buildUsageActivityCalendar(
            DAYS,
            [bucket("2026-08-03", 5)],
            "tokens",
          )}
          metric="tokens"
        />
      </TooltipProvider>,
    );
    const tile = screen
      .getAllByTestId("usage-activity-day")
      .find((entry) => entry.getAttribute("data-day") === "2026-08-03");
    if (tile === undefined) throw new Error("missing 2026-08-03 tile");
    fireEvent.pointerMove(tile);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Aug 3, 2026");
    expect(tooltip.textContent).toContain("Cost");
    expect(tooltip.textContent).toContain("$5.00");
    expect(tooltip.textContent).toContain("Tokens");
    expect(tooltip.textContent).toContain("10");
  });

  it("a day mixing priced and unpriced turns shows only its figure - the caveat is reserved for all-unpriced days", async () => {
    // User ruling: a per-tile "not counted" on every mixed day is cognitive
    // overload; the headline footnote already carries the window-wide count.
    render(
      <TooltipProvider delayDuration={0}>
        <UsageActivityHeatmap
          calendar={buildUsageActivityCalendar(
            DAYS,
            [
              bucket("2026-08-03", 5),
              {
                ...bucket("2026-08-03", 0),
                model: "grok-4",
                costProvenance: "unpriced",
                factCount: 2,
              },
            ],
            "cost",
          )}
          metric="cost"
        />
      </TooltipProvider>,
    );
    const tile = screen
      .getAllByTestId("usage-activity-day")
      .find((entry) => entry.getAttribute("data-day") === "2026-08-03");
    if (tile === undefined) throw new Error("missing 2026-08-03 tile");
    fireEvent.pointerMove(tile);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Cost$5.00");
    expect(tooltip.textContent).not.toContain("not counted");
    // Tokens are independent of pricing - the unpriced bucket's 10 tokens
    // count there alongside the priced bucket's 10.
    expect(tooltip.textContent).toContain("Tokens20");
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

  it("marks the scroller so an image export captures the whole year", () => {
    // A shared image has no scrollbar: without the marker the export would
    // crop the year to whatever slice the live scroller was anchored to.
    render(
      <TooltipProvider>
        <UsageActivityHeatmap calendar={calendar} metric="cost" />
      </TooltipProvider>,
    );
    const scroller = screen.getByTestId("usage-activity-scroller");
    expect(scroller.hasAttribute("data-usage-export-fit")).toBe(true);
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
