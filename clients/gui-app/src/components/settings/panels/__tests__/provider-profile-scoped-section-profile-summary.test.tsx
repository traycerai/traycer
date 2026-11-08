import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { tooltipTextFor } from "@/components/ui/__tests__/tooltip-probe";
import {
  NO_NOTICES,
  NO_OVERRIDES,
  NO_REVIEW,
  PersonalPageContext,
} from "@/components/settings/personal/personal-page-context";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  environmentStatusFixture,
  itemStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import {
  registerDetailsProvider,
  type DetailsProvider,
} from "@/lib/settings-details-entry";

// Same rationale as the sibling report-issue test: `ProfileEditDialog` and the
// refresh button pull in mutation/host hooks unconditionally, so those are
// mocked to keep this test scoped to a QueryClient, no bound host.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});
// The stub above is not sufficient on its own: it replaces `@/lib/host`, but
// the pinned-client chain also reads `useHostClient` from `@/lib/host/runtime`,
// which that stub does not intercept - so the real hook throws its "must be
// used inside a <HostRuntimeProvider>" error. The refresh button reaches that
// chain via `useProviderRateLimitRefresh` -> `useProviderRateLimitFetchScope`. Stub the
// one resolution they share, the way the host-less panel suites already do.
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
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: {
      environments: [{ environmentId: "personal-env", ownerKind: "user" }],
    },
    isError: false,
    refetch: () => Promise.resolve({}),
  }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: () => "test-user",
}));
vi.mock("@/components/settings/panels/provider-profile-edit-dialog", () => ({
  ProfileEditDialog: (props: {
    readonly open: boolean;
    readonly startInReauth: boolean;
    readonly onOpenChange: (open: boolean) => void;
  }) =>
    props.open ? (
      <div
        role="dialog"
        aria-label={props.startInReauth ? "Sign in editor" : "Profile editor"}
      >
        <button type="button" onClick={() => props.onOpenChange(false)}>
          Close editor
        </button>
      </div>
    ) : null,
}));

import { ProviderProfileScopedSection } from "@/components/settings/panels/provider-profile-scoped-section";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";

const RAW_EMAIL = "worker@example.com";
// Matches `redactEmail`'s format: first local-part char + fixed mask + the
// domain's first char. Duplicated here rather than imported so the test
// fails loudly if the two definitions ever drift apart.
const REDACTED_EMAIL = "w•••@e…";

function managedProfile(): ProviderCliState["profiles"][number] {
  return {
    profileId: "profile-managed",
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Work account",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: RAW_EMAIL, tier: null, accountUuid: null },
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
function opencodeState(): ProviderCliState {
  return {
    providerId: "opencode",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
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
    profiles: [managedProfile()],
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
          state={opencodeState()}
          hostId="host-1"
          isSelectedHostLocal
          canAddProfile
          credentialRefusal={null}
          onOpenCliSettings={() => undefined}
          startInReauth={false}
          failedAttempt={null}
          onAddProfile={() => undefined}
          onDismissFailedAttempt={() => undefined}
          selectedProfileId="profile-managed"
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
          {...overrides}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderSectionWithRecordedProfile(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PersonalPageContext.Provider
          value={{
            section: "providers",
            pick: PERSONAL_PICK,
            state: {
              kind: "ready",
              status: environmentStatusFixture({
                items: [
                  itemStatusFixture({
                    kind: "managed_profile",
                    key: "opencode:profile-managed",
                  }),
                ],
              }),
            },
            line: null,
            hostName: "Studio",
            localOverrides: NO_OVERRIDES,
            hostId: "host-1",
            client: null,
            notices: NO_NOTICES,
            review: NO_REVIEW,
          }}
        >
          <ProviderProfileScopedSection
            state={opencodeState()}
            hostId="host-1"
            isSelectedHostLocal
            canAddProfile
            credentialRefusal={null}
            onOpenCliSettings={() => undefined}
            startInReauth={false}
            failedAttempt={null}
            onAddProfile={() => undefined}
            onDismissFailedAttempt={() => undefined}
            selectedProfileId="profile-managed"
            onSelectedProfileIdChange={() => undefined}
            profileEnablementAvailable
            profileEnablementPending={() => false}
            onSetProfileEnabled={() => undefined}
          />
        </PersonalPageContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("<ProviderProfileScopedSection /> profile summary email reveal", () => {
  afterEach(() => {
    cleanup();
    useSettingsEnvironmentPickStore.setState({ pick: null });
  });

  it("does not leak the raw email through the tooltip while redacted", () => {
    renderSection({});

    // The visible text is redacted...
    expect(screen.queryByText(RAW_EMAIL)).toBeNull();
    const emailSpan = screen.getByText(REDACTED_EMAIL);
    // ...and hovering the redacted text must not read the raw address either -
    // the whole point of redaction is defeated if the tooltip still says it.
    expect(tooltipTextFor(emailSpan)).not.toBe(RAW_EMAIL);
  });

  it("reveals the raw email in the wrapping address, with no tooltip", () => {
    renderSection({});

    fireEvent.click(screen.getByRole("button", { name: /Reveal email/ }));

    const emailSpan = screen.getByText(RAW_EMAIL);
    expect(emailSpan.className).toContain("whitespace-normal");
    expect(emailSpan.className).toContain("break-words");
    expect(emailSpan.className).not.toContain("truncate");
    expect(tooltipTextFor(emailSpan)).toBeNull();
  });

  it("wraps the address and the plan, and shows no Signed in badge on a usable row", () => {
    const profile = managedProfile();
    renderSection({
      state: {
        ...opencodeState(),
        profiles: [
          {
            ...profile,
            identity: { email: RAW_EMAIL, tier: "Team", accountUuid: null },
          },
        ],
      },
    });

    const email = screen.getByText(REDACTED_EMAIL);
    expect(email.className).toContain("whitespace-normal");
    expect(email.className).toContain("break-words");
    expect(email.className).not.toContain("truncate");
    const plan = screen.getByText("Team");
    expect(plan.tagName).toBe("P");
    expect(plan.className).toContain("whitespace-normal");
    expect(plan.className).toContain("break-words");
    expect(plan.className).not.toContain("truncate");
    expect(screen.queryByText("Signed in")).toBeNull();
    expect(screen.queryByText("Signed out")).toBeNull();
  });

  it("shows standing text only when the profile is not usable, and keeps the verbs inline", async () => {
    const profile = managedProfile();
    const onAddProfile = vi.fn();
    renderSection({
      onAddProfile,
      state: {
        ...opencodeState(),
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
      },
    });

    const standing = screen.getByText("Signed out");
    expect(standing.tagName).toBe("P");
    expect(standing.className).toContain("whitespace-normal");
    expect(standing.className).toContain("break-words");
    expect(standing.className).not.toContain("truncate");
    expect(screen.queryByText("Signed in")).toBeNull();

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage profile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^More for / })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Manage profile" }),
    );
    expect(screen.getByRole("dialog", { name: "Profile editor" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close editor" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("dialog", { name: "Sign in editor" })).toBeTruthy();
    expect(onAddProfile).not.toHaveBeenCalled();
  });

  it("opens recorded managed-profile Details from its inline button", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    const provider = vi.fn<DetailsProvider>(() =>
      Promise.reject(new Error("no evidence")),
    );
    const unregister = registerDetailsProvider("managed_profile", provider);
    try {
      renderSectionWithRecordedProfile();
      await userEvent.click(screen.getByRole("button", { name: "Details" }));

      const drawer = await screen.findByRole("dialog");
      expect(
        within(drawer).getByRole("heading", { name: "Work account" }),
      ).toBeTruthy();
      expect(screen.queryByRole("menu")).toBeNull();
      await waitFor(() => {
        expect(provider).toHaveBeenCalled();
      });
      expect(provider.mock.calls[0]?.[0]).toEqual({
        environmentId: "personal-env",
        kind: "managed_profile",
        key: "opencode:profile-managed",
      });
    } finally {
      unregister();
    }
  });
});
