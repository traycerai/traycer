import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliCandidate,
  ProviderCliState,
  ProviderManagedInstallState,
  ProviderSelection,
  ProviderVersionVisibility,
  ProviderAdvisory,
} from "@traycer/protocol/host/provider-schemas";
import { ProviderCliCandidatesSection } from "@/components/settings/panels/provider-cli-candidates-section";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  setSelectionMutate: vi.fn(),
  addCustomPathMutate: vi.fn(),
  removeCustomPathMutate: vi.fn(),
  ensurePackMutate: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-ensure-pack-mutation", () => ({
  useProvidersEnsurePack: () => ({
    mutate: mocks.ensurePackMutate,
    isPending: false,
  }),
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
  readonly advisory?: ProviderAdvisory | null;
}): ProviderCliState {
  const state: ProviderCliState = {
    providerId: "claude-code",
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
    // Deliberate copy change: this cell now goes through the shared
    // `providerPackPreparingShortLabel` (which says "Preparing…") rather than
    // formatting `managedInstallState` itself. The local wording was the reason
    // it could drift - and it did, rendering a literal "Installing… %" for a
    // null percent that every other surface already handled.
    expect(screen.getByText("Preparing… 42%")).toBeDefined();
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

/**
 * The status cell for a managed pack that is NOT simply installed.
 *
 * Both bugs here shared a shape: this table renders `managedInstallState`
 * itself instead of going through the shared readiness helpers, so it drifted
 * from every other surface that shows the same state.
 */
describe("ProviderCliCandidatesSection: managed install status cell", () => {
  it("never renders a bare percent sign when progress is unknown", () => {
    // `percent` is nullable and null is a REAL state: a queued pack has seen no
    // bytes, and a pack whose download a live sibling host owns is genuinely in
    // progress with no observable count on this side. The raw interpolation
    // rendered the literal "Installing… %".
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: { status: "downloading", percent: null },
    });
    renderSection(state);
    expect(screen.queryByText(/Installing… %/u)).toBeNull();
    expect(screen.queryByText(/null/u)).toBeNull();
    // ...and it still says something. Rendering nothing would be the other way
    // to pass the assertions above.
    expect(screen.getByText(/Installing…|Preparing…/u)).toBeDefined();
  });

  it("still shows the percent when one is known", () => {
    // The control: a guard that suppressed every percent would pass the test
    // above and silently remove working progress reporting.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [bundledCandidate({ available: false })],
      managedInstallState: { status: "downloading", percent: 42 },
    });
    renderSection(state);
    expect(screen.getByText(/42%/u)).toBeDefined();
  });

  it("names the reason for a failed pack instead of a bare 'Not installed'", () => {
    // The arm that did not exist. Everything that points a stuck user at this
    // screen - the picker tooltip, the host's own RPC error - assumed it would
    // be readable once they arrived; it rendered red "Not installed" with no
    // reason and no way forward.
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
    expect(screen.getByText(/Setup failed/u)).toBeDefined();
    // P2. The assertion this test's own name always claimed. "Setup failed" is
    // the status CELL, which has one truncating grid column and can never carry
    // more; for a year that was the whole of what this screen said, while the
    // test read as though the reason were covered. The reason is a row-level
    // notice now, and this is what fails if it goes away again.
    expect(screen.getByText(/not enough disk space/iu)).toBeDefined();
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
      expect(screen.getByText(/Setup failed/u)).toBeDefined();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    },
  );
});

/**
 * P2/P4. The branch that had no coverage, and could not have had any.
 *
 * This section used to construct its own `ProviderPackPreparing` with
 * `fallbackRunnable: false` written in at both render sites, so
 * `providerPackBlocksExecution` was true by construction on this screen. Every
 * test above passes `candidates: [bundledCandidate({ available: false })]` and
 * therefore agrees with the hardcode by accident - which is why the whole
 * fabrication survived review twice. Mutation probing cannot find a branch that
 * no fixture reaches; only a fixture that reaches it can.
 *
 * Every case here differs from its neighbour above in ONE way: a candidate that
 * actually runs. That is the entire input to the derivation.
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

  it("says the provider is ready rather than that setup failed", () => {
    // The user's Claude Code runs fine from PATH. "Setup failed" in front of
    // them is simply false, and on an offline first launch it was every
    // pin-carrying provider on the machine at once.
    renderSection(failedPackWithPathFallback());
    expect(screen.getByText(/Ready · managed install failed/u)).toBeDefined();
    expect(screen.queryByText(/^Setup failed$/u)).toBeNull();
  });

  it("still names the reason - a quiet failure is not a hidden one", () => {
    // The provider working does not make the failure uninteresting. It makes it
    // non-blocking, which is a different thing.
    renderSection(failedPackWithPathFallback());
    expect(screen.getByText(/could not be reached/iu)).toBeDefined();
  });

  it("does not paint the status cell as an error", () => {
    // The contradiction P4 is really about: red is a claim, and the sentence
    // inside the red was "Ready". Asserted on the class because that is what
    // the user sees - there is no accessible role or text that carries colour.
    renderSection(failedPackWithPathFallback());
    const cell = screen.getByText(/Ready · managed install failed/u);
    expect(cell.className).not.toMatch(/text-destructive/u);
  });

  it("keeps the blocking case red, so the assertion above is not vacuous", () => {
    // The other half of the same predicate. Without this, deleting the
    // conditional entirely would leave the test above green.
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
    expect(screen.getByText(/Setup failed/u).className).toMatch(
      /text-destructive/u,
    );
  });

  it("reports the download as non-blocking too, not only the failure", () => {
    // `fallbackRunnable` was fabricated at BOTH render sites. Fixing one and
    // leaving the other would still show "Preparing…" - a wait the user does
    // not have - on a provider they can use right now.
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      managedInstallState: { status: "downloading", percent: 40 },
    });
    renderSection(state);
    expect(screen.getByText(/Ready · installing… 40%/u)).toBeDefined();
  });

  it("treats an unsettled availability probe as runnable", () => {
    // `providerHasRunnableFallback` fails OPEN on `availabilityPending`: the
    // shell-env PATH probe has not landed, so `candidates` under-reports, while
    // the execute path awaits that same probe before deciding. Gating here
    // would dim a working provider for a poll tick. Reached only through the
    // derivation - the hardcode could never express it.
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
    expect(screen.getByText(/Ready · managed install failed/u)).toBeDefined();
  });
});

/**
 * W10. The closure-carve advisory - the only advisory kind a Phase-1 host
 * populates.
 *
 * For `pi` and `opencode` the resolver skips an auto-discovered PATH binary
 * unconditionally on execute, while observe intents resolve it happily. So the
 * provider looked available and selectable and the turn threw at send. The
 * user's way out (explicitly selecting the PATH row) already worked; nothing
 * told them it existed.
 */
describe("ProviderCliCandidatesSection: row-incompatibility advisory", () => {
  const DETAIL =
    "This provider is paired with the exact build Traycer ships (1.2.3), so a version found on your PATH is not used automatically. Select that path below to use it anyway.";

  it("renders the advisory the host sent, verbatim", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [
        bundledCandidate({ available: false }),
        pathCandidate({ available: true }),
      ],
      advisory: { kind: "row-incompatibility", detail: DETAIL },
    });
    renderSection(state);
    expect(screen.getByText(DETAIL)).toBeDefined();
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
  });

  it("ignores the dormant Phase-2 kinds rather than rendering a raw code", () => {
    const state = providerState({
      selected: { kind: "bundled" },
      candidates: [pathCandidate({ available: true })],
      advisory: { kind: "yank-rollback", detail: "some phase-2 detail" },
    });
    renderSection(state);
    expect(screen.queryByText("some phase-2 detail")).toBeNull();
  });
});
