import type {
  AuthenticatedUser,
  TraycerTeamSubscription,
  TraycerUserSubscription,
} from "@traycer/protocol/auth";

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

export function userSubscription(plan: {
  readonly totalPlanCredits: number;
  readonly consumedFromPlan: number;
  readonly bonusCredits: number;
  readonly consumedFromBonus: number;
  readonly bundleRemaining: number;
}): TraycerUserSubscription {
  return {
    ...baseSubscription(),
    subscriptionStatus: "PRO_V3",
    isInTrial: false,
    totalPlanCredits: plan.totalPlanCredits,
    credit: {
      id: "credit-1",
      userId: "u1",
      customerId: "cus",
      lastResetAt: EPOCH,
      consumedFromPlan: plan.consumedFromPlan,
      bonusCredits: plan.bonusCredits,
      consumedFromBonus: plan.consumedFromBonus,
    },
    bundleSummary: {
      bundleTotal: plan.bundleRemaining,
      bundleConsumed: 0,
      bundleRemaining: plan.bundleRemaining,
    },
  };
}

export function teamSubscription(
  totalPlanCredits: number,
): TraycerTeamSubscription {
  return {
    ...baseSubscription(),
    teamID: "team-1",
    subscriptionStatus: "ULTRA_1X_V3",
    isInTrial: false,
    totalPlanCredits,
    hasActiveBundle: false,
    bundleSummary: { bundleTotal: 0, bundleConsumed: 0, bundleRemaining: 0 },
    team: {
      id: "team-1",
      slug: "acme",
      avatarUrl: null,
      privacyMode: false,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    },
  };
}

export function userWith(
  personal: TraycerUserSubscription,
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
    userSubscription: personal,
    payAsYouGoUsage: { allowPayAsYouGo: false },
    teamSubscriptions: teams,
  };
}
