import { describe, expect, it } from "vitest";
import {
  creditUsageSeverity,
  rateLimitWindowFillPercent,
  rateLimitWindowSeverityBarClassName,
} from "@/lib/rate-limits/window-severity";

describe("creditUsageSeverity", () => {
  it("marks only usage above 85 percent as limited", () => {
    expect(creditUsageSeverity(85)).toBe("healthy");
    expect(creditUsageSeverity(85.01)).toBe("limited");
  });
});

describe("rateLimitWindowSeverityBarClassName", () => {
  it("maps each severity to a distinct fill color", () => {
    expect(rateLimitWindowSeverityBarClassName("healthy")).toContain(
      "blue-500",
    );
    expect(rateLimitWindowSeverityBarClassName("running_low")).toContain(
      "amber-500",
    );
    expect(rateLimitWindowSeverityBarClassName("limited")).toContain("red-500");
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
