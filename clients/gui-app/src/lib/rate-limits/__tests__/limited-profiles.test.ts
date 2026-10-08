import { describe, expect, it } from "vitest";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import {
  clearedBannerKeys,
  isLimitedBannerDismissed,
  limitedBannerKey,
  type LimitedProfile,
} from "@/lib/rate-limits/limited-profiles";

const NOW = 1_000_000;

const profile: LimitedProfile = {
  providerId: "codex",
  profileId: "p1",
  name: "pro20x",
  limitName: "weekly",
  resetsAt: NOW + 100,
};

function window(severity: "healthy" | "limited"): StatusBarRateLimitWindow {
  return {
    windowKey: "codex:weekly",
    label: "wk",
    labelIsDuration: true,
    kind: "weekly",
    usedPercent: severity === "limited" ? 100 : 10,
    resetsAt: NOW + 100,
    severity,
  };
}

function segment(input: {
  readonly profileId: string | null;
  readonly state: StatusBarProviderSegmentModel["state"];
  readonly severity: "healthy" | "limited";
}): StatusBarProviderSegmentModel {
  const w = window(input.severity);
  return {
    providerId: "codex",
    profileId: input.profileId,
    account: null,
    hidden: false,
    state: input.state,
    reason: null,
    windows: [w],
    shown: [w],
    tightest: w,
  };
}

describe("limitedBannerKey", () => {
  it("joins provider and profile, with an empty profile for the ambient login", () => {
    expect(limitedBannerKey(profile)).toBe("codex:p1");
    expect(limitedBannerKey({ providerId: "codex", profileId: null })).toBe(
      "codex:",
    );
  });
});

describe("isLimitedBannerDismissed", () => {
  it("is true for an equal reset still in the future", () => {
    expect(
      isLimitedBannerDismissed({ "codex:p1": NOW + 100 }, profile, NOW),
    ).toBe(true);
  });

  it("is true for null equal to null, however late the clock", () => {
    expect(
      isLimitedBannerDismissed(
        { "codex:p1": null },
        { ...profile, resetsAt: null },
        NOW * 10,
      ),
    ).toBe(true);
  });

  it("is false once the dismissed reset has passed", () => {
    const passed = { ...profile, resetsAt: NOW - 1 };
    expect(isLimitedBannerDismissed({ "codex:p1": NOW - 1 }, passed, NOW)).toBe(
      false,
    );
    expect(
      isLimitedBannerDismissed(
        { "codex:p1": NOW },
        { ...profile, resetsAt: NOW },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false for a different reset time, either way round", () => {
    expect(
      isLimitedBannerDismissed({ "codex:p1": NOW + 50 }, profile, NOW),
    ).toBe(false);
    expect(isLimitedBannerDismissed({ "codex:p1": null }, profile, NOW)).toBe(
      false,
    );
    expect(
      isLimitedBannerDismissed(
        { "codex:p1": NOW + 100 },
        { ...profile, resetsAt: null },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false for an undefined bucket or a missing key", () => {
    expect(isLimitedBannerDismissed(undefined, profile, NOW)).toBe(false);
    expect(
      isLimitedBannerDismissed({ "codex:p2": NOW + 100 }, profile, NOW),
    ).toBe(false);
  });
});

describe("clearedBannerKeys", () => {
  it("holds only live segments with no limited window", () => {
    const cluster: StatusBarRateLimitCluster = {
      kind: "segments",
      segments: [
        segment({ profileId: "healthy", state: "live", severity: "healthy" }),
        segment({ profileId: "limited", state: "live", severity: "limited" }),
        segment({ profileId: "cold", state: "cold", severity: "healthy" }),
        segment({
          profileId: "degraded",
          state: "degraded",
          severity: "healthy",
        }),
        segment({ profileId: null, state: "live", severity: "healthy" }),
      ],
    };

    expect([...clearedBannerKeys(cluster)].sort()).toEqual([
      "codex:",
      "codex:healthy",
    ]);
  });

  it("is empty for a cluster that is not segments", () => {
    expect(clearedBannerKeys({ kind: "hidden" }).size).toBe(0);
  });
});
