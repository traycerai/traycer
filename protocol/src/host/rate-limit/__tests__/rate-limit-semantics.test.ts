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

function jcode(
  subProviders: readonly {
    subProviderId: string;
    limitName: string | null;
    window: ProviderRateLimitWindow | null;
    hardLimitReached: boolean;
    error: string | null;
  }[],
): ProviderRateLimits {
  return {
    provider: "jcode",
    available: true,
    subProviders: [...subProviders],
  };
}

function jcodeSub(
  subProviderId: string,
  windowValue: ProviderRateLimitWindow | null,
  hardLimitReached: boolean,
  error: string | null,
) {
  return {
    subProviderId,
    limitName: null,
    window: windowValue,
    hardLimitReached,
    error,
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

// jcode is the only provider whose quota is genuinely per SUB-provider, so its
// arm contributes a LIST of windows the way claude-code's model-scoped windows
// do. These pin that it folds into the shared rollup with no special casing -
// and that a failed sub-provider fetch never reads as headroom.
describe("jcode per-sub-provider severity folding", () => {
  it("takes the worst live sub-provider window", () => {
    expect(
      classifyProviderRateLimits(
        jcode([
          jcodeSub("openrouter", window(10, null, null), false, null),
          jcodeSub("copilot", window(85, 300, NOW + 1), false, null),
        ]),
        NOW,
      ),
    ).toBe("running_low");
  });

  it("stays Healthy when every live sub-provider is well under its threshold", () => {
    expect(
      classifyProviderRateLimits(
        jcode([
          jcodeSub("openrouter", window(10, null, null), false, null),
          jcodeSub("anthropic", window(20, 300, NOW + 1), false, null),
        ]),
        NOW,
      ),
    ).toBe("healthy");
  });

  it("reports Unknown - never Healthy - when a sub-provider's fetch failed and nothing else reported", () => {
    // Both "fetch failed" and "no quota" carry `window: null`. Neither may be
    // read as 0% used.
    expect(
      classifyProviderRateLimits(
        jcode([jcodeSub("anthropic", null, false, "401 after token refresh")]),
        NOW,
      ),
    ).toBe("unknown");
  });

  it("reports Unknown for an empty sub-provider list", () => {
    expect(classifyProviderRateLimits(jcode([]), NOW)).toBe("unknown");
  });

  it("honors hardLimitReached as authoritative, like Codex's reached-type", () => {
    // jcode computes `hard_limit_reached` upstream but does not serialize it,
    // so the host derives it. Reading the flag rather than re-deriving keeps a
    // future upstream rule change honest.
    expect(
      classifyProviderRateLimits(
        jcode([jcodeSub("copilot", window(12, 300, NOW + 1), true, null)]),
        NOW,
      ),
    ).toBe("limited");
  });

  it("discards an authoritative hard-limit signal from a fully expired capture", () => {
    // Same staleness guard Codex gets: an all-expired capture is Unknown, not
    // a stale "limited" that outlives the window it came from.
    expect(
      classifyProviderRateLimits(
        jcode([jcodeSub("copilot", window(100, 300, NOW - 1), true, null)]),
        NOW,
      ),
    ).toBe("unknown");
  });

  it("does not let an EXPIRED hard-limit row limit a healthy live snapshot", () => {
    // jcode is the only LIST arm, so one capture mixes rows with independent
    // reset times. The all-expired guard above only fires when EVERY row is
    // stale, so a rolled-over OpenRouter row must be dropped on its own
    // liveness - otherwise a user with headroom everywhere reads as limited.
    expect(
      classifyProviderRateLimits(
        jcode([
          jcodeSub("openrouter", window(100, 300, NOW - 1), true, null),
          jcodeSub("copilot", window(30, 300, NOW + 1), false, null),
        ]),
        NOW,
      ),
    ).toBe("healthy");
  });

  it("keeps a hard-limit row with no window authoritative", () => {
    // No window is no evidence of rolling over, matching the null-reset rule
    // in `isProviderRateLimitWindowLive`. Today the host never emits this
    // pair; an upstream build that starts serializing `hard_limit_reached`
    // without a percentage would, and it must not be silently discarded.
    expect(
      classifyProviderRateLimits(
        jcode([
          jcodeSub("copilot", null, true, null),
          jcodeSub("openrouter", window(30, 300, NOW + 1), false, null),
        ]),
        NOW,
      ),
    ).toBe("limited");
  });

  it("drops expired sub-provider windows from the live set", () => {
    expect(
      liveProviderRateLimitWindows(
        jcode([
          jcodeSub("openrouter", window(90, 300, NOW - 1), false, null),
          jcodeSub("copilot", window(30, 300, NOW + 1), false, null),
        ]),
        NOW,
      ),
    ).toEqual([window(30, 300, NOW + 1)]);
  });
});
