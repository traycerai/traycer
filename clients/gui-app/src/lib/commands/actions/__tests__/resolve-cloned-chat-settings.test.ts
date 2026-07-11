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
import {
  mapProfileIdAcrossHosts,
  resolveClonedChatSettings,
} from "../resolve-cloned-chat-settings";

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
  accountUuid: string | null,
): ProviderProfile {
  return {
    profileId,
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
    profiles,
  };
}

function buildClient(
  profiles: ProviderProfile[] | null,
): HostClient<HostRpcRegistry> {
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers:
        profiles === null
          ? {}
          : {
              "providers.list": () => ({
                providers: [claudeState(profiles)],
              }),
            },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return client;
}

describe("mapProfileIdAcrossHosts", () => {
  it("returns null (ambient) when the source has no accountUuid", () => {
    expect(
      mapProfileIdAcrossHosts(null, [
        profile("work-uuid", "managed", "Work", "acct-1"),
      ]),
    ).toBeNull();
  });

  it("maps to the target's managed profile sharing the same accountUuid", () => {
    expect(
      mapProfileIdAcrossHosts("acct-1", [
        profile("ambient", "ambient", "Terminal account", "acct-9"),
        profile("target-work-uuid", "managed", "Work", "acct-1"),
      ]),
    ).toBe("target-work-uuid");
  });

  it("maps to null when the matching target profile is itself ambient", () => {
    expect(
      mapProfileIdAcrossHosts("acct-1", [
        profile("ambient", "ambient", "Terminal account", "acct-1"),
      ]),
    ).toBeNull();
  });

  it("returns null when no target profile shares the accountUuid", () => {
    expect(
      mapProfileIdAcrossHosts("acct-1", [
        profile("ambient", "ambient", "Terminal account", "acct-9"),
        profile("other-uuid", "managed", "Personal", "acct-2"),
      ]),
    ).toBeNull();
  });
});

describe("resolveClonedChatSettings", () => {
  it("passes ambient settings through untouched with no RPC calls", async () => {
    const sourceClient = buildClient([]);
    const targetClient = buildClient([]);
    const result = await resolveClonedChatSettings({
      sourceSettings: BASE_SETTINGS,
      sourceClient,
      targetClient,
    });
    expect(result).toEqual({
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
    });
    expect(result).toEqual({
      settings: { ...sourceSettings, profileId: "target-work-uuid" },
      fallenBackToAmbient: false,
    });
  });

  it("falls back to ambient when the source host is unreachable (null client)", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    const targetClient = buildClient([
      profile("target-work-uuid", "managed", "Work", "acct-1"),
    ]);
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient: null,
      targetClient,
    });
    expect(result).toEqual({
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: true,
    });
  });

  it("falls back to ambient when the target has no profile with a matching accountUuid", async () => {
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
    });
    expect(result).toEqual({
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: true,
    });
  });

  it("falls back to ambient when the source profile itself carries no accountUuid", async () => {
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
    });
    expect(result).toEqual({
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: true,
    });
  });

  it("treats an RPC failure on either host the same as no match found", async () => {
    const sourceSettings = { ...BASE_SETTINGS, profileId: "source-work-uuid" };
    // No handlers registered -> every request rejects.
    const sourceClient = buildClient(null);
    const targetClient = buildClient([
      profile("target-work-uuid", "managed", "Work", "acct-1"),
    ]);
    const result = await resolveClonedChatSettings({
      sourceSettings,
      sourceClient,
      targetClient,
    });
    expect(result).toEqual({
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: true,
    });
  });
});
