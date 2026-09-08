import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";

// D27: the composer's rate-limit switch banner lists API-key profiles after
// non-limited OAuth profiles, badged "API key". Drives the real
// `useProfileRateLimitSwitchPrompt` hook (mirroring the established pattern
// in `profile-durability-d2-d3-rate-limit-switch.test.tsx`) so the ordering,
// `primaryTarget` precedence, and badge are proven end to end rather than
// against a re-implemented copy of `destinationsForLimitedProfile`.

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
// Render the Radix dropdown inline + always-open so the badge/row assertion
// doesn't fight pointer-open semantics in jsdom - the established pattern
// (see `folder-controls.test.tsx`'s identical comment) for testing content
// that a real DropdownMenuContent only portals in once open.
vi.mock("@/components/ui/dropdown-menu", () => {
  const passthrough = (props: { readonly children: ReactNode }): ReactNode =>
    props.children;
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: (props: { readonly children: ReactNode }) => (
      <div>{props.children}</div>
    ),
    DropdownMenuLabel: passthrough,
    DropdownMenuItem: (props: {
      readonly children: ReactNode;
      readonly "aria-label"?: string;
      readonly "aria-disabled"?: boolean;
      readonly onSelect?: (event: { preventDefault: () => void }) => void;
    }) => (
      // A real `<button>` rather than a `role`-carrying div: the stub is an
      // interactive menu row, so it has to be focusable and keyboard-operable
      // the way the primitive it stands in for is.
      <button
        type="button"
        role="menuitem"
        aria-label={props["aria-label"]}
        aria-disabled={props["aria-disabled"]}
        onClick={() => props.onSelect?.({ preventDefault: () => undefined })}
      >
        {props.children}
      </button>
    ),
  };
});

import {
  useProfileRateLimitSwitchPrompt,
  type ProfileRateLimitSwitchPrompt,
} from "../use-profile-rate-limit-switch-prompt";
import { ProfileRateLimitSwitchBanner } from "../profile-rate-limit-switch-banner";
import { useRateLimitSwitchPromptDismissalsStore } from "@/stores/rate-limits/rate-limit-switch-prompt-dismissals-store";

interface ProfileFixtureInput {
  readonly profileId: string;
  readonly label: string;
  readonly authType: "oauth" | "apiKey";
  readonly rateLimitStatus: ProviderProfileRateLimitStatus;
}

function profile(input: ProfileFixtureInput): ProviderProfile {
  return {
    profileId: input.profileId,
    enabled: true,
    kind: "managed",
    authType: input.authType,
    label: input.label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: input.rateLimitStatus,
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
    // D06/D07 fields, required on the live `ProviderProfile` shape - null for
    // every OAuth fixture, and (deliberately, for the apiKey fixture) a real
    // endpoint summary so an apiKey row looks like a real one.
    endpoint:
      input.authType === "apiKey"
        ? {
            host: "https://api.example.test",
            model: null,
            credentialKind: "api_key",
            credentialConfigured: true,
            lastTest: null,
          }
        : null,
    config: null,
  };
}

function claudeState(
  profiles: ReadonlyArray<ProviderProfile>,
): ProviderCliState {
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
    profiles: [...profiles],
  };
}

function PromptHarness(props: {
  readonly onPrompt: (prompt: ProfileRateLimitSwitchPrompt) => void;
}) {
  const prompt = useProfileRateLimitSwitchPrompt({
    harnessId: "claude",
    profileId: "current",
    selectedModel: null,
    active: true,
    client: null,
  });
  props.onPrompt(prompt);
  return (
    <TooltipProvider delayDuration={0}>
      {prompt.kind === "visible" ? (
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
          onSwitchProfile={() => undefined}
          affectedChatCount={1}
          onSwitchProfileForTask={() => undefined}
          onDismiss={prompt.dismiss}
        />
      ) : null}
    </TooltipProvider>
  );
}

const CURRENT = profile({
  profileId: "current",
  label: "Current",
  authType: "oauth",
  rateLimitStatus: "hard_limit",
});

describe("D27: API-key profiles order last in the rate-limit switch banner", () => {
  beforeEach(() => {
    mocks.providers = [];
    useRateLimitSwitchPromptDismissalsStore.setState({
      dismissedKeys: new Set<string>(),
    });
  });
  afterEach(cleanup);

  it("orders destinations non-limited OAuth first, then API-key, keeping wire order within each group", () => {
    const apiKeyA = profile({
      profileId: "api-key-a",
      label: "API Key A",
      authType: "apiKey",
      rateLimitStatus: "ok",
    });
    const oauthHealthy = profile({
      profileId: "oauth-healthy",
      label: "OAuth Healthy",
      authType: "oauth",
      rateLimitStatus: "ok",
    });
    const oauthLimited = profile({
      profileId: "oauth-limited",
      label: "OAuth Limited",
      authType: "oauth",
      rateLimitStatus: "hard_limit",
    });
    // Wire order deliberately does NOT match the expected banner order.
    mocks.providers = [
      claudeState([CURRENT, apiKeyA, oauthHealthy, oauthLimited]),
    ];

    // Collected rather than assigned into a `let`: TS keeps the `null`
    // narrowing from the initializer across a callback assignment, so every
    // read below the `if` would be `never`.
    const seen: ProfileRateLimitSwitchPrompt[] = [];
    render(<PromptHarness onPrompt={(prompt) => seen.push(prompt)} />);
    const latest = seen.at(-1) ?? null;

    expect(latest?.kind).toBe("visible");
    if (latest === null || latest.kind !== "visible") return;
    expect(
      latest.destinations.map((destination) => destination.profileId),
    ).toEqual(["oauth-healthy", "oauth-limited", "api-key-a"]);
    expect(
      latest.destinations.map((destination) => destination.isApiKey),
    ).toEqual([false, false, true]);
  });

  it("recommends the healthy OAuth profile as primaryTarget over an equally-proven API-key profile", () => {
    const apiKeyProvenBetter = profile({
      profileId: "api-key-a",
      label: "API Key A",
      authType: "apiKey",
      rateLimitStatus: "ok",
    });
    const oauthHealthy = profile({
      profileId: "oauth-healthy",
      label: "OAuth Healthy",
      authType: "oauth",
      rateLimitStatus: "ok",
    });
    mocks.providers = [
      claudeState([CURRENT, apiKeyProvenBetter, oauthHealthy]),
    ];

    // Collected rather than assigned into a `let`: TS keeps the `null`
    // narrowing from the initializer across a callback assignment, so every
    // read below the `if` would be `never`.
    const seen: ProfileRateLimitSwitchPrompt[] = [];
    render(<PromptHarness onPrompt={(prompt) => seen.push(prompt)} />);
    const latest = seen.at(-1) ?? null;

    expect(latest?.kind).toBe("visible");
    if (latest === null || latest.kind !== "visible") return;
    // Both destinations are proven strictly better than `current`'s
    // hard_limit; the reordering alone (D27) is what makes the healthy OAuth
    // profile win - `recommendedDestination` takes the first match in
    // `destinations` order, with no second rule for API-key rows.
    expect(latest.primaryTarget?.profileId).toBe("oauth-healthy");
  });

  it("renders the API key badge on an API-key row, which stays selectable", () => {
    const apiKeyA = profile({
      profileId: "api-key-a",
      label: "API Key A",
      authType: "apiKey",
      rateLimitStatus: "ok",
    });
    // A second, non-recommended OAuth destination so this mirrors the real
    // multi-destination case rather than the degenerate single-row one.
    const oauthLimited = profile({
      profileId: "oauth-limited",
      label: "OAuth Limited",
      authType: "oauth",
      rateLimitStatus: "hard_limit",
    });
    mocks.providers = [claudeState([CURRENT, apiKeyA, oauthLimited])];

    render(<PromptHarness onPrompt={() => undefined} />);

    const badge = screen.getByText("API key");
    expect(badge).toBeTruthy();
    const row = screen.getByRole("menuitem", { name: /API Key A/ });
    expect(row.getAttribute("aria-disabled")).toBe("false");
  });

  it("degrades to today's ordering when a row carries no authType (older host)", () => {
    const legacyProfile = profile({
      profileId: "legacy",
      label: "Legacy",
      authType: "oauth",
      rateLimitStatus: "ok",
    });
    // Simulates an older host build's row, which the live `ProviderProfile`
    // type says can't happen (`authType` is required) but real JSON off an
    // old host can still omit - `destinationsForLimitedProfile`'s `===
    // "apiKey"` check must survive it (D21/M12's `.catch` guard is what makes
    // this degrade rather than throw upstream). Built by omitting the field
    // from a real, schema-valid fixture rather than hand-rolling a fake
    // shape, then cast back: the whole point of this fixture IS the gap
    // between the wire and the type, which nothing "real" can express.
    const { authType: _authType, ...withoutAuthType } = legacyProfile;
    const legacyRow = withoutAuthType as ProviderProfile;
    const oauthHealthy = profile({
      profileId: "oauth-healthy",
      label: "OAuth Healthy",
      authType: "oauth",
      rateLimitStatus: "ok",
    });
    mocks.providers = [claudeState([CURRENT, legacyRow, oauthHealthy])];

    // Collected rather than assigned into a `let`: TS keeps the `null`
    // narrowing from the initializer across a callback assignment, so every
    // read below the `if` would be `never`.
    const seen: ProfileRateLimitSwitchPrompt[] = [];
    render(<PromptHarness onPrompt={(prompt) => seen.push(prompt)} />);
    const latest = seen.at(-1) ?? null;

    expect(latest?.kind).toBe("visible");
    if (latest === null || latest.kind !== "visible") return;
    // Wire order preserved - the missing `authType` degrades to `isApiKey:
    // false` (today's behavior), never sorted last and never thrown on.
    expect(
      latest.destinations.map((destination) => destination.profileId),
    ).toEqual(["legacy", "oauth-healthy"]);
    expect(latest.destinations[0]?.isApiKey).toBe(false);
  });
});
