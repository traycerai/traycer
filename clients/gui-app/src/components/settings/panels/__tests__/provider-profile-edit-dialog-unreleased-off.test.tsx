/**
 * The build without environments (`unreleased-features.ts`) words the profile
 * key's custody line as the release before them did.
 */
vi.mock("@/unreleased-features", () => ({
  UNRELEASED_FEATURES_ENABLED: false,
}));
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
vi.mock("@/hooks/providers/use-set-provider-profile-api-key-mutation", () => ({
  useSetProviderProfileApiKey: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock(
  "@/hooks/providers/use-clear-provider-profile-api-key-mutation",
  () => ({
    useClearProviderProfileApiKey: () => ({
      mutate: vi.fn(),
      reset: vi.fn(),
      isPending: false,
      error: null,
    }),
  }),
);
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";

const profile: ProviderProfile = {
  profileId: "profile-managed",
  enabled: true,
  kind: "managed",
  authType: "oauth",
  label: "Work account",
  auth: { status: "authenticated", badgeText: null, label: null, detail: null },
  identity: { email: null, tier: null, accountUuid: null },
  usageUpdatedAt: null,
  rateLimitStatus: "unknown",
  rateLimitLimitedScopes: null,
  duplicateOfProfileId: null,
  accentColor: null,
  ambientDriftNotice: null,
  apiKey: { supported: true, configured: false },
};

const state: ProviderCliState = {
  providerId: "opencode",
  enabled: true,
  disabledBy: null,
  nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  selected: { kind: "bundled" },
  candidates: [],
  auth: { status: "authenticated", badgeText: null, label: null, detail: null },
  authPending: false,
  checkedAt: null,
  apiKey: { supported: false, configured: false, source: null },
  terminalAgentArgs: "",
  envOverrides: [],
  loginCapability: null,
  availabilityPending: false,
  profiles: [profile],
};

afterEach(() => {
  cleanup();
});

describe("<ProfileEditDialog /> without environments", () => {
  it("says the profile's key is stored encrypted on this device and never shown again", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ProfileEditDialog
            state={state}
            profile={profile}
            profiles={[profile]}
            canOauth
            oauthUnavailableHint={null}
            startInReauth={false}
            isLocalHost
            open
            onOpenChange={() => undefined}
            remainingProfilesAfterRemoval={[]}
            onSelectedProfileIdChange={() => undefined}
            profileEnablementAvailable
            profileEnablementPending={() => false}
            onSetProfileEnabled={() => undefined}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText(
        "Stored encrypted on this device and used only by this profile. The key is never shown again after you save it.",
      ),
    ).toBeTruthy();
  });
});
