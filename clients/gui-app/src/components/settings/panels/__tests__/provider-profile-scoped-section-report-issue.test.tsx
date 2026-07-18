import "../../../../../__tests__/test-browser-apis";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

// `ProviderProfileScopedSection` always mounts `ProfileEditDialog`, whose
// mutation hooks call `useHostClient()` unconditionally regardless of the
// dialog's `open` state. Mock the mutation/host hooks it and its refresh
// button pull in so this test only needs a QueryClient, not a bound host.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});
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

function ambientProfile(): ProviderCliState["profiles"][number] {
  return {
    profileId: "ambient",
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
function opencodeState(): ProviderCliState {
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
    profiles: [ambientProfile()],
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
          startInReauth={false}
          failedAttempt={null}
          onAddProfile={() => undefined}
          onDismissFailedAttempt={() => undefined}
          selectedProfileId={null}
          onSelectedProfileIdChange={() => undefined}
          {...overrides}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("<ProviderProfileScopedSection /> sign-in failure report action", () => {
  afterEach(() => {
    cleanup();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("hides the report action when the support capability is unavailable", () => {
    renderSection({
      failedAttempt: {
        providerId: "opencode",
        message: "secret-token-should-never-render",
      },
    });

    screen.getByText(/Sign-in did not finish for/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("reports only fixed generic context, never the provider identity or raw failure message", () => {
    renderSection({
      failedAttempt: {
        providerId: "opencode",
        message: "secret-token-should-never-render",
      },
    });

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Provider sign-in failed",
        message: "Sign-in did not finish for a provider profile.",
        code: null,
        source: "Provider sign-in",
      },
    });
    const context = useDesktopDialogStore.getState().reportIssueContext;
    expect(JSON.stringify(context)).not.toContain("secret-token");
    expect(JSON.stringify(context)).not.toContain("opencode");
  });

  it("renders no failure banner (and no report action) when there is no failed attempt", () => {
    renderSection({ failedAttempt: null });

    expect(screen.queryByText(/Sign-in did not finish for/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });
});
