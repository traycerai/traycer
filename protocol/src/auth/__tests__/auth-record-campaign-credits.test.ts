import { describe, expect, it } from "vitest";
import {
  downgradeRecordAcrossMajors,
  upgradeRecordToVersion,
  type ValueOf,
} from "@traycer/protocol/framework/index";
import {
  authRecordRegistry,
  authenticatedUserResponseRecordV100,
  authenticatedUserResponseRecordV200,
  authenticatedUserResponseRecordV300,
} from "@traycer/protocol/auth/registry";
import type { AuthenticatedUserCampaignCredit } from "@traycer/protocol/auth";

type V200 = ValueOf<typeof authenticatedUserResponseRecordV200>;
type V300 = ValueOf<typeof authenticatedUserResponseRecordV300>;

const campaignCredits: AuthenticatedUserCampaignCredit[] = [
  {
    campaignId: "campaign-1",
    name: "Desktop offer",
    description: null,
    grantCredits: 500,
    remainingCredits: 320,
    endsAt: "2026-12-31T00:00:00.000Z",
  },
  {
    campaignId: "campaign-2",
    name: "Launch bonus",
    description: "Thanks for trying it",
    grantCredits: 100,
    remainingCredits: 100,
    endsAt: "2027-01-31T00:00:00.000Z",
  },
];

function baseV200(): V200 {
  return {
    user: {
      id: "user-1",
      name: "Ada Lovelace",
      providerId: "provider-id-1",
      providerHandle: "ada",
      providerType: "GITHUB",
      email: "ada@example.com",
      avatarUrl: null,
      activatedAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      lastSeenAt: null,
      privacyMode: false,
      isLearningEnabled: true,
    },
    userSubscription: {
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
    },
    payAsYouGoUsage: { allowPayAsYouGo: false },
    teamSubscriptions: [],
  };
}

function baseV300(): V300 {
  return {
    ...baseV200(),
    environments: { personal: "env-personal", teams: [] },
    actingAs: null,
  };
}

describe("authenticated-user-response campaignCredits", () => {
  describe.each([
    ["major 2", authenticatedUserResponseRecordV200, baseV200],
    ["major 3", authenticatedUserResponseRecordV300, baseV300],
  ])("%s", (_label, record, base) => {
    it("keeps a valid campaignCredits list", () => {
      const parsed = record.schema.parse({ ...base(), campaignCredits });
      expect(parsed.campaignCredits).toEqual(campaignCredits);
    });

    it("parses a body without campaignCredits, leaving it absent", () => {
      const parsed = record.schema.parse(base());
      expect(parsed.campaignCredits).toBeUndefined();
    });

    it.each([
      ["a string", "not-a-list"],
      ["an item missing name", [{ ...campaignCredits[0], name: undefined }]],
      [
        "a negative remainingCredits",
        [{ ...campaignCredits[0], remainingCredits: -5 }],
      ],
      [
        "an endsAt that is not a date",
        [{ ...campaignCredits[0], endsAt: "soon" }],
      ],
    ])("drops %s to undefined without rejecting the record", (_n, bad) => {
      const result = record.schema.safeParse({
        ...base(),
        campaignCredits: bad,
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("unreachable");
      expect(result.data.campaignCredits).toBeUndefined();
      expect(result.data.user).toEqual(base().user);
      expect(result.data.userSubscription).toEqual(base().userSubscription);
    });
  });

  it("strips campaignCredits on the frozen major-1 schema", () => {
    const parsed = authenticatedUserResponseRecordV100.schema.parse({
      ...baseV200(),
      campaignCredits,
    });
    expect(Object.hasOwn(parsed, "campaignCredits")).toBe(false);
  });

  describe("bridges", () => {
    const registry = authRecordRegistry["authenticated-user-response"];

    it("keeps campaignCredits on 3 to 2", () => {
      const result = downgradeRecordAcrossMajors(registry, 3, 2, {
        ...baseV300(),
        campaignCredits,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(
        authenticatedUserResponseRecordV200.schema.parse(result.value)
          .campaignCredits,
      ).toEqual(campaignCredits);
    });

    it("drops campaignCredits on 2 to 1", () => {
      const result = downgradeRecordAcrossMajors(registry, 2, 1, {
        ...baseV200(),
        campaignCredits,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(Object.hasOwn(result.value, "campaignCredits")).toBe(false);
      expect(
        Object.hasOwn(
          authenticatedUserResponseRecordV100.schema.parse(result.value),
          "campaignCredits",
        ),
      ).toBe(false);
    });

    it("drops campaignCredits on 3 to 1", () => {
      const result = downgradeRecordAcrossMajors(registry, 3, 1, {
        ...baseV300(),
        campaignCredits,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(Object.hasOwn(result.value, "campaignCredits")).toBe(false);
    });

    it("keeps campaignCredits on 2 to 3", () => {
      const upgraded = upgradeRecordToVersion(
        registry,
        { major: 2, minor: 0 },
        { major: 3, minor: 0 },
        { ...baseV200(), campaignCredits },
      );
      expect(
        authenticatedUserResponseRecordV300.schema.parse(upgraded)
          .campaignCredits,
      ).toEqual(campaignCredits);
    });
  });
});
