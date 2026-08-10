import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderAdvisory,
  ProviderCliCandidate,
  ProviderCliState,
  ProviderManagedInstallState,
  ProviderManagedVersions,
  ProviderNextRunBinary,
  ProviderSelection,
  ProviderVersionVisibility,
} from "@traycer/protocol/host/provider-schemas";
import { createElement, type ReactNode } from "react";
import { ProviderCliCandidatesSection } from "@/components/settings/panels/provider-cli-candidates-section";
import { PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD } from "@/components/settings/panels/provider-pack-version-manager-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { anyTooltipHasText } from "@/components/ui/__tests__/tooltip-probe";

type CapturedVersionManagerProps = {
  readonly hostId: string | null;
  readonly packId: string;
  readonly packDisplayName: string;
  readonly managedVersions: ProviderManagedVersions;
};

const mocks = vi.hoisted(() => ({
  setSelectionMutate: vi.fn(),
  addCustomPathMutate: vi.fn(),
  removeCustomPathMutate: vi.fn(),
  ensurePackMutate: vi.fn(),
  hostSupportsMethod: false,
  useHostSupportsMethod: vi.fn(
    (hostId: string | null, _method: string): boolean => {
      // Mirrors the real boolean form: no host ⇒ not yet/never supported.
      if (hostId === null) return false;
      return mocks.hostSupportsMethod;
    },
  ),
  lastVersionManagerProps: null as CapturedVersionManagerProps | null,
  versionManagerPanel: vi.fn(
    (props: CapturedVersionManagerProps): ReactNode => {
      mocks.lastVersionManagerProps = props;
      return createElement("div", {
        "data-testid": "version-manager-panel",
        "data-pack-id": props.packId,
      });
    },
  ),
}));

// Shallow-mount capture for Manage versions open path. Keep the capability
// constant export so gate tests still import the real method name.
vi.mock(
  "@/components/settings/panels/provider-pack-version-manager-panel",
  () => ({
    PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD:
      "providers.usePackVersion" as const,
    ProviderPackVersionManagerPanel: (props: CapturedVersionManagerProps) =>
      mocks.versionManagerPanel(props),
  }),
);

vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  useProvidersEnsurePack: () => ({
    mutate: mocks.ensurePackMutate,
    isPending: false,
  }),
}));

// Capability gate for Manage versions — evaluated against the scoped hostId
// prop, never an ambient active-host hook.
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (hostId: string | null, method: string): boolean =>
    mocks.useHostSupportsMethod(hostId, method),
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

// CliBinaryMissingNotice opens install URLs through this mutation; the empty
// notice tests need the hook mocked so they do not require a QueryClient.
vi.mock("@/hooks/runner/use-open-external-link-mutation", () => ({
  useRunnerOpenExternalLink: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

/**
 * B5-T1 table rework coverage: managed install progress, retired standalone
 * notices, PATH-row advisory tooltip, Active chip from nextRunBinary, and
 * Manage versions capability gating — plus older empty-candidate / old-host
 * tolerance cases that this section still owns.
 */

const TEST_HOST_ID = "host-test";

function emptyManagedVersions(): ProviderManagedVersions {
  return {
    autoDownload: true,
    pinnedVersion: null,
    updateAvailable: null,
    sharedWithProviders: [],
    totalSizeBytes: null,
    available: [],
  };
}

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
  readonly providerId?: ProviderCliState["providerId"];
  readonly selected: ProviderSelection;
  readonly candidates: readonly ProviderCliCandidate[];
  readonly managedInstallState?: ProviderManagedInstallState | null;
  readonly versionVisibility?: ProviderVersionVisibility | null;
  readonly advisory?: ProviderAdvisory | null;
  readonly nextRunBinary?: ProviderNextRunBinary | null;
  readonly packId?: string | null;
  readonly managedVersions?: ProviderManagedVersions | null;
}): ProviderCliState {
  const state: ProviderCliState = {
    providerId: args.providerId === undefined ? "claude-code" : args.providerId,
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
    },
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
    ...(args.advisory !== undefined ? { advisory: args.advisory } : {}),
    ...(args.nextRunBinary !== undefined
      ? { nextRunBinary: args.nextRunBinary }
      : {}),
    ...(args.packId !== undefined ? { packId: args.packId } : {}),
    ...(args.managedVersions !== undefined
      ? { managedVersions: args.managedVersions }
      : {}),
  };
}

// Second helper rather than a default/optional param - the monorepo forbids
// `fn(x?: T)` and `fn(x = …)`. Existing call sites use `renderSection`; the
// multi-provider case (traycer borrowing opencode) uses `renderSectionWith`.
function renderSection(state: ProviderCliState): void {
  renderSectionWith(state, [state], TEST_HOST_ID);
}

function renderSectionWith(
  state: ProviderCliState,
  providers: readonly ProviderCliState[],
  hostId: string | null,
): void {
  render(
    <TooltipProvider>
      <ProviderCliCandidatesSection
        state={state}
        providers={providers}
        hostId={hostId}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.hostSupportsMethod = false;
  mocks.lastVersionManagerProps = null;
  vi.clearAllMocks();
});

describe("ProviderCliCandidatesSection: empty-candidate notice (F2 route-back)", () => {
  it("shows amp's install notice with the ampcode.com/manual link when candidates are empty", () => {
    // Amp joined PROVIDERS_WITHOUT_BUNDLED_BINARY: with nothing on PATH the
    // host sends an empty candidate list. The notice is the only on-screen
    // route back from the silent MCP binary-absent dead end.
    const state = providerState({
      providerId: "amp",
      selected: { kind: "path" },
      candidates: [],
    });
    renderSection(state);

    expect(
      screen.getByText(
        "No Amp CLI was found on this machine, and Traycer ships no bundled copy of it. Install it, or add its path below.",
      ),
    ).toBeDefined();
    const guide = screen.getByRole("link", { name: "Amp installation guide" });
    expect(guide.getAttribute("href")).toBe("https://ampcode.com/manual");
  });

  it("waits for the PATH probe instead of declaring the binary missing", () => {
    // `availabilityPending` means the host's shell/PATH probe has not settled,
    // and the protocol is explicit that `candidates` must not be trusted until
    // it does. The empty list here is interim, not a verdict — for the
    // PATH-only providers this is the ordinary cold-open state, so treating it
    // as final tells people to install a CLI the probe is about to find.
    const state: ProviderCliState = {
      ...providerState({
        providerId: "amp",
        selected: { kind: "path" },
        candidates: [],
      }),
      availabilityPending: true,
    };
    renderSection(state);

    expect(screen.getByText("Looking for the Amp CLI…")).toBeDefined();
    expect(
      screen.queryByText(/No Amp CLI was found on this machine/),
    ).toBeNull();
    // The install guide is the actionable half of the wrong advice; it must
    // not be reachable while the answer is still unknown.
    expect(
      screen.queryByRole("link", { name: "Amp installation guide" }),
    ).toBeNull();
  });

  it("renders the empty sentence with no link when the install URL is null (cursor)", () => {
    // Cursor has no verified install page in this repo; null means omit the
    // anchor rather than shipping a guessed URL that 404s.
    const state = providerState({
      providerId: "cursor",
      selected: { kind: "path" },
      candidates: [],
    });
    renderSection(state);

    expect(
      screen.getByText(
        "No Cursor CLI was found on this machine, and Traycer ships no bundled copy of it. Install it, or add its path below.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("borrows opencode's candidates when traycer's own list is empty", () => {
    // traycer and openrouter share the opencode pack; an empty own list with a
    // populated source must still surface those rows so the user can pick one.
    const traycer = providerState({
      providerId: "traycer",
      selected: { kind: "bundled" },
      candidates: [],
    });
    const opencode = providerState({
      providerId: "opencode",
      selected: { kind: "bundled" },
      candidates: [
        pathCandidate({
          path: "/usr/local/bin/opencode",
          version: "1.0.0",
          available: true,
        }),
      ],
    });
    renderSectionWith(traycer, [traycer, opencode], TEST_HOST_ID);

    expect(
      screen.getByRole("radio", { name: "Select /usr/local/bin/opencode" }),
    ).toBeDefined();
    expect(
      screen.queryByText(/No Traycer CLI was found on this machine/),
    ).toBeNull();
  });

  it("renders the candidates table, not the empty notice, when candidates exist", () => {
    const state = providerState({
      providerId: "amp",
      selected: { kind: "path" },
      candidates: [
        pathCandidate({
          path: "/usr/local/bin/amp",
          version: "1.2.3",
          available: true,
        }),
      ],
    });
    renderSection(state);

    expect(
      screen.getByRole("radio", { name: "Select /usr/local/bin/amp" }),
    ).toBeDefined();
    expect(
      screen.queryByText(/No Amp CLI was found on this machine/),
    ).toBeNull();
  });
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

  it("shows install progress with version and percent while downloading", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: {
        status: "downloading",
        percent: 42,
        version: "1.18.11",
      },
    });
    renderSection(state);
    expect(screen.getByText("Managed")).toBeDefined();
    // Managed row owns its install subject: version + percent, never a bare
    // "Preparing…" that drifts from the version-manager progress copy.
    expect(screen.getByText("Installing v1.18.11 · 42%")).toBeDefined();
    expect(
      screen.getByRole("progressbar", { name: "Installing v1.18.11 · 42%" }),
    ).toBeDefined();
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

describe("ProviderCliCandidatesSection: former standalone notice lines are gone", () => {
  it("never renders the retired PATH-unblock sentence", () => {
    // Replaced by the host-driven Active chip. Client-side inference of
    // "Running from PATH · installing managed copy" was wrong for
    // closure-coupled packs and is no longer a surface on this screen.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: {
        status: "downloading",
        percent: 10,
        version: "1.18.11",
      },
      nextRunBinary: {
        kind: "path",
        path: "/usr/local/bin/claude",
        version: "1.0.0",
      },
    });
    renderSection(state);
    expect(
      screen.queryByText("Running from PATH · installing managed copy"),
    ).toBeNull();
  });
});

describe("ProviderCliCandidatesSection: version-visibility on Managed row", () => {
  it("renders the plural caption under Managed for multiple differing sessions", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
      managedInstallState: { status: "installed", version: "1.0.0" },
      versionVisibility: { differingSessionCount: 3 },
    });
    renderSection(state);
    expect(
      screen.getByText("3 running sessions use a different version."),
    ).toBeDefined();
  });

  it("renders the singular caption for exactly one differing session", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
      managedInstallState: { status: "installed", version: "1.0.0" },
      versionVisibility: { differingSessionCount: 1 },
    });
    renderSection(state);
    expect(
      screen.getByText("1 running session uses a different version."),
    ).toBeDefined();
  });

  it("renders nothing when the count is zero", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
      managedInstallState: { status: "installed", version: "1.0.0" },
      versionVisibility: { differingSessionCount: 0 },
    });
    renderSection(state);
    expect(screen.queryByText(/different version/i)).toBeNull();
  });
});

/**
 * Managed-row status cell for non-installed managed pack state.
 *
 * B5-T1 formats downloading from raw managedInstallState (version + percent).
 * Errors are the short cell copy "Install failed" — the standalone detail
 * sentence above the table is intentionally gone.
 */
describe("ProviderCliCandidatesSection: managed install status cell", () => {
  it("shows indeterminate Installing v<version>… when percent is null", () => {
    // `percent` is nullable and null is a REAL state: a queued pack has seen no
    // bytes, and a pack whose download a live sibling host owns is genuinely in
    // progress with no observable count on this side. Null must never stall or
    // error — it is an honest indeterminate install.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: {
        status: "downloading",
        percent: null,
        version: "1.18.11",
      },
    });
    renderSection(state);
    expect(screen.getByText("Installing v1.18.11…")).toBeDefined();
    expect(
      screen.getByRole("progressbar", { name: "Installing v1.18.11…" }),
    ).toBeDefined();
    expect(screen.queryByText(/Installing… %/u)).toBeNull();
    expect(screen.queryByText(/null/u)).toBeNull();
    expect(screen.queryByText(/Setup failed|Install failed/u)).toBeNull();
  });

  it("uses a graceful generic install label when version is missing", () => {
    // `managedInstallState.version` is optional on the wire. A missing key is
    // "version not reported", never a stringified undefined in the cell.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: { status: "downloading", percent: null },
    });
    renderSection(state);
    expect(screen.queryByText(/undefined/u)).toBeNull();
    expect(screen.queryByText(/Installing vundefined/u)).toBeNull();
    expect(screen.getByText(/^Installing…$/u)).toBeDefined();
  });

  it("uses a graceful generic percent label when version is missing but percent is known", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: { status: "downloading", percent: 42 },
    });
    renderSection(state);
    expect(screen.queryByText(/undefined/u)).toBeNull();
    expect(screen.getByText("Installing · 42%")).toBeDefined();
  });

  it("still shows the percent when one is known", () => {
    // The control: a guard that suppressed every percent would pass the null
    // case above and silently remove working progress reporting.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: {
        status: "downloading",
        percent: 42,
        version: "1.18.11",
      },
    });
    renderSection(state);
    expect(screen.getByText(/42%/u)).toBeDefined();
  });

  it("shows Install failed with Retry for a retryable error (no standalone detail)", () => {
    // Cell copy is the short "Install failed". The former row-level reason
    // sentence is intentionally gone from this screen.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: {
        status: "error",
        reason: "disk-full",
        message: "ENOSPC",
        retryAtMs: null,
      },
    });
    renderSection(state);
    expect(screen.getByText("Install failed")).toBeDefined();
    expect(screen.queryByText(/not enough disk space/iu)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("routes the retry through providers.ensurePack", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: {
        status: "error",
        reason: "network",
        message: "offline",
        retryAtMs: null,
      },
    });
    renderSection(state);
    screen.getByRole("button", { name: "Retry" }).click();
    expect(mocks.ensurePackMutate).toHaveBeenCalledWith({
      providerId: state.providerId,
    });
  });

  it.each([["unrepairable" as const], ["trust-unavailable" as const]])(
    "withholds the retry for %s - a click that cannot work",
    (reason) => {
      // Same allow-list the picker rail uses. `unrepairable` is terminal
      // host-side and a `trust-unavailable` host has no install machinery at all,
      // so a button here would be offered-then-failed on the one screen a stuck
      // user was told to open.
      const state = providerState({
        selected: { kind: "bundled" },
        candidates: [bundledCandidate({ available: false })],
        managedInstallState: {
          status: "error",
          reason,
          message: "terminal",
          retryAtMs: null,
        },
      });
      renderSection(state);
      expect(screen.getByText("Install failed")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    },
  );
});

/**
 * A pack that failed behind a working PATH binary still says "Install failed"
 * on the Managed cell (raw managed subject). The former B5-T3 short labels
 * "Update failed" / "Setup failed" are not this table's cell copy.
 */
describe("ProviderCliCandidatesSection: a pack that failed behind a working binary", () => {
  function failedPackWithPathFallback(): ProviderCliState {
    return providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: {
        status: "error",
        reason: "network",
        message: "offline",
        retryAtMs: null,
      },
    });
  }

  it("shows Install failed for both blocking and non-blocking managed errors", () => {
    renderSection(failedPackWithPathFallback());
    expect(screen.getByText("Install failed")).toBeDefined();
    expect(screen.queryByText(/^Update failed$/u)).toBeNull();
    expect(screen.queryByText(/^Setup failed$/u)).toBeNull();
    // Standalone reason detail is intentionally gone.
    expect(screen.queryByText(/could not be reached/iu)).toBeNull();
  });

  it("does not paint the non-blocking status cell as an error colour", () => {
    // PATH fallback makes the row available enough that the cell is not
    // marked unavailable. Asserted on the class because that is what the user
    // sees - there is no accessible role that carries colour.
    renderSection(failedPackWithPathFallback());
    const cell = screen.getByText("Install failed");
    expect(cell.className).not.toMatch(/text-destructive/u);
    const versionCell = cell.closest(".text-destructive");
    expect(versionCell).toBeNull();
  });

  it("dims the blocking error case, so the assertion above is not vacuous", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: {
        status: "error",
        reason: "network",
        message: "offline",
        retryAtMs: null,
      },
    });
    renderSection(state);
    const cell = screen.getByText("Install failed");
    expect(cell.closest(".text-destructive")).not.toBeNull();
  });

  it("reports the managed row's own install progress while a PATH binary can still run", () => {
    // The Managed row shows only its install subject — not a fused
    // "Ready · installing" line. A PATH fallback is the Active chip's job,
    // not the status cell's.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: {
        status: "downloading",
        percent: 40,
        version: "1.18.11",
      },
      nextRunBinary: {
        kind: "path",
        path: "/usr/local/bin/claude",
        version: "1.0.0",
      },
    });
    renderSection(state);
    expect(screen.getByText("Installing v1.18.11 · 40%")).toBeDefined();
    expect(screen.queryByText(/^Updating in background$/u)).toBeNull();
  });

  it("still shows Install failed when availability is pending", () => {
    // availabilityPending fails open for readiness derivation (retry still
    // offered for network), but the cell copy is raw managed state.
    const state: ProviderCliState = {
      ...providerState({
        selected: { kind: "bundled" },
        candidates: [bundledCandidate({ available: false })],
        managedInstallState: {
          status: "error",
          reason: "network",
          message: "offline",
          retryAtMs: null,
        },
      }),
      availabilityPending: true,
    };
    renderSection(state);
    expect(screen.getByText("Install failed")).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });
});

/**
 * W10. The closure-carve advisory - the only advisory kind a Phase-1 host
 * populates.
 *
 * After the table rework the host detail rides a PATH-row info tooltip rather
 * than a bare line above the table.
 */
describe("ProviderCliCandidatesSection: row-incompatibility advisory", () => {
  const DETAIL =
    "This provider is paired with the exact build Traycer ships (1.2.3), so a version found on your PATH is not used automatically. Select that path below to use it anyway.";

  it("surfaces the host advisory through a PATH-row tooltip, not a standalone line", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      advisory: { kind: "row-incompatibility", detail: DETAIL },
    });
    renderSection(state);
    // Not a free-standing paragraph above the table (former notice line).
    expect(screen.queryByText(DETAIL)).toBeNull();
    const info = screen.getByLabelText(
      "Why this PATH binary is not used automatically",
    );
    // Nested under FilePathTooltip: focusing the info icon can open both
    // tooltips, so assert the advisory is among open tooltips rather than the
    // unique role=tooltip.
    fireEvent.focus(info);
    const openTips = screen.getAllByRole("tooltip").map((el) => el.textContent);
    expect(openTips.some((text) => text === DETAIL)).toBe(true);
    fireEvent.blur(info);
  });

  it("renders nothing when the host sends no advisory", () => {
    // The overwhelmingly common case - every wire-coupled provider, and every
    // old host, which leaves the key genuinely absent.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [pathCandidate({ available: true })],
    });
    renderSection(state);
    expect(screen.queryByText(/paired with the exact build/u)).toBeNull();
    expect(
      screen.queryByLabelText("Why this PATH binary is not used automatically"),
    ).toBeNull();
    expect(anyTooltipHasText(/paired with the exact build/u)).toBe(false);
  });

  it("renders nothing for an advisory with no detail", () => {
    // `detail` is nullable on the wire. A bare kind is a code, not copy, and
    // showing an empty notice is worse than showing none.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [pathCandidate({ available: true })],
      advisory: { kind: "row-incompatibility", detail: null },
    });
    renderSection(state);
    expect(screen.queryByText(/paired with the exact build/u)).toBeNull();
    expect(
      screen.queryByLabelText("Why this PATH binary is not used automatically"),
    ).toBeNull();
  });

  it("ignores the dormant Phase-2 kinds rather than rendering a raw code", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [pathCandidate({ available: true })],
      advisory: { kind: "yank-rollback", detail: "some phase-2 detail" },
    });
    renderSection(state);
    expect(screen.queryByText("some phase-2 detail")).toBeNull();
    expect(anyTooltipHasText("some phase-2 detail")).toBe(false);
  });
});

/**
 * B5 table rework: Active chip is host-driven via `nextRunBinary`, never
 * client inference. Radio stays on the persisted selection; the chip only
 * appears when the next execute would resolve to a different candidate.
 */
describe("ProviderCliCandidatesSection: Active chip from nextRunBinary", () => {
  it("shows Active on the PATH row when nextRunBinary is path and selection is managed", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: {
        status: "downloading",
        percent: 10,
        version: "1.18.11",
      },
      nextRunBinary: {
        kind: "path",
        path: "/usr/local/bin/claude",
        version: "1.0.0",
      },
    });
    renderSection(state);

    const managedRadio = screen.getByRole("radio", {
      name: "Select bundled binary",
    });
    const pathRadio = screen.getByRole("radio", {
      name: "Select /usr/local/bin/claude",
    });
    // Radio remains the persisted selection while the chip differs.
    expect(managedRadio).toHaveProperty("checked", true);
    expect(pathRadio).toHaveProperty("checked", false);
    expect(screen.getByText(/^Active$/u)).toBeDefined();
    expect(screen.queryByText("Active (bundled build)")).toBeNull();
    expect(
      anyTooltipHasText(
        "New sessions use this binary. Running sessions keep the binary they started with.",
      ),
    ).toBe(true);
  });

  it("labels the Managed row Active (bundled build) when nextRunBinary.kind is bundled", () => {
    const state = providerState({
      selected: { kind: "path" },
      candidates: [
        bundledCandidate({ available: true, version: "1.2.3" }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "installed", version: "1.2.3" },
      nextRunBinary: {
        kind: "bundled",
        path: null,
        version: "1.2.3",
      },
    });
    renderSection(state);

    expect(
      screen.getByRole("radio", { name: "Select /usr/local/bin/claude" }),
    ).toHaveProperty("checked", true);
    expect(
      screen.getByRole("radio", { name: "Select bundled binary" }),
    ).toHaveProperty("checked", false);
    expect(screen.getByText("Active (bundled build)")).toBeDefined();
    expect(screen.queryByText(/^Active$/u)).toBeNull();
  });

  it("still shows Active (bundled build) when selection is Managed and nextRun is the inline bundled fallback", () => {
    // Non-null managedInstallState means the row is Managed. Selected managed
    // install vs next-run inline bundled share the row but are different
    // binaries — the chip must stay visible.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: true, version: "1.2.3" }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "installed", version: "1.2.3" },
      nextRunBinary: {
        kind: "bundled",
        path: null,
        version: "1.0.0",
      },
    });
    renderSection(state);

    expect(screen.getByText("Managed")).toBeDefined();
    expect(
      screen.getByRole("radio", { name: "Select bundled binary" }),
    ).toHaveProperty("checked", true);
    expect(screen.getByText("Active (bundled build)")).toBeDefined();
    expect(screen.queryByText(/^Active$/u)).toBeNull();
  });

  it.each([
    ["absent field", undefined],
    ["explicit null", null],
  ] as const)(
    "hides Active (bundled build) on the legacy Bundled row when managedInstallState is %s",
    (_label, managedInstallState) => {
      // Legacy / pre-registry row: label is "Bundled", selection.kind is
      // bundled, and nextRunBinary.kind bundled is the same inline binary the
      // radio already names — no chip. Only a non-null managedInstallState
      // makes the bundled next-run a distinct fallback worth labelling.
      const state = providerState({
        selected: { kind: "bundled" },
        candidates: [
          bundledCandidate({ available: true, version: "1.2.3" }),
          pathCandidate({ available: true }),
        ],
        ...(managedInstallState === undefined ? {} : { managedInstallState }),
        nextRunBinary: {
          kind: "bundled",
          path: null,
          version: "1.2.3",
        },
      });
      renderSection(state);

      expect(screen.getByText("Bundled")).toBeDefined();
      expect(screen.queryByText("Managed")).toBeNull();
      expect(
        screen.getByRole("radio", { name: "Select bundled binary" }),
      ).toHaveProperty("checked", true);
      expect(screen.queryByText("Active (bundled build)")).toBeNull();
      expect(screen.queryByText(/^Active$/u)).toBeNull();
    },
  );

  it("shows no Active chip when nextRunBinary is null", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: true, version: "1.0.0" }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "installed", version: "1.0.0" },
      nextRunBinary: null,
    });
    renderSection(state);
    expect(screen.queryByText(/^Active$/u)).toBeNull();
    expect(screen.queryByText("Active (bundled build)")).toBeNull();
  });

  it("shows no Active chip when nextRunBinary is absent (old host)", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: true, version: "1.0.0" }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "installed", version: "1.0.0" },
    });
    renderSection(state);
    expect(screen.queryByText(/^Active$/u)).toBeNull();
    expect(screen.queryByText("Active (bundled build)")).toBeNull();
  });

  it("shows no Active chip when nextRunBinary matches the persisted selection", () => {
    const state = providerState({
      selected: { kind: "path" },
      candidates: [
        bundledCandidate({ available: true, version: "1.0.0" }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "installed", version: "1.0.0" },
      nextRunBinary: {
        kind: "path",
        path: "/usr/local/bin/claude",
        version: "1.0.0",
      },
    });
    renderSection(state);
    expect(screen.queryByText(/^Active$/u)).toBeNull();
    expect(screen.queryByText("Active (bundled build)")).toBeNull();
    expect(
      screen.getByRole("radio", { name: "Select /usr/local/bin/claude" }),
    ).toHaveProperty("checked", true);
  });

  it("shows no Active chip when nextRunBinary is managed and selection is managed", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: true, version: "1.0.0" }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "installed", version: "1.0.0" },
      nextRunBinary: {
        kind: "managed",
        path: "/managed/claude",
        version: "1.0.0",
      },
    });
    renderSection(state);
    expect(screen.queryByText(/^Active$/u)).toBeNull();
    expect(screen.queryByText("Active (bundled build)")).toBeNull();
    expect(
      screen.getByRole("radio", { name: "Select bundled binary" }),
    ).toHaveProperty("checked", true);
  });
});

/**
 * Manage versions is capability-gated against the scoped hostId prop. Pack
 * fields alone are not enough — an older host must never be offered the panel
 * entry point (offered-then-failed).
 */
describe("ProviderCliCandidatesSection: Manage versions capability gate", () => {
  function stateWithPackFields(): ProviderCliState {
    return providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: true, version: "1.0.0" }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "installed", version: "1.0.0" },
      packId: "claude-code",
      managedVersions: emptyManagedVersions(),
    });
  }

  it("hides Manage versions when capability is false even with pack fields", () => {
    mocks.hostSupportsMethod = false;
    renderSection(stateWithPackFields());
    expect(mocks.useHostSupportsMethod).toHaveBeenCalledWith(
      TEST_HOST_ID,
      PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD,
    );
    expect(
      screen.queryByRole("button", { name: "Manage versions" }),
    ).toBeNull();
  });

  it("hides Manage versions when hostId is null even if pack fields are present", () => {
    // Support flag is irrelevant: null host fails closed (same as the real
    // useHostSupportsMethod boolean form).
    mocks.hostSupportsMethod = true;
    renderSectionWith(stateWithPackFields(), [stateWithPackFields()], null);
    expect(mocks.useHostSupportsMethod).toHaveBeenCalledWith(
      null,
      PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD,
    );
    expect(
      screen.queryByRole("button", { name: "Manage versions" }),
    ).toBeNull();
  });

  it("shows Manage versions when capability is true and pack fields are present", () => {
    mocks.hostSupportsMethod = true;
    renderSection(stateWithPackFields());
    expect(mocks.useHostSupportsMethod).toHaveBeenCalledWith(
      TEST_HOST_ID,
      PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD,
    );
    expect(
      screen.getByRole("button", { name: "Manage versions" }),
    ).toBeDefined();
  });

  it("hides Manage versions when packId is missing even if capability is true", () => {
    mocks.hostSupportsMethod = true;
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
      managedInstallState: { status: "installed", version: "1.0.0" },
      managedVersions: emptyManagedVersions(),
    });
    renderSection(state);
    expect(
      screen.queryByRole("button", { name: "Manage versions" }),
    ).toBeNull();
  });

  it("forwards scoped hostId, packId, pack-scoped title, and managedVersions on open", () => {
    mocks.hostSupportsMethod = true;
    const managedVersions = emptyManagedVersions();
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: true, version: "1.0.0" }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "installed", version: "1.0.0" },
      // Shared-store pack id, not the provider display name — the panel title
      // must stay pack-scoped (e.g. opencode CLI from an openrouter row).
      packId: "opencode",
      managedVersions,
    });
    renderSection(state);

    fireEvent.click(screen.getByRole("button", { name: "Manage versions" }));

    expect(screen.getByTestId("version-manager-panel")).toBeDefined();
    expect(mocks.lastVersionManagerProps).toEqual({
      hostId: TEST_HOST_ID,
      packId: "opencode",
      packDisplayName: "opencode CLI",
      managedVersions,
    });
  });
});

describe("ProviderCliCandidatesSection: tooltip trigger keyboard reachability", () => {
  it("exposes the PATH advisory and Active chip as focusable buttons", () => {
    const DETAIL =
      "This provider is paired with the exact build Traycer ships (1.2.3), so a version found on your PATH is not used automatically. Select that path below to use it anyway.";
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: {
        status: "downloading",
        percent: 10,
        version: "1.18.11",
      },
      advisory: { kind: "row-incompatibility", detail: DETAIL },
      nextRunBinary: {
        kind: "path",
        path: "/usr/local/bin/claude",
        version: "1.0.0",
      },
    });
    renderSection(state);

    const advisory = screen.getByRole("button", {
      name: "Why this PATH binary is not used automatically",
    });
    advisory.focus();
    expect(document.activeElement).toBe(advisory);

    const chip = screen.getByRole("button", { name: "Active" });
    chip.focus();
    expect(document.activeElement).toBe(chip);
  });
});
