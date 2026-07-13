import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import { selectionFromChatRunSettings } from "@/lib/composer/chat-run-settings";

/**
 * D6 (durability audit): "Pre-feature chat (null profileId everywhere) after
 * flag ON + managed profiles exist: stays ambient, zero prompts."
 *
 * A chat created before the profile feature existed has a persisted
 * `ChatRunSettings` blob with NO `profileId` KEY AT ALL (not `null` - the
 * field is structurally absent), because the type didn't have it yet. This
 * probes both halves: (1) the seed resolver treats "absent" the same as
 * "ambient", and (2) with the flag now on and 2 managed profiles present,
 * an otherwise-healthy ambient login produces zero new prompts/banners.
 */

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderCliState[],
  refresh: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/hooks/providers/use-tab-providers-list-query", () => ({
  useTabProvidersList: (activity: { enabled: boolean }) =>
    activity.enabled
      ? { data: { providers: mocks.providers } }
      : { data: undefined },
}));
vi.mock("@/hooks/providers/use-tab-refresh-providers", () => ({
  useTabRefreshProviders: () => mocks.refresh,
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useProviderReauthGate } from "../use-provider-reauth-gate";
import { useProfileRateLimitSwitchPrompt } from "../use-profile-rate-limit-switch-prompt";
import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";

// A genuine legacy blob: parsed JSON that never had a `profileId` key,
// exactly what an old serialized `ChatRunSettings` looks like at runtime
// (TypeScript can't express "missing key" on a literal typed as
// `ChatRunSettings`, so this goes through `JSON.parse` the same way the
// real persisted-blob rehydration path does).
function legacyChatRunSettingsBlob(): ChatRunSettings {
  const json = JSON.stringify({
    harnessId: "claude",
    model: "sonnet-4.5",
    permissionMode: "supervised",
    reasoningEffort: "high",
    serviceTier: null,
    agentMode: "regular",
    // no `profileId` key here at all
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
    accentColor: null,
    ambientDriftNotice: null,
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

function PreFeatureComposerHarness({
  seed,
}: {
  readonly seed: ChatRunSettings;
}) {
  const initialProfileId = selectionFromChatRunSettings(seed).profileId;
  const [profileId, setProfileId] = useState<string | null>(initialProfileId);
  // `authoritative: true` - this harness models the chat's OWN persisted
  // settings (`chat.settings`), the authoritative seed, not a fallback.
  const reauthGate = useProviderReauthGate(
    "claude",
    profileId,
    true,
    "authoritative",
  );
  const rateLimitPrompt = useProfileRateLimitSwitchPrompt(
    "claude",
    profileId,
    true,
  );
  const onSwitchProfile = useCallback((next: string | null) => {
    setProfileId(next);
  }, []);

  return (
    <div>
      <div data-testid="profile-id">{profileId ?? "ambient"}</div>
      <div data-testid="send-blocked">{String(reauthGate.signedOut)}</div>
      <div data-testid="banner-visible">
        {String(!reauthGate.signedOut && rateLimitPrompt.limited)}
      </div>
      {!reauthGate.signedOut && rateLimitPrompt.limited ? (
        <ProfileRateLimitSwitchBanner
          harnessId="claude"
          hardLimited={rateLimitPrompt.hardLimited}
          current={rateLimitPrompt.current}
          alternatives={rateLimitPrompt.alternatives}
          onSwitchProfile={onSwitchProfile}
          affectedChatCount={1}
          onSwitchProfileForTask={() => undefined}
          onDismiss={rateLimitPrompt.dismiss}
        />
      ) : null}
    </div>
  );
}

describe("D6: pre-feature chat + flag-on multi-profile state", () => {
  beforeEach(() => {
    mocks.providers = [];
  });
  afterEach(() => {
    cleanup();
  });

  it("selectionFromChatRunSettings resolves an absent profileId key to ambient (null), not undefined", () => {
    const selection = selectionFromChatRunSettings(legacyChatRunSettingsBlob());
    expect(selection.profileId).toBeNull();
  });

  it("a pre-feature chat with a healthy ambient login shows zero prompts/banners even with 2 managed profiles present", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "ok"),
        profile("work-uuid", "managed", "Work", "ok"),
        profile("personal-uuid", "managed", "Personal", "near_limit"),
      ]),
    ];
    render(<PreFeatureComposerHarness seed={legacyChatRunSettingsBlob()} />);

    expect(screen.getByTestId("profile-id").textContent).toBe("ambient");
    expect(screen.getByTestId("send-blocked").textContent).toBe("false");
    expect(screen.getByTestId("banner-visible").textContent).toBe("false");
    expect(
      screen.queryByRole("button", { name: /Continue this session on/ }),
    ).toBeNull();
  });

  it("documents intended behavior (not a bug): the feature applies uniformly, so a rate-limited AMBIENT login on a pre-feature chat DOES surface the same switch banner a managed profile would get", () => {
    mocks.providers = [
      claudeState([
        profile("ambient", "ambient", "Terminal account", "hard_limit"),
        profile("work-uuid", "managed", "Work", "ok"),
      ]),
    ];
    render(<PreFeatureComposerHarness seed={legacyChatRunSettingsBlob()} />);

    expect(screen.getByTestId("profile-id").textContent).toBe("ambient");
    // This is expected, not a regression: a pre-feature chat is
    // indistinguishable from a "chat committed to the ambient login" once
    // resolved, and ambient's own rate-limit state is real - the multi-
    // profile feature does not special-case "this chat predates profiles".
    expect(screen.getByTestId("banner-visible").textContent).toBe("true");
  });
});
