import type {
  CopySettingsCategory,
  CopySettingsCategoryPreview,
  ProvidersApplyCopySettingsResponse,
  ProvidersCopySettingsRequest,
  ProvidersPreviewCopySettingsResponse,
} from "@traycer/protocol/host/provider-profile-config-schemas";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

/**
 * W2-T11: the Copy settings page (D13) - select -> review -> results, the
 * Default-account-never-a-target exclusion, whole-category selection, the
 * review's per-target/per-category rendering (removals by name, ownership
 * flips from the response), apply results with a narrowed retry, and the
 * method-gated render guard.
 */

const previewMocks = vi.hoisted(() => ({
  data: undefined as ProvidersPreviewCopySettingsResponse | undefined,
  isError: false,
  refetch: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-preview-copy-settings-query", () => ({
  useProvidersPreviewCopySettings: () => ({
    data: previewMocks.data,
    isError: previewMocks.isError,
    refetch: previewMocks.refetch,
  }),
}));

type ApplyMutateOptions = {
  readonly onSuccess: (response: ProvidersApplyCopySettingsResponse) => void;
};

const applyMocks = vi.hoisted(() => ({
  mutate:
    vi.fn<
      (
        variables: ProvidersCopySettingsRequest,
        options: ApplyMutateOptions,
      ) => void
    >(),
  isPending: false,
}));

vi.mock("@/hooks/providers/use-providers-apply-copy-settings-mutation", () => ({
  useProvidersApplyCopySettings: () => ({
    mutate: applyMocks.mutate,
    isPending: applyMocks.isPending,
  }),
}));

import { CopySettingsPage } from "@/components/settings/panels/copy-settings-page";
import { providerProfileFixture } from "@/testing/provider-profile-fixture";

const HOST_ID = "host-a";
const PROVIDER_ID = "claude-code";

function ambientProfile(): ProviderProfile {
  return providerProfileFixture({
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
  });
}

function managedProfile(profileId: string, label: string): ProviderProfile {
  return providerProfileFixture({
    profileId,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: {
      email: `${profileId}@example.test`,
      tier: null,
      accountUuid: null,
    },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  });
}

function stateWithProfiles(
  profiles: readonly ProviderProfile[],
): ProviderCliState {
  return {
    providerId: PROVIDER_ID,
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
    profilesSupported: true,
  };
}

function categoryPreview(overrides: {
  readonly category: CopySettingsCategory;
  readonly adds: readonly string[];
  readonly changes: readonly string[];
  readonly removals: readonly string[];
  readonly carriesSecretValues: boolean;
  readonly ownershipFlip: "none" | "linkedToOwn";
  readonly noop: boolean;
}): CopySettingsCategoryPreview {
  return {
    category: overrides.category,
    adds: [...overrides.adds],
    changes: [...overrides.changes],
    removals: [...overrides.removals],
    carriesSecretValues: overrides.carriesSecretValues,
    ownershipFlip: overrides.ownershipFlip,
    noop: overrides.noop,
  };
}

function renderPage(args: {
  readonly profiles: readonly ProviderProfile[];
  readonly initialSourceProfileId: string | null;
  readonly onClose: () => void;
}) {
  return render(
    <CopySettingsPage
      state={stateWithProfiles(args.profiles)}
      client={null}
      hostId={HOST_ID}
      initialSourceProfileId={args.initialSourceProfileId}
      onClose={args.onClose}
    />,
  );
}

function goToReview(): void {
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
}

beforeEach(() => {
  resetNegotiatedManifests();
  recordNegotiatedHostMethods(HOST_ID, [
    "providers.previewCopySettings",
    "providers.applyCopySettings",
  ]);
  previewMocks.data = undefined;
  previewMocks.isError = false;
  previewMocks.refetch.mockReset();
  applyMocks.mutate.mockReset();
  applyMocks.isPending = false;
});

afterEach(() => {
  cleanup();
});

describe("CopySettingsPage select step", () => {
  it("never lists the Default account as a copy target", () => {
    renderPage({
      profiles: [
        ambientProfile(),
        managedProfile("p1", "Profile One"),
        managedProfile("p2", "Profile Two"),
      ],
      initialSourceProfileId: "p1",
      onClose: vi.fn(),
    });
    const copyTo = screen.getByRole("group", { name: "Copy to" });
    const checkboxes = within(copyTo).getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(1);
    expect(within(copyTo).queryByText("Default account")).toBeNull();
    within(copyTo).getByText("Profile Two");
  });

  it("removes the newly-selected source from the target list", () => {
    renderPage({
      profiles: [
        ambientProfile(),
        managedProfile("p1", "Profile One"),
        managedProfile("p2", "Profile Two"),
      ],
      initialSourceProfileId: null,
      onClose: vi.fn(),
    });
    let copyTo = screen.getByRole("group", { name: "Copy to" });
    expect(within(copyTo).getAllByRole("checkbox")).toHaveLength(2);

    const copyFrom = screen.getByRole("group", { name: "Copy from" });
    fireEvent.click(
      within(copyFrom).getByRole("radio", { name: /Profile One/ }),
    );

    copyTo = screen.getByRole("group", { name: "Copy to" });
    expect(within(copyTo).getAllByRole("checkbox")).toHaveLength(1);
    expect(within(copyTo).queryByText("Profile One")).toBeNull();
    within(copyTo).getByText("Profile Two");
  });

  it("copies categories whole - one checkbox per category, no entry-level checkboxes", () => {
    renderPage({
      profiles: [ambientProfile(), managedProfile("p1", "Profile One")],
      initialSourceProfileId: null,
      onClose: vi.fn(),
    });
    const whatToCopy = screen.getByRole("group", { name: "What to copy" });
    expect(within(whatToCopy).getAllByRole("checkbox")).toHaveLength(6);
  });

  it("labels env and mcp as carrying secret values, and cliArgs as not", () => {
    renderPage({
      profiles: [ambientProfile(), managedProfile("p1", "Profile One")],
      initialSourceProfileId: null,
      onClose: vi.fn(),
    });
    expect(screen.getAllByText("includes secret values")).toHaveLength(2);
  });

  it("never renders a credential field for the endpoint category, and states the credential is not copied", () => {
    renderPage({
      profiles: [ambientProfile(), managedProfile("p1", "Profile One")],
      initialSourceProfileId: null,
      onClose: vi.fn(),
    });
    expect(screen.queryByRole("textbox", { name: /credential/i })).toBeNull();
    screen.getByText(
      "Base URL, credential kind and default model. The credential itself is never copied.",
    );
  });
});

describe("CopySettingsPage review step", () => {
  it("names a removal individually, not only as a count", () => {
    renderPage({
      profiles: [ambientProfile(), managedProfile("p1", "Profile One")],
      initialSourceProfileId: null,
      onClose: vi.fn(),
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Copy to" })).getByRole(
        "checkbox",
      ),
    );
    previewMocks.data = {
      targets: [
        {
          profileId: "p1",
          label: "Profile One",
          categories: [
            categoryPreview({
              category: "mcp",
              adds: [],
              changes: [],
              removals: ["old-server"],
              carriesSecretValues: true,
              ownershipFlip: "none",
              noop: false,
            }),
          ],
        },
      ],
    };
    goToReview();
    screen.getByText("Removed: old-server");
  });

  it("shows a Linked -> Own flip and a Linked-to-Linked no-op", () => {
    renderPage({
      profiles: [
        ambientProfile(),
        managedProfile("p1", "Profile One"),
        managedProfile("p2", "Profile Two"),
      ],
      initialSourceProfileId: null,
      onClose: vi.fn(),
    });
    const copyTo = screen.getByRole("group", { name: "Copy to" });
    for (const checkbox of within(copyTo).getAllByRole("checkbox")) {
      fireEvent.click(checkbox);
    }
    previewMocks.data = {
      targets: [
        {
          profileId: "p1",
          label: "Profile One",
          categories: [
            categoryPreview({
              category: "skills",
              adds: ["new-skill"],
              changes: [],
              removals: [],
              carriesSecretValues: false,
              ownershipFlip: "linkedToOwn",
              noop: false,
            }),
          ],
        },
        {
          profileId: "p2",
          label: "Profile Two",
          categories: [
            categoryPreview({
              category: "skills",
              adds: [],
              changes: [],
              removals: [],
              carriesSecretValues: false,
              ownershipFlip: "none",
              noop: true,
            }),
            // D13's Linked→Linked no-op is a Skills/Plugins fact. A scalar
            // category reports `noop` too (nothing to copy), and it has no
            // Linked/Own axis to be "already Linked" on.
            categoryPreview({
              category: "env",
              adds: [],
              changes: [],
              removals: [],
              carriesSecretValues: true,
              ownershipFlip: "none",
              noop: true,
            }),
          ],
        },
      ],
    };
    goToReview();
    screen.getByText("Skills: Linked → Own for Profile One");
    screen.getByText("Skills: already Linked — no change");
    expect(
      screen.queryByText("Environment: already Linked — no change"),
    ).toBeNull();
    // It falls through to the generic line instead.
    expect(screen.getAllByText("No changes").length).toBeGreaterThan(0);
  });
});

describe("CopySettingsPage results step", () => {
  it("renders a copied and a failed target distinctly, and Retry failed re-applies only the failed id", () => {
    renderPage({
      profiles: [
        ambientProfile(),
        managedProfile("p1", "Profile One"),
        managedProfile("p2", "Profile Two"),
      ],
      initialSourceProfileId: null,
      onClose: vi.fn(),
    });
    const copyTo = screen.getByRole("group", { name: "Copy to" });
    for (const checkbox of within(copyTo).getAllByRole("checkbox")) {
      fireEvent.click(checkbox);
    }
    previewMocks.data = {
      targets: [
        { profileId: "p1", label: "Profile One", categories: [] },
        { profileId: "p2", label: "Profile Two", categories: [] },
      ],
    };
    goToReview();

    applyMocks.mutate.mockImplementation((_variables, options) => {
      options.onSuccess({
        results: [
          { profileId: "p1", outcome: { kind: "copied" } },
          { profileId: "p2", outcome: { kind: "failed", reason: "boom" } },
        ],
      });
    });
    fireEvent.click(screen.getByRole("button", { name: /Copy to 2 profiles/ }));

    screen.getByText("Copied");
    screen.getByText("Failed: boom");

    applyMocks.mutate.mockClear();
    applyMocks.mutate.mockImplementation((_variables, options) => {
      options.onSuccess({
        results: [{ profileId: "p2", outcome: { kind: "copied" } }],
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));

    expect(applyMocks.mutate).toHaveBeenCalledTimes(1);
    const retryCall = applyMocks.mutate.mock.calls.at(0);
    if (retryCall === undefined) throw new Error("apply was not called");
    const [retryVariables] = retryCall;
    expect(retryVariables.targets).toEqual(["p2"]);
    expect(screen.getAllByText("Copied")).toHaveLength(2);
    expect(screen.queryByText(/Failed/)).toBeNull();
  });
});

describe("CopySettingsPage method gating", () => {
  it("does not render when the host has not negotiated providers.applyCopySettings", () => {
    resetNegotiatedManifests();
    recordNegotiatedHostMethods(HOST_ID, ["providers.previewCopySettings"]);
    const { container } = renderPage({
      profiles: [ambientProfile(), managedProfile("p1", "Profile One")],
      initialSourceProfileId: null,
      onClose: vi.fn(),
    });
    expect(container.firstChild).toBeNull();
  });
});
