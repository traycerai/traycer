import { describe, expect, it } from "vitest";
import type { ProviderRateLimits, ProviderRateLimitWindow } from "../schemas";
import {
  classifyProviderRateLimits,
  classifyProviderRateLimitWindow,
  liveProviderRateLimitWindows,
} from "../semantics";

const NOW = 1_000_000;

function window(
  usedPercent: number,
  durationMinutes: number | null,
  resetsAt: number | null,
): ProviderRateLimitWindow {
  return { usedPercent, durationMinutes, resetsAt };
}

function claude(
  fiveHour: ProviderRateLimitWindow | null,
  sevenDay: ProviderRateLimitWindow | null,
): ProviderRateLimits {
  return {
    provider: "claude-code",
    available: true,
    subscriptionType: null,
    fiveHour,
    sevenDay,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    modelScoped: [],
    extraUsage: null,
  };
}

function codex(
  primary: ProviderRateLimitWindow | null,
  rateLimitReachedType: string | null,
): ProviderRateLimits {
  return {
    provider: "codex",
    available: true,
    planType: null,
    limitId: null,
    limitName: null,
    primary,
    secondary: null,
    extraWindows: [],
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType,
  };
}

describe("classifyProviderRateLimitWindow", () => {
  it("warns short windows at 80% and long or undated windows at 95%", () => {
    expect(classifyProviderRateLimitWindow(window(79, 300, null))).toBe(
      "healthy",
    );
    expect(classifyProviderRateLimitWindow(window(80, 300, null))).toBe(
      "running_low",
    );
    expect(classifyProviderRateLimitWindow(window(94, 10_080, null))).toBe(
      "healthy",
    );
    expect(classifyProviderRateLimitWindow(window(95, 10_080, null))).toBe(
      "running_low",
    );
    expect(classifyProviderRateLimitWindow(window(94, null, null))).toBe(
      "healthy",
    );
    expect(classifyProviderRateLimitWindow(window(95, null, null))).toBe(
      "running_low",
    );
  });

  it("reports Limited at 100% for every duration", () => {
    expect(classifyProviderRateLimitWindow(window(100, 300, null))).toBe(
      "limited",
    );
    expect(classifyProviderRateLimitWindow(window(100, null, null))).toBe(
      "limited",
    );
  });
});

describe("classifyProviderRateLimits", () => {
  it("uses the most severe live window in a mixed snapshot", () => {
    expect(
      classifyProviderRateLimits(
        claude(window(80, 300, NOW + 1), window(96, 10_080, NOW + 1)),
        NOW,
      ),
    ).toBe("running_low");
  });

  it("ignores expired windows and becomes Unknown when all have expired", () => {
    const mixed = claude(
      window(100, 300, NOW - 1),
      window(40, 10_080, NOW + 1),
    );
    expect(liveProviderRateLimitWindows(mixed, NOW)).toEqual([
      window(40, 10_080, NOW + 1),
    ]);
    expect(classifyProviderRateLimits(mixed, NOW)).toBe("healthy");
    expect(
      classifyProviderRateLimits(
        claude(window(100, 300, NOW), window(96, 10_080, NOW - 1)),
        NOW,
      ),
    ).toBe("unknown");
  });

  it("returns Unknown for missing or unavailable detail", () => {
    expect(classifyProviderRateLimits(claude(null, null), NOW)).toBe("unknown");
    expect(
      classifyProviderRateLimits(
        { provider: "claude-code", available: false, reason: "timeout" },
        NOW,
      ),
    ).toBe("unknown");
  });

  it("honors a provider-authoritative hard-limit signal", () => {
    expect(
      classifyProviderRateLimits(
        codex(window(12, 300, NOW + 1), "primary"),
        NOW,
      ),
    ).toBe("limited");
  });

  it("discards an authoritative signal from a fully expired capture", () => {
    expect(
      classifyProviderRateLimits(
        codex(window(100, 300, NOW - 1), "primary"),
        NOW,
      ),
    ).toBe("unknown");
  });
});
