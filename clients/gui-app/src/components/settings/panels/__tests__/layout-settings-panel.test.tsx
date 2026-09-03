import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    const actual = await importOriginal<
      typeof import("@/hooks/rate-limits/use-configured-rate-limit-providers")
    >();
    return {
      ...actual,
      useVisibleRateLimitProviders: () => mocks.providers,
    };
  },
);

vi.mock("@/hooks/rate-limits/use-rate-limit-profile-selection", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/rate-limits/use-rate-limit-profile-selection")
  >();
  return {
    ...actual,
    useRateLimitProfileSelection: () => ({
      activeChatSettings: null,
      lastProfileByHarness: {},
    }),
  };
});

interface RateLimitRequestParams {
  readonly providerId: string;
  readonly profileId: string | null;
}

function resultKey(providerId: string, profileId: string | null): string {
  return profileId === null ? providerId : `${providerId}:${profileId}`;
}

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueriesWithResponseMap: (args: {
    readonly requests: ReadonlyArray<{ readonly params: RateLimitRequestParams }>;
  }) =>
    args.requests.map((request) => ({
      data:
        mocks.envelopes[
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
    : { latest: rateLimits, lastGood: null, lastGoodAt: null, lastFailureAt: null };
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

describe("<LayoutSettingsPanel />", () => {
  it("writes the placement setting to the store via the segmented control", () => {
    render(<LayoutSettingsPanel />);

    expect(useLayoutStore.getState().statusBar.placement).toBe("header");

    fireEvent.click(screen.getByRole("button", { name: "Status bar" }));

    expect(useLayoutStore.getState().statusBar.placement).toBe("status-bar");
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

  it("renders provider rows in ORDERED_PROVIDERS order regardless of input order", () => {
    // Fed claude-code before codex; ORDERED_PROVIDERS ranks codex ahead of
    // claude-code, and the panel must sort rather than render input order.
    mocks.providers = [configuredProvider("claude-code"), configuredProvider("codex")];
    mocks.envelopes = {
      codex: envelopeFor(codexReady()),
      "claude-code": envelopeFor(claudeReady()),
    };

    render(<LayoutSettingsPanel />);

    const codexRow = screen.getByRole("switch", { name: "Codex" });
    const claudeRow = screen.getByRole("switch", { name: "Claude Code" });
    expect(
      codexRow.compareDocumentPosition(claudeRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("toggles a window's hidden state, updating hiddenWindowKeys", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
    ).toEqual([]);

    fireEvent.click(screen.getByRole("switch", { name: "Codex 5h" }));

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenWindowKeys,
    ).toEqual(["codex:primary"]);
  });

  it("collapses a hidden provider's window rows", () => {
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = { codex: envelopeFor(codexReady()) };

    render(<LayoutSettingsPanel />);

    expect(screen.getByRole("switch", { name: "Codex 5h" })).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
    ).toEqual(["codex"]);
    expect(screen.queryByRole("switch", { name: "Codex 5h" })).toBeNull();
  });

  it("keeps a provider with no reading toggleable, saying why it lists no windows", () => {
    // Nothing in the shared cache for this provider: the page never fetches,
    // so "no envelope" is a routine state and not an error one. The keys a
    // window toggle is written under are stable, so the row still works.
    mocks.providers = [configuredProvider("codex")];
    mocks.envelopes = {};

    render(<LayoutSettingsPanel />);

    expect(screen.getByText(/waiting for first reading/)).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Codex" }));

    expect(
      useLayoutStore.getState().statusBar.rateLimits.hiddenProviders,
    ).toEqual(["codex"]);
  });

  it("disables the RAM share switch while the resource scope is desktop-app", () => {
    render(<LayoutSettingsPanel />);

    const ramShare = () =>
      screen.getByRole("switch", { name: "RAM share of host" });
    expect(ramShare().hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Desktop app" }));

    expect(useLayoutStore.getState().statusBar.resources.scope).toBe(
      "desktop-app",
    );
    expect(ramShare().hasAttribute("disabled")).toBe(true);
  });

  it("shows only the desktop-only note in the installed mobile app", () => {
    setMobileApp(true);
    render(<LayoutSettingsPanel />);

    expect(screen.getByText("Status bar is desktop-only")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Placement" })).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Show rate limits" }),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Show resource monitor" }),
    ).toBeNull();

    // Other groups are unaffected - only the status bar surface is dropped.
    expect(
      screen.getByRole("switch", { name: "Pin context breakdown" }),
    ).toBeTruthy();
  });

  it("shows the unresolved-host notice and lists no providers for an unusable explicit pick", () => {
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
      expect(useSettingsStore.getState().showNavigatorResourceStats).toBe(
        true,
      );
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
      expect(useSettingsStore.getState().showGlobalResourceMonitor).toBe(
        false,
      );
    });
  });
});
