import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { tooltipTextFor } from "@/components/ui/__tests__/tooltip-probe";

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

describe("<ProviderProfileScopedSection /> profile summary email reveal", () => {
  afterEach(() => {
    cleanup();
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

  it("shows standing text only when the profile is not usable, and keeps the verbs in More", async () => {
    const profile = managedProfile();
    renderSection({
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

    await userEvent.click(
      screen.getByRole("button", { name: "More for Work account" }),
    );
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(
      within(menu).getByRole("button", { name: "Manage profile" }),
    ).toBeTruthy();
    expect(within(menu).queryByRole("switch")).toBeNull();
  });
});
