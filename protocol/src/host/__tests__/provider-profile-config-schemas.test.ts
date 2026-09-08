import { describe, expect, it } from "vitest";
import { z } from "zod";

import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  providerSelectionSchema,
  providersStartLoginSeedSourceSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  profileCliSelectionSchema,
  profileConfigSchema,
  profileSeedSourceSchema,
  providersCreateApiKeyProfileRequestSchema,
  providersCreateApiKeyProfileResponseSchema,
  providersGetProfileConfigResponseSchema,
  providersSetProfileConfigRequestSchema,
} from "@traycer/protocol/host/provider-profile-config-schemas";

const NEW_PROFILE_CONFIG_METHOD_NAMES = [
  "providers.getProfileConfig",
  "providers.setProfileConfig",
  "providers.setProfileOwnership",
  "providers.createApiKeyProfile",
  "providers.testProfileConnection",
  "providers.previewCopySettings",
  "providers.applyCopySettings",
  "providers.resolveLaunchEnv",
] as const;

describe("provider-profile-config-schemas (D21)", () => {
  it("registers all eight methods as optional @1.0 capabilities off the released floor", () => {
    for (const method of NEW_PROFILE_CONFIG_METHOD_NAMES) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);

      const entry = hostRpcRegistry[method];
      expect(entry).toBeDefined();
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1]).toBeDefined();
      expect(entry[1].latestMinor).toBe(0);
      expect(entry[1].versions[0].upgradeFromPreviousVersion).toBeNull();
      expect(entry[1].downgradePathsFromLatest).toEqual({});
    }
  });

  it("credentialUpdate accepts all three arms and rejects set with no value", () => {
    const base = {
      providerId: "claude-code" as const,
      profileId: null,
      config: {
        cliSelection: null,
        terminalAgentArgs: "",
        env: [],
        endpoint: null,
        skills: "linked" as const,
        plugins: "linked" as const,
      },
    };

    expect(
      providersSetProfileConfigRequestSchema.safeParse({
        ...base,
        credentialUpdate: { kind: "unchanged" },
      }).success,
    ).toBe(true);
    expect(
      providersSetProfileConfigRequestSchema.safeParse({
        ...base,
        credentialUpdate: { kind: "set", value: "sk-abc" },
      }).success,
    ).toBe(true);
    expect(
      providersSetProfileConfigRequestSchema.safeParse({
        ...base,
        credentialUpdate: { kind: "clear" },
      }).success,
    ).toBe(true);
    expect(
      providersSetProfileConfigRequestSchema.safeParse({
        ...base,
        credentialUpdate: { kind: "set" },
      }).success,
    ).toBe(false);
  });

  it("profileConfigSchema has exactly the six documented keys", () => {
    expect(Object.keys(profileConfigSchema.shape).sort()).toEqual(
      [
        "cliSelection",
        "terminalAgentArgs",
        "env",
        "endpoint",
        "skills",
        "plugins",
      ].sort(),
    );
  });

  it("no response schema here models a credential: a stray key is dropped on parse", () => {
    const parsed = providersGetProfileConfigResponseSchema.parse({
      config: {
        cliSelection: null,
        terminalAgentArgs: "",
        env: [],
        endpoint: null,
        skills: "linked",
        plugins: "linked",
        credential: "sk-should-not-survive",
      },
    });
    expect(parsed.config).not.toHaveProperty("credential");
  });

  it("createApiKeyProfile requires a passing test and never puts a bare error on the wire", () => {
    expect(
      providersCreateApiKeyProfileRequestSchema.safeParse({
        providerId: "claude-code",
        label: "Work",
        accentColor: null,
        startFrom: { kind: "empty" },
        endpoint: {
          baseUrl: null,
          credentialKind: "api_key",
          defaultModel: null,
        },
        credential: "sk-abc",
      }).success,
    ).toBe(true);

    // D10: a failed test is an ORDINARY outcome carrying a scrubbed reason,
    // not an RPC error - and a success is not expressible without the verdict
    // that made it one.
    expect(
      providersCreateApiKeyProfileResponseSchema.safeParse({
        ok: false,
        reason: "401 from the endpoint",
      }).success,
    ).toBe(true);
    expect(
      providersCreateApiKeyProfileResponseSchema.safeParse({
        ok: false,
        reason: "x".repeat(513),
      }).success,
    ).toBe(false);
    expect(
      providersCreateApiKeyProfileResponseSchema.safeParse({
        ok: true,
        profileId: "p1",
        verdict: { at: 1, ok: true, reason: null },
      }).success,
    ).toBe(true);
    expect(
      providersCreateApiKeyProfileResponseSchema.safeParse({
        ok: true,
        profileId: "p1",
      }).success,
    ).toBe(false);
  });

  // Rule 11: `providersStartLoginSeedSourceSchema` is a FORCED duplicate of
  // `profileSeedSourceSchema` (importing it into `provider-schemas.ts` would
  // close a module cycle), and a forced duplicate needs a guard on it - the
  // two back the same user gesture on two different methods
  // (`startLogin@1.3`'s `startFrom` and `createApiKeyProfile`'s).
  it("the startLogin@1.3 seed source and profileSeedSourceSchema serialize identically", () => {
    expect(z.toJSONSchema(providersStartLoginSeedSourceSchema)).toEqual(
      z.toJSONSchema(profileSeedSourceSchema),
    );
  });

  it("profileCliSelectionSchema accepts a managed arm that providerSelectionSchema still rejects (critique B2)", () => {
    const managed = { kind: "managed", version: "1.2.3" };
    expect(profileCliSelectionSchema.safeParse(managed).success).toBe(true);
    expect(providerSelectionSchema.safeParse(managed).success).toBe(false);
  });
});
