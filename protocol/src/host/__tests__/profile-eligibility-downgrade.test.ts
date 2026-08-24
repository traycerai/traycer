import { describe, expect, it } from "vitest";
import {
  downgradeProviderCliStateListToV70,
  providerCliStateSchema,
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

function profileRow(profileId: string, enabled: boolean) {
  return {
    profileId,
    kind: "managed" as const,
    authType: "oauth" as const,
    label: profileId,
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
    enabled,
  };
}

describe("providers.list v8 to v7 future-provider downgrade", () => {
  it("filters a future provider, omits disabled profiles, and strips enabled", () => {
    const liveState = providerCliStateSchema.parse({
      ...providerState("claude-code"),
      profiles: [profileRow("enabled", true), profileRow("disabled", false)],
    });
    const futureProviderState = {
      ...liveState,
      providerId: "future-provider",
    };

    const downgraded = downgradeProviderCliStateListToV70([
      liveState,
      futureProviderState,
    ]);

    expect(downgraded).toHaveLength(1);
    expect(downgraded[0]?.providerId).toBe("claude-code");
    expect(downgraded[0]?.profiles).toHaveLength(1);
    expect(downgraded[0]?.profiles[0]?.profileId).toBe("enabled");
    expect(downgraded[0]?.profiles[0]).not.toHaveProperty("enabled");
  });
});
