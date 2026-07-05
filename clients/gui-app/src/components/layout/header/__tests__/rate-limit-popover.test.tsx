import "../../../../../__tests__/test-browser-apis";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { useAccountContextStore } from "@/stores/auth/account-context-store";

type QueryResult = {
  data: { providerRateLimits: ProviderRateLimits | null } | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
};

type MockAuthUser = {
  data: AuthenticatedUser | null;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: Mock<(...args: unknown[]) => Promise<unknown>>;
};

type MockState = {
  configured: ReadonlyArray<{ providerId: string; lane: string }>;
  results: Record<string, QueryResult>;
  draining: boolean;
  openSettings: Mock<(...args: unknown[]) => void>;
  enqueue: Mock<(...args: unknown[]) => Promise<void>>;
  authUser: MockAuthUser;
  // Last `options` object `RateLimitRefreshAllButton` passed to
  // `useHostQueries`, so a test can assert it reused the real lane options
  // (e.g. `retry: false`) instead of dropping them.
  lastUseHostQueriesOptions: { retry: boolean | undefined } | null;
  // Provider ids of the last `requests` batch passed to `useHostQueries`, so
  // a test can assert the button subscribes to EVERY configured httpFetch
  // provider's query state, not just the first.
  lastUseHostQueriesProviderIds: ReadonlyArray<string> | null;
};

function coldAuthUser(): MockAuthUser {
  return {
    data: null,
    isPending: false,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 0,
    refetch: vi.fn(() => Promise.resolve({})),
  };
}

const mocks = vi.hoisted<MockState>(() => ({
  configured: [],
  results: {},
  draining: false,
  openSettings: vi.fn(),
  enqueue: vi.fn((..._args: unknown[]) => Promise.resolve()),
  lastUseHostQueriesOptions: null,
  lastUseHostQueriesProviderIds: null,
  authUser: {
    data: null,
    isPending: false,
    isError: false,
    isFetching: false,
    dataUpdatedAt: 0,
    refetch: vi.fn(() => Promise.resolve({})),
  },
}));

vi.mock("@/hooks/rate-limits/use-configured-rate-limit-providers", () => ({
  useConfiguredRateLimitProviders: () => mocks.configured,
}));
vi.mock("@/hooks/rate-limits/use-is-rate-limit-queue-draining", () => ({
  useIsRateLimitQueueDraining: () => mocks.draining,
}));
vi.mock("@/hooks/host/use-host-provider-rate-limits-query", () => ({
  useHostProviderRateLimitsQuery: (providerId: string) =>
    mocks.results[providerId] ?? readyResult(null),
}));
// `RateLimitRefreshAllButton` reads each configured httpFetch provider's
// query state directly (to fold its `isFetching` into the button's own
// spinner) via the same fixture map every other mocked query hook here uses.
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: (args: {
    requests: ReadonlyArray<{ params: { providerId: string } }>;
    options: { retry: boolean | undefined } | null;
  }) => {
    mocks.lastUseHostQueriesOptions = args.options;
    mocks.lastUseHostQueriesProviderIds = args.requests.map(
      (request) => request.params.providerId,
    );
    return args.requests.map(
      (request) =>
        mocks.results[request.params.providerId] ?? readyResult(null),
    );
  },
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});
vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));
vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  // Wrapper (not `mocks.enqueue` directly) so `beforeEach` can swap the spy -
  // an object-literal binding would freeze the original fn at module load.
  enqueueRateLimitFetch: (...args: unknown[]) => mocks.enqueue(...args),
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
}));
// The Traycer tab reads the signed-in user's subscription (AuthService), not a
// host RPC. Default is a signed-out/cold user -> no Traycer tab, so the
// host-RPC-provider tests below behave exactly as before.
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => mocks.authUser,
}));
// The aperture usage query + its turn-refresh only mount inside the shared
// RateLimitView (rate-limit-based Traycer plans). Stub them so no real host
// query fires; the Traycer tests below use a credit-based plan anyway.
vi.mock("@/hooks/host/use-host-rate-limit-usage-query", () => ({
  useHostRateLimitUsageQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/host/use-refresh-rate-limit-usage-on-traycer-turn", () => ({
  useRefreshRateLimitUsageOnTraycerTurn: () => {},
}));

import { RateLimitPopover } from "@/components/layout/header/rate-limit-popover";

const NOW = Date.now();

function readyResult(
  providerRateLimits: ProviderRateLimits | null,
): QueryResult {
  return {
    data: { providerRateLimits },
    isPending: false,
    isFetching: false,
    isError: false,
    dataUpdatedAt: NOW - 90_000,
    refetch: vi.fn(() => Promise.resolve({})),
  };
}

function claudeReady(): ProviderRateLimits {
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

function codexReady(): ProviderRateLimits {
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

const EPOCH = new Date(0);

function baseSubscription() {
  return {
    id: "sub",
    userID: "u1",
    orgID: null,
    teamID: null,
    customerId: "cus",
    createdAt: EPOCH,
    updatedAt: EPOCH,
    subscriptionExpiry: null,
    trialEndsAt: null,
    hasPaymentMethod: true,
    rechargeRateSeconds: 60,
  };
}

function authUserFixture(overrides: {
  status: "PRO_V3" | "FREE";
  withTeam: boolean;
}): AuthenticatedUser {
  return {
    user: {
      id: "u1",
      name: "Ada",
      providerId: "p1",
      providerHandle: "ada",
      providerType: "GITHUB",
      email: "ada@example.com",
      avatarUrl: null,
      activatedAt: EPOCH,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      lastSeenAt: EPOCH,
      privacyMode: false,
      isLearningEnabled: true,
    },
    userSubscription: {
      ...baseSubscription(),
      subscriptionStatus: overrides.status,
      isInTrial: false,
      totalPlanCredits: 100,
      credit: {
        id: "c1",
        userId: "u1",
        customerId: "cus",
        bonusCredits: 0,
        consumedFromPlan: 30,
        consumedFromBonus: 0,
        lastResetAt: EPOCH,
      },
    },
    payAsYouGoUsage: { allowPayAsYouGo: false },
    teamSubscriptions: overrides.withTeam
      ? [
          {
            ...baseSubscription(),
            teamID: "team-1",
            subscriptionStatus: "ULTRA_1X_V3",
            isInTrial: false,
            totalPlanCredits: 500,
            hasActiveBundle: false,
            bundleSummary: {
              bundleTotal: 0,
              bundleConsumed: 0,
              bundleRemaining: 0,
            },
            credit: {
              id: "c2",
              userId: "u1",
              customerId: "cus",
              orgId: "team-1",
              bonusCredits: 0,
              consumedFromPlan: 100,
              consumedFromBonus: 0,
              lastResetAt: EPOCH,
            },
            team: {
              id: "team-1",
              slug: "acme",
              avatarUrl: null,
              privacyMode: false,
              createdAt: EPOCH,
              updatedAt: EPOCH,
            },
          },
        ]
      : [],
  };
}

function readyAuthUser(data: AuthenticatedUser): MockAuthUser {
  return {
    data,
    isPending: false,
    isError: false,
    isFetching: false,
    dataUpdatedAt: NOW - 60_000,
    refetch: vi.fn(() => Promise.resolve({})),
  };
}

let onClose: () => void;

function renderPopover() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Popover open>
          <PopoverTrigger>trigger</PopoverTrigger>
          <RateLimitPopover onClose={onClose} />
        </Popover>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.configured = [];
  mocks.results = {};
  mocks.draining = false;
  mocks.openSettings = vi.fn();
  mocks.enqueue = vi.fn((..._args: unknown[]) => Promise.resolve());
  mocks.lastUseHostQueriesOptions = null;
  mocks.lastUseHostQueriesProviderIds = null;
  mocks.authUser = coldAuthUser();
  useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
  onClose = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("<RateLimitPopover /> zero-provider state", () => {
  it("shows a single CTA with no rail when nothing is configured", () => {
    mocks.configured = [];
    renderPopover();
    expect(
      screen.getByText("Connect Claude Code or Codex to see usage here."),
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("opens provider settings and closes the popover from the CTA", () => {
    mocks.configured = [];
    renderPopover();
    fireEvent.click(
      screen.getByRole("button", { name: "Open provider settings" }),
    );
    expect(mocks.openSettings).toHaveBeenCalledWith({
      section: "providers",
      resetToGeneral: false,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("<RateLimitPopover /> rail", () => {
  it("pins Overview first, then one tab per provider in app order", () => {
    // Passed out of order; the rail must sort to codex, claude-code, ...
    mocks.configured = [
      { providerId: "kilocode", lane: "httpFetch" },
      { providerId: "codex", lane: "ephemeralProcess" },
    ];
    mocks.results = {
      codex: readyResult(codexReady()),
      kilocode: readyResult({
        provider: "kilocode",
        available: true,
        creditBalance: 5,
        passState: null,
      }),
    };
    renderPopover();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Overview",
      "Codex",
      "Kilo Code",
    ]);
  });

  it("lands on Overview, stacking every provider's condensed block", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "claude-code", lane: "ephemeralProcess" },
    ];
    mocks.results = {
      codex: readyResult(codexReady()),
      "claude-code": readyResult(claudeReady()),
    };
    renderPopover();
    // Both provider blocks render their header name (rail buttons are icon-only).
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    // Popover variant renders "% used" copy (codex primary 4% used, claude
    // fiveHour 22% used - both windows are the 5-hour session window, so the
    // bare "Current session" label renders once per provider).
    expect(screen.getAllByText("Current session")).toHaveLength(2);
    expect(screen.getByText("4% used")).toBeTruthy();
    expect(screen.getByText("22% used")).toBeTruthy();
    // Overview is condensed: the plan/tier label ("Pro 5x") is detail-only.
    expect(screen.queryByText("Pro 5x")).toBeNull();
  });

  it("draws a divider only between consecutive condensed blocks (no header row)", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "claude-code", lane: "ephemeralProcess" },
    ];
    mocks.results = {
      codex: readyResult(codexReady()),
      "claude-code": readyResult(claudeReady()),
    };
    renderPopover();
    // Fixup C #4: the "All providers" header (and its divider) is gone; only the
    // between-block dividers remain: 2 providers -> 1 divider. PopoverContent
    // portals to body.
    expect(document.querySelectorAll('[class*="bg-border/70"]').length).toBe(1);
  });

  it("switches to a single provider detail (with plan label) on tab click", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = { codex: readyResult(codexReady()) };
    renderPopover();
    // Overview is condensed, so the plan label isn't shown there...
    expect(screen.queryByText("Pro 5x")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByText("Codex")).toBeTruthy();
    // ...but the single-provider detail tab surfaces it.
    expect(screen.getByText("Pro 5x")).toBeTruthy();
  });

  it("shows a relative countdown for a short window and an absolute date for a weekly one", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = {
      codex: readyResult({
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
        secondary: {
          usedPercent: 40,
          resetsAt: NOW + 3 * 24 * 60 * 60 * 1000,
          durationMinutes: 10080,
        },
        extraWindows: [],
        credits: null,
        individualLimit: null,
        resetCredits: null,
        rateLimitReachedType: null,
      }),
    };
    renderPopover();
    // Fixup C #1: 5h primary -> relative countdown; weekly secondary -> absolute
    // weekday-tagged time. Both split the same way as the Settings card.
    expect(screen.getByText(/^Resets in /)).toBeTruthy();
    expect(
      screen.getByText(/^Resets [A-Za-z]{3} \d{1,2}:\d{2}\s?[AP]M$/i),
    ).toBeTruthy();
  });
});

function coldResult(): QueryResult {
  return {
    data: undefined,
    isPending: true,
    isFetching: true,
    isError: false,
    dataUpdatedAt: 0,
    refetch: vi.fn(() => Promise.resolve({})),
  };
}

describe("<RateLimitPopover /> Overview progressive reveal", () => {
  function popoverElement() {
    return (
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <Popover open>
            <PopoverTrigger>trigger</PopoverTrigger>
            <RateLimitPopover onClose={onClose} />
          </Popover>
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  it("shows one centered loading indicator, no per-provider sections, while nothing has resolved yet", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "claude-code", lane: "ephemeralProcess" },
    ];
    mocks.results = { codex: coldResult(), "claude-code": coldResult() };
    renderPopover();

    expect(screen.getByText("Fetching usage limits")).toBeTruthy();
    // Neither provider's own reading is visible yet - only the combined loader.
    expect(screen.queryByText("Current session")).toBeNull();
    expect(screen.queryByText("4% used")).toBeNull();
  });

  it("reveals a provider in place as it resolves, hiding still-cold siblings, and drops the combined loader", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "claude-code", lane: "ephemeralProcess" },
    ];
    mocks.results = { codex: coldResult(), "claude-code": coldResult() };
    const { rerender } = renderPopover();

    // Codex resolves first; Claude Code is still in flight.
    mocks.results = {
      codex: readyResult(codexReady()),
      "claude-code": coldResult(),
    };
    rerender(popoverElement());

    // The combined loader is gone now that one provider has data...
    expect(screen.queryByText("Fetching usage limits")).toBeNull();
    // ...Codex's own section is visible...
    expect(
      screen.getByText("Codex").closest('[class*="gap-4"]')?.className,
    ).not.toContain("hidden");
    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByText("4% used")).toBeTruthy();
    // ...but Claude Code's still-cold section is hidden, not painted as its
    // own blank/loading block.
    expect(
      screen.getByText("Claude Code").closest('[class*="gap-4"]')?.className,
    ).toContain("hidden");

    // Claude Code resolves next - both sections are now visible.
    mocks.results = {
      codex: readyResult(codexReady()),
      "claude-code": readyResult(claudeReady()),
    };
    rerender(popoverElement());
    expect(
      screen.getByText("Claude Code").closest('[class*="gap-4"]')?.className,
    ).not.toContain("hidden");
  });
});

describe("<RateLimitPopover /> per-provider states", () => {
  it("shows skeleton bars (not a spinner) on cold load", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = {
      codex: {
        data: undefined,
        isPending: true,
        isFetching: true,
        isError: false,
        dataUpdatedAt: 0,
        refetch: vi.fn(() => Promise.resolve({})),
      },
    };
    renderPopover();
    const skeleton = screen.getByTestId("rate-limit-detail-skeleton");
    expect(skeleton).toBeTruthy();
    // Regression: several dark theme presets set `--muted` equal to
    // `--popover`, so a plain `bg-muted` skeleton block is the same color as
    // the popover background and reads as an empty section, not a loading
    // one. Each block overrides that with `bg-foreground/15`, which contrasts
    // against any background without needing a border.
    const blocks = skeleton.querySelectorAll('[data-slot="skeleton"]');
    expect(blocks.length).toBeGreaterThan(0);
    blocks.forEach((block) => {
      expect(block.className).toContain("bg-foreground/15");
    });
  });

  it("dims stale content and notes a failed refresh when degraded", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = {
      codex: {
        ...readyResult(codexReady()),
        isError: true,
      },
    };
    renderPopover();
    expect(screen.getByText(/· refresh failed/)).toBeTruthy();
    // PopoverContent portals to document.body, outside the render container.
    expect(document.querySelectorAll(".opacity-60").length).toBeGreaterThan(0);
  });

  it("shows Refreshing instead of an updated timestamp while a refresh is in progress", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = { codex: readyResult(codexReady()) };
    mocks.draining = true;
    renderPopover();

    const label = screen.getByText("Refreshing");
    expect(label).toBeTruthy();
    expect(label.className).toContain("working-text-shimmer");
    expect(screen.getByTestId("usage-limit-refreshing-dots")).toBeTruthy();
    expect(screen.queryByText(/^Updated /)).toBeNull();
  });

  it("shows a plain error message with no inline retry control when a fetch never succeeded", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = {
      codex: {
        data: undefined,
        isPending: false,
        isFetching: false,
        isError: true,
        dataUpdatedAt: 0,
        refetch: vi.fn(() => Promise.resolve({})),
      },
    };
    renderPopover();
    expect(
      screen.getByText("Couldn't load usage limits right now."),
    ).toBeTruthy();
    // No separate "Retry" link - the header's own refresh icon already covers
    // it (feedback: "we already have a reload button"). That icon is
    // detail-tab-only (Overview relies on "Refresh all"), so switch there first.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Codex" }));
    // Codex is ephemeralProcess -> the header's refresh routes through the
    // serial queue, same as retrying used to.
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "codex",
      { type: "PERSONAL" },
      { force: true },
    );
  });

  it("maps an available:false reason to a plain-language message", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = {
      codex: readyResult({
        provider: "codex",
        available: false,
        reason: "cli_not_found",
      }),
    };
    renderPopover();
    expect(
      screen.getByText("Usage limits unavailable — the CLI isn't installed"),
    ).toBeTruthy();
  });
});

describe("<RateLimitPopover /> Refresh all", () => {
  it("is disabled while the queue is draining", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = { codex: readyResult(codexReady()) };
    mocks.draining = true;
    renderPopover();
    const refreshAll = screen.getByRole("button", { name: "Refresh all" });
    expect((refreshAll as HTMLButtonElement).disabled).toBe(true);
  });

  it("is disabled while an httpFetch provider is fetching, even though the ephemeralProcess queue isn't draining", () => {
    // Regression: "Refresh all" used to read only the ephemeralProcess queue's
    // draining flag, so an all-httpFetch popover (or one mid-invalidation on
    // just its httpFetch providers) never visibly spun despite actively
    // refreshing.
    mocks.configured = [{ providerId: "kilocode", lane: "httpFetch" }];
    mocks.results = {
      kilocode: {
        ...readyResult({
          provider: "kilocode",
          available: true,
          creditBalance: 9,
          passState: null,
        }),
        isFetching: true,
      },
    };
    mocks.draining = false;
    renderPopover();
    const refreshAll = screen.getByRole("button", { name: "Refresh all" });
    expect((refreshAll as HTMLButtonElement).disabled).toBe(true);
  });

  it("passes the httpFetch lane's real query options (e.g. retry: false) to useHostQueries for every configured httpFetch provider", () => {
    // Regression 1: an earlier version passed `options: null`, so this batch
    // of queries silently inherited the global QueryClient's default retry
    // policy for the exact same query key `RateLimitProviderBlock`'s own
    // `useHostProviderRateLimitsQuery` deliberately sets `retry: false` for.
    // Regression 2 (review feedback): both httpFetch providers are configured
    // here - not just one - because production derives the shared options from
    // `httpFetchProviders[0]` (safe today: `providerRateLimitQueryOptions`
    // branches on lane, never provider id, so all httpFetch options are
    // identical) and must still subscribe to EVERY provider's query state.
    // Passed in non-canonical order to exercise the sort in front of `[0]`.
    mocks.configured = [
      { providerId: "kilocode", lane: "httpFetch" },
      { providerId: "openrouter", lane: "httpFetch" },
    ];
    mocks.results = {
      kilocode: readyResult({
        provider: "kilocode",
        available: true,
        creditBalance: 9,
        passState: null,
      }),
      openrouter: readyResult({
        provider: "openrouter",
        available: true,
        limit: 100,
        limitRemaining: 40,
        dailySpend: 5,
        weeklySpend: 12,
        monthlySpend: 30,
        totalCredits: 100,
        totalUsage: 60,
        balance: 40,
      }),
    };
    renderPopover();
    expect(mocks.lastUseHostQueriesOptions?.retry).toBe(false);
    expect([...(mocks.lastUseHostQueriesProviderIds ?? [])].sort()).toEqual([
      "kilocode",
      "openrouter",
    ]);
  });

  it("keeps a single ephemeralProcess provider's own refresh button disabled while the queue is draining, even though its own isFetching has already settled", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = { codex: readyResult(codexReady()) };
    mocks.draining = true;
    renderPopover();
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    const refreshCodex = screen.getByRole("button", { name: "Refresh Codex" });
    expect((refreshCodex as HTMLButtonElement).disabled).toBe(true);
  });

  it("enqueues each ephemeralProcess provider with force:true", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "claude-code", lane: "ephemeralProcess" },
    ];
    mocks.results = {
      codex: readyResult(codexReady()),
      "claude-code": readyResult(claudeReady()),
    };
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "codex",
      { type: "PERSONAL" },
      { force: true },
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "claude-code",
      { type: "PERSONAL" },
      { force: true },
    );
  });
});

describe("<RateLimitPopover /> rail settings", () => {
  it("opens provider settings and closes the popover from the rail settings icon", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = { codex: readyResult(codexReady()) };
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Provider settings" }));
    expect(mocks.openSettings).toHaveBeenCalledWith({
      section: "providers",
      resetToGeneral: false,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("<RateLimitPopover /> per-provider refresh", () => {
  it("routes an httpFetch provider's refresh through refetch, not the queue", () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    mocks.configured = [{ providerId: "kilocode", lane: "httpFetch" }];
    mocks.results = {
      kilocode: {
        ...readyResult({
          provider: "kilocode",
          available: true,
          creditBalance: 9,
          passState: null,
        }),
        refetch,
      },
    };
    renderPopover();
    // The per-provider refresh only lives in the single-provider detail tab now
    // (item 2 feedback: Overview keeps only the rail's "Refresh all").
    fireEvent.click(screen.getByRole("tab", { name: "Kilo Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Kilo Code" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

// Guards that a stacked Overview keeps each provider's block scoped, and that
// it has no per-provider refresh controls (item 2 feedback: only the rail's
// "Refresh all" - the single-provider detail tab keeps its own).
describe("<RateLimitPopover /> Overview block scoping", () => {
  it("shows no per-provider refresh controls on Overview, only Refresh all", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "claude-code", lane: "ephemeralProcess" },
    ];
    mocks.results = {
      codex: readyResult(codexReady()),
      "claude-code": readyResult(claudeReady()),
    };
    renderPopover();
    expect(screen.queryByRole("button", { name: "Refresh Codex" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Refresh Claude Code" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh all" })).toBeTruthy();
    // Rail buttons are icon-only, so each provider name appears exactly once -
    // in its own block header, confirming the blocks are stacked (not merged).
    expect(screen.getAllByText("Codex").length).toBe(1);
  });

  it("keeps the per-provider refresh control in the single-provider detail tab", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = { codex: readyResult(codexReady()) };
    renderPopover();
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByRole("button", { name: "Refresh Codex" })).toBeTruthy();
  });
});

describe("<RateLimitPopover /> Traycer tab", () => {
  it("adds a Traycer tab for a paid account, even with no host-RPC providers", () => {
    mocks.configured = [];
    mocks.authUser = readyAuthUser(
      authUserFixture({ status: "PRO_V3", withTeam: false }),
    );
    renderPopover();
    // Eligible Traycer alone keeps the rail (not the zero-provider CTA).
    expect(
      screen.queryByText("Connect Claude Code or Codex to see usage here."),
    ).toBeNull();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Overview",
      "Traycer Inference",
    ]);
  });

  it("omits the Traycer tab for a free, unbundled account", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    mocks.results = { codex: readyResult(codexReady()) };
    mocks.authUser = readyAuthUser(
      authUserFixture({ status: "FREE", withTeam: false }),
    );
    renderPopover();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Overview",
      "Codex",
    ]);
  });

  it("orders the Traycer tab per PROVIDER_ID_ORDER (after Codex, before Kilo Code)", () => {
    mocks.configured = [
      { providerId: "kilocode", lane: "httpFetch" },
      { providerId: "codex", lane: "ephemeralProcess" },
    ];
    mocks.results = {
      codex: readyResult(codexReady()),
      kilocode: readyResult({
        provider: "kilocode",
        available: true,
        creditBalance: 5,
        passState: null,
      }),
    };
    mocks.authUser = readyAuthUser(
      authUserFixture({ status: "PRO_V3", withTeam: false }),
    );
    renderPopover();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Overview",
      "Codex",
      "Traycer Inference",
      "Kilo Code",
    ]);
  });

  it("shows the subscription detail with an account picker on the Traycer tab", () => {
    mocks.configured = [];
    mocks.authUser = readyAuthUser(
      authUserFixture({ status: "PRO_V3", withTeam: true }),
    );
    renderPopover();
    fireEvent.click(screen.getByRole("tab", { name: "Traycer Inference" }));
    // Shared subscription view: plan credit breakdown (30 of 100).
    expect(screen.getByText("$30.00 / $100.00")).toBeTruthy();
    // Detail tab surfaces the same Personal/Team picker as the Settings card.
    expect(screen.getByRole("combobox", { name: "Account" })).toBeTruthy();
    // Plan/tier chip next to the name - the trailing "_V3" pricing-generation
    // tag is stripped (matching Cloud UI's own Settings pages), so "PRO_V3"
    // reads as "Pro", not "Pro V3".
    expect(screen.getByText("Pro")).toBeTruthy();
  });

  it("renders a condensed Traycer block with no picker or plan chip on Overview", () => {
    mocks.configured = [];
    mocks.authUser = readyAuthUser(
      authUserFixture({ status: "PRO_V3", withTeam: true }),
    );
    renderPopover();
    // Overview reflects the selected account's numbers, but exposes no controls.
    expect(screen.getByText("$30.00 / $100.00")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Account" })).toBeNull();
    // Overview is condensed, same as the host-RPC providers' plan chip.
    expect(screen.queryByText("Pro")).toBeNull();
  });

  it("reflects the selected account's own plan in the chip, not the personal account's", () => {
    mocks.configured = [];
    mocks.authUser = readyAuthUser(
      authUserFixture({ status: "PRO_V3", withTeam: true }),
    );
    // The fixture's team subscription is on "ULTRA_1X_V3" - selecting the
    // team account should show that plan in the chip, not the personal one.
    useAccountContextStore.setState({
      accountContext: { type: "TEAM", teamId: "team-1" },
    });
    renderPopover();
    fireEvent.click(screen.getByRole("tab", { name: "Traycer Inference" }));
    // "ULTRA_1X_V3" reads as the bare "Ultra" tier name (matching
    // `subscriptionPlanLabel`'s own tier-name mapping), not the personal
    // account's "Pro".
    expect(screen.getByText("Ultra")).toBeTruthy();
    expect(screen.queryByText("Pro")).toBeNull();
  });

  it("refetches the subscription from the Traycer tab's refresh button", () => {
    mocks.configured = [];
    const authUser = readyAuthUser(
      authUserFixture({ status: "PRO_V3", withTeam: false }),
    );
    mocks.authUser = authUser;
    renderPopover();
    fireEvent.click(screen.getByRole("tab", { name: "Traycer Inference" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh Traycer Inference" }),
    );
    expect(authUser.refetch).toHaveBeenCalled();
  });
});
