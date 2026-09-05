import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import { setMobileApp } from "@/lib/mobile-app";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

// The panel's own `trackLayoutSetting` calls straight into `trackSettingChanged`
// - mocked here (preserving every other export) so a round-trip test can
// assert the exact analytics id fired, the same seam the rest of this suite
// already uses for its other hook mocks.
vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    trackSettingChanged: vi.fn(),
  };
});

// ── module-level mock state ─────────────────────────────────────────────────

interface MockState {
  providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  envelopes: Record<string, ProviderRateLimitEnvelope>;
  // `null` only until the first `resetAll()` (every test's `beforeEach`)
  // assigns a real fixture - kept nullable here rather than cast, since
  // `hostScopeFixture` cannot be referenced from inside `vi.hoisted`'s
  // synchronous initializer (it runs before the module's own imports settle).
  scope: HostScope | null;
  hasExplicitPick: boolean;
}

const mocks = vi.hoisted<MockState>(() => ({
  providers: [],
  envelopes: {},
  scope: null,
  hasExplicitPick: false,
}));

// The panel depends on the SCOPE, not the six hooks it composes - the same
// boundary `rate-limit-icon.test.tsx` mocks at. `useScopedHostBinding` is left
// real: it is a pure function of the scope and the ambient binding.
vi.mock("@/hooks/rate-limits/use-rate-limit-host-scope", () => ({
  useRateLimitResolveHostScope: () => ({
    scope: mocks.scope ?? hostScopeFixture({}),
    hasExplicitPick: mocks.hasExplicitPick,
  }),
}));

vi.mock(
  "@/hooks/rate-limits/use-configured-rate-limit-providers",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-configured-rate-limit-providers")
      >();
    return {
      ...actual,
      useVisibleRateLimitProviders: () => mocks.providers,
    };
  },
);

vi.mock(
  "@/hooks/rate-limits/use-rate-limit-profile-selection",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-rate-limit-profile-selection")
      >();
    return {
      ...actual,
      useRateLimitProfileSelection: () => ({
        activeChatSettings: null,
        lastProfileByHarness: {},
      }),
    };
  },
);

interface RateLimitRequestParams {
  readonly providerId: string;
  readonly profileId: string | null;
}

function resultKey(providerId: string, profileId: string | null): string {
  return profileId === null ? providerId : `${providerId}:${profileId}`;
}

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueriesWithResponseMap: (args: {
    readonly requests: ReadonlyArray<{
      readonly params: RateLimitRequestParams;
    }>;
  }) =>
    args.requests.map((request) => ({
      data: mocks.envelopes[
        resultKey(request.params.providerId, request.params.profileId)
      ],
      isPending: false,
      isFetching: false,
      isError: false,
      dataUpdatedAt: 0,
      refetch: () => Promise.resolve({}),
    })),
}));

// `useHostClient` is never actually exercised: every real read behind it
// (`useVisibleRateLimitProviders`, `useHostQueriesWithResponseMap`) is mocked
// above, so this only needs to satisfy the hook's call site without throwing.
// `useHostBinding` and `HostRuntimeContext` stay real - `useScopedHostBinding`
// composes them directly and this suite wants its real null-binding behavior.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => null,
  };
});

import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import { trackSettingChanged } from "@/lib/analytics";

// ── fixtures ─────────────────────────────────────────────────────────────

const NO_PROFILES: ReadonlyArray<ProviderProfile> = [];

function configuredProvider(
  providerId: "codex" | "claude-code",
): ConfiguredRateLimitProvider {
  return {
    providerId,
    lane: "ephemeralProcess",
    profiles: NO_PROFILES,
    fetchEligibility: { ambient: true, managedProfiles: true },
  };
}

const NOW = Date.now();

function codexReady(): Extract<ProviderRateLimits, { provider: "codex" }> {
  return {
    provider: "codex",
    available: true,
    planType: "pro_5x",
    limitId: null,
    limitName: null,
    primary: {
      usedPercent: 4,
      resetsAt: NOW + 60 * 60 * 1000,
      durationMinutes: 300,
    },
    secondary: null,
    extraWindows: [],
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType: null,
  };
}

function claudeReady(): Extract<
  ProviderRateLimits,
  { provider: "claude-code" }
> {
  return {
    provider: "claude-code",
    available: true,
    subscriptionType: "max",
    fiveHour: {
      usedPercent: 22,
      resetsAt: NOW + 60 * 60 * 1000,
      durationMinutes: 300,
    },
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    modelScoped: [],
    extraUsage: null,
  };
}

function envelopeFor(
  rateLimits: ProviderRateLimits,
): ProviderRateLimitEnvelope {
  return rateLimits.available
    ? {
        latest: rateLimits,
        lastGood: rateLimits,
        lastGoodAt: NOW,
        lastFailureAt: null,
      }
    : {
        latest: rateLimits,
        lastGood: null,
        lastGoodAt: null,
        lastFailureAt: null,
      };
}

// ── setup / teardown ─────────────────────────────────────────────────────

function resetAll(): void {
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  window.localStorage.clear();
  mocks.providers = [];
  mocks.envelopes = {};
  mocks.scope = hostScopeFixture({});
  mocks.hasExplicitPick = false;
  setMobileApp(false);
  vi.mocked(trackSettingChanged).mockClear();
}

beforeEach(resetAll);
afterEach(() => {
  cleanup();
  resetAll();
});

/** Radix's select: open with the keyboard, then commit the named option. */
function choose(control: string, option: string): void {
  fireEvent.keyDown(screen.getByRole("combobox", { name: control }), {
    key: "ArrowDown",
  });
  const item = screen.getByRole("option", { name: option });
  fireEvent.focus(item);
  fireEvent.keyDown(item, { key: "Enter" });
}

/** The window-chip group a provider's "Limits" row renders. */
function windowsGroup(providerLabel: string): HTMLElement {
  return screen.getByRole("group", { name: `${providerLabel} limits` });
}

function metricsGroup(): HTMLElement {
  return screen.getByRole("group", { name: "Metrics" });
}

describe("<LayoutSettingsPanel />", () => {
  it("writes the placement setting to the store via the segmented control", () => {
    render(<LayoutSettingsPanel />);

    expect(useLayoutStore.getState().statusBar.placement).toBe("header");

    fireEvent.click(screen.getByRole("button", { name: "Status bar" }));

    expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
  });

  it("renders the groups in their fixed order, Status bar first and Sidebar last", () => {
    // The order a control keeps as groups arrive: Status bar, then Composer
    // when it has rows, then Chat, then Sidebar. Asserted on the rendered
    // document rather than trusted to a JSX read, since each group is now its
    // own file mounted from one line here.
    render(<LayoutSettingsPanel />);

    const order = ["status-bar", "chat", "sidebar"].map((group) =>
      screen.getByTestId(`layout-${group}-group`),
    );

    for (let index = 1; index < order.length; index += 1) {
      expect(
        order[index - 1].compareDocumentPosition(order[index]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("shows the header resource-monitor row only while placement is header", () => {
    render(<LayoutSettingsPanel />);

    expect(
      screen.getByRole("switch", { name: "Show resource monitor in header" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Status bar" }));

    expect(
      screen.queryByRole("switch", { name: "Show resource monitor in header" }),
    ).toBeNull();
  });

  it("renders provider subgroups in ORDERED_PROVIDERS order regardless of input order", () => {
    // Fed claude-code before codex; ORDERED_PROVIDERS ranks codex ahead of
    // claude-code, and the panel must sort rather than render input order.
    mocks.providers = [
      configuredProvider("claude-code"),
      configuredProvider("codex"),
    ];
    mocks.envelopes = {
      codex: envelopeFor(codexReady()),
      "claude-code": envelopeFor(claudeReady()),
    };

    render(<LayoutSettingsPanel />);

    const codexCard = screen.getByTestId("layout-provider-subgroup-codex");
    const claudeCard = screen.getByTestId(
      "layout-provider-subgroup-claude-code",
    );
    expect(
      codexCard.compareDocumentPosition(claudeCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("round-trips 'Show used / remaining label' to showModeWord and tracks the analytics id", () => {
    render(<LayoutSettingsPanel />);

    expect(useLayoutStore.getState().statusBar.rateLimits.showModeWord).toBe(
      true,
    );

    fireEvent.click(
      screen.getByRole("switch", { name: "Show used / remaining label" }),
    );

    expect(useLayoutStore.getState().statusBar.rateLimits.showModeWord).toBe(
      false,
    );
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.statusBar.rateLimits.showModeWord",
    );
  });

  it("round-trips a provider's 'show all limits' switch to expandedProviders and tracks the analytics id", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    expect(
      useLayoutStore.getState().statusBar.rateLimits.expandedProviders,
    ).toEqual([]);

    fireEvent.click(
      screen.getByRole("switch", { name: "Codex show all limits" }),
    );

    expect(
      useLayoutStore.getState().statusBar.rateLimits.expandedProviders,
    ).toEqual(["codex"]);
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.statusBar.rateLimits.expandedProvider",
    );
  });

  it("toggles a window chip's hidden state, writing hiddenWindowKeys and tracking the analytics id, and the chip's aria-pressed follows the store", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
    ).toEqual([]);

    const chip = within(windowsGroup("Codex")).getByRole("button", {
      name: "5h",
    });
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chip);

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
    ).toEqual(["codex:primary"]);
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.statusBar.rateLimits.window",
    );
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chip);

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
    ).toEqual([]);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });

  it("collapses a hidden provider's 'show all limits' row and limit chips, restores them when re-enabled, and never touches hiddenWindowKeys", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    // Hide a window first, so the deny-list is non-empty going into the
    // provider toggle below - proving the provider switch never reaches it.
    fireEvent.click(
      within(windowsGroup("Codex")).getByRole("button", { name: "5h" }),
    );
    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
    ).toEqual(["codex:primary"]);

    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
    ).toEqual(["codex"]);
    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
    ).toEqual(["codex:primary"]);
    expect(
      screen.queryByRole("switch", { name: "Codex show all limits" }),
    ).toBeNull();
    expect(screen.queryByRole("group", { name: "Codex limits" })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
    ).toEqual([]);
    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
    ).toEqual(["codex:primary"]);
    expect(
      screen.getByRole("switch", { name: "Codex show all limits" }),
    ).toBeTruthy();
    expect(windowsGroup("Codex")).toBeTruthy();
  });

  it("keeps a provider with no reading toggleable, saying why it lists no limits", () => {
    // Nothing in the shared cache for this provider: the page never fetches,
    // so "no envelope" is a routine state and not an error one. The keys a
    // window toggle is written under are stable, so the row still works.
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = {};

    render(<LayoutSettingsPanel />);

    expect(screen.getByText("Waiting for first reading")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Codex limits" })).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Codex show all limits" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
    ).toEqual(["codex"]);
  });

  it("turning off 'Show usage limits' collapses Display and every provider card, leaves Placement and Resource monitor mounted, and restores everything when turned back on", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    expect(screen.getByTestId("layout-usage-display-subgroup")).toBeTruthy();
    expect(screen.getByTestId("layout-provider-subgroup-codex")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Show usage limits" }));

    expect(useLayoutStore.getState().statusBar.rateLimits.enabled).toBe(false);
    expect(screen.queryByTestId("layout-usage-display-subgroup")).toBeNull();
    expect(screen.queryByTestId("layout-provider-subgroup-codex")).toBeNull();
    expect(screen.getByRole("group", { name: "Placement" })).toBeTruthy();
    expect(screen.getByTestId("layout-resource-monitor-subgroup")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Show usage limits" }));

    expect(useLayoutStore.getState().statusBar.rateLimits.enabled).toBe(true);
    expect(screen.getByTestId("layout-usage-display-subgroup")).toBeTruthy();
    expect(screen.getByTestId("layout-provider-subgroup-codex")).toBeTruthy();
  });

  it("turning off 'Show resource monitor' collapses the Scope row and the Metrics chips", () => {
    render(<LayoutSettingsPanel />);

    expect(screen.getByRole("group", { name: "Scope" })).toBeTruthy();
    expect(metricsGroup()).toBeTruthy();

    fireEvent.click(
      screen.getByRole("switch", { name: "Show resource monitor" }),
    );

    expect(useLayoutStore.getState().statusBar.resources.enabled).toBe(false);
    expect(screen.queryByRole("group", { name: "Scope" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Metrics" })).toBeNull();
  });

  it("round-trips a metric chip to resources.metrics and tracks the analytics id", () => {
    render(<LayoutSettingsPanel />);

    expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual([
      "cpu",
      "memory",
      "processes",
    ]);

    fireEvent.click(
      within(metricsGroup()).getByRole("button", { name: "CPU" }),
    );

    expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual([
      "memory",
      "processes",
    ]);
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.statusBar.resources.metric",
    );
  });

  it("disables the RAM share chip while the resource scope is desktop-app, no-ops its click, and shows the hint", () => {
    render(<LayoutSettingsPanel />);

    const ramShare = () =>
      within(metricsGroup()).getByRole("button", { name: "RAM share" });
    expect(ramShare().getAttribute("aria-disabled")).toBe("false");
    expect(
      screen.queryByText("RAM share is only available for the host scope."),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Desktop app" }));

    expect(useLayoutStore.getState().statusBar.resources.scope).toBe(
      "desktop-app",
    );
    expect(ramShare().getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("RAM share is only available for the host scope."),
    ).toBeTruthy();

    const before = useLayoutStore.getState().statusBar.resources.metrics;
    fireEvent.click(ramShare());
    expect(useLayoutStore.getState().statusBar.resources.metrics).toEqual(
      before,
    );
  });

  it("collapses the status bar group to the note and the header resource-monitor row in the installed mobile app, with no preview", () => {
    setMobileApp(true);
    render(<LayoutSettingsPanel />);

    expect(screen.getByText("Status bar is desktop-only")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Placement" })).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Show usage limits" }),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Show resource monitor" }),
    ).toBeNull();
    expect(screen.queryByTestId("status-bar-preview-frame")).toBeNull();

    // Other groups are unaffected - only the status bar surface is dropped.
    expect(
      screen.getByRole("switch", { name: "Pin context breakdown" }),
    ).toBeTruthy();
  });

  it("keeps the header resource-monitor switch reachable in the installed mobile app", () => {
    setMobileApp(true);
    useSettingsStore.setState({ showGlobalResourceMonitor: true });
    render(<LayoutSettingsPanel />);

    // `MobileAppHeader` draws that monitor, and the store key is device-local -
    // so if this row collapsed with the footer controls the preference would be
    // stuck at its default on the phone. It carries no placement condition
    // here: there is no other placement on that build.
    const monitor = screen.getByRole("switch", {
      name: "Show resource monitor in header",
    });

    fireEvent.click(monitor);

    expect(useSettingsStore.getState().showGlobalResourceMonitor).toBe(false);
  });

  it("shows the unresolved-host notice, lists no providers, and renders no preview for an unusable explicit pick", () => {
    mocks.hasExplicitPick = true;
    mocks.scope = hostScopeFixture({
      status: "unreachable",
      isViewingActive: false,
      hostLabel: "Other Machine",
    });
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    expect(
      screen.getByText(/Can't reach Other Machine right now/),
    ).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Codex" })).toBeNull();
    expect(screen.queryByTestId("status-bar-preview-frame")).toBeNull();
  });

  describe("relocated rows", () => {
    it("renders and writes 'Pin context breakdown' in the Chat group", () => {
      render(<LayoutSettingsPanel />);
      const chatGroup = screen.getByTestId("layout-chat-group");

      expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(false);
      fireEvent.click(
        within(chatGroup).getByRole("switch", {
          name: "Pin context breakdown",
        }),
      );
      expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(true);
    });

    it("renders and writes 'Minimap side' in the Chat group", () => {
      render(<LayoutSettingsPanel />);
      const chatGroup = screen.getByTestId("layout-chat-group");

      expect(
        within(chatGroup).getByRole("combobox", { name: "Minimap side" }),
      ).toBeTruthy();
      choose("Minimap side", "Left");
      expect(useSettingsStore.getState().chatTurnMinimapSide).toBe("left");
    });

    it("renders and writes 'Show resource chips on sidebar rows' in the Sidebar group", () => {
      render(<LayoutSettingsPanel />);
      const sidebarGroup = screen.getByTestId("layout-sidebar-group");

      expect(useSettingsStore.getState().showNavigatorResourceStats).toBe(
        false,
      );
      fireEvent.click(
        within(sidebarGroup).getByRole("switch", {
          name: "Show resource chips on sidebar rows",
        }),
      );
      expect(useSettingsStore.getState().showNavigatorResourceStats).toBe(true);
    });

    it("renders and writes 'Show resource monitor in header' in the Status bar group", () => {
      render(<LayoutSettingsPanel />);
      const statusBarGroup = screen.getByTestId("layout-status-bar-group");

      expect(useSettingsStore.getState().showGlobalResourceMonitor).toBe(true);
      fireEvent.click(
        within(statusBarGroup).getByRole("switch", {
          name: "Show resource monitor in header",
        }),
      );
      expect(useSettingsStore.getState().showGlobalResourceMonitor).toBe(false);
    });
  });
});
