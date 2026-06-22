/**
 * Canonical AuthenticatedUser test fixture for traycer-agents tests.
 *
 * Every field required by the real authn service contract is present so that
 * future model changes cause compile-time failures rather than silent
 * runtime mismatches.
 */
import type { AuthenticatedUser } from "@traycer/protocol/auth";

/**
 * Returns a deeply-populated AuthenticatedUser fixture.
 * Pass overrides to customise individual fields per test.
 */
export function createAuthenticatedUserFixture(
  overrides: Partial<AuthenticatedUser> | undefined,
): AuthenticatedUser {
  const effectiveOverrides = overrides ?? {};
  const base: AuthenticatedUser = {
    user: {
      id: "user-fixture-1",
      name: "Test User",
      providerId: "github|12345",
      providerHandle: "testuser",
      providerType: "GITHUB",
      email: "test@example.com",
      avatarUrl: "https://example.com/avatar.png",
      activatedAt: new Date("2024-01-01T00:00:00Z"),
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
      lastSeenAt: new Date("2024-01-01T00:00:00Z"),
      privacyMode: false,
      isLearningEnabled: true,
    } as AuthenticatedUser["user"],
    userSubscription: {
      id: "sub-fixture-1",
      userID: "user-fixture-1",
      orgID: null,
      teamID: null,
      customerId: "cus_fixture1",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-01-01T00:00:00Z"),
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus: "PRO",
      hasPaymentMethod: true,
      isInTrial: false,
      rechargeRateSeconds: 3600,
    } as AuthenticatedUser["userSubscription"],
    teamSubscriptions: [],
    payAsYouGoUsage: {
      allowPayAsYouGo: false,
    },
  };

  return { ...base, ...effectiveOverrides };
}
