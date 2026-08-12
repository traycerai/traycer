import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { anyTooltipHasText } from "@/components/ui/__tests__/tooltip-probe";

type CapturedVersionManagerProps = {
  readonly hostId: string | null;
  readonly packId: string;
  readonly packDisplayName: string;
  readonly managedVersions: ProviderManagedVersions;
};

/**
 * Named because `hostSupportsMethod` CANNOT be typed at the property.
 *
 * `false as boolean | null` is the obvious spelling and it does not survive:
 * `@typescript-eslint/no-unnecessary-type-assertion` reports it (the sole
 * reader, `useHostSupportsMethod`, already returns `boolean | null`, so the
 * rule concludes the assertion buys nothing) and `lint --fix` DELETES it.
 * The property then infers `boolean`, and every `= null` below fails to
 * compile — which `vitest` will not tell you, because it does not type-check.
 *
 * `null` is a real value here, not a widening for convenience: the hook
 * answers null while support is still unknown, and the panel must stay silent
 * for it rather than claim the host is too old.
 */
type SectionMocks = {
  setSelectionMutate: Mock;
  addCustomPathMutate: Mock;
  removeCustomPathMutate: Mock;
  ensurePackMutate: Mock;
  hostSupportsMethod: boolean | null;
  useVersionManagerSupport: Mock<(hostId: string | null) => boolean | null>;
  // Concretely typed, not bare `Mock`: a bare one is `Mock<Procedure>`, whose
  // return is `any`, and the two call sites below then trip
  // `no-unsafe-return`.
  useHostSupportsMethod: Mock<
    (hostId: string | null, method: string) => boolean | null
  >;
  lastVersionManagerProps: CapturedVersionManagerProps | null;
  versionManagerPanel: Mock<(props: CapturedVersionManagerProps) => ReactNode>;
};

const mocks = vi.hoisted((): SectionMocks => ({
  setSelectionMutate: vi.fn(),
  addCustomPathMutate: vi.fn(),
  removeCustomPathMutate: vi.fn(),
  ensurePackMutate: vi.fn(),
  hostSupportsMethod: false,
  useHostSupportsMethod: vi.fn(
    (hostId: string | null, _method: string): boolean | null => {
      // Mirrors the real boolean form: no host ⇒ not yet/never supported.
      if (hostId === null) return false;
      return mocks.hostSupportsMethod;
    },
  ),
  // Mirrors `useProviderPackVersionManagerSupport`: three-valued, and null for
  // a null host because no handshake is possible without one.
  useVersionManagerSupport: vi.fn((hostId: string | null): boolean | null => {
    if (hostId === null) return null;
    return mocks.hostSupportsMethod;
  }),
  lastVersionManagerProps: null,
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

// Shallow-mount capture for Manage versions open path.
vi.mock(
  "@/components/settings/panels/provider-pack-version-manager-panel",
  () => ({
    ProviderPackVersionManagerPanel: (props: CapturedVersionManagerProps) =>
      mocks.versionManagerPanel(props),
  }),
);

// The capability gate the section reads. THREE-VALUED on purpose: null means
// "handshake has not landed", which this surface must not render as "your host
// is too old" - it explains rather than hides now, so a collapsed boolean
// would put a wrong sentence on screen during first paint.
vi.mock(
  "@/components/settings/panels/provider-pack-version-manager-capability",
  () => ({
    useProviderPackVersionManagerSupport: (
      hostId: string | null,
    ): boolean | null => mocks.useVersionManagerSupport(hostId),
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
  useHostSupportsMethod: (
    hostId: string | null,
    method: string,
  ): boolean | null => mocks.useHostSupportsMethod(hostId, method),
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
 * Table coverage: managed install progress, retired standalone notices,
 * PATH-row advisory tooltip, the substitution note derived from
 * `nextRunBinary`, and version-menu capability gating — plus older
 * empty-candidate / old-host tolerance cases this section still owns.
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
  readonly managedVersionsUnavailable?: ProviderCliState["managedVersionsUnavailable"];
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
      modelProviders: null,
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
    ...(args.managedVersionsUnavailable !== undefined
      ? { managedVersionsUnavailable: args.managedVersionsUnavailable }
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
    // Replaced by the host-driven substitution note. Client-side inference of
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
 * The Managed row's status line for non-installed pack state.
 *
 * Downloading is formatted from raw managedInstallState (version + percent).
 * Errors take neither the Version cell nor a badge: the row keeps reporting
 * the version it will run, and the failure is one sentence on the status line
 * that OPENS with what is running instead. The standalone detail sentence
 * above the table stays gone.
 */
describe("ProviderCliCandidatesSection: managed install status line", () => {
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

  it("states a retryable error as readable text, not as a tooltip's accessible name", () => {
    // The reason used to be the accessible name of a warning icon, reachable
    // only by hover or by a screen reader. It is the one sentence that decides
    // whether a retry is worth attempting - four of the eight reasons are
    // terminal and say so - and the row's status line has room for it.
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
    expect(screen.queryByText("Install failed")).toBeNull();
    expect(screen.getByText(/not enough disk space/iu)).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("keeps the row's version and leads the failure with what actually runs", () => {
    // THE REGRESSION, and the shape that replaced its first fix. The error
    // branch used to replace the whole status cell, so the row lost its
    // version entirely; the fix for that put the failure beside an "Active
    // (bundled build)" chip, so the row announced a success badge and a
    // failure at once. Now the row reports the version it will run, and the
    // failure is one sentence that OPENS with what is running instead.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: true, version: "0.146.0" })],
      nextRunBinary: { kind: "bundled", path: null, version: "0.146.0" },
      managedInstallState: {
        status: "error",
        reason: "network",
        message: "fetch failed with status 404",
        version: "0.147.0",
        retryAtMs: null,
      },
    });
    renderSection(state);
    expect(screen.getByText("v0.146.0")).toBeDefined();
    // Leads with what runs, then names the version that actually failed -
    // which is the whole difference between "retry" and "this pin was never
    // published".
    const line = screen.getByText(/^Running the bundled build\./u);
    expect(line.textContent).toMatch(/managed v0\.147\.0/iu);
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
      // The failure is still reported - it just reads as text on the row's
      // status line now. Both reasons render copy naming the build, so one
      // matcher covers the pair without asserting reason-specific wording
      // twice.
      expect(screen.getByText(/managed build/iu)).toBeDefined();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    },
  );
});

/**
 * A pack that failed behind a working PATH binary. The Managed row keeps
 * reporting its version and states the failure on its status line; the picker
 * rail's short labels "Update failed" / "Setup failed" are not this table's
 * copy either.
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

  it("reports both blocking and non-blocking managed errors on the status line", () => {
    renderSection(failedPackWithPathFallback());
    expect(screen.getByText(/could not download/iu)).toBeDefined();
    expect(screen.queryByText(/^Update failed$/u)).toBeNull();
    expect(screen.queryByText(/^Setup failed$/u)).toBeNull();
    // The picker rail's short phrasing is not this table's copy either.
    expect(screen.queryByText(/could not be reached/iu)).toBeNull();
  });

  it("does not paint the non-blocking row's version as an error colour", () => {
    // PATH fallback makes the row available enough that it is not marked
    // unavailable. Anchored on the VERSION CELL, which is the only element
    // that carries the dimming - asserting it on the status line would pass
    // trivially in both directions, since the line never carries that class.
    renderSection(failedPackWithPathFallback());
    const version = screen.getByText("Not installed");
    expect(version.className).not.toMatch(/text-destructive/u);
    expect(version.closest(".text-destructive")).toBeNull();
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
    expect(screen.getByText("Not installed").className).toMatch(
      /text-destructive/u,
    );
  });

  it("reports the managed row's install progress AND what runs meanwhile", () => {
    // The progress label stays byte-identical to the progressbar's accessible
    // name. What runs in the meantime is folded onto the same line rather than
    // dropped: with the Active chip deleted, the row that would have worn it
    // is the PATH row, which says nothing now - so suppressing this clause
    // during an install would lose the fact entirely, not merely relocate it.
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
    expect(
      screen.getByRole("progressbar", { name: "Installing v1.18.11 · 40%" }),
    ).toBeDefined();
    expect(
      screen.getByText(/Running the copy on your PATH until it's ready\./u),
    ).toBeDefined();
    expect(screen.queryByText(/^Updating in background$/u)).toBeNull();
  });

  it("still reports the failure when availability is pending", () => {
    // availabilityPending fails open for readiness derivation (retry still
    // offered for network), but the warning is driven by raw managed state.
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
    expect(screen.getByText(/could not download/iu)).toBeDefined();
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
    "Traycer is built to run opencode 1.2.3 specifically, so this copy on your PATH is not used. Select this row to use it anyway.";

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
    expect(screen.queryByText(/built to run opencode/u)).toBeNull();
    expect(
      screen.queryByLabelText("Why this PATH binary is not used automatically"),
    ).toBeNull();
    expect(anyTooltipHasText(/built to run opencode/u)).toBe(false);
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
    expect(screen.queryByText(/built to run opencode/u)).toBeNull();
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
 * `nextRunBinary` is host-computed and stays exactly as specified; what
 * changed is where it is rendered.
 *
 * It used to be an "Active" chip badged onto whichever row WON. That put a
 * success-shaped badge on a row that had just failed its install, and answered
 * "which row wins?" as decoration rather than as an answer. The same fact is
 * now ONE SENTENCE ON THE ROW THE RADIO PICKS — where the user's attention
 * already is, and where it can name the cause in the same breath.
 */
describe("ProviderCliCandidatesSection: substitution note from nextRunBinary", () => {
  it("notes the PATH substitution on the SELECTED managed row, not on the PATH row", () => {
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
    // The radio remains the persisted selection while what-runs differs.
    expect(managedRadio).toHaveProperty("checked", true);
    expect(pathRadio).toHaveProperty("checked", false);
    // The chip's tooltip is gone with it — the same fact is now readable text
    // rather than something a pointer has to uncover.
    expect(
      anyTooltipHasText(
        "This is the binary Traycer will start. Sessions already running keep the one they started with.",
      ),
    ).toBe(false);
    // While an install is in flight the note takes its "until it's ready"
    // form, so the standalone substitution sentence must NOT also appear.
    expect(screen.queryByText(/Not used right now/u)).toBeNull();
    // The note rides the row the radio picks — the Managed row — and it is
    // that row, not the PATH row, that carries the sentence.
    const note = screen.getByText(
      /Running the copy on your PATH until it's ready\./u,
    );
    expect(note.closest("div")?.textContent).toMatch(/Managed/u);
  });

  it("tells the selected PATH row that the bundled build will start instead", () => {
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
    const note = screen.getByText(
      /Not used right now — Traycer will start the bundled build instead\./u,
    );
    // On the PATH row — the one the radio picks — not on the bundled row that
    // actually wins, which is where the chip used to land.
    expect(note.closest("div")?.textContent).toMatch(
      /usr\/local\/bin\/claude/u,
    );
  });

  it("still notes the substitution when selection is Managed and nextRun is the inline bundled fallback", () => {
    // Non-null managedInstallState means the row is Managed. The selected
    // managed install and the next-run inline bundled build share that row but
    // are different binaries — the note must stay.
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
    expect(
      screen.getByText(
        /Not used right now — Traycer will start the bundled build instead\./u,
      ),
    ).toBeDefined();
  });

  it.each([
    ["absent field", undefined],
    ["explicit null", null],
  ] as const)(
    "notes nothing on the legacy Bundled row when managedInstallState is %s",
    (_label, managedInstallState) => {
      // Legacy / pre-registry row: label is "Bundled", selection.kind is
      // bundled, and nextRunBinary.kind bundled is the same inline binary the
      // radio already names — nothing is being substituted. Only a non-null
      // managedInstallState makes the bundled next-run a distinct fallback.
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
      expect(screen.queryByText(/Not used right now/u)).toBeNull();
    },
  );

  it("notes nothing when nextRunBinary is null", () => {
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
    expect(screen.queryByText(/Not used right now/u)).toBeNull();
  });

  it("notes nothing when nextRunBinary is absent (old host)", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: true, version: "1.0.0" }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "installed", version: "1.0.0" },
    });
    renderSection(state);
    expect(screen.queryByText(/Not used right now/u)).toBeNull();
  });

  it("notes nothing when nextRunBinary matches the persisted selection", () => {
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
    expect(screen.queryByText(/Not used right now/u)).toBeNull();
    expect(
      screen.getByRole("radio", { name: "Select /usr/local/bin/claude" }),
    ).toHaveProperty("checked", true);
  });

  it("notes nothing when nextRunBinary is managed and selection is managed", () => {
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
    expect(screen.queryByText(/Not used right now/u)).toBeNull();
    expect(
      screen.getByRole("radio", { name: "Select bundled binary" }),
    ).toHaveProperty("checked", true);
  });
});

/**
 * The structural properties the row layout rests on.
 *
 * Each reported defect is closed here by a property rather than by copy: one
 * subject per column, one status per row. These are the assertions that fail
 * first if the Version cell starts accreting affordances again — which is what
 * happened three times before this layout.
 */
describe("ProviderCliCandidatesSection: one subject per column, one status per row", () => {
  it("renders the version as bare text, with no control inside the cell", () => {
    // DEFECT 1. The managed version used to render inside the menu's padded
    // <button> while every other row rendered bare text, so the two could not
    // share a right edge however the cell was aligned. Any control back inside
    // this cell reintroduces exactly that.
    mocks.hostSupportsMethod = true;
    renderSection(
      providerState({
        selected: { kind: "bundled" },
        candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
        managedInstallState: { status: "installed", version: "1.0.0" },
        packId: "claude-code",
        managedVersions: emptyManagedVersions(),
      }),
    );

    const version = screen.getByText("v1.0.0");
    expect(version.closest("button")).toBeNull();
    expect(version.querySelector("button")).toBeNull();
    // And the menu is still reachable — from the action column instead.
    const menu = screen.getByRole("button", {
      name: "claude-code CLI version",
    });
    expect(version.contains(menu)).toBe(false);
  });

  it("shows only the highest-priority status when several are true at once", () => {
    // R3. A failed install, a substitution and differing sessions are all true
    // here. The row shows ONE line: a second would reintroduce the crowding
    // the whole revision removes, so the session count is deliberately starved.
    renderSection(
      providerState({
        selected: { kind: "bundled" },
        candidates: [bundledCandidate({ available: true, version: "0.146.0" })],
        nextRunBinary: { kind: "bundled", path: null, version: "0.146.0" },
        managedInstallState: {
          status: "error",
          reason: "network",
          message: "fetch failed with status 404",
          version: "0.147.0",
          retryAtMs: null,
        },
        versionVisibility: { differingSessionCount: 3 },
      }),
    );

    expect(screen.getByText(/^Running the bundled build\./u)).toBeDefined();
    expect(
      screen.queryByText(/running sessions use a different version/u),
    ).toBeNull();
    expect(screen.queryByText(/Not used right now/u)).toBeNull();
  });

  it("reports the version the Managed row will actually run, never the one that failed", () => {
    // R1. Showing the unreachable target as "the version" is what let an
    // Active badge sit beside a version nothing could start. The column is
    // total: every row reports what it runs, with no exception for this one.
    renderSection(
      providerState({
        selected: { kind: "bundled" },
        candidates: [bundledCandidate({ available: true, version: "0.146.0" })],
        nextRunBinary: { kind: "bundled", path: null, version: "0.146.0" },
        managedInstallState: {
          status: "error",
          reason: "network",
          message: "fetch failed with status 404",
          version: "0.147.0",
          retryAtMs: null,
        },
      }),
    );

    expect(screen.getByText("v0.146.0")).toBeDefined();
    // The failed target appears only inside the status sentence, never as the
    // row's version.
    expect(screen.queryByText("v0.147.0")).toBeNull();
  });
});

/**
 * Manage versions is capability-gated against the scoped hostId prop. Pack
 * fields alone are not enough — an older host must never be offered the panel
 * entry point (offered-then-failed).
 */
describe("ProviderCliCandidatesSection: version menu capability gate", () => {
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

  // WAS: "hides Manage versions when capability is false even with pack
  // fields", asserting the toggle disappeared.
  //
  // Hiding it is what the user reported: a settings tab with no control and no
  // reason reads as "this feature does not exist on my machine". An old host
  // now says so instead of vanishing.
  it("still offers the version menu when capability is false, and explains the host is too old", async () => {
    mocks.hostSupportsMethod = false;
    renderSection(stateWithPackFields());
    expect(mocks.useVersionManagerSupport).toHaveBeenCalledWith(TEST_HOST_ID);
    const toggle = screen.getByRole("button", {
      name: "claude-code CLI version",
    });
    fireEvent.click(toggle);
    const notice = await screen.findByTestId("version-manager-unavailable");
    expect(notice.textContent).toMatch(/too old/iu);
  });

  // `null` is "not answered yet", not "unsupported". Treating it as a refusal
  // would flash a wrong explanation at a host that supports this perfectly.
  it("stays silent while capability support is still unknown", () => {
    mocks.hostSupportsMethod = null;
    renderSection(stateWithPackFields());
    expect(screen.queryByTestId("version-manager-unavailable")).toBeNull();
  });

  it("explains a null managedVersions instead of hiding the panel", async () => {
    mocks.hostSupportsMethod = true;
    renderSection(
      providerState({
        selected: { kind: "bundled" },
        candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
        packId: "claude-code",
        managedVersions: null,
        managedVersionsUnavailable: { reason: "registry-unconfigured" },
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "claude-code CLI version" }),
    );
    const notice = await screen.findByTestId("version-manager-unavailable");
    expect(notice.textContent).toMatch(/no provider registry configured/iu);
  });

  // Both null is the one case that still hides: no managed pack at all, so
  // there is genuinely nothing to manage and nothing to explain.
  it("shows a plain version with no menu when the provider has no managed pack", () => {
    mocks.hostSupportsMethod = true;
    renderSection(
      providerState({
        selected: { kind: "bundled" },
        candidates: [bundledCandidate({ available: true, version: "1.0.0" })],
        packId: null,
        managedVersions: null,
        managedVersionsUnavailable: null,
      }),
    );
    expect(
      screen.queryByRole("button", { name: "claude-code CLI version" }),
    ).toBeNull();
  });

  it("hides the version menu when hostId is null even if pack fields are present", () => {
    // Support flag is irrelevant: a null host has no handshake, so the hook
    // answers null and this surface hides rather than explains.
    mocks.hostSupportsMethod = true;
    renderSectionWith(stateWithPackFields(), [stateWithPackFields()], null);
    expect(mocks.useVersionManagerSupport).toHaveBeenCalledWith(null);
    expect(
      screen.queryByRole("button", { name: "claude-code CLI version" }),
    ).toBeNull();
  });

  it("shows the version menu when capability is true and pack fields are present", () => {
    mocks.hostSupportsMethod = true;
    renderSection(stateWithPackFields());
    expect(mocks.useVersionManagerSupport).toHaveBeenCalledWith(TEST_HOST_ID);
    expect(
      screen.getByRole("button", { name: "claude-code CLI version" }),
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
      screen.queryByRole("button", { name: "claude-code CLI version" }),
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

    // Pack-scoped, not provider-scoped: this row's pack is opencode.
    fireEvent.click(
      screen.getByRole("button", { name: "opencode CLI version" }),
    );

    expect(screen.getByTestId("version-manager-panel")).toBeDefined();
    expect(mocks.lastVersionManagerProps).toEqual({
      hostId: TEST_HOST_ID,
      packId: "opencode",
      packDisplayName: "opencode CLI",
      managedVersions,
    });
  });
});

describe("ProviderCliCandidatesSection: keyboard reachability", () => {
  it("exposes the PATH advisory and the version menu as focusable buttons", () => {
    // The Active chip used to be the second trigger here. It is gone, but the
    // version menu took its place as a control with NO visible label — a bare
    // chevron in the action column — so its keyboard reachability and its
    // accessible name are now the thing that has to hold.
    mocks.hostSupportsMethod = true;
    const DETAIL =
      "Traycer is built to run opencode 1.2.3 specifically, so this copy on your PATH is not used. Select this row to use it anyway.";
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
      packId: "claude-code",
      managedVersions: emptyManagedVersions(),
    });
    renderSection(state);

    const advisory = screen.getByRole("button", {
      name: "Why this PATH binary is not used automatically",
    });
    advisory.focus();
    expect(document.activeElement).toBe(advisory);

    const versionMenu = screen.getByRole("button", {
      name: "claude-code CLI version",
    });
    versionMenu.focus();
    expect(document.activeElement).toBe(versionMenu);
  });
});
