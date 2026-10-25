import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  NO_NOTICES,
  NO_OVERRIDES,
  NO_REVIEW,
  PersonalPageContext,
} from "@/components/settings/personal/personal-page-context";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
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

function managedProfile(): ProviderCliState["profiles"][number] {
  return {
    ...ambientProfile(),
    profileId: "managed-1",
    kind: "managed",
    label: "Work",
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
    profiles: [managedProfile()],
    ...overrides,
  };
}

function renderSection(
  overrides: Partial<Parameters<typeof ProviderProfileScopedSection>[0]>,
  hostName: string | null,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const section = (
    <ProviderProfileScopedSection
      state={opencodeState({})}
      hostId="host-1"
      isSelectedHostLocal
      canAddProfile
      credentialRefusal={null}
      onOpenCliSettings={() => undefined}
      startInReauth={false}
      failedAttempt={null}
      onAddProfile={() => undefined}
      onDismissFailedAttempt={() => undefined}
      selectedProfileId={null}
      onSelectedProfileIdChange={() => undefined}
      profileEnablementAvailable={false}
      profileEnablementPending={() => false}
      onSetProfileEnabled={() => undefined}
      {...overrides}
    />
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {hostName === null ? (
          section
        ) : (
          <PersonalPageContext.Provider
            value={{
              section: "providers",
              pick: PERSONAL_PICK,
              state: { kind: "unknown" },
              line: null,
              hostName,
              localOverrides: NO_OVERRIDES,
              hostId: "host-1",
              client: null,
              notices: NO_NOTICES,
              review: NO_REVIEW,
            }}
          >
            {section}
          </PersonalPageContext.Provider>
        )}
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
    useSettingsEnvironmentPickStore.setState({ pick: null });
  });

  it("disables Manage profile with the disabled reason while the provider is off", () => {
    renderSection({ state: opencodeState({ enabled: false }) }, null);

    const manageButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Manage profile",
    });
    expect(manageButton.disabled).toBe(true);
    expect(tooltipTextNear(manageButton)).toBe(
      "OpenCode is turned off. Turn it on to sign in or manage its profiles.",
    );
  });

  it("keeps Manage profile enabled with no tooltip while the provider is on", () => {
    renderSection({ state: opencodeState({ enabled: true }) }, null);

    const manageButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Manage profile",
    });
    expect(manageButton.disabled).toBe(false);
    expect(tooltipTextNear(manageButton)).toBe(
      "Change the profile name and accent color, sign in again, or remove this profile.",
    );
  });

  it("disables Retry alongside Add profile when canAddProfile is false", () => {
    renderSection(
      {
        canAddProfile: false,
        failedAttempt: {
          providerId: "opencode",
          message: "did not finish",
        },
      },
      null,
    );

    const retryButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Retry",
    });
    expect(retryButton.disabled).toBe(true);
    const addProfileButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Add a profile",
    });
    expect(addProfileButton.disabled).toBe(true);
  });

  it("shows the CLI & Args link when sign-in is blocked by a missing CLI, not by the provider being off", () => {
    renderSection(
      {
        canAddProfile: false,
        state: opencodeState({
          enabled: true,
          loginCapability: OAUTH_CAP,
          candidates: [],
        }),
      },
      null,
    );

    expect(screen.getByRole("button", { name: "CLI & Args" })).toBeDefined();
    expect(
      screen.getByText("The OpenCode CLI is not installed on this host.", {
        exact: false,
      }),
    ).toBeDefined();
  });

  it("shows the CLI & Args link when the host resolved no CLI although an unselected one is available", () => {
    renderSection(
      {
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
      },
      null,
    );

    expect(screen.getByRole("button", { name: "CLI & Args" })).toBeDefined();
    expect(
      screen.getByText(
        "The selected OpenCode CLI is not available on this host.",
        { exact: false },
      ),
    ).toBeDefined();
  });

  it("does not show the CLI & Args link when sign-in is blocked because the provider is off", () => {
    renderSection(
      {
        canAddProfile: false,
        state: opencodeState({
          enabled: false,
          loginCapability: OAUTH_CAP,
          candidates: [],
        }),
      },
      null,
    );

    // The reason is still shown - just without a link to a tab that does not
    // fix "the provider is off" (that is the header switch's job).
    expect(
      screen.getByText(
        "OpenCode is turned off. Turn it on to sign in or manage its profiles.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "CLI & Args" })).toBeNull();
  });

  it("keeps the Profiles header and the Sync profiles entry when a syncable provider has no profiles on a Local row, so saved rules stay manageable", () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-1", hostName: "Studio" },
    });
    renderSection(
      {
        state: opencodeState({ providerId: "claude-code", profiles: [] }),
      },
      null,
    );

    expect(screen.getByText("Profiles")).toBeDefined();
    expect(screen.getByRole("button", { name: /Sync profiles/ })).toBeDefined();
    // Nothing to add a sign-in to from here: the profile controls stay absent.
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
  });

  it("holds Sign in and Add a profile with the credential refusal as the reason, and offers no CLI & Args link, when the host takes no credentials", () => {
    const REFUSAL = "Sandboxes don't take sign-ins";
    const profile = managedProfile();
    renderSection(
      {
        canAddProfile: false,
        credentialRefusal: REFUSAL,
        // A missing CLI would otherwise be the reason, with a link to fix it:
        // on a sandbox no CLI setup helps, so the refusal must win.
        state: opencodeState({
          enabled: true,
          loginCapability: OAUTH_CAP,
          candidates: [],
          profiles: [
            {
              ...profile,
              auth: {
                status: "unauthenticated",
                badgeText: null,
                label: null,
                detail: null,
              },
            },
          ],
        }),
      },
      null,
    );

    const signIn = screen.getByRole<HTMLButtonElement>("button", {
      name: "Sign in",
    });
    expect(signIn.disabled).toBe(true);
    expect(tooltipTextNear(signIn)).toBe(REFUSAL);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Add a profile" })
        .disabled,
    ).toBe(true);
    expect(screen.getByText(REFUSAL)).toBeDefined();
    expect(screen.queryByRole("button", { name: "CLI & Args" })).toBeNull();
    expect(
      screen.queryByText("The OpenCode CLI is not installed on this host.", {
        exact: false,
      }),
    ).toBeNull();
  });

  it("names the terminal login after its host, with no Terminal badge and no manage or re-auth button, and its one verb starts a new sign-in", () => {
    const onAddProfile = vi.fn();
    renderSection(
      {
        onAddProfile,
        state: opencodeState({ profiles: [ambientProfile()] }),
      },
      "Studio",
    );

    expect(
      screen.getByRole("button", {
        name: "OpenCode profile: OpenCode's own login on Studio",
      }),
    ).toBeDefined();
    expect(
      screen.getByText(
        "OpenCode's own login on Studio · works on this computer only",
      ),
    ).toBeDefined();
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByText("Email unavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Refresh/ })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in to use everywhere" }),
    );
    expect(onAddProfile).toHaveBeenCalledTimes(1);
  });

  it("falls back to this computer when the page names no host, and holds the sign-in verb with the credential refusal", () => {
    renderSection(
      {
        canAddProfile: false,
        credentialRefusal: "Sandboxes don't take sign-ins",
        state: opencodeState({ profiles: [ambientProfile()] }),
      },
      null,
    );

    expect(
      screen.getByRole("button", {
        name: "OpenCode profile: OpenCode's own login on this computer",
      }),
    ).toBeDefined();
    const verb = screen.getByRole<HTMLButtonElement>("button", {
      name: "Sign in to use everywhere",
    });
    expect(verb.disabled).toBe(true);
    expect(tooltipTextNear(verb)).toBe("Sandboxes don't take sign-ins");
  });
});
