import { describe, expect, it } from "vitest";
import {
  formatDateRangeLabel,
  formatDayLabel,
  formatMetricValue,
} from "@/lib/usage-analytics/format-metric-value";

describe("formatMetricValue", () => {
  it("formats cost as USD", () => {
    expect(formatMetricValue(12.3, "cost")).toBe("$12.30");
  });

  it("formats tokens compactly", () => {
    expect(formatMetricValue(12_900, "tokens")).toBe("12.9K");
  });

  it("formats zero tokens plainly", () => {
    expect(formatMetricValue(0, "tokens")).toBe("0");
  });
});

describe("formatDayLabel", () => {
  it("renders a bucketed YYYY-MM-DD as 'Mon D'", () => {
    expect(formatDayLabel("2026-08-09")).toBe("Aug 9");
  });

  it("does not zero-pad the day number", () => {
    expect(formatDayLabel("2026-01-05")).toBe("Jan 5");
  });

  it("falls back to the raw string for a malformed day", () => {
    expect(formatDayLabel("nodashesatall")).toBe("nodashesatall");
  });
});

describe("formatDateRangeLabel", () => {
  it("renders the first and last day with the year once", () => {
    expect(
      formatDateRangeLabel(["2026-08-01", "2026-08-02", "2026-08-10"]),
    ).toBe("Aug 1 – Aug 10, 2026");
  });

  it("handles a single-day window", () => {
    expect(formatDateRangeLabel(["2026-01-05"])).toBe("Jan 5 – Jan 5, 2026");
  });

  it("names both years when the window straddles New Year", () => {
    // A 30- or 90-day window crosses New Year every year, and reading the
    // year off the last day alone stamped the wrong one on the first.
    expect(formatDateRangeLabel(["2025-12-31", "2026-01-01"])).toBe(
      "Dec 31, 2025 – Jan 1, 2026",
    );
  });

  it("renders nothing for an empty day list", () => {
    expect(formatDateRangeLabel([])).toBe("");
  });
});
