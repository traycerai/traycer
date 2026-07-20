import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliCandidate,
  ProviderCliState,
  ProviderManagedInstallState,
  ProviderSelection,
  ProviderVersionVisibility,
} from "@traycer/protocol/host/provider-schemas";
import { ProviderCliCandidatesSection } from "@/components/settings/panels/provider-cli-candidates-section";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  setSelectionMutate: vi.fn(),
  addCustomPathMutate: vi.fn(),
  removeCustomPathMutate: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-set-selection-mutation", () => ({
  useProvidersSetSelection: () => ({
    mutate: mocks.setSelectionMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-add-custom-path-mutation", () => ({
  useProvidersAddCustomPath: () => ({
    mutate: mocks.addCustomPathMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-remove-custom-path-mutation", () => ({
  useProvidersRemoveCustomPath: () => ({
    mutate: mocks.removeCustomPathMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-detect-version-query", () => ({
  useProvidersDetectVersion: () => ({
    isFetching: false,
    data: undefined,
  }),
}));

/**
 * T3 renderer coverage: install-progress rendering, the "Bundled"/"Managed"
 * candidate label swap, the D6 PATH-unblock composite notice, and the
 * version-visibility caption - each verified both when the host populates
 * the new provider-pack-registry fields and when it omits them entirely (old
 * host tolerance).
 */

function bundledCandidate(
  overrides: Partial<ProviderCliCandidate>,
): ProviderCliCandidate {
  return {
    kind: "bundled",
    path: "",
    version: null,
    available: false,
    versionPending: false,
    ...overrides,
  };
}

function pathCandidate(
  overrides: Partial<ProviderCliCandidate>,
): ProviderCliCandidate {
  return {
    kind: "path",
    path: "/usr/local/bin/claude",
    version: "1.0.0",
    available: true,
    versionPending: false,
    ...overrides,
  };
}

function providerState(args: {
  readonly selected: ProviderSelection;
  readonly candidates: readonly ProviderCliCandidate[];
  readonly managedInstallState?: ProviderManagedInstallState | null;
  readonly versionVisibility?: ProviderVersionVisibility | null;
}): ProviderCliState {
  const state: ProviderCliState = {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: args.selected,
    candidates: [...args.candidates],
    auth: {
      status: "unknown",
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
    profiles: [],
  };
  // Apply each optional field independently (not an if/else-if chain) so
  // passing both together can't silently drop one.
  return {
    ...state,
    ...(args.managedInstallState !== undefined
      ? { managedInstallState: args.managedInstallState }
      : {}),
    ...(args.versionVisibility !== undefined
      ? { versionVisibility: args.versionVisibility }
      : {}),
  };
}

function renderSection(state: ProviderCliState) {
  return render(
    <TooltipProvider>
      <ProviderCliCandidatesSection state={state} providers={[state]} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProviderCliCandidatesSection: old-host tolerance (managedInstallState/versionVisibility absent)", () => {
  it("renders today's plain 'Bundled' label and availability-based status with no new fields at all", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
    });
    renderSection(state);
    expect(screen.getByText("Bundled")).toBeDefined();
    expect(screen.getByText("Not installed")).toBeDefined();
    expect(screen.queryByText(/Installing…/)).toBeNull();
    expect(screen.queryByText(/running from path/i)).toBeNull();
    expect(screen.queryByText(/using a different version/i)).toBeNull();
  });

  it("tolerates an explicit null the same as an absent field", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
      managedInstallState: null,
      versionVisibility: null,
    });
    renderSection(state);
    expect(screen.getByText("Bundled")).toBeDefined();
    expect(screen.getByText("v1.0.0")).toBeDefined();
  });
});

describe("ProviderCliCandidatesSection: managed-install progress states", () => {
  it("shows 'Managed' label and 'Not installed' for the absent state", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: { status: "absent" },
    });
    renderSection(state);
    expect(screen.getByText("Managed")).toBeDefined();
    expect(screen.getByText("Not installed")).toBeDefined();
  });

  it("shows install progress with percent while downloading, and does not dim the row", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: { status: "downloading", percent: 42 },
    });
    renderSection(state);
    expect(screen.getByText("Managed")).toBeDefined();
    expect(screen.getByText("Installing… 42%")).toBeDefined();
  });

  it("shows the resolved version once installed", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: true, version: "2.5.0" })],
      managedInstallState: { status: "installed" },
    });
    renderSection(state);
    expect(screen.getByText("Managed")).toBeDefined();
    expect(screen.getByText("v2.5.0")).toBeDefined();
  });
});

describe("ProviderCliCandidatesSection: D6 PATH-unblock composite state", () => {
  it("shows the PATH-unblock notice when selection is managed, install is in progress, and a PATH binary is available", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "downloading", percent: 10 },
    });
    renderSection(state);
    expect(
      screen.getByText("Running from PATH · installing managed copy"),
    ).toBeDefined();
  });

  it("does not show the notice when the managed pack is merely absent with no download in flight yet (reachable first-boot state)", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "absent" },
    });
    renderSection(state);
    expect(
      screen.queryByText("Running from PATH · installing managed copy"),
    ).toBeNull();
  });

  it("does not show the notice once the managed pack is installed", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: true, version: "1.0.0" }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "installed" },
    });
    renderSection(state);
    expect(
      screen.queryByText("Running from PATH · installing managed copy"),
    ).toBeNull();
  });

  it("does not show the notice when no PATH binary is available", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: { status: "downloading", percent: 10 },
    });
    renderSection(state);
    expect(
      screen.queryByText("Running from PATH · installing managed copy"),
    ).toBeNull();
  });

  it("does not show the notice when the user explicitly selected PATH (not a fallback)", () => {
    const state = providerState({
      selected: { kind: "path" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "downloading", percent: 10 },
    });
    renderSection(state);
    expect(
      screen.queryByText("Running from PATH · installing managed copy"),
    ).toBeNull();
  });
});

describe("ProviderCliCandidatesSection: version-visibility caption", () => {
  it("renders the plural, direction-free caption for multiple differing sessions", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
      versionVisibility: { differingSessionCount: 3 },
    });
    renderSection(state);
    expect(
      screen.getByText("3 other sessions are using a different version."),
    ).toBeDefined();
  });

  it("renders the singular caption for exactly one differing session", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
      versionVisibility: { differingSessionCount: 1 },
    });
    renderSection(state);
    expect(
      screen.getByText("1 other session is using a different version."),
    ).toBeDefined();
  });

  it("renders nothing when the count is zero", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
      versionVisibility: { differingSessionCount: 0 },
    });
    renderSection(state);
    expect(screen.queryByText(/using a different version/i)).toBeNull();
  });
});
