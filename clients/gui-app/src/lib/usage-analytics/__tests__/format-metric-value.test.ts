import { describe, expect, it } from "vitest";
import {
  formatDayLabel,
  formatMetricValue,
  niceCeil,
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

describe("niceCeil", () => {
  it("rounds up to the nearest clean 1/2/5/10 step", () => {
    expect(niceCeil(0)).toBe(0);
    expect(niceCeil(0.8)).toBe(1);
    expect(niceCeil(1.4)).toBe(2);
    expect(niceCeil(3)).toBe(5);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(42)).toBe(50);
  });
});
