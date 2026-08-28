import { describe, expect, it, vi } from "vitest";
import type { ProviderRateLimits } from "@traycer/protocol/host/rate-limit";
import type { ProfileUsageComparisonEntry } from "@/lib/rate-limits/profile-usage-comparison-state";
import {
  profileUsageAccessibleStatus,
  projectComparisonEntry,
  scopeProfileUsageRefreshStatus,
} from "../profile-dropdown-usage";

const NOW = 2_000_000;
const USAGE = {
  available: true,
  provider: "claude-code",
  subscriptionType: null,
  fiveHour: { usedPercent: 84, resetsAt: NOW + 60_000, durationMinutes: 300 },
  sevenDay: {
    usedPercent: 46,
    resetsAt: NOW + 7 * 24 * 60 * 60 * 1_000,
    durationMinutes: 10_080,
  },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  modelScoped: [],
  extraUsage: null,
} satisfies ProviderRateLimits;

function entry(
  detail: ProfileUsageComparisonEntry["detail"],
): ProfileUsageComparisonEntry {
  return {
    profileId: "work",
    providerId: "claude-code",
    fetchEligible: true,
    detail,
    refreshStatus: "idle",
    refresh: vi.fn(() => Promise.resolve()),
    ensureFresh: vi.fn(() => Promise.resolve()),
  };
}

describe("picker comparison projection adapter", () => {
  it("only exposes queued state for a refresh initiated by this profile", () => {
    expect(scopeProfileUsageRefreshStatus("queued", false)).toBe("idle");
    expect(scopeProfileUsageRefreshStatus("idle", true)).toBe("queued");
    expect(scopeProfileUsageRefreshStatus("queued", true)).toBe("queued");
    expect(scopeProfileUsageRefreshStatus("refreshing", false)).toBe(
      "refreshing",
    );
  });

  it("uses T1's most-constrained live window and duration-aware severity", () => {
    const projected = projectComparisonEntry(
      entry({ kind: "fresh", usage: USAGE, asOf: NOW }),
      NOW,
    );
    expect(projected.projection.kind).toBe("detail");
    expect(projected.projection.compactWindow?.id).toBe("five-hour");
    expect(projected.projection.severity).toBe("running_low");
    expect(profileUsageAccessibleStatus(projected.projection)).toBe(
      "Running low",
    );
  });

  it("keeps semantic warnings percentage-free", () => {
    const projected = projectComparisonEntry(
      entry({ kind: "semantic-only", status: "hard_limit" }),
      NOW,
    );
    expect(projected.projection.kind).toBe("semantic_only");
    expect(projected.projection.compactWindow).toBeNull();
    expect(profileUsageAccessibleStatus(projected.projection)).toBe("Limited");
  });

  it("retains failed last-good detail as stale and exposes no fabricated cold data", () => {
    const retained = projectComparisonEntry(
      entry({
        kind: "failed-with-last-good",
        usage: USAGE,
        asOf: NOW - 30_000,
        failedAt: NOW,
      }),
      NOW,
    );
    expect(retained.projection.kind).toBe("stale");
    expect(profileUsageAccessibleStatus(retained.projection)).toBe("Stale");

    const cold = projectComparisonEntry(
      entry({ kind: "failed-no-last-good", failedAt: NOW }),
      NOW,
    );
    expect(cold.projection.kind).toBe("unavailable");
    expect(cold.projection).toMatchObject({ reason: "fetch_failed" });
    expect(cold.projection.compactWindow).toBeNull();
    expect(profileUsageAccessibleStatus(cold.projection)).toBe("Not checked");
  });

  it("preserves a successful provider-unavailable reason instead of treating it as a query failure", () => {
    const projected = projectComparisonEntry(
      entry({
        kind: "unavailable",
        usage: {
          provider: "claude-code",
          available: false,
          reason: "insufficient_permissions",
        },
      }),
      NOW,
    );

    expect(projected.projection).toMatchObject({
      kind: "unavailable",
      reason: "insufficient_permissions",
    });
    expect(projected.projection.compactWindow).toBeNull();
  });
});
