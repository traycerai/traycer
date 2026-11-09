import type { CredentialStanding } from "@traycer/protocol/host/provider-credential-home-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { tooltipTextFor } from "@/components/ui/__tests__/tooltip-probe";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

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

function profileWithStanding(
  standing: Partial<CredentialStanding>,
  overrides: Partial<ProviderProfile>,
): ProviderProfile {
  return {
    ...managedProfile(),
    credentialHome: {
      homeAddress: "synthetic-home",
      bindingVersion: 1,
      materialRevision: 1,
      custodyVersion: 1,
      custodyClass: "self-sufficient",
      environmentPresence: null,
      handoffEnvironmentId: null,
      materialFingerprint: "synthetic-material",
      observation: null,
      materialMatchesBinding: "yes",
      standing: {
        material: "usable",
        repairDeadline: null,
        familyVersion: null,
        authority: null,
        cause: null,
        observation: { source: "custodian", status: "answered", capturedAt: 1 },
        ...standing,
      },
    },
    ...overrides,
  };
}

function renderProfile(profile: ProviderProfile) {
  renderSection({ state: { ...opencodeState(), profiles: [profile] } });
}

// The row's own inventory attributes sit beside the badge row, inside the summary.
function summaryAttributes(badge: HTMLElement): HTMLElement | null {
  return (
    badge.parentElement?.parentElement?.querySelector<HTMLElement>(
      "[data-provider-profile-id]",
    ) ?? null
  );
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

  it("reveals the raw email in the truncated address and its tooltip", () => {
    renderSection({});

    fireEvent.click(screen.getByRole("button", { name: /Reveal email/ }));

    const emailSpan = screen.getByText(RAW_EMAIL);
    expect(emailSpan.className).toContain("truncate");
    expect(tooltipTextFor(emailSpan)).toBe(RAW_EMAIL);
  });

  it("truncates the address and the plan chip, and badges a usable row Signed in", () => {
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

    const actions = document.querySelector(
      '[data-slot="profile-summary-actions"]',
    );
    expect(actions).not.toBeNull();
    expect(actions?.className).toContain("flex-wrap");
    const email = screen.getByText(REDACTED_EMAIL);
    expect(email.className).toContain("truncate");
    const plan = screen.getByText("Team");
    expect(plan.className).toContain("truncate");
    const planChip = plan.parentElement;
    expect(planChip?.getAttribute("data-variant")).toBe("outline");
    expect(planChip?.getAttribute("data-size")).toBe("xs");
    expect(planChip?.textContent).toBe("Team");
    const signedIn = screen.getByText("Signed in");
    expect(signedIn.getAttribute("data-slot")).toBe("badge");
    expect(signedIn.getAttribute("data-variant")).toBe("outline");
    expect(signedIn.getAttribute("data-size")).toBe("xs");
    const manage = screen.getByRole("button", { name: "Manage profile" });
    expect(manage.getAttribute("data-size")).toBe("xs");
    expect(manage.getAttribute("data-variant")).toBe("outline");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByText("Signed out")).toBeNull();
  });

  it("badges Signed out and offers Sign in only when the profile is unauthenticated", async () => {
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
    expect(standing.getAttribute("data-slot")).toBe("badge");
    expect(standing.getAttribute("data-variant")).toBe("outline");
    expect(standing.getAttribute("data-size")).toBe("xs");
    expect(screen.queryByText("Signed in")).toBeNull();

    const signIn = screen.getByRole("button", { name: "Sign in" });
    expect(signIn.getAttribute("data-size")).toBe("xs");
    expect(signIn.getAttribute("data-variant")).toBe("secondary");
    const manage = screen.getByRole("button", { name: "Manage profile" });
    expect(manage.getAttribute("data-size")).toBe("xs");
    expect(manage.getAttribute("data-variant")).toBe("outline");
    expect(screen.queryByRole("button", { name: /^More for / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    await userEvent.click(manage);
    expect(screen.getByRole("dialog", { name: "Profile editor" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close editor" }));
    await userEvent.click(signIn);
    expect(screen.getByRole("dialog", { name: "Sign in editor" })).toBeTruthy();
    expect(onAddProfile).not.toHaveBeenCalled();
  });

  it("does not put Details on the selected profile row", () => {
    renderSection({});
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("badges an ambient row Signed out when the provider is unauthenticated", async () => {
    const unauthenticated = {
      status: "unauthenticated" as const,
      badgeText: null,
      label: null,
      detail: null,
    };
    renderSection({
      selectedProfileId: null,
      state: {
        ...opencodeState(),
        auth: unauthenticated,
        profiles: [
          {
            ...managedProfile(),
            profileId: "ambient",
            kind: "ambient",
            label: "Terminal account",
            auth: {
              status: "authenticated",
              badgeText: null,
              label: null,
              detail: null,
            },
          },
        ],
      },
    });

    const badge = screen.getByText("Signed out");
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(badge.getAttribute("data-variant")).toBe("outline");
    expect(screen.queryByText("Signed in")).toBeNull();
    const signIn = screen.getByRole("button", { name: "Sign in" });
    expect(signIn.getAttribute("data-size")).toBe("xs");
    expect(signIn.getAttribute("data-variant")).toBe("secondary");
    await userEvent.click(signIn);
    expect(screen.getByRole("dialog", { name: "Sign in editor" })).toBeTruthy();
  });

  it("keeps a managed profile's own badge and hides Sign in when only the provider is unauthenticated", () => {
    const unauthenticated = {
      status: "unauthenticated" as const,
      badgeText: null,
      label: null,
      detail: null,
    };
    renderSection({
      state: {
        ...opencodeState(),
        auth: unauthenticated,
      },
    });

    const badge = screen.getByText("Signed in");
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(badge.getAttribute("data-variant")).toBe("outline");
    expect(screen.queryByText("Signed out")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("badges a refused credential and shows only its cause on the detail line", () => {
    renderProfile(
      profileWithStanding(
        { material: "refused-by-provider", cause: "plan lapsed" },
        {},
      ),
    );

    expect(
      screen.getByText("Refused by provider").getAttribute("data-slot"),
    ).toBe("badge");
    expect(screen.getByText("plan lapsed")).toBeTruthy();
    expect(screen.queryByText("Signed in")).toBeNull();
    expect(screen.queryByText(/Refused by provider:/)).toBeNull();
  });

  it("badges Unknown with the cause when the credential observation is unknown", () => {
    renderProfile(
      profileWithStanding(
        {
          cause: "probe timed out",
          observation: {
            source: "custodian",
            status: "unknown",
            capturedAt: 1,
          },
        },
        {},
      ),
    );

    expect(screen.getByText("Unknown").getAttribute("data-slot")).toBe("badge");
    expect(screen.getByText("probe timed out")).toBeTruthy();
    expect(screen.queryByText(/Status unknown/)).toBeNull();
  });

  it("renders a usable credential as Signed in without a detail line", () => {
    renderProfile(profileWithStanding({}, {}));

    const badge = screen.getByText("Signed in");
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(summaryAttributes(badge)?.querySelector("p")).toBeNull();
  });

  it("keeps the whole revoking notice on the detail line beside the status badge", () => {
    renderProfile({
      ...managedProfile(),
      presence: { kind: "revoking", cause: "signed-out-by-person" },
    });

    expect(screen.getByText("Signed in").getAttribute("data-slot")).toBe(
      "badge",
    );
    expect(screen.getByText("Disconnecting: signed out.")).toBeTruthy();
  });

  it("keeps the data inventory attributes on the secondary line", () => {
    renderProfile({
      ...profileWithStanding(
        { material: "stale", cause: "session expired" },
        {},
      ),
      presence: { kind: "admitted", bindingVersion: 1 },
    });

    const attributes = summaryAttributes(screen.getByText("Stale"));
    expect(attributes?.getAttribute("data-provider-profile-id")).toBe(
      "profile-managed",
    );
    expect(attributes?.getAttribute("data-provider-profile-presence")).toBe(
      JSON.stringify({ kind: "admitted", bindingVersion: 1 }),
    );
    expect(
      attributes?.getAttribute("data-provider-profile-standing"),
    ).toContain('"material":"stale"');
    expect(attributes?.textContent).toBe("session expired");
  });
});
