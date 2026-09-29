import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";

// Same rationale as the sibling scoped-section suites: the dialog this section
// always mounts pulls in mutation/host hooks unconditionally, so those are
// stubbed to keep this test scoped to a QueryClient with no bound host.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => ({
  useRenameProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => ({
  useRecolorProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));

import { ProviderProfileScopedSection } from "@/components/settings/panels/provider-profile-scoped-section";

const OAUTH_CAP: ProviderCliState["loginCapability"] = {
  oauthArgs: ["auth", "login"],
  token: null,
  codePaste: null,
  terminalLogin: null,
  remoteSafe: null,
  selfOpensBrowser: null,
};

function ambientProfile(): ProviderCliState["profiles"][number] {
  return {
    profileId: "ambient",
    enabled: true,
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

// `opencode` is not in the rate-limit-capable provider set, so the embedded
// usage card and refresh button take their no-query branch - no additional
// host-query mocking needed for this section-level test.
function opencodeState(overrides: Partial<ProviderCliState>): ProviderCliState {
  return {
    providerId: "opencode",
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
    profiles: [ambientProfile()],
    ...overrides,
  };
}

function renderSection(
  overrides: Partial<Parameters<typeof ProviderProfileScopedSection>[0]>,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProviderProfileScopedSection
          state={opencodeState({})}
          hostId="host-1"
          isSelectedHostLocal
          canAddProfile
          onOpenCliSettings={() => undefined}
          startInReauth={false}
          failedAttempt={null}
          onAddProfile={() => undefined}
          onDismissFailedAttempt={() => undefined}
          selectedProfileId={null}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable={false}
          profileStatusRefreshAvailable={false}
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
          {...overrides}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * The host-gating redesign: a provider that is off holds every profile
 * control it does not need to turn itself back on, whether or not the host
 * could otherwise run its CLI (`profileControlsHold`'s `managementHeldReason`).
 * `canAddProfile` is a caller-computed prop (mirroring `resolveCreateProfileGate`
 * / `providerHostBlock`) - these tests exercise the SECTION's own reaction to
 * it and to `state.enabled`, not the gate function itself (covered in
 * `provider-signin-availability.test.ts`).
 */
describe("<ProviderProfileScopedSection /> host gate", () => {
  afterEach(() => {
    cleanup();
  });

  it("disables Manage profile with the disabled reason, and holds the refresh button and usage card inert, while the provider is off", () => {
    renderSection({ state: opencodeState({ enabled: false }) });

    const manageButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Manage profile",
    });
    expect(manageButton.disabled).toBe(true);
    expect(tooltipTextNear(manageButton)).toBe(
      "OpenCode is turned off. Turn it on to sign in or manage its profiles.",
    );

    // Wrapped, not merely styled: `inert` removes the refresh button and the
    // usage card from the accessibility tree and from pointer/focus
    // interaction, which `pointer-events-none` classes alone do not do.
    const refreshButton = screen.getByRole("button", {
      name: /^Refresh profile statuses/,
    });
    expect(refreshButton.closest("[inert]")).not.toBeNull();
  });

  it("keeps Manage profile enabled with no tooltip while the provider is on", () => {
    renderSection({ state: opencodeState({ enabled: true }) });

    const manageButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Manage profile",
    });
    expect(manageButton.disabled).toBe(false);
    expect(tooltipTextNear(manageButton)).toBe(
      "Change the profile name and accent color, sign in again, or remove this profile.",
    );
    expect(
      screen
        .getByRole("button", { name: /^Refresh profile statuses/ })
        .closest("[inert]"),
    ).toBeNull();
  });

  it("disables Retry alongside Add profile when canAddProfile is false", () => {
    renderSection({
      canAddProfile: false,
      failedAttempt: {
        providerId: "opencode",
        message: "did not finish",
      },
    });

    const retryButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Retry",
    });
    expect(retryButton.disabled).toBe(true);
    const addProfileButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Add profile",
    });
    expect(addProfileButton.disabled).toBe(true);
  });

  it("shows the CLI & Args link when sign-in is blocked by a missing CLI, not by the provider being off", () => {
    renderSection({
      canAddProfile: false,
      state: opencodeState({
        enabled: true,
        loginCapability: OAUTH_CAP,
        candidates: [],
      }),
    });

    expect(screen.getByRole("button", { name: "CLI & Args" })).toBeDefined();
    expect(
      screen.getByText("The OpenCode CLI is not installed on this host.", {
        exact: false,
      }),
    ).toBeDefined();
  });

  it("shows the CLI & Args link when the host resolved no CLI although an unselected one is available", () => {
    renderSection({
      canAddProfile: false,
      state: opencodeState({
        enabled: true,
        loginCapability: OAUTH_CAP,
        selected: { kind: "custom", path: "/gone/opencode" },
        candidates: [
          {
            kind: "custom",
            path: "/gone/opencode",
            version: null,
            available: false,
            versionPending: false,
          },
          {
            kind: "custom",
            path: "/other/opencode",
            version: "1.0.0",
            available: true,
            versionPending: false,
          },
        ],
        cliBinaryResolved: false,
      }),
    });

    expect(screen.getByRole("button", { name: "CLI & Args" })).toBeDefined();
    expect(
      screen.getByText(
        "The selected OpenCode CLI is not available on this host.",
        { exact: false },
      ),
    ).toBeDefined();
  });

  it("does not show the CLI & Args link when sign-in is blocked because the provider is off", () => {
    renderSection({
      canAddProfile: false,
      state: opencodeState({
        enabled: false,
        loginCapability: OAUTH_CAP,
        candidates: [],
      }),
    });

    // The reason is still shown - just without a link to a tab that does not
    // fix "the provider is off" (that is the header switch's job).
    expect(
      screen.getByText(
        "OpenCode is turned off. Turn it on to sign in or manage its profiles.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "CLI & Args" })).toBeNull();
  });
});
