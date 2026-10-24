import { describe, expect, it } from "vitest";
import {
  getRecordSchema,
  validateVersionedRecordRegistry,
} from "@traycer/protocol/framework/index";
import { authRecordRegistry } from "@traycer/protocol/auth/registry";

/**
 * `defineVersionedRecordRegistry` validates when `registry.ts` loads, so a
 * bad version annotation on any auth record throws APP-WIDE while both
 * `bun run --cwd traycer compile` and `bun run compile` still pass. Merely
 * importing the registry already exercises that guarantee; this file pins
 * it with an explicit assertion, mirroring
 * `framework/__tests__/seeded-registries.test.ts` (which covers the host RPC
 * registry, the common record registry and the persistence record
 * registry, but not this one).
 */
describe("authRecordRegistry", () => {
  it("validates at import (does not throw)", () => {
    expect(() =>
      validateVersionedRecordRegistry(authRecordRegistry),
    ).not.toThrow();
  });

  it("carries majors 1 and 2 on the four records bumped for Apple sign-in and major 3 on authenticated-user-response", () => {
    expect(Object.keys(authRecordRegistry.user).sort()).toEqual(["1", "2"]);
    expect(
      Object.keys(authRecordRegistry["authenticated-user-response"]).sort(),
    ).toEqual(["1", "2", "3"]);
    expect(
      Object.keys(authRecordRegistry["provider-login-response"]).sort(),
    ).toEqual(["1", "2"]);
    expect(
      Object.keys(authRecordRegistry["exchange-token-response"]).sort(),
    ).toEqual(["1", "2"]);
    expect(
      Object.keys(authRecordRegistry["list-all-mcp-servers-response"]).sort(),
    ).toEqual(["1", "2"]);
  });

  it("keeps organization and legacy-authenticated-user-response at major 1 only", () => {
    expect(Object.keys(authRecordRegistry.organization).sort()).toEqual(["1"]);
    expect(
      Object.keys(
        authRecordRegistry["legacy-authenticated-user-response"],
      ).sort(),
    ).toEqual(["1"]);
  });

  it("requires environments and actingAs on the latest authenticated-user-response schema", () => {
    const schema = getRecordSchema(
      authRecordRegistry,
      "authenticated-user-response",
      "latest",
    );
    const base = {
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
    const environments = {
      personal: "env-personal",
      teams: [{ teamId: "team-1", environmentId: "env-team-1" }],
    };
    const actingAs = { environmentId: "env-team-1" };

    expect(schema.safeParse({ ...base, environments, actingAs }).success).toBe(
      true,
    );
    expect(schema.safeParse({ ...base, actingAs }).success).toBe(false);
    expect(schema.safeParse({ ...base, environments }).success).toBe(false);
  });

  it("serves the major-2 user schema at 'latest', which accepts APPLE", () => {
    const schema = getRecordSchema(authRecordRegistry, "user", "latest");
    const result = schema.safeParse({
      id: "user-1",
      name: "Ada Lovelace",
      providerId: "provider-id-1",
      providerHandle: "ada",
      providerType: "APPLE",
      email: "ada@example.com",
      avatarUrl: null,
      activatedAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      lastSeenAt: null,
      privacyMode: false,
      isLearningEnabled: true,
    });
    expect(result.success).toBe(true);
  });
});
