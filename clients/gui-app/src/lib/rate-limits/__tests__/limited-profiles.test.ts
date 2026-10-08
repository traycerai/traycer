import { describe, expect, it } from "vitest";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import {
  clearedBannerReadings,
  isLimitedBannerDismissed,
  limitedBannerKey,
  type LimitedBannerDismissal,
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
  readonly readAt: number | null;
}): StatusBarProviderSegmentModel {
  const w = window(input.severity);
  return {
    providerId: "codex",
    profileId: input.profileId,
    account: null,
    hidden: false,
    state: input.state,
    reason: null,
    readAt: input.readAt,
    windows: [w],
    shown: [w],
    tightest: w,
  };
}

describe("limitedBannerKey", () => {
  it("joins provider and profile, and is the provider alone for the ambient login", () => {
    expect(limitedBannerKey(profile)).toBe("codex:p1");
    expect(limitedBannerKey({ providerId: "codex", profileId: null })).toBe(
      "codex",
    );
  });

  it("keeps the ambient login and an empty-string profile id apart", () => {
    const ambient = limitedBannerKey({ providerId: "codex", profileId: null });
    const empty = limitedBannerKey({ providerId: "codex", profileId: "" });
    expect(empty).toBe("codex:");
    expect(ambient).not.toBe(empty);
  });
});

function dismissal(resetsAt: number | null): LimitedBannerDismissal {
  return { resetsAt, dismissedAt: NOW - 1000 };
}

describe("isLimitedBannerDismissed", () => {
  it("is true for an equal reset still in the future", () => {
    expect(
      isLimitedBannerDismissed(
        { "codex:p1": dismissal(NOW + 100) },
        profile,
        NOW,
      ),
    ).toBe(true);
  });

  it("is true for null equal to null, however late the clock", () => {
    expect(
      isLimitedBannerDismissed(
        { "codex:p1": dismissal(null) },
        { ...profile, resetsAt: null },
        NOW * 10,
      ),
    ).toBe(true);
  });

  it("is false once the dismissed reset has passed", () => {
    const passed = { ...profile, resetsAt: NOW - 1 };
    expect(
      isLimitedBannerDismissed({ "codex:p1": dismissal(NOW - 1) }, passed, NOW),
    ).toBe(false);
    expect(
      isLimitedBannerDismissed(
        { "codex:p1": dismissal(NOW) },
        { ...profile, resetsAt: NOW },
        NOW,
      ),
    ).toBe(false);
  });

  it("is false for a different reset time, either way round", () => {
    expect(
      isLimitedBannerDismissed(
        { "codex:p1": dismissal(NOW + 50) },
        profile,
        NOW,
      ),
    ).toBe(false);
    expect(
      isLimitedBannerDismissed({ "codex:p1": dismissal(null) }, profile, NOW),
    ).toBe(false);
    expect(
      isLimitedBannerDismissed(
        { "codex:p1": dismissal(NOW + 100) },
        { ...profile, resetsAt: null },
        NOW,
      ),
    ).toBe(false);
  });

  it("does not let a dismissal of the ambient login hide an empty-string profile's banner", () => {
    const emptyProfile: LimitedProfile = { ...profile, profileId: "" };
    const ambientProfile: LimitedProfile = { ...profile, profileId: null };
    const bucket = { codex: dismissal(NOW + 100) };
    expect(isLimitedBannerDismissed(bucket, ambientProfile, NOW)).toBe(true);
    expect(isLimitedBannerDismissed(bucket, emptyProfile, NOW)).toBe(false);
  });

  it("is false for an undefined bucket or a missing key", () => {
    expect(isLimitedBannerDismissed(undefined, profile, NOW)).toBe(false);
    expect(
      isLimitedBannerDismissed(
        { "codex:p2": dismissal(NOW + 100) },
        profile,
        NOW,
      ),
    ).toBe(false);
  });
});

describe("clearedBannerReadings", () => {
  it("holds each live, unlimited segment's reading time and nothing else", () => {
    const cluster: StatusBarRateLimitCluster = {
      kind: "segments",
      segments: [
        segment({
          profileId: "healthy",
          state: "live",
          severity: "healthy",
          readAt: 111,
        }),
        segment({
          profileId: "limited",
          state: "live",
          severity: "limited",
          readAt: 222,
        }),
        segment({
          profileId: "cold",
          state: "cold",
          severity: "healthy",
          readAt: 333,
        }),
        segment({
          profileId: "degraded",
          state: "degraded",
          severity: "healthy",
          readAt: 444,
        }),
        segment({
          profileId: null,
          state: "live",
          severity: "healthy",
          readAt: 555,
        }),
        segment({
          profileId: "unreceipted",
          state: "live",
          severity: "healthy",
          readAt: null,
        }),
      ],
    };

    expect(new Map(clearedBannerReadings(cluster))).toEqual(
      new Map([
        ["codex:healthy", 111],
        ["codex", 555],
      ]),
    );
  });

  it("is empty for a cluster that is not segments", () => {
    expect(clearedBannerReadings({ kind: "hidden" }).size).toBe(0);
  });
});
