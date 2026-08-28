import { describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { resolveClonedChatSettings } from "../resolve-cloned-chat-settings";

const BASE_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
  account:
    | string
    | null
    | { readonly accountUuid: string | null; readonly enabled: boolean },
): ProviderProfile {
  const accountUuid =
    typeof account === "object" && account !== null
      ? account.accountUuid
      : account;
  const enabled =
    typeof account === "object" && account !== null ? account.enabled : true;
  return {
    profileId,
    enabled,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity:
      accountUuid === null ? null : { email: null, tier: null, accountUuid },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function claudeState(profiles: ProviderProfile[]): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
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
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles,
  };
}

function buildClient(
  profiles: ProviderProfile[] | null,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers:
        profiles === null
          ? {}
          : {
              "providers.list": () => ({
                providers: [claudeState(profiles)],
                native: null,
              }),
            },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

describe("resolveClonedChatSettings", () => {
  it("passes ambient settings through untouched when Terminal is enabled", async () => {
    const sourceClient = buildClient([]);
    const targetClient = buildClient([
      profile("ambient", "ambient", "Terminal account", "acct-9"),
    ]);
    const result = await resolveClonedChatSettings({
      sourceSettings: BASE_SETTINGS,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "ready",
      settings: BASE_SETTINGS,
      fallenBackToAmbient: false,
    });
  });

  it("maps the source profile to the target's matching profile by accountUuid", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const sourceClient = buildClient([
      profile("source-work-uuid", "managed", "Work", "acct-1"),
    ]);
    const targetClient = buildClient([
      profile("ambient", "ambient", "Terminal account", "acct-9"),
      profile("target-work-uuid", "managed", "Work", "acct-1"),
    ]);
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "ready",
      settings: { ...sourceSettings, profileId: "target-work-uuid" },
      fallenBackToAmbient: false,
    });
  });

  it("requires profile selection when the identity match on the target is disabled", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const sourceClient = buildClient([
      profile("source-work-uuid", "managed", "Work", "acct-1"),
    ]);
    const targetProfiles = [
      profile("ambient", "ambient", "Terminal account", "acct-9"),
      profile("target-work-uuid", "managed", "Work", {
        accountUuid: "acct-1",
        enabled: false,
      }),
    ];
    const targetClient = buildClient(targetProfiles);
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });

    expect(result).toEqual({
      status: "profile-selection-required",
      providerId: "claude-code",
      reason: "matching-profile-disabled",
      matchedProfileId: "target-work-uuid",
      targetProfiles,
    });
  });

  it("returns ready for an explicitly selected enabled target profile", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const targetProfiles = [
      profile("ambient", "ambient", "Terminal account", "acct-9"),
      profile("target-work-uuid", "managed", "Work", "acct-1"),
    ];
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient: null,
      targetClient: buildClient(targetProfiles),
      explicitTargetProfileId: { profileId: "target-work-uuid" },
    });

    expect(result).toEqual({
      status: "ready",
      settings: { ...sourceSettings, profileId: "target-work-uuid" },
      fallenBackToAmbient: false,
    });
  });

  it("reports when an explicitly selected profile disappeared from the target", async () => {
    const targetProfiles = [
      profile("ambient", "ambient", "Terminal account", "acct-9"),
      profile("target-work-uuid", "managed", "Work", "acct-1"),
    ];
    const result = await resolveClonedChatSettings({
      sourceSettings: { ...BASE_SETTINGS, profileId: "source-work-uuid" },
      sourceClient: null,
      targetClient: buildClient(targetProfiles),
      explicitTargetProfileId: { profileId: "vanished-profile" },
    });

    expect(result).toEqual({
      status: "profile-selection-required",
      providerId: "claude-code",
      reason: "explicit-profile-missing",
      matchedProfileId: "vanished-profile",
      targetProfiles,
    });
  });

  it("falls back to ambient when the source host is unreachable (null client)", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const targetClient = buildClient([
      profile("ambient", "ambient", "Terminal account", "acct-9"),
      profile("target-work-uuid", "managed", "Work", "acct-1"),
    ]);
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient: null,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "ready",
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: true,
    });
  });

  it("falls back to Terminal when no identity matches and Terminal is enabled", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const sourceClient = buildClient([
      profile("source-work-uuid", "managed", "Work", "acct-1"),
    ]);
    const targetClient = buildClient([
      profile("ambient", "ambient", "Terminal account", "acct-9"),
    ]);
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "ready",
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: true,
    });
  });

  it("requires profile selection when no eligible Terminal fallback exists", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const sourceClient = buildClient([
      profile("source-work-uuid", "managed", "Work", null),
    ]);
    const targetClient = buildClient([
      profile("target-work-uuid", "managed", "Work", "acct-1"),
    ]);
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "profile-selection-required",
      providerId: "claude-code",
      reason: "no-enabled-terminal-fallback",
      matchedProfileId: null,
      targetProfiles: [
        profile("target-work-uuid", "managed", "Work", "acct-1"),
      ],
    });
  });

  it("distinguishes target catalog transport failure from an empty catalog", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    // The source may be unavailable; the target catalog failure is the
    // recovery state this regression distinguishes from an honest empty list.
    const sourceClient = buildClient(null);
    const targetClient = buildClient(null);
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
      explicitTargetProfileId: null,
    });
    expect(result).toEqual({
      status: "catalog-unavailable",
      providerId: "claude-code",
    });
  });
});
