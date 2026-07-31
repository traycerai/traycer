import "../../../../../__tests__/test-browser-apis";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
          signInUnavailableHint={null}
          startInReauth={false}
          failedAttempt={null}
          onAddProfile={() => undefined}
          onDismissFailedAttempt={() => undefined}
          selectedProfileId="profile-managed"
          onSelectedProfileIdChange={() => undefined}
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

  it("reveals the raw email in both the text and the tooltip once toggled", () => {
    renderSection({});

    fireEvent.click(screen.getByRole("button", { name: /Reveal email/ }));

    const emailSpan = screen.getByText(RAW_EMAIL);
    expect(tooltipTextFor(emailSpan)).toBe(RAW_EMAIL);
  });
});
