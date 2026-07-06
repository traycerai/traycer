import "../../../../../__tests__/test-browser-apis";
import type {
  AuthenticatedUser,
  TraycerTeamSubscription,
  TraycerUserSubscription,
} from "@traycer/protocol/auth";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountContextStore } from "@/stores/auth/account-context-store";

const mocks = vi.hoisted(() => ({
  data: null as AuthenticatedUser | null,
  refetch: vi.fn(() => Promise.resolve({})),
  openExternalLink: vi.fn(),
}));

vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({
    data: mocks.data,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    authnBaseUrl: "https://authn.traycer.ai",
    openExternalLink: mocks.openExternalLink,
  }),
}));

// Pure side-effect hook (subscribes to turn completions to refetch credits);
// no render output, and it needs a QueryClient this unit harness doesn't set up.
vi.mock("@/hooks/auth/use-refresh-credits-on-traycer-turn", () => ({
  useRefreshCreditsOnTraycerTurn: () => {},
}));

// Host RPC query + its turn-completion refresh, mounted by RateLimitView. Both
// need a host client/QueryClient this unit harness doesn't set up, so stub them:
// the query returns no data (totalTokens === 0 → "unavailable" text).
vi.mock("@/hooks/host/use-host-rate-limit-usage-query", () => ({
  useHostRateLimitUsageQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/host/use-refresh-rate-limit-usage-on-traycer-turn", () => ({
  useRefreshRateLimitUsageOnTraycerTurn: () => {},
}));

import { TraycerSubscriptionSection } from "../traycer-subscription-section";

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

const userSubscription: TraycerUserSubscription = {
  ...baseSubscription(),
  subscriptionStatus: "PRO_V3",
  isInTrial: false,
  totalPlanCredits: 100,
  credit: {
    id: "c1",
    userId: "u1",
    customerId: "cus",
    bonusCredits: 0,
    consumedFromPlan: 30,
    consumedFromBonus: 0,
    lastResetAt: EPOCH,
  },
};

const teamSubscription: TraycerTeamSubscription = {
  ...baseSubscription(),
  subscriptionStatus: "ULTRA_1X_V3",
  isInTrial: false,
  totalPlanCredits: 500,
  hasActiveBundle: false,
  bundleSummary: { bundleTotal: 0, bundleConsumed: 0, bundleRemaining: 0 },
  credit: {
    id: "c2",
    userId: "u1",
    customerId: "cus",
    orgId: "team-1",
    bonusCredits: 0,
    consumedFromPlan: 100,
    consumedFromBonus: 0,
    lastResetAt: EPOCH,
  },
  team: {
    id: "team-1",
    slug: "acme",
    avatarUrl: null,
    privacyMode: false,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  },
};

const user: AuthenticatedUser = {
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
  teamSubscriptions: [teamSubscription],
};

describe("TraycerSubscriptionSection", () => {
  beforeEach(() => {
    mocks.data = user;
    useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the personal subscription by default", () => {
    render(<TraycerSubscriptionSection />);
    // Plan bucket: 30 consumed of 100 total (extension's consumed/total wording).
    expect(screen.getByText("$30.00 / $100.00")).toBeDefined();
  });

  it("renders the selected team's subscription", () => {
    render(<TraycerSubscriptionSection />);
    act(() => {
      useAccountContextStore
        .getState()
        .setAccountContext({ type: "TEAM", teamId: "team-1" });
    });
    // Plan bucket: 100 consumed of 500 total.
    expect(screen.getByText("$100.00 / $500.00")).toBeDefined();
  });

  it("renders the rate-limit view for a non-V3 (legacy/v2) plan", () => {
    mocks.data = {
      ...user,
      userSubscription: {
        ...userSubscription,
        subscriptionStatus: "PRO_PLUS_V2",
        totalPlanCredits: undefined,
        credit: undefined,
        rechargeRateSeconds: 1800,
      },
    };
    render(<TraycerSubscriptionSection />);
    expect(screen.getByText("Rate limit")).toBeDefined();
    // 1800s → 30 minutes recharge.
    expect(screen.getByText("30 minutes")).toBeDefined();
    // Not credit-based: no credit-breakdown header.
    expect(screen.queryByText("Credit breakdown")).toBeNull();
    // Aperture usage mocked to no data (totalTokens === 0) → "unavailable"
    // text, never a 0/0 bar (decision 2 / invariant I4).
    expect(
      screen.getByText("Live artifact usage is unavailable."),
    ).toBeDefined();
  });
});
