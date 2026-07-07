import { describe, expect, it } from "vitest";
import {
  rateLimitWindowFillPercent,
  rateLimitWindowSeverity,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";

describe("rateLimitWindowSeverity", () => {
  it("returns blue at and below 85% used", () => {
    expect(rateLimitWindowSeverity(-5)).toBe("blue");
    expect(rateLimitWindowSeverity(0)).toBe("blue");
    expect(rateLimitWindowSeverity(60)).toBe("blue");
    expect(rateLimitWindowSeverity(85)).toBe("blue");
  });

  it("returns red over 85% used", () => {
    expect(rateLimitWindowSeverity(85.1)).toBe("red");
    expect(rateLimitWindowSeverity(100)).toBe("red");
  });
});

describe("rateLimitWindowSeverityBarClassName", () => {
  it("maps each severity to a distinct fill color", () => {
    expect(rateLimitWindowSeverityBarClassName("blue")).toContain("blue-500");
    expect(rateLimitWindowSeverityBarClassName("red")).toContain("red-500");
  });
});

describe("rateLimitWindowFillPercent", () => {
  it("tracks the real used percentage, clamped to [0, 100]", () => {
    expect(rateLimitWindowFillPercent(-3)).toBe(0);
    expect(rateLimitWindowFillPercent(0)).toBe(0);
    expect(rateLimitWindowFillPercent(40)).toBe(40);
    expect(rateLimitWindowFillPercent(85)).toBe(85);
    expect(rateLimitWindowFillPercent(150)).toBe(100);
  });
});
