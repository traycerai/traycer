import { describe, expect, it } from "vitest";
import type {
  ProviderRateLimits,
  ProviderRateLimitWindow,
} from "@traycer/protocol/host/rate-limit";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import { projectProfileUsage } from "@/lib/rate-limits/profile-usage-projection";

const NOW = 1_000_000;
const STALE_AFTER_MS = 300_000;

function window(
  usedPercent: number,
  durationMinutes: number | null,
  resetsAt: number | null,
): ProviderRateLimitWindow {
  return { usedPercent, durationMinutes, resetsAt };
}

function codex(overrides: {
  readonly primary: ProviderRateLimitWindow | null;
  readonly secondary: ProviderRateLimitWindow | null;
  readonly extraWindows: Extract<
    ProviderRateLimits,
    { provider: "codex"; available: true }
  >["extraWindows"];
  readonly rateLimitReachedType: string | null;
}): Extract<ProviderRateLimits, { provider: "codex"; available: true }> {
  return {
    provider: "codex",
    available: true,
    planType: null,
    limitId: null,
    limitName: null,
    primary: overrides.primary,
    secondary: overrides.secondary,
    extraWindows: overrides.extraWindows,
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType: overrides.rateLimitReachedType,
  };
}

function openRouter(
  limit: number | null,
  limitRemaining: number | null,
): Extract<ProviderRateLimits, { provider: "openrouter"; available: true }> {
  return {
    provider: "openrouter",
    available: true,
    limit,
    limitRemaining,
    dailySpend: null,
    weeklySpend: null,
    monthlySpend: null,
    totalCredits: null,
    totalUsage: null,
    balance: null,
  };
}

function claude(
  fiveHour: ProviderRateLimitWindow | null,
  sevenDay: ProviderRateLimitWindow | null,
): Extract<ProviderRateLimits, { provider: "claude-code"; available: true }> {
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

function envelope(
  data: Extract<ProviderRateLimits, { available: true }>,
  lastGoodAt: number,
): ProviderRateLimitEnvelope {
  return {
    latest: data,
    lastGood: data,
    lastGoodAt,
    lastFailureAt: null,
  };
}

function project(
  rateLimitStatus: "ok" | "near_limit" | "hard_limit" | "unknown",
  usageUpdatedAt: number | null,
  value: ProviderRateLimitEnvelope | null,
  detailError: boolean,
) {
  return projectProfileUsage({
    rateLimitStatus,
    usageUpdatedAt,
    envelope: value,
    detailError,
    now: NOW,
    staleAfterMs: STALE_AFTER_MS,
  });
}

describe("projectProfileUsage", () => {
  it("selects the most severe compact window before comparing percentages", () => {
    const projection = project(
      "near_limit",
      NOW,
      envelope(
        claude(window(85, 300, NOW + 1), window(90, 10_080, NOW + 1)),
        NOW,
      ),
      false,
    );
    expect(projection.kind).toBe("detail");
    expect(projection.severity).toBe("running_low");
    expect(projection.compactWindow?.id).toBe("five-hour");
    expect(projection.compactWindow?.severity).toBe("running_low");
  });

  it("projects OpenRouter hard limits as an equivalent Credits meter", () => {
    const projection = project(
      "ok",
      NOW,
      envelope(openRouter(100, 10), NOW),
      false,
    );
    expect(projection).toMatchObject({
      kind: "detail",
      severity: "limited",
      compactWindow: {
        id: "credits",
        name: "Credits",
        severity: "limited",
        window: {
          usedPercent: 90,
          durationMinutes: null,
          resetsAt: null,
        },
      },
    });
    expect(projection.windows).toHaveLength(1);
  });

  it("keeps OpenRouter percentage-free when no hard limit is available", () => {
    expect(
      project("ok", NOW, envelope(openRouter(null, null), NOW), false),
    ).toMatchObject({
      kind: "unavailable",
      reason: "missing_windows",
      compactWindow: null,
      windows: [],
    });
  });

  it("selects the most consumed live window and ignores expired windows", () => {
    const projection = project(
      "ok",
      NOW - 1_000,
      envelope(
        codex({
          primary: window(100, 300, NOW - 1),
          secondary: window(72, 10_080, NOW + 1),
          extraWindows: [
            {
              limitId: "spark",
              limitName: "Spark",
              primary: window(84, 300, NOW + 1),
              secondary: null,
            },
          ],
          rateLimitReachedType: null,
        }),
        NOW - 1_000,
      ),
      false,
    );
    expect(projection.kind).toBe("detail");
    expect(projection.compactWindow?.id).toBe("extra:spark:primary");
    expect(projection.compactWindow?.window.usedPercent).toBe(84);
  });

  it("keeps core windows first and includes warning extras without duplicating the constraining extra", () => {
    const projection = project(
      "near_limit",
      NOW - 1_000,
      envelope(
        codex({
          primary: window(82, 300, NOW + 1),
          secondary: window(96, 10_080, NOW + 1),
          extraWindows: [
            {
              limitId: "healthy-extra",
              limitName: "Healthy extra",
              primary: window(70, 300, NOW + 1),
              secondary: null,
            },
            {
              limitId: "low-extra",
              limitName: "Low extra",
              primary: window(85, 300, NOW + 1),
              secondary: null,
            },
          ],
          rateLimitReachedType: null,
        }),
        NOW - 1_000,
      ),
      false,
    );
    expect(projection.windows.map((entry) => entry.id)).toEqual([
      "primary",
      "secondary",
      "extra:low-extra:primary",
    ]);
    expect(projection.compactWindow?.id).toBe("secondary");
  });

  it("includes a healthy extra only when it is the constraining window", () => {
    const projection = project(
      "ok",
      NOW - 1_000,
      envelope(
        codex({
          primary: window(40, 300, NOW + 1),
          secondary: window(50, 10_080, NOW + 1),
          extraWindows: [
            {
              limitId: "extra",
              limitName: "Extra",
              primary: window(70, 300, NOW + 1),
              secondary: null,
            },
          ],
          rateLimitReachedType: null,
        }),
        NOW - 1_000,
      ),
      false,
    );
    expect(projection.windows.map((entry) => entry.id)).toEqual([
      "primary",
      "secondary",
      "extra:extra:primary",
    ]);
    expect(projection.compactWindow?.id).toBe("extra:extra:primary");
  });

  it("represents retained and aged detail as stale without changing percentages", () => {
    const data = codex({
      primary: window(40, 300, NOW + 1),
      secondary: window(20, 10_080, NOW + 1),
      extraWindows: [],
      rateLimitReachedType: null,
    });
    const retained: ProviderRateLimitEnvelope = {
      latest: { provider: "codex", available: false, reason: "timeout" },
      lastGood: data,
      lastGoodAt: NOW - 1_000,
      lastFailureAt: NOW,
    };
    const retainedProjection = project("ok", NOW - 1_000, retained, false);
    expect(retainedProjection.kind).toBe("stale");
    expect(retainedProjection.compactWindow?.window.usedPercent).toBe(40);
    expect(
      retainedProjection.kind === "stale"
        ? retainedProjection.unavailableReason
        : null,
    ).toBe("timeout");

    const agedProjection = project(
      "ok",
      NOW - STALE_AFTER_MS,
      envelope(data, NOW - STALE_AFTER_MS),
      false,
    );
    expect(agedProjection.kind).toBe("stale");
  });

  it("keeps semantic-only and never-checked states percentage-free", () => {
    const semantic = project("near_limit", NOW - 1_000, null, false);
    expect(semantic).toMatchObject({
      kind: "semantic_only",
      severity: "running_low",
      compactWindow: null,
      windows: [],
      unavailableReason: null,
    });
    const neverChecked = project("unknown", null, null, false);
    expect(neverChecked).toEqual({
      kind: "not_checked",
      severity: "unknown",
      compactWindow: null,
      windows: [],
      checkedAt: null,
    });
    expect(project("ok", null, null, false)).toEqual(neverChecked);
  });

  it("preserves unavailable diagnostics without treating them as Healthy", () => {
    const unavailable: ProviderRateLimitEnvelope = {
      latest: {
        provider: "claude-code",
        available: false,
        reason: "insufficient_permissions",
      },
      lastGood: null,
      lastGoodAt: null,
      lastFailureAt: null,
    };
    expect(project("unknown", NOW, unavailable, false)).toEqual({
      kind: "unavailable",
      severity: "unknown",
      reason: "insufficient_permissions",
      compactWindow: null,
      windows: [],
      checkedAt: NOW,
    });
  });

  it("does not fabricate a fill for provider-authoritative semantic limits without windows", () => {
    const projection = project(
      "hard_limit",
      NOW,
      envelope(
        codex({
          primary: null,
          secondary: null,
          extraWindows: [],
          rateLimitReachedType: "primary",
        }),
        NOW,
      ),
      false,
    );
    expect(projection).toMatchObject({
      kind: "semantic_only",
      severity: "limited",
      compactWindow: null,
      windows: [],
      unavailableReason: null,
    });
  });

  it("projects thrown detail errors without losing retained last-good data", () => {
    const data = codex({
      primary: window(40, 300, NOW + 1),
      secondary: window(20, 10_080, NOW + 1),
      extraWindows: [],
      rateLimitReachedType: null,
    });
    const stale = project("ok", NOW - 1_000, envelope(data, NOW - 1_000), true);
    expect(stale.kind).toBe("stale");
    expect(stale.compactWindow?.window.usedPercent).toBe(40);
    expect(stale.kind === "stale" ? stale.unavailableReason : null).toBe(
      "fetch_failed",
    );
    expect(project("unknown", null, null, true)).toMatchObject({
      kind: "unavailable",
      severity: "unknown",
      reason: "fetch_failed",
      compactWindow: null,
    });
  });
});
