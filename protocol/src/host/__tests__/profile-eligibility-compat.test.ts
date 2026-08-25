import { describe, expect, it } from "vitest";
import {
  downgradeResponseAcrossMajors,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providerCliStateSchema,
  providerProfileSchema,
  providerProfileSchemaV70,
  providersListResponseSchema,
  providersListResponseSchemaV70,
  providersSetEnabledRequestSchemaV21,
  providersSetProfileEnabledRequestSchema,
  providersSetProfileEnabledResponseSchema,
} from "@traycer/protocol/host/provider-schemas";

function providerState(providerId: string) {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" as const },
    candidates: [],
    auth: {
      status: "unknown" as const,
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
  };
}

function profileRow(
  enabled: boolean | undefined,
  launchCommand: {
    readonly command: string;
    readonly shell: "posix";
  } | null,
) {
  return {
    profileId: enabled === false ? "disabled" : "enabled",
    kind: "managed" as const,
    authType: "oauth" as const,
    label: enabled === false ? "Disabled" : "Enabled",
    auth: {
      status: "authenticated" as const,
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown" as const,
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
    launchCommand,
    ...(enabled === undefined ? {} : { enabled }),
  };
}

describe("profile eligibility protocol compatibility", () => {
  it("defaults omitted profile eligibility to enabled", () => {
    expect(providerProfileSchema.parse(profileRow(undefined, null)).enabled).toBe(
      true,
    );
    expect(providerProfileSchemaV70.safeParse(profileRow(false, null)).success).toBe(
      true,
    );
  });

  it("normalizes a malformed present profile eligibility value to enabled", () => {
    const malformed = { ...profileRow(undefined, null), enabled: "yes" };

    expect(providerProfileSchema.parse(malformed).enabled).toBe(true);
  });

  it("upgrades a v7 response with legacy profiles as enabled", () => {
    const legacy = providersListResponseSchemaV70.parse({
      providers: [
        {
          ...providerState("claude-code"),
          profiles: [profileRow(undefined, null)],
        },
      ],
      native: null,
    });

    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 7, minor: 0 },
      { major: 8, minor: 0 },
      legacy,
    );
    expect(upgraded.providers[0]?.profiles).toEqual([
      expect.objectContaining({ profileId: "enabled", enabled: true }),
    ]);
  });

  it("omits disabled profiles from the v8-to-v7 older-client projection", () => {
    const current = providersListResponseSchema.parse({
      providers: [
        providerCliStateSchema.parse({
          ...providerState("claude-code"),
          profiles: [
            profileRow(true, {
              command: "CLAUDE_CONFIG_DIR='/profiles/enabled' claude",
              shell: "posix",
            }),
            profileRow(false, null),
          ],
        }),
      ],
      native: null,
    });

    const downgraded = downgradeResponseAcrossMajors(
      hostRpcRegistry["providers.list"],
      8,
      7,
      current,
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(downgraded.value.providers[0]?.profiles).toEqual([
      expect.objectContaining({ profileId: "enabled" }),
    ]);
    expect(
      JSON.stringify(downgraded.value.providers[0]?.profiles),
    ).not.toContain("disabled");
    expect(downgraded.value.providers[0]?.profiles[0]).not.toHaveProperty(
      "launchCommand",
    );
    expect(downgraded.value.providers[0]?.profiles[0]).not.toHaveProperty(
      "enabled",
    );
  });

  it("keeps profile enablement on its optional RPC instead of released setEnabled@2.1", () => {
    expect(
      providersSetEnabledRequestSchemaV21.safeParse({
        providerId: "claude-code",
        enabled: true,
        profileId: "managed",
        profileEnabled: false,
      }).data,
    ).toEqual({
      providerId: "claude-code",
      enabled: true,
      profileAction: null,
    });
    expect(
      providersSetProfileEnabledRequestSchema.parse({
        providerId: "claude-code",
        profileId: "managed",
        enabled: false,
      }),
    ).toEqual({
      providerId: "claude-code",
      profileId: "managed",
      enabled: false,
    });
    expect(
      providersSetProfileEnabledResponseSchema.parse({
        profileId: "managed",
        enabled: false,
      }),
    ).toEqual({ profileId: "managed", enabled: false });
    expect(hostRpcRegistry["providers.setProfileEnabled"]).toBeDefined();
  });
});
