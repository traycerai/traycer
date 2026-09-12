import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { assertSettingsSearchTargets } from "@/components/settings/__tests__/settings-search-targets";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import { setMobileApp } from "@/lib/mobile-app";
import {
  isStatusBarControlsAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";
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
import {
  AnalyticsEvent,
  sanitizeAnalyticsProperties,
  trackSettingChanged,
} from "@/lib/analytics";

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

/**
 * Two live limits on one provider, deliberately in two severity tiers: `5h` at
 * 22% of a 5-hour window is healthy, `wk` at 96% of a 7-day one is running low
 * (long windows warn at 95). A figure drawn from the wrong window is therefore
 * visible in its COLOUR as well as its width.
 */
function claudeReadyWithTwoLimits(): Extract<
  ProviderRateLimits,
  { provider: "claude-code" }
> {
  return {
    ...claudeReady(),
    sevenDay: {
      usedPercent: 96,
      resetsAt: NOW + 3 * 24 * 60 * 60 * 1000,
      durationMinutes: 7 * 24 * 60,
    },
  };
}

/**
 * The same two limits with the weekly one spent, so the list has to draw `100%`
 * - the widest reading `windowPercentValueText` can produce - beside a shorter
 * one.
 */
function claudeReadyWithExhaustedWeekly(): Extract<
  ProviderRateLimits,
  { provider: "claude-code" }
> {
  return {
    ...claudeReady(),
    sevenDay: {
      usedPercent: 100,
      resetsAt: NOW + 3 * 24 * 60 * 60 * 1000,
      durationMinutes: 7 * 24 * 60,
    },
  };
}

/** The same two limits with the 5-hour one already rolled over. */
function claudeReadyWithExpiredFiveHour(): Extract<
  ProviderRateLimits,
  { provider: "claude-code" }
> {
  const reading = claudeReadyWithTwoLimits();
  return {
    ...reading,
    fiveHour: { usedPercent: 22, resetsAt: NOW - 1000, durationMinutes: 300 },
  };
}

/**
 * A Claude reading carrying a MODEL-SCOPED window, whose key exists only in the
 * payload - the half `fixedProviderWindowKeys` cannot name.
 */
function claudeReadyWithModelWindow(): Extract<
  ProviderRateLimits,
  { provider: "claude-code" }
> {
  return {
    ...claudeReady(),
    modelScoped: [
      {
        displayName: "Fable",
        usedPercent: 57,
        resetsAt: NOW + 6 * 24 * 60 * 60 * 1000,
        durationMinutes: null,
      },
    ],
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

/** The checkbox list a provider's "Limits" row renders. */
function limitsGroup(providerLabel: string): HTMLElement {
  return screen.getByRole("group", { name: `${providerLabel} limits` });
}

/**
 * A limit entry by its LABEL. The figures beside a limit that has a reading
 * extend the box's accessible name rather than replacing it (`5h, 4% used`), so
 * every call site here names the label and nothing else.
 */
function limitCheckbox(providerLabel: string, name: string): HTMLElement {
  return within(limitsGroup(providerLabel)).getByRole("checkbox", {
    name: (accessibleName: string) =>
      accessibleName === name || accessibleName.startsWith(`${name},`),
  });
}

/** The entry labels a provider's list draws, in list order. */
function limitLabels(providerLabel: string): ReadonlyArray<string | null> {
  return within(limitsGroup(providerLabel))
    .getAllByTestId("settings-checkbox-list-label")
    .map((label) => label.textContent);
}

/** One entry's percent cell, whose reserved width is what aligns the gauges. */
function limitPercentCell(
  providerLabel: string,
  name: string,
): HTMLElement | null {
  return (
    limitCheckbox(providerLabel, name)
      .closest("label")
      ?.querySelector('[data-testid="layout-limit-percent"]') ?? null
  );
}

/** One entry's mini bar, or `null` for an entry drawing no figure. */
function limitBar(providerLabel: string, name: string): HTMLElement | null {
  return (
    limitCheckbox(providerLabel, name)
      .closest("label")
      ?.querySelector('[data-testid="status-bar-provider-mini-bar-fill"]') ??
    null
  );
}

const AUTOMATIC = "Tightest limit (automatic)";

/** A pick the current reading does not carry, so the list stands automatic in. */
const STALE_LIMIT_KEY = "codex:extra:retired-limit:primary";

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

  it("renders the groups in their fixed order, Presets first and Sidebar last", () => {
    // The order a control keeps as groups arrive: Presets, then Status bar,
    // then Tabs, then Composer, then Chat, then Sidebar. Asserted on the
    // rendered document rather than trusted to a JSX read, since each group is
    // now its own file mounted from one line here.
    render(<LayoutSettingsPanel />);

    const order = [
      "presets",
      "status-bar",
      "tabs",
      "composer",
      "chat",
      "sidebar",
    ].map((group) => screen.getByTestId(`layout-${group}-group`));

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

  it("keeps the header resource-monitor row under status-bar placement at a narrow viewport", () => {
    // A desktop build narrowed below `md` - a split screen, a dragged-in edge.
    // `AppShell` drops the strip there whatever the placement says and
    // `MobileAppHeader` keeps the resource monitor, so this row governs the
    // only monitor on screen and the group's own `Show resource monitor`
    // governs a strip that is not drawn. `useIsMobileViewport` reads
    // `window.innerWidth` directly (the global `matchMedia` shim always reports
    // `false`), so setting it before render is enough.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    try {
      useLayoutStore.setState({
        statusBar: { ...DEFAULT_STATUS_BAR_LAYOUT, placement: "status-bar" },
      });
      render(<LayoutSettingsPanel />);
      const monitor = screen.getByRole("switch", {
        name: "Show resource monitor in header",
      });

      fireEvent.click(monitor);

      expect(useSettingsStore.getState().showGlobalResourceMonitor).toBe(false);
      // The GROUP stays on the build, not the viewport: a temporarily narrow
      // window must not hide the placement setting.
      expect(screen.getByRole("button", { name: "Status bar" })).toBeTruthy();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1024,
      });
    }
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

  it("lists the automatic entry first, checked and held, then one unchecked entry per limit the provider reports", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    const boxes = within(limitsGroup("Codex")).getAllByRole("checkbox");
    expect(boxes.map((box) => box.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
    ]);
    expect(limitCheckbox("Codex", AUTOMATIC).hasAttribute("disabled")).toBe(
      true,
    );
    expect(limitCheckbox("Codex", "5h").hasAttribute("disabled")).toBe(false);
  });

  it("checks a limit into the provider's explicit picks and tracks the analytics id, and the box follows the store", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual(
      {},
    );

    fireEvent.click(limitCheckbox("Codex", "5h"));

    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
      codex: { automatic: true, limitKeys: ["codex:primary"] },
    });
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.statusBar.rateLimits.providerLimits",
    );
    expect(limitCheckbox("Codex", "5h").getAttribute("aria-checked")).toBe(
      "true",
    );

    fireEvent.click(limitCheckbox("Codex", "5h"));

    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
      codex: { automatic: true, limitKeys: [] },
    });
    expect(limitCheckbox("Codex", "5h").getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("unchecks automatic once an explicit pick is checked, tracking its own analytics id, and then holds that pick", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    fireEvent.click(limitCheckbox("Codex", "5h"));
    // Two checked: neither is held.
    expect(limitCheckbox("Codex", AUTOMATIC).hasAttribute("disabled")).toBe(
      false,
    );

    fireEvent.click(limitCheckbox("Codex", AUTOMATIC));

    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
      codex: { automatic: false, limitKeys: ["codex:primary"] },
    });
    expect(trackSettingChanged).toHaveBeenCalledWith(
      "layout",
      "layout.statusBar.rateLimits.providerAutomatic",
    );
    // The one checked entry left is held, so the provider always draws
    // something; the switch above is how it is hidden.
    expect(limitCheckbox("Codex", "5h").hasAttribute("disabled")).toBe(true);
    expect(limitCheckbox("Codex", AUTOMATIC).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("collapses a hidden provider's limits list, restores it when re-enabled, and never touches the selection", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    // Pick a limit first, so the selection is non-default going into the
    // provider toggle below - proving the provider switch never reaches it.
    fireEvent.click(limitCheckbox("Codex", "5h"));
    const selected = {
      codex: { automatic: true, limitKeys: ["codex:primary"] },
    };
    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual(
      selected,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
    ).toEqual(["codex"]);
    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual(
      selected,
    );
    expect(screen.queryByRole("group", { name: "Codex limits" })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
    ).toEqual([]);
    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual(
      selected,
    );
    expect(limitCheckbox("Codex", "5h").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("keeps a provider with no reading toggleable, listing only the automatic entry and saying why", () => {
    // Nothing in the shared cache for this provider: the page never fetches,
    // so "no envelope" is a routine state and not an error one. The automatic
    // entry needs no reading to exist, so the list still has its one row.
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = {};

    render(<LayoutSettingsPanel />);

    expect(
      screen.getByText(/listed here once the first reading arrives/),
    ).toBeTruthy();
    expect(within(limitsGroup("Codex")).getAllByRole("checkbox")).toHaveLength(
      1,
    );
    expect(limitCheckbox("Codex", AUTOMATIC).hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
    ).toEqual(["codex"]);
  });

  // The list is built from `providerWindowEntries` on the retained reading, not
  // from the fixed-key list, which is what lets a model-scoped limit - whose
  // identity is a `displayName` off the wire - be picked at all.
  it("lists a discovered model window by its catalog label and writes its catalog key", () => {
    mocks.providers = [configuredProvider("claude-code")];
    mocks.envelopes = {
      "claude-code": envelopeFor(claudeReadyWithModelWindow()),
    };

    render(<LayoutSettingsPanel />);

    // In list order, so this pins the catalog's ordering too.
    expect(limitLabels("Claude Code")).toEqual([AUTOMATIC, "5h", "Fable"]);

    fireEvent.click(limitCheckbox("Claude Code", "Fable"));

    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
      "claude-code": {
        automatic: true,
        limitKeys: ["claude-code:model:Fable"],
      },
    });
  });

  // ── each entry's own figure ───────────────────────────────────────────────

  it("draws one mini bar and percentage per limit, each filled and toned from its own window", () => {
    mocks.providers = [configuredProvider("claude-code")];
    mocks.envelopes = {
      "claude-code": envelopeFor(claudeReadyWithTwoLimits()),
    };

    render(<LayoutSettingsPanel />);

    const fiveHour = limitBar("Claude Code", "5h");
    const weekly = limitBar("Claude Code", "wk");
    expect(fiveHour?.style.width).toBe("22%");
    expect(weekly?.style.width).toBe("96%");
    // Two rows of one provider in two severity tiers: a bar drawn from the
    // provider's tightest window instead of its own would be amber twice.
    expect(fiveHour?.className).toContain("bg-blue-500");
    expect(weekly?.className).toContain("bg-amber-500");
    expect(within(limitsGroup("Claude Code")).getByText("22%")).toBeTruthy();
    // The figures are `aria-hidden`; the same reading reaches the box's name.
    expect(limitCheckbox("Claude Code", "5h")).toBe(
      within(limitsGroup("Claude Code")).getByRole("checkbox", {
        name: "5h, 22% used",
      }),
    );
  });

  it("reserves one percent-cell width across every row, wide enough for a 100% reading", () => {
    // `100%` is the widest reading there is, and its `%` advances wider than a
    // tabular digit - so a cell sized by digit count grows for that row alone
    // and shifts its gauge left of every other row's. Every row reserving the
    // same width is what makes the column a track.
    mocks.providers = [configuredProvider("claude-code")];
    mocks.envelopes = {
      "claude-code": envelopeFor(claudeReadyWithExhaustedWeekly()),
    };

    render(<LayoutSettingsPanel />);

    expect(limitPercentCell("Claude Code", "wk")?.textContent).toBe("100%");
    expect(limitPercentCell("Claude Code", "5h")?.textContent).toBe("22%");
    for (const entry of [AUTOMATIC, "5h", "wk"]) {
      expect(limitPercentCell("Claude Code", entry)?.className).toContain(
        "min-w-[5ch]",
      );
    }
  });

  it("shows the tightest limit's figure and short name on the automatic entry", () => {
    mocks.providers = [configuredProvider("claude-code")];
    mocks.envelopes = {
      "claude-code": envelopeFor(claudeReadyWithTwoLimits()),
    };

    render(<LayoutSettingsPanel />);

    // `wk` at 96% binds harder than `5h` at 22%, so that is what the entry is
    // reading - and it says which, because a bare percentage on this one row
    // would be the only figure in the list with nothing naming its limit.
    const automatic = limitCheckbox("Claude Code", AUTOMATIC);
    expect(automatic).toBe(
      within(limitsGroup("Claude Code")).getByRole("checkbox", {
        name: `${AUTOMATIC}, wk, 96% used`,
      }),
    );
    const row = automatic.closest("label");
    expect(
      row
        ?.querySelector('[data-testid="status-bar-provider-mini-bar"]')
        ?.getAttribute("data-window-key"),
    ).toBe("claude-code:sevenDay");
    expect(row?.textContent).toContain("wk");
  });

  it("gives a discovered model window its own figure, and reads it when it is the tightest", () => {
    mocks.providers = [configuredProvider("claude-code")];
    mocks.envelopes = {
      "claude-code": envelopeFor(claudeReadyWithModelWindow()),
    };

    render(<LayoutSettingsPanel />);

    expect(limitBar("Claude Code", "Fable")?.style.width).toBe("57%");
    const group = within(limitsGroup("Claude Code"));
    expect(
      group.getByRole("checkbox", { name: "Fable, 57% used" }),
    ).toBeTruthy();
    expect(
      group.getByRole("checkbox", { name: `${AUTOMATIC}, Fable, 57% used` }),
    ).toBeTruthy();
  });

  it("draws no figures at all for a provider with no reading", () => {
    // Nothing fetched, and this page never fetches - so the list is what it
    // always was, labels alone. A control does not show sample figures.
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = {};

    render(<LayoutSettingsPanel />);

    expect(
      limitsGroup("Codex").querySelectorAll(
        '[data-testid="status-bar-provider-mini-bar"]',
      ),
    ).toHaveLength(0);
    expect(
      limitCheckbox("Codex", AUTOMATIC).closest("label")?.textContent,
    ).toBe(AUTOMATIC);
  });

  it("keeps an expired window listed and checkable but draws no figure for it", () => {
    // Its reset instant has passed, so the strip has already dropped it
    // (`liveWindows`) and its percentage is spent usage. The row stays - the
    // pick has to survive the window's own cycle - and simply shows nothing.
    mocks.providers = [configuredProvider("claude-code")];
    mocks.envelopes = {
      "claude-code": envelopeFor(claudeReadyWithExpiredFiveHour()),
    };

    render(<LayoutSettingsPanel />);

    expect(limitLabels("Claude Code")).toEqual([AUTOMATIC, "5h", "wk"]);
    expect(limitBar("Claude Code", "5h")).toBeNull();
    expect(limitBar("Claude Code", "wk")?.style.width).toBe("96%");

    fireEvent.click(limitCheckbox("Claude Code", "5h"));

    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
      "claude-code": { automatic: true, limitKeys: ["claude-code:fiveHour"] },
    });
  });

  // The migrated `Show all limits` user opening Layout before any reading has
  // landed: the strip is drawing the tightest (`shownWindows` stands it in), so
  // the list has to say so rather than render nothing checked.
  it("shows automatic checked and held when none of the stored picks is in the current reading", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = {};
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: {
          ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
          providers: {
            codex: {
              automatic: false,
              limitKeys: ["codex:primary", "codex:secondary"],
            },
          },
        },
      },
    });

    render(<LayoutSettingsPanel />);

    expect(limitCheckbox("Codex", AUTOMATIC).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(limitCheckbox("Codex", AUTOMATIC).hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      screen.getByText(/The limits you picked come back with them/),
    ).toBeTruthy();
    // Rendering it checked must not write: the picks are still the stored
    // selection and return with the first reading.
    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
      codex: {
        automatic: false,
        limitKeys: ["codex:primary", "codex:secondary"],
      },
    });
  });

  // The forced -> unforced transition: a pick made while the automatic entry is
  // standing in must not lift the stand-in out from under itself, which would
  // hold (and blur) the box just clicked and silently uncheck automatic.
  it("writes automatic through with a pick made while it is standing in, holding nothing", async () => {
    const user = userEvent.setup();
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: {
          ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
          providers: {
            // A model-scoped pick whose model has been renamed: stored, and
            // absent from a reading that carries other windows.
            codex: { automatic: false, limitKeys: [STALE_LIMIT_KEY] },
          },
        },
      },
    });

    render(<LayoutSettingsPanel />);

    expect(limitCheckbox("Codex", AUTOMATIC).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(limitCheckbox("Codex", AUTOMATIC).hasAttribute("disabled")).toBe(
      true,
    );

    await user.click(limitCheckbox("Codex", "5h"));

    // The stale pick stays - it comes back with its own reading - and the
    // checked automatic the user was looking at is now the stored one.
    expect(useLayoutStore.getState().statusBar.rateLimits.providers).toEqual({
      codex: {
        automatic: true,
        limitKeys: [STALE_LIMIT_KEY, "codex:primary"],
      },
    });
    expect(document.activeElement).toBe(limitCheckbox("Codex", "5h"));
    expect(
      within(limitsGroup("Codex"))
        .getAllByRole("checkbox")
        .map((box) => box.hasAttribute("disabled")),
    ).toEqual([false, false]);
  });

  it("describes the limits group by its row description, so the rule that held an entry is announced", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    const describedBy = limitsGroup("Codex").getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain(
      "At least one stays checked",
    );
  });

  // A focused element that becomes `disabled` blurs to `<body>`. The rendered
  // count is what prevents it: the entry a click can reach is never the one
  // that is about to be held.
  it("keeps focus on the entry that was clicked, in both directions", async () => {
    const user = userEvent.setup();
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    await user.click(limitCheckbox("Codex", "5h"));
    expect(document.activeElement).toBe(limitCheckbox("Codex", "5h"));

    await user.click(limitCheckbox("Codex", AUTOMATIC));
    expect(document.activeElement).toBe(limitCheckbox("Codex", AUTOMATIC));
    expect(limitCheckbox("Codex", "5h").hasAttribute("disabled")).toBe(true);
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

    it("hides the pinned breakdown field chips while the pin switch is off and shows them once it is on", () => {
      render(<LayoutSettingsPanel />);
      const chatGroup = screen.getByTestId("layout-chat-group");

      expect(
        within(chatGroup).queryByRole("group", {
          name: "Pinned breakdown fields",
        }),
      ).toBeNull();

      fireEvent.click(
        within(chatGroup).getByRole("switch", {
          name: "Pin context breakdown",
        }),
      );

      const subgroup = within(chatGroup).getByTestId(
        "layout-chat-pinned-context-subgroup",
      );
      const chips = within(subgroup).getByRole("group", {
        name: "Pinned breakdown fields",
      });
      expect(
        within(chips)
          .getAllByRole("button")
          .map((chip) => chip.textContent),
      ).toEqual(["Used", "Fresh", "Cache read", "Cache write", "Output"]);
      for (const chip of within(chips).getAllByRole("button")) {
        expect(chip.getAttribute("aria-pressed")).toBe("true");
      }
    });

    it("writes the pinned breakdown fields from the chips and tracks the analytics id", () => {
      useSettingsStore.setState({ pinContextUsageBreakdown: true });
      render(<LayoutSettingsPanel />);
      const chips = screen.getByRole("group", {
        name: "Pinned breakdown fields",
      });

      fireEvent.click(within(chips).getByRole("button", { name: "Fresh" }));
      fireEvent.click(
        within(chips).getByRole("button", { name: "Cache write" }),
      );

      expect(useSettingsStore.getState().pinnedContextBreakdownFields).toEqual([
        "used",
        "cacheRead",
        "output",
      ]);
      expect(
        within(chips)
          .getByRole("button", { name: "Fresh" })
          .getAttribute("aria-pressed"),
      ).toBe("false");
      expect(trackSettingChanged).toHaveBeenCalledWith(
        "layout",
        "pinnedContextBreakdownFields",
      );
    });

    it("keeps the last selected field chip pressed and inert", () => {
      useSettingsStore.setState({
        pinContextUsageBreakdown: true,
        pinnedContextBreakdownFields: ["output"],
      });
      render(<LayoutSettingsPanel />);
      const chips = screen.getByRole("group", {
        name: "Pinned breakdown fields",
      });
      const output = within(chips).getByRole("button", { name: "Output" });

      expect(output.getAttribute("aria-disabled")).toBe("true");
      // The inert chip is not silent about why: a hint says what the floor is
      // and where the strip is hidden instead.
      expect(
        screen.getByText(
          "One field stays selected - use the switch above to hide the strip.",
        ),
      ).toBeTruthy();
      fireEvent.click(output);

      expect(useSettingsStore.getState().pinnedContextBreakdownFields).toEqual([
        "output",
      ]);
      expect(output.getAttribute("aria-pressed")).toBe("true");
      expect(
        within(chips)
          .getByRole("button", { name: "Used" })
          .getAttribute("aria-disabled"),
      ).toBe("false");
    });

    it("renders and writes 'Context indicator' in the Chat group, tracking the analytics id", () => {
      render(<LayoutSettingsPanel />);
      const chatGroup = screen.getByTestId("layout-chat-group");
      const control = within(chatGroup).getByRole("group", {
        name: "Context indicator",
      });

      expect(
        within(control)
          .getByRole("button", { name: "Text" })
          .getAttribute("aria-pressed"),
      ).toBe("true");

      fireEvent.click(within(control).getByRole("button", { name: "Ring" }));
      expect(useSettingsStore.getState().contextIndicatorStyle).toBe("ring");

      fireEvent.click(
        within(control).getByRole("button", { name: "Ring only" }),
      );
      expect(useSettingsStore.getState().contextIndicatorStyle).toBe(
        "ring-only",
      );
      expect(
        within(control)
          .getByRole("button", { name: "Ring only" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(trackSettingChanged).toHaveBeenCalledWith(
        "layout",
        "contextIndicatorStyle",
      );
    });

    it.each(["pinnedContextBreakdownFields", "contextIndicatorStyle"])(
      "accepts %s through the runtime analytics allowlist",
      (setting) => {
        expect(
          sanitizeAnalyticsProperties(AnalyticsEvent.SettingChanged, {
            source: "direct_ui",
            section: "layout",
            setting,
          }),
        ).toEqual({ source: "direct_ui", section: "layout", setting });
      },
    );

    it("keeps the Chat group's own order, with Fields inside the pin subgroup", () => {
      useSettingsStore.setState({ pinContextUsageBreakdown: true });
      render(<LayoutSettingsPanel />);
      const chatGroup = screen.getByTestId("layout-chat-group");
      const subgroup = within(chatGroup).getByTestId(
        "layout-chat-pinned-context-subgroup",
      );

      // The Fields row belongs to the switch that governs it - scoping the
      // query to the group alone would still pass if it escaped the subgroup.
      expect(
        within(subgroup).getByRole("group", {
          name: "Pinned breakdown fields",
        }),
      ).toBeTruthy();

      const order = [
        within(chatGroup).getByTestId("context-usage-preview-block"),
        subgroup,
        within(chatGroup).getByRole("group", { name: "Context indicator" }),
        within(chatGroup).getByRole("combobox", { name: "Minimap position" }),
      ];
      for (let index = 1; index < order.length; index += 1) {
        expect(
          order[index - 1].compareDocumentPosition(order[index]) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    });

    it("previews the context indicator at the top of the Chat group, following the controls under it", () => {
      render(<LayoutSettingsPanel />);
      const chatGroup = screen.getByTestId("layout-chat-group");
      const frame = within(chatGroup).getByTestId(
        "context-usage-preview-frame",
      );

      // The real chip, from the sample usage - so the destructive tone the
      // sample was chosen for is what a reader sees first.
      expect(within(frame).getByTestId("context-usage-chip").textContent).toBe(
        "5% context left",
      );

      fireEvent.click(
        within(
          within(chatGroup).getByRole("group", { name: "Context indicator" }),
        ).getByRole("button", { name: "Ring only" }),
      );
      expect(within(frame).getByTestId("context-usage-ring")).toBeTruthy();

      fireEvent.click(
        within(chatGroup).getByRole("switch", {
          name: "Pin context breakdown",
        }),
      );
      expect(
        within(frame).getByTestId("context-usage-pinned-strip"),
      ).toBeTruthy();

      const fieldChips = within(chatGroup).getByRole("group", {
        name: "Pinned breakdown fields",
      });
      fireEvent.click(
        within(fieldChips).getByRole("button", { name: "Cache write" }),
      );
      expect(within(frame).queryByText("Cache write")).toBeNull();

      // Back on through the same chip: the strip prints it again, in place.
      fireEvent.click(
        within(fieldChips).getByRole("button", { name: "Cache write" }),
      );
      expect(within(frame).getByText("Cache write")).toBeTruthy();

      // Unpinning returns the chip to the STYLE that was chosen, not to the
      // default the group started at.
      fireEvent.click(
        within(chatGroup).getByRole("switch", {
          name: "Pin context breakdown",
        }),
      );
      expect(
        within(frame).queryByTestId("context-usage-pinned-strip"),
      ).toBeNull();
      expect(within(frame).getByTestId("context-usage-ring")).toBeTruthy();
    });

    it("renders and writes 'Minimap position' in the Chat group", () => {
      render(<LayoutSettingsPanel />);
      const chatGroup = screen.getByTestId("layout-chat-group");

      expect(
        within(chatGroup).getByRole("combobox", { name: "Minimap position" }),
      ).toBeTruthy();
      choose("Minimap position", "Left");
      expect(useSettingsStore.getState().chatTurnMinimapSide).toBe("left");
    });

    it("renders 'Resource chips on sidebar rows' as metric chips in the Sidebar group and writes the list", () => {
      render(<LayoutSettingsPanel />);
      const sidebarGroup = screen.getByTestId("layout-sidebar-group");
      const chips = within(sidebarGroup).getByRole("group", {
        name: "Resource chips on sidebar rows",
      });
      const cpu = within(chips).getByRole("button", { name: "CPU" });
      const memory = within(chips).getByRole("button", { name: "Memory" });
      const processes = within(chips).getByRole("button", {
        name: "Processes",
      });

      // Off by default, exactly as the switch it replaces was.
      expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);
      expect(cpu.getAttribute("aria-pressed")).toBe("false");
      expect(memory.getAttribute("aria-pressed")).toBe("false");
      expect(processes.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(processes);
      fireEvent.click(cpu);
      // Chip order, not click order.
      expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
        "cpu",
        "processes",
      ]);
      expect(cpu.getAttribute("aria-pressed")).toBe("true");
      expect(memory.getAttribute("aria-pressed")).toBe("false");
      expect(processes.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(memory);
      expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([
        "cpu",
        "memory",
        "processes",
      ]);

      fireEvent.click(cpu);
      fireEvent.click(memory);
      fireEvent.click(processes);
      expect(useSettingsStore.getState().navigatorResourceMetrics).toEqual([]);
      expect(
        within(sidebarGroup).queryByRole("switch", {
          name: /resource chips/i,
        }),
      ).toBeNull();
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

  // Every anchored Layout entry the search index offers must land on exactly
  // one element in the shell that offers it, and on none where it is
  // withheld. The one gate on this page is the build: the footer controls
  // collapse in the installed mobile app, and an entry left always-available
  // while its row is gated fails the mobile case.
  describe("search targets", () => {
    it("matches the index on desktop", () => {
      const context: SettingsAvailabilityContext = {
        runnerHost: null,
        featureSettings: null,
        mobileApp: false,
      };
      expect(isStatusBarControlsAvailable(context)).toBe(true);
      const { container } = render(<LayoutSettingsPanel />);

      assertSettingsSearchTargets("layout", context, container);
    });

    it("matches the index in the installed mobile app", () => {
      setMobileApp(true);
      const context: SettingsAvailabilityContext = {
        runnerHost: null,
        featureSettings: null,
        mobileApp: true,
      };
      expect(isStatusBarControlsAvailable(context)).toBe(false);
      const { container } = render(<LayoutSettingsPanel />);

      assertSettingsSearchTargets("layout", context, container);
    });
  });

  // Its own group, not a row borrowed by the footer's: a tab is not part of
  // the status bar, and the status bar group collapses on a build where this
  // row still applies.
  describe("Tabs", () => {
    it("renders and writes 'Home tab' in the Tabs group, tracking the analytics id", () => {
      render(<LayoutSettingsPanel />);
      const tabsGroup = screen.getByTestId("layout-tabs-group");

      expect(useSettingsStore.getState().homeTabEnabled).toBe(false);
      const toggle = within(tabsGroup).getByRole("switch", {
        name: "Home tab",
      });
      expect(toggle.getAttribute("aria-checked")).toBe("false");

      fireEvent.click(toggle);

      expect(useSettingsStore.getState().homeTabEnabled).toBe(true);
      // The row moved off General with its key and its setting id; only the
      // section follows the page.
      expect(trackSettingChanged).toHaveBeenCalledWith(
        "layout",
        "homeTabEnabled",
      );
    });

    it("reflects a Home tab value already in the store", () => {
      useSettingsStore.setState({ homeTabEnabled: true });
      render(<LayoutSettingsPanel />);

      expect(
        screen
          .getByRole("switch", { name: "Home tab" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });

    // No `isMobileApp()` gate anywhere in this group: that build has no strip
    // but it does draw the Home tab, as the first entry in the nav drawer.
    it("renders whole in the installed mobile app, where the Status bar group collapses", () => {
      setMobileApp(true);
      render(<LayoutSettingsPanel />);

      expect(screen.getByText("Status bar is desktop-only")).toBeTruthy();
      const tabsGroup = screen.getByTestId("layout-tabs-group");

      fireEvent.click(
        within(tabsGroup).getByRole("switch", { name: "Home tab" }),
      );

      expect(useSettingsStore.getState().homeTabEnabled).toBe(true);
    });
  });
});
