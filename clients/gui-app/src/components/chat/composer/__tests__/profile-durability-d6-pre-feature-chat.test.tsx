import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { selectionFromChatRunSettings } from "@/lib/composer/chat-run-settings";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
}));

vi.mock("@/hooks/providers/use-tab-providers-list-query", () => ({
  useTabProvidersList: (activity: { enabled: boolean }) =>
    activity.enabled
      ? { data: { providers: mocks.providers } }
      : { data: undefined },
}));

import { useProfileRateLimitSwitchPrompt } from "../use-profile-rate-limit-switch-prompt";

function legacyChatRunSettingsBlob(): ChatRunSettings {
  const json = JSON.stringify({
    harnessId: "claude",
    model: "sonnet-4.5",
    permissionMode: "supervised",
    reasoningEffort: "high",
    serviceTier: null,
    agentMode: "regular",
  });
  return JSON.parse(json) as ChatRunSettings;
}

function profile(
  profileId: string,
  kind: "ambient" | "managed",
  label: string,
  rateLimitStatus: ProviderProfileRateLimitStatus,
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
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

function claudeState(profiles: ProviderProfile[]): ProviderCliState {
  const providerId: ProviderId = "claude-code";
  return {
    providerId,
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

describe("D6: pre-feature chat + multi-profile state", () => {
  beforeEach(() => {
    mocks.providers = [];
  });

  it("resolves an absent profileId key to the ambient profile", () => {
    expect(
      selectionFromChatRunSettings(legacyChatRunSettingsBlob()).profileId,
    ).toBeNull();
  });

  it("keeps a healthy ambient pre-feature chat hidden despite managed profiles", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "ok"),
        profile("work", "managed", "Work", "ok"),
        profile("personal", "managed", "Personal", "near_limit"),
      ]),
    ];
    const { result } = renderHook(() =>
      useProfileRateLimitSwitchPrompt(
        "claude",
        selectionFromChatRunSettings(legacyChatRunSettingsBlob()).profileId,
        true,
      ),
    );
    expect(result.current.kind).toBe("hidden");
  });

  it("applies the warning uniformly when the ambient profile is limited", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work", "managed", "Work", "ok"),
      ]),
    ];
    const { result } = renderHook(() =>
      useProfileRateLimitSwitchPrompt(
        "claude",
        selectionFromChatRunSettings(legacyChatRunSettingsBlob()).profileId,
        true,
      ),
    );
    expect(result.current.kind).toBe("visible");
  });
});
