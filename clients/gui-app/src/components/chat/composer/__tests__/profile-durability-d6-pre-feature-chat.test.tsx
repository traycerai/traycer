import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { selectionFromChatRunSettings } from "@/lib/composer/chat-run-settings";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
}));

vi.mock("@/hooks/providers/use-tab-providers-list-query", () => ({
  useTabProvidersList: (activity: { enabled: boolean }) =>
    activity.enabled
      ? { data: { providers: mocks.providers } }
      : { data: undefined },
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: (
    _client: unknown,
    activity: { enabled: boolean },
  ) =>
    activity.enabled
      ? { data: { providers: mocks.providers } }
      : { data: undefined },
}));
vi.mock("@/hooks/rate-limits/use-profile-usage-presentation", () => ({
  useProfileUsagePresentation: () => ({
    isHostReady: true,
    entries: new Map(),
  }),
}));

import { useProviderReauthGate } from "../use-provider-reauth-gate";
import { useProfileRateLimitSwitchPrompt } from "../use-profile-rate-limit-switch-prompt";
import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";

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
    rateLimitLimitedScopes: null,
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

// Seeded from `selectionFromChatRunSettings` on a legacy (no `profileId`
// key) blob, so the initial `profileId` state matches exactly what a
// pre-feature chat resolves to on first render - mirrors
// `ComposerProfileSwitchHarness` in
// `profile-durability-d2-d3-rate-limit-switch.test.tsx`, the current
// composer/store harness pattern for this banner.
function PreFeatureComposerHarness() {
  const [profileId, setProfileId] = useState<string | null>(
    selectionFromChatRunSettings(legacyChatRunSettingsBlob()).profileId,
  );
  const reauthGate = useProviderReauthGate(
    "claude",
    profileId,
    true,
    "authoritative",
  );
  const prompt = useProfileRateLimitSwitchPrompt({
    harnessId: "claude",
    profileId,
    selectedModel: null,
    active: true,
    client: null,
  });
  const visible = !reauthGate.signedOut && prompt.kind === "visible";
  return (
    <TooltipProvider delayDuration={0}>
      <div>
        <div data-testid="profile-id">{profileId ?? "ambient"}</div>
        <div data-testid="send-blocked">{String(reauthGate.signedOut)}</div>
        <div data-testid="banner-visible">{String(visible)}</div>
        {visible ? (
          <ProfileRateLimitSwitchBanner
            harnessId="claude"
            providerId={prompt.providerId}
            severity={prompt.severity}
            limitedFamilies={prompt.limitedFamilies}
            current={prompt.current}
            profiles={prompt.profiles}
            destinations={prompt.destinations}
            primaryTarget={prompt.primaryTarget}
            probeTarget={null}
            runTargetHostId={null}
            onSwitchProfile={setProfileId}
            affectedChatCount={1}
            onSwitchProfileForTask={() => undefined}
            onDismiss={prompt.dismiss}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

describe("D6: pre-feature chat + multi-profile state", () => {
  beforeEach(() => {
    mocks.providers = [];
  });
  afterEach(cleanup);

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
      useProfileRateLimitSwitchPrompt({
        harnessId: "claude",
        profileId: selectionFromChatRunSettings(legacyChatRunSettingsBlob())
          .profileId,
        selectedModel: null,
        active: true,
        client: null,
      }),
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
      useProfileRateLimitSwitchPrompt({
        harnessId: "claude",
        profileId: selectionFromChatRunSettings(legacyChatRunSettingsBlob())
          .profileId,
        selectedModel: null,
        active: true,
        client: null,
      }),
    );
    expect(result.current.kind).toBe("visible");
  });

  it("integrated: a pre-feature chat with a healthy ambient login renders zero prompts/banners even with 2 managed profiles present", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "ok"),
        profile("work", "managed", "Work", "ok"),
        profile("personal", "managed", "Personal", "near_limit"),
      ]),
    ];
    render(<PreFeatureComposerHarness />);

    expect(screen.getByTestId("profile-id").textContent).toBe("ambient");
    expect(screen.getByTestId("send-blocked").textContent).toBe("false");
    expect(screen.getByTestId("banner-visible").textContent).toBe("false");
    expect(screen.queryByRole("button", { name: /^Switch to/ })).toBeNull();
  });

  it("integrated: a rate-limited ambient login on a pre-feature chat renders the same switch banner a managed profile would get", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work", "managed", "Work", "ok"),
      ]),
    ];
    render(<PreFeatureComposerHarness />);

    expect(screen.getByTestId("profile-id").textContent).toBe("ambient");
    // Expected, not a regression: a pre-feature chat is indistinguishable
    // from a chat committed to the ambient login once resolved, and
    // ambient's own rate-limit state is real - the multi-profile feature
    // does not special-case "this chat predates profiles".
    expect(screen.getByTestId("banner-visible").textContent).toBe("true");
    expect(
      screen.getByRole("button", { name: "Switch to Work" }),
    ).toBeDefined();
  });
});
