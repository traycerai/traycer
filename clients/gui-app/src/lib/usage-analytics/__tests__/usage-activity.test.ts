import { describe, expect, it } from "vitest";
import {
  buildUsageActivityCalendar,
  isWindowTooWideError,
} from "@/lib/usage-analytics/usage-activity";
import type { UsageBucket } from "@/lib/usage-analytics/usage-chart-data";

function bucket(
  day: string,
  knownCostUsd: number,
  overrides: Partial<UsageBucket>,
): UsageBucket {
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
    ...overrides,
  };
}

/** Oldest-first calendar days, inclusive - fixture stand-in for `lastNCalendarDays`. */
function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

describe("buildUsageActivityCalendar", () => {
  it("gives every day a tile - zero-usage days get level 0, not a hole", () => {
    // 2026-08-02 is a Sunday.
    const days = dayRange("2026-08-02", "2026-08-08");
    const calendar = buildUsageActivityCalendar(
      days,
      [bucket("2026-08-03", 5, {})],
      "cost",
    );
    expect(calendar.weeks).toHaveLength(1);
    const cells = calendar.weeks[0]?.cells ?? [];
    expect(cells.filter((cell) => cell !== null)).toHaveLength(7);
    expect(
      cells.filter((cell) => cell !== null && cell.level === 0),
    ).toHaveLength(6);
  });

  it("pads a mid-week window start so weekday rows stay aligned", () => {
    // 2026-08-05 is a Wednesday - rows 0-2 of the first week are padding.
    const days = dayRange("2026-08-05", "2026-08-08");
    const calendar = buildUsageActivityCalendar(days, [], "cost");
    const first = calendar.weeks[0]?.cells ?? [];
    expect(first.slice(0, 3)).toEqual([null, null, null]);
    expect(first[3]?.day).toBe("2026-08-05");
  });

  it("quantizes nonzero days by quartile and washes nothing out under a long tail", () => {
    const days = dayRange("2026-08-02", "2026-08-08");
    const calendar = buildUsageActivityCalendar(
      days,
      [
        bucket("2026-08-02", 1, {}),
        bucket("2026-08-03", 2, {}),
        bucket("2026-08-04", 3, {}),
        // The whale day: a linear-to-max scale would push every other day
        // into the faintest step.
        bucket("2026-08-05", 1000, {}),
      ],
      "cost",
    );
    const byDay = new Map(
      (calendar.weeks[0]?.cells ?? [])
        .filter((cell) => cell !== null)
        .map((cell) => [cell.day, cell.level]),
    );
    expect(byDay.get("2026-08-05")).toBe(4);
    expect(byDay.get("2026-08-02")).toBeGreaterThanOrEqual(1);
    expect(byDay.get("2026-08-04")).toBeGreaterThanOrEqual(2);
  });

  it("reads a uniform history as full intensity, not the faintest step", () => {
    const days = dayRange("2026-08-02", "2026-08-04");
    const calendar = buildUsageActivityCalendar(
      days,
      [bucket("2026-08-02", 2, {}), bucket("2026-08-03", 2, {})],
      "cost",
    );
    const levels = (calendar.weeks[0]?.cells ?? [])
      .filter((cell) => cell !== null && cell.value > 0)
      .map((cell) => cell?.level);
    expect(levels).toEqual([4, 4]);
  });

  it("labels months where they begin, never the window's partial first month", () => {
    const days = dayRange("2026-06-15", "2026-08-11");
    const calendar = buildUsageActivityCalendar(days, [], "cost");
    expect(calendar.monthLabels.map((label) => label.label)).toEqual([
      "Jul",
      "Aug",
    ]);
    for (const label of calendar.monthLabels) {
      expect(label.weekIndex).toBeGreaterThan(0);
      expect(label.weekIndex).toBeLessThan(calendar.weeks.length);
    }
  });

  it("computes streaks - and an inactive today does not zero the current streak", () => {
    // Window ends today (2026-08-08); today has no usage yet.
    const days = dayRange("2026-08-01", "2026-08-08");
    const calendar = buildUsageActivityCalendar(
      days,
      [
        bucket("2026-08-02", 1, {}),
        bucket("2026-08-03", 1, {}),
        bucket("2026-08-04", 1, {}),
        // gap on 08-05
        bucket("2026-08-06", 1, {}),
        bucket("2026-08-07", 1, {}),
      ],
      "cost",
    );
    expect(calendar.stats.longestStreakDays).toBe(3);
    expect(calendar.stats.currentStreakDays).toBe(2);
    expect(calendar.stats.mostActiveMonth).toBe("Aug 2026");
  });

  it("counts a day of unpriced work as activity, not as an empty day", () => {
    // Cost is the selected metric and this day's usage was never priced, so
    // its value is 0 - but the turns happened. Reporting that as inactivity
    // would break the streak and drop the day from the accessible table.
    const days = dayRange("2026-08-02", "2026-08-05");
    const calendar = buildUsageActivityCalendar(
      days,
      [
        bucket("2026-08-02", 4, {}),
        bucket("2026-08-03", 0, { costProvenance: "unpriced", factCount: 2 }),
        bucket("2026-08-04", 6, {}),
      ],
      "cost",
    );
    const byDay = new Map(
      (calendar.weeks[0]?.cells ?? [])
        .filter((cell) => cell !== null)
        .map((cell) => [cell.day, cell]),
    );
    const unpriced = byDay.get("2026-08-03");
    expect(unpriced?.value).toBe(0);
    expect(unpriced?.factCount).toBe(2);
    // Faintest visible step, never the empty one.
    expect(unpriced?.level).toBe(1);
    // And the streak runs straight through it.
    expect(calendar.stats.longestStreakDays).toBe(3);
  });

  it("names a most-active month even when every active day is unpriced", () => {
    // All-unpriced year under the Cost metric: every month sums to $0, but
    // the tiles/streaks/table all recognize the work - "—" beside them
    // reads as a contradiction. Fact counts break the all-zero tie.
    const days = dayRange("2026-07-28", "2026-08-05");
    const calendar = buildUsageActivityCalendar(
      days,
      [
        bucket("2026-07-29", 0, { costProvenance: "unpriced", factCount: 1 }),
        bucket("2026-08-02", 0, { costProvenance: "unpriced", factCount: 3 }),
        bucket("2026-08-03", 0, { costProvenance: "unpriced", factCount: 2 }),
      ],
      "cost",
    );
    expect(calendar.stats.mostActiveMonth).toBe("Aug 2026");
  });

  it("names the most active day by value", () => {
    const days = dayRange("2026-08-02", "2026-08-04");
    const calendar = buildUsageActivityCalendar(
      days,
      [bucket("2026-08-02", 1, {}), bucket("2026-08-03", 9, {})],
      "cost",
    );
    expect(calendar.stats.mostActiveDay).toBe("Aug 3, 2026");
  });
});

describe("isWindowTooWideError", () => {
  it("recognizes the legacy validator's rejection and nothing else", () => {
    expect(
      isWindowTooWideError({
        message: "windowDays must be an integer between 1 and 90, got 365",
      }),
    ).toBe(true);
    // A transient failure is NOT a reason to quietly shrink the calendar.
    expect(isWindowTooWideError({ message: "socket hang up" })).toBe(false);
    expect(isWindowTooWideError(null)).toBe(false);
  });
});
