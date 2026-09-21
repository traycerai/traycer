import { describe, expect, it } from "vitest";
import {
  downgradeRecordAcrossMajors,
  upgradeRecordToVersion,
  type ValueOf,
} from "@traycer/protocol/framework/index";
import {
  authRecordRegistry,
  authenticatedUserResponseRecordV100,
  exchangeTokenResponseRecordV100,
  exchangeTokenResponseRecordV200,
  listAllMcpServersResponseRecordV100,
  listAllMcpServersResponseRecordV200,
  providerLoginResponseRecordV100,
  providerLoginResponseRecordV200,
  userRecordV100,
  userRecordV200,
} from "@traycer/protocol/auth/registry";
import type {
  AuthenticatedUser,
  ProviderType,
  User,
} from "@traycer/protocol/auth";

/**
 * Bridge coverage for the two records that actually downgrade: `user` owns
 * the real bridge, `authenticated-user-response` delegates to it and
 * rebuilds the envelope around the result.
 *
 * `downgradeRecordAcrossMajors` hands a bridge's output straight back to
 * its caller WITHOUT validating it, so every downgrade assertion below
 * re-parses the result against the frozen major-1 schema rather than only
 * comparing strings - a bridge that emitted an out-of-contract shape would
 * pass a string comparison and fail here.
 *
 * `User` and `AuthenticatedUser` are the registry's own latest-major (2)
 * types, so the fixtures below stay in lock-step with the schema.
 */

function userFixture(providerType: ProviderType): User {
  return {
    id: "user-1",
    name: "Ada Lovelace",
    providerId: "provider-id-1",
    providerHandle: "ada",
    providerType,
    email: "ada@example.com",
    avatarUrl: "https://example.com/ada.png",
    activatedAt: new Date("2024-01-01T00:00:00.000Z"),
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-02T00:00:00.000Z"),
    lastSeenAt: new Date("2024-01-03T00:00:00.000Z"),
    privacyMode: false,
    isLearningEnabled: true,
  };
}

function subscriptionFixture(): AuthenticatedUser["userSubscription"] {
  return {
    id: "sub-1",
    userID: "user-1",
    orgID: null,
    teamID: null,
    customerId: "cus_1",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    subscriptionExpiry: null,
    trialEndsAt: null,
    subscriptionStatus: "PRO",
    hasPaymentMethod: true,
    isInTrial: false,
    rechargeRateSeconds: 3600,
  };
}

function authenticatedUserResponseFixtureWithHostId(
  providerType: ProviderType,
  hostId: string | null,
): AuthenticatedUser {
  return {
    user: userFixture(providerType),
    userSubscription: subscriptionFixture(),
    payAsYouGoUsage: { allowPayAsYouGo: false },
    teamSubscriptions: [],
    hostId,
  };
}

function authenticatedUserResponseFixtureWithoutHostId(
  providerType: ProviderType,
): AuthenticatedUser {
  return {
    user: userFixture(providerType),
    userSubscription: subscriptionFixture(),
    payAsYouGoUsage: { allowPayAsYouGo: false },
    teamSubscriptions: [],
  };
}

describe("user record bridge (2 to 1 and 1 to 2)", () => {
  it("downgrades APPLE to EMAIL, leaving every other field unchanged", () => {
    const v200 = userFixture("APPLE");
    const result = downgradeRecordAcrossMajors(
      authRecordRegistry.user,
      2,
      1,
      v200,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const parsed = userRecordV100.schema.parse(result.value);
    expect(parsed).toEqual({ ...v200, providerType: "EMAIL" });
  });

  it("passes GITHUB through both directions unchanged", () => {
    assertPassthrough("GITHUB");
  });

  it("passes GOOGLE through both directions unchanged", () => {
    assertPassthrough("GOOGLE");
  });

  it("passes GITLAB through both directions unchanged", () => {
    assertPassthrough("GITLAB");
  });

  it("passes EMAIL through both directions unchanged", () => {
    assertPassthrough("EMAIL");
  });

  it("rejects APPLE on the frozen major-1 schema and accepts it on major 2", () => {
    const record = userFixture("APPLE");
    expect(userRecordV100.schema.safeParse(record).success).toBe(false);
    expect(userRecordV200.schema.safeParse(record).success).toBe(true);
  });
});

function assertPassthrough(
  providerType: "GITHUB" | "GOOGLE" | "GITLAB" | "EMAIL",
): void {
  const v200 = userFixture(providerType);

  const downgraded = downgradeRecordAcrossMajors(
    authRecordRegistry.user,
    2,
    1,
    v200,
  );
  expect(downgraded.ok).toBe(true);
  if (!downgraded.ok) throw new Error("unreachable");
  expect(userRecordV100.schema.parse(downgraded.value)).toEqual(v200);

  const v100 = userRecordV100.schema.parse(v200);
  const upgraded = upgradeRecordToVersion(
    authRecordRegistry.user,
    { major: 1, minor: 0 },
    { major: 2, minor: 0 },
    v100,
  );
  expect(userRecordV200.schema.parse(upgraded)).toEqual(v200);
}

describe("authenticated-user-response bridge (2 to 1)", () => {
  it("maps the nested user and rebuilds the envelope, hostId present and null", () => {
    const v200 = authenticatedUserResponseFixtureWithHostId("APPLE", null);
    const result = downgradeRecordAcrossMajors(
      authRecordRegistry["authenticated-user-response"],
      2,
      1,
      v200,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const parsed = authenticatedUserResponseRecordV100.schema.parse(
      result.value,
    );
    expect(parsed).toEqual({
      ...v200,
      user: { ...v200.user, providerType: "EMAIL" },
      hostId: null,
    });
  });

  it("maps the nested user and rebuilds the envelope, hostId absent", () => {
    const v200 = authenticatedUserResponseFixtureWithoutHostId("APPLE");
    const result = downgradeRecordAcrossMajors(
      authRecordRegistry["authenticated-user-response"],
      2,
      1,
      v200,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const parsed = authenticatedUserResponseRecordV100.schema.parse(
      result.value,
    );
    expect(parsed).toEqual({
      ...v200,
      user: { ...v200.user, providerType: "EMAIL" },
    });
    expect(Object.hasOwn(parsed, "hostId")).toBe(false);
  });

  it("preserves userSubscription, payAsYouGoUsage and teamSubscriptions for a non-Apple user", () => {
    const v200 = authenticatedUserResponseFixtureWithHostId("GITHUB", "host-1");
    const result = downgradeRecordAcrossMajors(
      authRecordRegistry["authenticated-user-response"],
      2,
      1,
      v200,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const parsed = authenticatedUserResponseRecordV100.schema.parse(
      result.value,
    );
    expect(parsed).toEqual(v200);
  });
});

describe("a record with no downgrade path", () => {
  it("refuses provider-login-response 2 to 1 with a typed DOWNGRADE_UNSUPPORTED", () => {
    const v200: ValueOf<typeof providerLoginResponseRecordV200> = {
      token: "token-1",
      user: userFixture("GITHUB"),
    };
    const result = downgradeRecordAcrossMajors(
      authRecordRegistry["provider-login-response"],
      2,
      1,
      v200,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "DOWNGRADE_UNSUPPORTED",
        message: "No direct downgrade path exists from major 2 to major 1",
      },
    });
  });
});

/**
 * The three cloud-ui-only envelopes were bumped to major 2 solely to keep
 * cloud-ui's TypeScript type truthful (plan, "Protocol" section) - they have
 * no downgrade path, so that promise rests entirely on the major-2 schema
 * actually ACCEPTING `APPLE` and the major-1 schema actually REJECTING it.
 * Both halves are asserted below; acceptance alone would still pass if V100
 * and V200 were wired to the same schema by mistake.
 */
describe("cloud-ui-only envelopes: major 2 accepts APPLE, major 1 rejects it", () => {
  it("provider-login-response", () => {
    const applePayload: ValueOf<typeof providerLoginResponseRecordV200> = {
      token: "token-1",
      user: userFixture("APPLE"),
    };
    expect(
      providerLoginResponseRecordV200.schema.safeParse(applePayload).success,
    ).toBe(true);
    expect(
      providerLoginResponseRecordV100.schema.safeParse(applePayload).success,
    ).toBe(false);
  });

  it("exchange-token-response", () => {
    const applePayload: ValueOf<typeof exchangeTokenResponseRecordV200> = {
      token: "token-1",
      user: authenticatedUserResponseFixtureWithoutHostId("APPLE"),
    };
    expect(
      exchangeTokenResponseRecordV200.schema.safeParse(applePayload).success,
    ).toBe(true);
    expect(
      exchangeTokenResponseRecordV100.schema.safeParse(applePayload).success,
    ).toBe(false);
  });

  it("list-all-mcp-servers-response", () => {
    const applePayload: ValueOf<typeof listAllMcpServersResponseRecordV200> = {
      user: { user: userFixture("APPLE"), servers: [] },
      organizations: [],
    };
    expect(
      listAllMcpServersResponseRecordV200.schema.safeParse(applePayload)
        .success,
    ).toBe(true);
    expect(
      listAllMcpServersResponseRecordV100.schema.safeParse(applePayload)
        .success,
    ).toBe(false);
  });
});
