import { describe, expect, it } from "vitest";
import type {
  AuthenticatedUser,
  SubscriptionStatus,
  TraycerTeamSubscription,
  TraycerUserSubscription,
} from "@traycer/protocol/auth";
import {
  accountContextValue,
  isCreditBasedPricing,
  isPaid,
  isTraycerEligible,
  parseAccountContextValue,
  resolveTraycerSubscriptionState,
  selectSubscription,
  subscriptionPlanLabel,
} from "@/lib/auth/traycer-subscription-content";

const EPOCH = new Date(0);

function baseSubscription() {
  return {
    id: "sub",
    userID: "u1",
    orgID: null,
    teamID: null,
    customerId: "cus",
    createdAt: EPOCH,
    updatedAt: EPOCH,
    subscriptionExpiry: null,
    trialEndsAt: null,
    hasPaymentMethod: true,
    rechargeRateSeconds: 60,
  };
}

function userSub(overrides: {
  status: SubscriptionStatus;
  hasActiveBundle?: boolean;
}): TraycerUserSubscription {
  return {
    ...baseSubscription(),
    subscriptionStatus: overrides.status,
    isInTrial: false,
    hasActiveBundle: overrides.hasActiveBundle,
  };
}

function teamSub(teamId: string): TraycerTeamSubscription {
  return {
    ...baseSubscription(),
    teamID: teamId,
    subscriptionStatus: "ULTRA_1X_V3",
    isInTrial: false,
    totalPlanCredits: 500,
    hasActiveBundle: false,
    bundleSummary: { bundleTotal: 0, bundleConsumed: 0, bundleRemaining: 0 },
    team: {
      id: teamId,
      slug: "acme",
      avatarUrl: null,
      privacyMode: false,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    },
  };
}

function userWith(
  userSubscription: TraycerUserSubscription,
  teams: TraycerTeamSubscription[],
): AuthenticatedUser {
  return {
    user: {
      id: "u1",
      name: "Ada",
      providerId: "p1",
      providerHandle: "ada",
      providerType: "GITHUB",
      email: "ada@example.com",
      avatarUrl: null,
      activatedAt: EPOCH,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      lastSeenAt: EPOCH,
      privacyMode: false,
      isLearningEnabled: true,
    },
    userSubscription,
    payAsYouGoUsage: { allowPayAsYouGo: false },
    teamSubscriptions: teams,
  };
}

describe("isPaid / isCreditBasedPricing", () => {
  it("treats only FREE/PENDING as unpaid", () => {
    expect(isPaid("FREE")).toBe(false);
    expect(isPaid("PENDING")).toBe(false);
    expect(isPaid("PRO_V3")).toBe(true);
    expect(isPaid("PRO_PLUS_V2")).toBe(true);
  });

  it("marks V3 tiers (and FREE) as credit-based, legacy/v2 as rate-limit", () => {
    expect(isCreditBasedPricing("PRO_V3")).toBe(true);
    expect(isCreditBasedPricing("FREE")).toBe(true);
    expect(isCreditBasedPricing("PRO_PLUS_V2")).toBe(false);
    expect(isCreditBasedPricing("PRO_LEGACY")).toBe(false);
  });
});

describe("isTraycerEligible", () => {
  it("is eligible on a paid plan", () => {
    expect(isTraycerEligible(userSub({ status: "PRO_V3" }))).toBe(true);
  });

  it("is eligible on a free plan that holds an active bundle", () => {
    expect(
      isTraycerEligible(userSub({ status: "FREE", hasActiveBundle: true })),
    ).toBe(true);
  });

  it("is not eligible on a free, unbundled plan", () => {
    expect(isTraycerEligible(userSub({ status: "FREE" }))).toBe(false);
    expect(
      isTraycerEligible(userSub({ status: "FREE", hasActiveBundle: false })),
    ).toBe(false);
  });
});

describe("selectSubscription", () => {
  const personal = userSub({ status: "PRO_V3" });
  const team = teamSub("team-1");
  const user = userWith(personal, [team]);

  it("returns null when the user isn't loaded", () => {
    expect(selectSubscription(null, { type: "PERSONAL" }, [])).toBeNull();
  });

  it("returns the personal subscription for the PERSONAL context", () => {
    expect(selectSubscription(user, { type: "PERSONAL" }, [team])).toBe(
      personal,
    );
  });

  it("returns the matching team subscription for a TEAM context", () => {
    expect(
      selectSubscription(user, { type: "TEAM", teamId: "team-1" }, [team]),
    ).toBe(team);
  });

  it("returns null for a TEAM context with no matching team", () => {
    expect(
      selectSubscription(user, { type: "TEAM", teamId: "gone" }, [team]),
    ).toBeNull();
  });
});

describe("account-context value round-trip", () => {
  it("round-trips PERSONAL and TEAM", () => {
    expect(
      parseAccountContextValue(accountContextValue({ type: "PERSONAL" })),
    ).toEqual({
      type: "PERSONAL",
    });
    expect(
      parseAccountContextValue(
        accountContextValue({ type: "TEAM", teamId: "team-1" }),
      ),
    ).toEqual({ type: "TEAM", teamId: "team-1" });
  });
});

describe("resolveTraycerSubscriptionState", () => {
  const subscription = userSub({ status: "PRO_V3" });

  it("is cold while pending with no subscription yet", () => {
    expect(
      resolveTraycerSubscriptionState({
        isPending: true,
        isError: false,
        subscription: null,
      }),
    ).toEqual({ kind: "cold" });
  });

  it("is error when the fetch failed with no subscription", () => {
    expect(
      resolveTraycerSubscriptionState({
        isPending: false,
        isError: true,
        subscription: null,
      }),
    ).toEqual({ kind: "error" });
  });

  it("is empty when loaded but the account has no subscription", () => {
    expect(
      resolveTraycerSubscriptionState({
        isPending: false,
        isError: false,
        subscription: null,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("is ready when a subscription is present, degraded mirroring isError", () => {
    expect(
      resolveTraycerSubscriptionState({
        isPending: false,
        isError: false,
        subscription,
      }),
    ).toEqual({ kind: "ready", subscription, degraded: false });
    expect(
      resolveTraycerSubscriptionState({
        isPending: false,
        isError: true,
        subscription,
      }),
    ).toEqual({ kind: "ready", subscription, degraded: true });
  });
});

describe("subscriptionPlanLabel", () => {
  it("maps free-tier statuses to BYOA", () => {
    expect(subscriptionPlanLabel("FREE")).toBe("BYOA");
    expect(subscriptionPlanLabel("PENDING")).toBe("BYOA");
  });

  it("maps V3 credit plans", () => {
    expect(subscriptionPlanLabel("BYOA_V3")).toBe("Sync");
    expect(subscriptionPlanLabel("LITE_V3")).toBe("Lite");
    expect(subscriptionPlanLabel("PRO_V3")).toBe("Pro");
    expect(subscriptionPlanLabel("ULTRA_1X_V3")).toBe("Ultra");
    expect(subscriptionPlanLabel("ULTRA_2X_V3")).toBe("Ultra+");
    expect(subscriptionPlanLabel("ULTRA_3X_V3")).toBe("Ultra+");
    expect(subscriptionPlanLabel("ULTRA_4X_V3")).toBe("Ultra+");
    expect(subscriptionPlanLabel("ULTRA_5X_V3")).toBe("Ultra+");
  });

  it("marks legacy lite and pro tiers", () => {
    expect(subscriptionPlanLabel("LITE")).toBe("Lite (Legacy)");
    expect(subscriptionPlanLabel("LITE_V2")).toBe("Lite (Legacy)");
    expect(subscriptionPlanLabel("PRO")).toBe("Pro (Legacy)");
    expect(subscriptionPlanLabel("PRO_V2")).toBe("Pro (Legacy)");
    expect(subscriptionPlanLabel("PRO_LEGACY")).toBe("Pro (Legacy)");
    expect(subscriptionPlanLabel("PRO_PLUS")).toBe("Pro+ (Legacy)");
  });

  it("maps PRO_PLUS_V2 without a legacy suffix", () => {
    expect(subscriptionPlanLabel("PRO_PLUS_V2")).toBe("Pro+");
  });
});
