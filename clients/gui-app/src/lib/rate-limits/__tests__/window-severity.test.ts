import { describe, expect, it } from "vitest";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverity,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";

describe("rateLimitWindowSeverity", () => {
  it("returns green at 0% used (100% available)", () => {
    expect(rateLimitWindowSeverity(0)).toBe("green");
    // A clock-skewed negative reading still reads as fully available.
    expect(rateLimitWindowSeverity(-5)).toBe("green");
  });

  it("returns blue above 0% and under 60% used", () => {
    expect(rateLimitWindowSeverity(0.1)).toBe("blue");
    expect(rateLimitWindowSeverity(59.9)).toBe("blue");
  });

  it("returns yellow for 60-85% used, inclusive of both bounds", () => {
    expect(rateLimitWindowSeverity(60)).toBe("yellow");
    expect(rateLimitWindowSeverity(70)).toBe("yellow");
    expect(rateLimitWindowSeverity(85)).toBe("yellow");
  });

  it("returns red over 85% used", () => {
    expect(rateLimitWindowSeverity(85.1)).toBe("red");
    expect(rateLimitWindowSeverity(100)).toBe("red");
  });
});

describe("rateLimitWindowSeverityBarClassName", () => {
  it("maps each severity to a distinct fill color", () => {
    expect(rateLimitWindowSeverityBarClassName("green")).toContain("green-500");
    expect(rateLimitWindowSeverityBarClassName("blue")).toContain("blue-500");
    expect(rateLimitWindowSeverityBarClassName("yellow")).toContain(
      "yellow-500",
    );
    expect(rateLimitWindowSeverityBarClassName("red")).toContain("red-500");
  });
});

describe("rateLimitWindowFillPercent", () => {
  it("fills the whole track at 0% used (or below) for the full green bar", () => {
    expect(rateLimitWindowFillPercent(0)).toBe(100);
    expect(rateLimitWindowFillPercent(-3)).toBe(100);
  });

  it("tracks the real used percentage otherwise, clamped to [0, 100]", () => {
    expect(rateLimitWindowFillPercent(40)).toBe(40);
    expect(rateLimitWindowFillPercent(85)).toBe(85);
    expect(rateLimitWindowFillPercent(150)).toBe(100);
  });
});
