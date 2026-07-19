import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
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
vi.mock("@/hooks/rate-limits/use-profile-usage-presentation", () => ({
  useProfileUsagePresentation: () => ({
    isHostReady: true,
    entries: new Map(),
  }),
}));

import { useProviderReauthGate } from "../use-provider-reauth-gate";
import { useProfileRateLimitSwitchPrompt } from "../use-profile-rate-limit-switch-prompt";
import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";
import { resolveComposerTopBannerKind } from "../chat-composer-top-banner";
import { useRateLimitSwitchPromptDismissalsStore } from "@/stores/rate-limits/rate-limit-switch-prompt-dismissals-store";

function profile(input: {
  readonly profileId: string;
  readonly kind: "ambient" | "managed";
  readonly label: string;
  readonly rateLimitStatus: ProviderProfileRateLimitStatus;
  readonly authenticated: boolean;
}): ProviderProfile {
  const { profileId, kind, label, rateLimitStatus, authenticated } = input;
  return {
    profileId,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: authenticated ? "authenticated" : "unauthenticated",
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

function ComposerProfileSwitchHarness() {
  const [profileId, setProfileId] = useState<string | null>(null);
  const reauthGate = useProviderReauthGate(
    "claude",
    profileId,
    true,
    "authoritative",
  );
  const prompt = useProfileRateLimitSwitchPrompt(
    "claude",
    profileId,
    null,
    true,
  );
  const visible = prompt.kind === "visible";
  return (
    <TooltipProvider delayDuration={0}>
      <div>
        <div data-testid="profile-id">{profileId ?? "ambient"}</div>
        <div data-testid="send-blocked">{String(reauthGate.signedOut)}</div>
        <div data-testid="banner-visible">
          {String(!reauthGate.signedOut && visible)}
        </div>
        {!reauthGate.signedOut && visible ? (
          <ProfileRateLimitSwitchBanner
            harnessId="claude"
            providerId={prompt.providerId}
            severity={prompt.severity}
            limitedFamilies={prompt.limitedFamilies}
            current={prompt.current}
            profiles={prompt.profiles}
            destinations={prompt.destinations}
            primaryTarget={prompt.primaryTarget}
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

function ComposerBannerPrecedenceHarness() {
  const [profileId, setProfileId] = useState<string | null>(null);
  const [pendingAmbientDrift, setPendingAmbientDrift] = useState(false);
  const [acknowledgedAmbientDrift, setAcknowledgedAmbientDrift] =
    useState(false);
  const reauthGate = useProviderReauthGate(
    "claude",
    profileId,
    true,
    "authoritative",
  );
  const prompt = useProfileRateLimitSwitchPrompt(
    "claude",
    profileId,
    null,
    true,
  );
  const rateLimitVisible = !reauthGate.signedOut && prompt.kind === "visible";
  const topBannerKind = resolveComposerTopBannerKind({
    reauthVisible: reauthGate.signedOut,
    ambientDriftVisible: pendingAmbientDrift && !acknowledgedAmbientDrift,
    rateLimitVisible,
  });
  const submit = (): void => {
    if (!acknowledgedAmbientDrift) {
      setPendingAmbientDrift(true);
      return;
    }
  };
  return (
    <TooltipProvider delayDuration={0}>
      <div>
        <button type="button" onClick={submit}>
          Send
        </button>
        <div data-testid="top-banner-kind">{topBannerKind}</div>
        {topBannerKind === "ambient-drift" ? (
          <div role="alert">
            <span>Terminal account changed</span>
            <button
              type="button"
              onClick={() => {
                setAcknowledgedAmbientDrift(true);
                setPendingAmbientDrift(false);
              }}
            >
              Continue with Terminal account
            </button>
          </div>
        ) : null}
        {topBannerKind === "rate-limit" && prompt.kind === "visible" ? (
          <ProfileRateLimitSwitchBanner
            harnessId="claude"
            providerId={prompt.providerId}
            severity={prompt.severity}
            limitedFamilies={prompt.limitedFamilies}
            current={prompt.current}
            profiles={prompt.profiles}
            destinations={prompt.destinations}
            primaryTarget={prompt.primaryTarget}
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

describe("D2/D3: lifecycle, durability, and banner precedence", () => {
  beforeEach(() => {
    mocks.providers = [];
    useRateLimitSwitchPromptDismissalsStore.setState({
      dismissedKeys: new Set<string>(),
    });
  });
  afterEach(cleanup);

  it("keeps Terminal identity drift ahead of rate-limit and reveals the warning after acknowledgement", () => {
    const ambient = profile({
      profileId: "ambient",
      kind: "ambient",
      label: "Terminal account",
      rateLimitStatus: "hard_limit",
      authenticated: true,
    });
    mocks.providers = [
      claudeState([
        {
          ...ambient,
          identity: {
            email: "new@example.test",
            tier: null,
            accountUuid: null,
          },
          ambientDriftNotice: {
            previousEmail: "old@example.test",
            changedAt: 1735689600000,
          },
        },
        profile({
          profileId: "work",
          kind: "managed",
          label: "Work",
          rateLimitStatus: "ok",
          authenticated: true,
        }),
      ]),
    ];
    render(<ComposerBannerPrecedenceHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByTestId("top-banner-kind").textContent).toBe(
      "ambient-drift",
    );
    expect(screen.queryByRole("button", { name: "Switch to Work" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Terminal account" }),
    );
    expect(screen.getByTestId("top-banner-kind").textContent).toBe(
      "rate-limit",
    );
    expect(
      screen.getByRole("button", { name: "Switch to Work" }),
    ).toBeDefined();
  });

  it("allows a dismissed warning to resurface when severity changes", () => {
    mocks.providers = [
      claudeState([
        profile({
          profileId: "ambient",
          kind: "ambient",
          label: "Terminal account",
          rateLimitStatus: "near_limit",
          authenticated: true,
        }),
        profile({
          profileId: "work",
          kind: "managed",
          label: "Work",
          rateLimitStatus: "ok",
          authenticated: true,
        }),
      ]),
    ];
    const { rerender } = render(<ComposerProfileSwitchHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss rate-limit suggestion" }),
    );
    expect(screen.getByTestId("banner-visible").textContent).toBe("false");
    mocks.providers = [
      claudeState([
        profile({
          profileId: "ambient",
          kind: "ambient",
          label: "Terminal account",
          rateLimitStatus: "hard_limit",
          authenticated: true,
        }),
        profile({
          profileId: "work",
          kind: "managed",
          label: "Work",
          rateLimitStatus: "ok",
          authenticated: true,
        }),
      ]),
    ];
    rerender(<ComposerProfileSwitchHarness />);
    expect(screen.getByTestId("banner-visible").textContent).toBe("true");
  });

  it("renders the all-limited state as a stable read-only warning with no automatic action", () => {
    mocks.providers = [
      claudeState([
        profile({
          profileId: "ambient",
          kind: "ambient",
          label: "Terminal account",
          rateLimitStatus: "hard_limit",
          authenticated: true,
        }),
        profile({
          profileId: "work",
          kind: "managed",
          label: "Work",
          rateLimitStatus: "hard_limit",
          authenticated: true,
        }),
      ]),
    ];
    const { rerender } = render(<ComposerProfileSwitchHarness />);
    expect(screen.getByTestId("banner-visible").textContent).toBe("true");
    expect(
      screen.getByRole("button", { name: "View profile limits" }),
    ).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
    for (let index = 0; index < 5; index += 1) {
      act(() => rerender(<ComposerProfileSwitchHarness />));
    }
    expect(screen.getByTestId("profile-id").textContent).toBe("ambient");
  });
});
