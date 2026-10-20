import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster as StatusBarRateLimitClusterModel,
  StatusBarRateLimitRefreshModel,
  StatusBarRateLimitRetryTarget,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import { TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS } from "@/lib/rate-limits/rate-limit-timing";
import {
  manualRateLimitRetryAt,
  manualRateLimitRetryKey,
} from "@/lib/rate-limits/manual-retry-ledger";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { windowPercentText } from "@/lib/rate-limits/status-bar-window-text";
import { providerDisplayName } from "@/lib/provider-ordering";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

interface MockState {
  cluster: StatusBarRateLimitClusterModel;
  refresh: StatusBarRateLimitRefreshModel;
  retryTargets: ReadonlyArray<StatusBarRateLimitRetryTarget>;
  // `null` by default, exactly as the host-less rows below expect: only a row
  // about reading gives the cluster a scope to read through.
  scope: { readonly hostId: string } | null;
  fetch: Mock<
    (scope: unknown, target: unknown, opts: unknown) => Promise<void>
  >;
  collect: Mock<(scope: unknown, target: unknown) => Promise<void>>;
}

const mocks = vi.hoisted<MockState>(() => ({
  cluster: { kind: "no-providers" },
  refresh: {
    ephemeralTargets: [],
    ephemeralFetching: false,
    httpRefetches: [],
    httpFetching: false,
  },
  retryTargets: [],
  scope: null,
  fetch: vi.fn((): Promise<void> => Promise.resolve()),
  collect: vi.fn((): Promise<void> => Promise.resolve()),
}));

vi.mock(
  "@/hooks/rate-limits/use-status-bar-rate-limit-segments",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-status-bar-rate-limit-segments")
      >();
    return {
      ...actual,
      useStatusBarRateLimitSegments: () => ({
        cluster: mocks.cluster,
        mountTargets: [],
        retryTargets: mocks.retryTargets,
        refresh: mocks.refresh,
      }),
    };
  },
);

vi.mock("@/hooks/rate-limits/use-provider-rate-limit-fetch-scope", () => ({
  useProviderRateLimitFetchScope: () => mocks.scope,
}));

// The one way the GUI reads the ephemeral lane, and the boundary that talks to
// the host - so the spy is what proves which read a gesture made. `force` is
// the whole claim: a click passes the host's read floors, the state's own one
// re-read does not.
vi.mock("@/lib/rate-limits/provider-rate-limit-fetch", () => ({
  fetchProviderRateLimits: (scope: unknown, target: unknown, opts: unknown) =>
    mocks.fetch(scope, target, opts),
  collectProviderRateLimits: (scope: unknown, target: unknown) =>
    mocks.collect(scope, target),
}));

vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-mount", () => ({
  useRefreshProviderRateLimitsOnMount: () => undefined,
}));

import { StatusBarRateLimitCluster } from "@/components/layout/status-bar/status-bar-rate-limit-cluster";

const PROFILE_SELECTION: RateLimitProfileSelection = {
  shownProfiles: {},
  lastProfileByHarness: {},
};

function segmentFixture(
  providerId: ConfiguredRateLimitProvider["providerId"],
  tightest: StatusBarRateLimitWindow | null,
): StatusBarProviderSegmentModel {
  return {
    providerId,
    profileId: null,
    account: null,
    hidden: false,
    state: "live",
    reason: null,
    fetching: false,
    retryOffered: false,
    windows: tightest === null ? [] : [tightest],
    shown: tightest === null ? [] : [tightest],
    tightest,
  };
}

function windowFixture(overrides: {
  readonly windowKey: string;
  readonly usedPercent: number;
}): StatusBarRateLimitWindow {
  return {
    windowKey: overrides.windowKey,
    label: "5h",
    labelIsDuration: true,
    kind: "session",
    usedPercent: overrides.usedPercent,
    resetsAt: null,
    // Expanded, so every reading prints its percentage and countdown; a
    // healthy profile is a bare bar (`status-bar-provider-segment.test.tsx`).
    severity: "running_low",
  };
}

function clusterTree(
  props: { readonly providers?: ReadonlyArray<ConfiguredRateLimitProvider> },
  queryClient: QueryClient,
): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/*
          The cluster no longer owns the Popover root - it only renders a
          `PopoverTrigger`, so a real `Popover` has to wrap it here for that
          trigger to have anything to open. `AppStatusBar` is the real owner in
          production; `app-status-bar.test.tsx` covers that wiring end to end.
        */}
        <Popover>
          <StatusBarRateLimitCluster
            hostId="host-a"
            providers={props.providers ?? []}
            profileSelection={PROFILE_SELECTION}
            editing={false}
          />
        </Popover>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function renderCluster(props: {
  readonly providers?: ReadonlyArray<ConfiguredRateLimitProvider>;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(clusterTree(props, queryClient));
  return {
    ...view,
    // The same tree again, for a test that changes what the mocks answer and
    // needs the cluster to re-render rather than to mount afresh - a remount
    // would restart every timer whether or not its key moved.
    rerenderCluster: (): void => {
      view.rerender(clusterTree(props, queryClient));
    },
  };
}

beforeEach(() => {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

afterEach(() => {
  cleanup();
  useRateLimitPopoverStore.setState({
    activeTab: "overview",
    revealProfile: null,
  });
  mocks.cluster = { kind: "no-providers" };
  mocks.refresh = {
    ephemeralTargets: [],
    ephemeralFetching: false,
    httpRefetches: [],
    httpFetching: false,
  };
  mocks.retryTargets = [];
  mocks.scope = null;
  mocks.fetch.mockImplementation((): Promise<void> => Promise.resolve());
  window.localStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

describe("<StatusBarRateLimitCluster />", () => {
  it("opens the panel its trigger is wired to when clicked", () => {
    renderCluster({});

    const trigger = screen.getByTestId("status-bar-rate-limit-trigger");
    expect(trigger.getAttribute("data-state")).toBe("closed");

    fireEvent.click(trigger);

    expect(trigger.getAttribute("data-state")).toBe("open");
  });

  // Pinned as its own structural check: the trigger has to be INSIDE the
  // scroller - it is what scrolls - and the control that refreshes these
  // numbers has to sit right after the scroller, outside it, so it never
  // scrolls away with the readings it refreshes. Checked by DOM structure
  // rather than class strings, since a class rename should not silently
  // stop this from failing.
  it("wraps the trigger in the scroller and pins the refresh control after it, outside", () => {
    renderCluster({});

    const scroller = screen.getByTestId("status-bar-rate-limit-scroller");
    const trigger = screen.getByTestId("status-bar-rate-limit-trigger");
    // The default (no-providers) cluster disables the refresh with a
    // reason, but it is still rendered.
    const refreshButton = screen.getByRole("button", {
      name: "Refresh usage — nothing to refresh",
    });

    expect(scroller.contains(trigger)).toBe(true);
    expect(scroller.contains(refreshButton)).toBe(false);
    expect(
      Boolean(
        scroller.compareDocumentPosition(refreshButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  describe("refresh control", () => {
    function refreshButton(name: string) {
      return screen.getByRole("button", { name });
    }

    it("is disabled with a reason when the cluster is no-providers", () => {
      mocks.cluster = { kind: "no-providers" };
      renderCluster({});

      const button = refreshButton("Refresh usage — nothing to refresh");
      expect(button.hasAttribute("disabled")).toBe(true);
    });

    it("is disabled with a reason when the cluster is hidden", () => {
      mocks.cluster = { kind: "hidden" };
      renderCluster({});

      const button = refreshButton("Refresh usage — nothing to refresh");
      expect(button.hasAttribute("disabled")).toBe(true);
    });

    it("is enabled when the cluster has segments and a target to refresh", () => {
      mocks.cluster = {
        kind: "segments",
        segments: [segmentFixture("codex", null)],
      };
      mocks.refresh = {
        ephemeralTargets: [{ providerId: "codex", profileId: null }],
        ephemeralFetching: false,
        httpRefetches: [],
        httpFetching: false,
      };
      renderCluster({});

      const button = refreshButton("Refresh usage");
      expect(button.hasAttribute("disabled")).toBe(false);
    });
  });

  it("renders the connect-a-provider copy for no-providers and still opens the panel on click", () => {
    mocks.cluster = { kind: "no-providers" };
    renderCluster({});

    expect(
      screen.getByText("Connect a supported provider to see usage here."),
    ).not.toBeNull();

    const trigger = screen.getByTestId("status-bar-rate-limit-trigger");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("data-state")).toBe("open");
  });

  it("draws the glyph, not the connect sentence, for no-providers when Density is Compact", () => {
    useLayoutStore
      .getState()
      .setRegionValues("usageLimits", { density: "compact" });
    mocks.cluster = { kind: "no-providers" };
    renderCluster({});

    expect(screen.getByTestId("rate-limit-gauge-icon")).not.toBeNull();
    expect(
      screen.queryByText("Connect a supported provider to see usage here."),
    ).toBeNull();

    const trigger = screen.getByTestId("status-bar-rate-limit-trigger");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("data-state")).toBe("open");
  });

  it("renders 'Usage hidden' for the hidden cluster and still opens the panel on click", () => {
    mocks.cluster = { kind: "hidden" };
    renderCluster({});

    expect(screen.getByText("Usage hidden")).not.toBeNull();

    const trigger = screen.getByTestId("status-bar-rate-limit-trigger");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("data-state")).toBe("open");
  });

  describe("trigger accessible name", () => {
    it("is 'Usage limits' for no-providers", () => {
      mocks.cluster = { kind: "no-providers" };
      renderCluster({});

      expect(
        screen.getByRole("button", { name: "Usage limits" }),
      ).not.toBeNull();
    });

    it("is 'Usage limits' for hidden", () => {
      mocks.cluster = { kind: "hidden" };
      renderCluster({});

      expect(
        screen.getByRole("button", { name: "Usage limits" }),
      ).not.toBeNull();
    });

    it("lists each segment's tightest reading, provider by provider", () => {
      const codexUsed = 34;
      const claudeCodeUsed = 57;
      mocks.cluster = {
        kind: "segments",
        segments: [
          segmentFixture(
            "codex",
            windowFixture({
              windowKey: "codex:primary",
              usedPercent: codexUsed,
            }),
          ),
          segmentFixture(
            "claude-code",
            windowFixture({
              windowKey: "claude-code:fiveHour",
              usedPercent: claudeCodeUsed,
            }),
          ),
        ],
      };
      renderCluster({});

      const expectedName = `Usage limits: ${providerDisplayName("codex")} ${windowPercentText(
        codexUsed,
        "used",
      )}, ${providerDisplayName("claude-code")} ${windowPercentText(
        claudeCodeUsed,
        "used",
      )}`;
      expect(screen.getByRole("button", { name: expectedName })).not.toBeNull();
    });

    it("switches to remaining phrasing under percentMode: remaining", () => {
      useLayoutStore
        .getState()
        .setRegionValues("usageLimits", { amount: "remaining" });
      const codexUsed = 34;
      mocks.cluster = {
        kind: "segments",
        segments: [
          segmentFixture(
            "codex",
            windowFixture({
              windowKey: "codex:primary",
              usedPercent: codexUsed,
            }),
          ),
        ],
      };
      renderCluster({});

      const expectedName = `Usage limits: ${providerDisplayName("codex")} ${windowPercentText(
        codexUsed,
        "remaining",
      )}`;
      expect(screen.getByRole("button", { name: expectedName })).not.toBeNull();
    });
  });
});

/**
 * The cluster scrolls instead of shortening or folding its readings: every
 * drawn account's segment is in the DOM at every width, printing every part
 * the preferences ask for, and what the strip has no room for is a scroll
 * away.
 *
 * jsdom lays nothing out, so `scrollWidth` / `clientWidth` are 0 unless a
 * test says otherwise - which the wheel case does, on the scroller node
 * alone, with the same per-node `defineProperties` the wheel hook's own suite
 * uses. Whether the scroller actually overflows at a real width, and which
 * edge fades when it does, is a layout claim and lives in the Chromium
 * fixture, not here.
 */
describe("<StatusBarRateLimitCluster /> scrolls its readings", () => {
  const SCROLLER_TESTID = "status-bar-rate-limit-scroller";
  const TRIGGER_TESTID = "status-bar-rate-limit-trigger";
  const MINUTE_MS = 60_000;

  function scroller(): HTMLElement {
    return screen.getByTestId(SCROLLER_TESTID);
  }

  function renderScrollingCluster() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    // A fresh element per render: React bails out of an element it has
    // already rendered by reference, and the point of `rerenderSame` is to
    // let the mocked segments hook be read again.
    const tree = (hostId: string | null) => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={0}>
          <Popover>
            <StatusBarRateLimitCluster
              hostId={hostId}
              providers={[]}
              profileSelection={PROFILE_SELECTION}
              editing={false}
            />
          </Popover>
        </TooltipProvider>
      </QueryClientProvider>
    );
    const view = render(tree("host-a"));
    return {
      ...view,
      rerenderSame: () => view.rerender(tree("host-a")),
      rerenderOnHost: (hostId: string | null) => view.rerender(tree(hostId)),
    };
  }

  function accountSegment(input: {
    readonly providerId: ConfiguredRateLimitProvider["providerId"];
    readonly profileId: string;
    readonly usedPercent: number;
    readonly resetsAt: number | null;
  }): StatusBarProviderSegmentModel {
    const window: StatusBarRateLimitWindow = {
      ...windowFixture({
        windowKey: `${input.providerId}:primary`,
        usedPercent: input.usedPercent,
      }),
      resetsAt: input.resetsAt,
    };
    return {
      ...segmentFixture(input.providerId, window),
      profileId: input.profileId,
      account: {
        profileId: input.profileId,
        accentColor: "#336699",
        label: input.profileId,
      },
    };
  }

  /** Six drawn accounts across three providers - more than any strip fits. */
  function sixAccountCluster(resetsAt: number | null): void {
    mocks.cluster = {
      kind: "segments",
      segments: [
        accountSegment({
          providerId: "codex",
          profileId: "work",
          usedPercent: 34,
          resetsAt,
        }),
        accountSegment({
          providerId: "codex",
          profileId: "personal",
          usedPercent: 80,
          resetsAt,
        }),
        accountSegment({
          providerId: "claude-code",
          profileId: "work",
          usedPercent: 57,
          resetsAt,
        }),
        accountSegment({
          providerId: "claude-code",
          profileId: "personal",
          usedPercent: 12,
          resetsAt,
        }),
        accountSegment({
          providerId: "grok",
          profileId: "work",
          usedPercent: 91,
          resetsAt,
        }),
        accountSegment({
          providerId: "grok",
          profileId: "personal",
          usedPercent: 5,
          resetsAt,
        }),
      ],
    };
  }

  function drawnProfileIds(): ReadonlyArray<string | null> {
    return screen
      .getAllByTestId(/^status-bar-provider-segment-/)
      .map((segment) => segment.getAttribute("data-profile-id"));
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws every account's segment, with nothing folded away", () => {
    sixAccountCluster(null);
    renderScrollingCluster();

    expect(drawnProfileIds()).toEqual([
      "work",
      "personal",
      "work",
      "personal",
      "work",
      "personal",
    ]);
    expect(screen.queryByTestId("status-bar-folded-providers")).toBeNull();
    // And every one of them is in the trigger's name: a segment that has to
    // be scrolled to is still a reading the control is named by.
    const name = screen.getByTestId(TRIGGER_TESTID).getAttribute("aria-label");
    for (const segment of mocks.cluster.kind === "segments"
      ? mocks.cluster.segments
      : []) {
      expect(name).toContain(
        `${providerDisplayName(segment.providerId)} · ${segment.profileId}`,
      );
    }
  });

  it("draws the usage glyph instead of the readings when Density is Compact", () => {
    useLayoutStore
      .getState()
      .setRegionValues("usageLimits", { density: "compact" });
    sixAccountCluster(null);
    renderScrollingCluster();

    expect(screen.getByTestId("rate-limit-gauge-icon")).not.toBeNull();
    expect(screen.queryByTestId(/^status-bar-provider-segment-/)).toBeNull();
    // The trigger still names every reading, so the glyph loses no information
    // for a screen reader.
    expect(
      screen.getByTestId(TRIGGER_TESTID).getAttribute("aria-label"),
    ).toContain("Codex · work 34% used");
  });

  it("prints the bar, the percentage and the countdown on every expanded reading when Reset time is on", () => {
    vi.useFakeTimers();
    sixAccountCluster(Date.now() + 4 * 60 * MINUTE_MS + 15 * MINUTE_MS + 5_000);
    renderScrollingCluster();

    const windows = screen.getAllByTestId(/^status-bar-window-(?!percent-)/);
    expect(windows).toHaveLength(6);
    for (const window of windows) {
      expect(window.textContent).toMatch(/^\d+%4h 15m$/);
    }
    expect(screen.getAllByTestId("status-bar-provider-mini-bar")).toHaveLength(
      6,
    );
  });

  it("drops the countdown from every expanded reading when Reset time is off", () => {
    useLayoutStore.getState().setRegionValues("usageLimits", { reset: false });
    vi.useFakeTimers();
    sixAccountCluster(Date.now() + 4 * 60 * MINUTE_MS + 15 * MINUTE_MS + 5_000);
    renderScrollingCluster();

    const windows = screen.getAllByTestId(/^status-bar-window-(?!percent-)/);
    expect(windows).toHaveLength(6);
    // The bar and the percentage are the floor in the detailed form: no
    // switch takes them away. The window's name takes the countdown's place.
    for (const window of windows) {
      expect(window.textContent).toMatch(/^\d+%5h$/);
    }
    expect(screen.getAllByTestId("status-bar-provider-mini-bar")).toHaveLength(
      6,
    );
  });

  it("turns a vertical wheel over the readings into a horizontal scroll", () => {
    sixAccountCluster(null);
    renderScrollingCluster();
    Object.defineProperties(scroller(), {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 24 },
      scrollWidth: { configurable: true, value: 900 },
    });

    fireEvent.wheel(scroller(), { deltaY: 80, deltaMode: 0 });

    expect(scroller().scrollLeft).toBe(80);
  });

  it("scrolls back to the start when the segment set changes, and stays put when a reading moves", () => {
    vi.useFakeTimers();
    const resetsAt = Date.now() + 4 * 60 * MINUTE_MS + 15 * MINUTE_MS + 5_000;
    sixAccountCluster(resetsAt);
    const view = renderScrollingCluster();
    scroller().scrollLeft = 120;

    // A countdown tick: the same six segments, one minute later.
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });
    expect(
      screen.getAllByTestId("status-bar-window-codex:primary")[0].textContent,
    ).toContain("4h 14m");
    expect(scroller().scrollLeft).toBe(120);

    // A percentage update: the same six segments, one of them re-read.
    sixAccountCluster(resetsAt);
    if (mocks.cluster.kind === "segments") {
      const [first, ...rest] = mocks.cluster.segments;
      const window: StatusBarRateLimitWindow = {
        ...windowFixture({ windowKey: "codex:primary", usedPercent: 35 }),
        resetsAt,
      };
      mocks.cluster = {
        kind: "segments",
        segments: [
          { ...first, windows: [window], shown: [window], tightest: window },
          ...rest,
        ],
      };
    }
    view.rerenderSame();
    expect(
      screen.getAllByTestId("status-bar-window-percent-codex:primary")[0]
        .textContent,
    ).toBe("35%");
    expect(scroller().scrollLeft).toBe(120);

    // A set change: one account unchecked.
    sixAccountCluster(resetsAt);
    if (mocks.cluster.kind === "segments") {
      mocks.cluster = {
        kind: "segments",
        segments: mocks.cluster.segments.slice(1),
      };
    }
    view.rerenderSame();
    expect(drawnProfileIds()).toHaveLength(5);
    expect(scroller().scrollLeft).toBe(0);
  });

  it("scrolls back to the start on a host switch even when the new host draws the same segment ids", () => {
    // The strip keeps this subtree across a switch, and two hosts each
    // drawing the same providers' same accounts produce identical segment
    // keys - so the host has to be part of what the reset is keyed on, or a
    // strip that now reads a different machine would open scrolled to
    // wherever the last one was left.
    sixAccountCluster(null);
    const view = renderScrollingCluster();
    const before = drawnProfileIds();
    scroller().scrollLeft = 120;

    // Same mocked cluster, same ids, on the same mounted scroller - only the
    // host changes.
    view.rerenderOnHost("host-b");

    expect(drawnProfileIds()).toEqual(before);
    expect(scroller().scrollLeft).toBe(0);

    // And `null` (no host resolved yet) is a different host from any id,
    // not a spelling of one.
    scroller().scrollLeft = 60;
    view.rerenderOnHost(null);
    expect(scroller().scrollLeft).toBe(0);
  });

  describe("accounts", () => {
    /** Codex twice - Work and Personal - then Claude. Three segments. */
    function twoAccountCluster(): void {
      mocks.cluster = {
        kind: "segments",
        segments: [
          {
            ...segmentFixture(
              "codex",
              windowFixture({ windowKey: "codex:primary", usedPercent: 34 }),
            ),
            profileId: "work",
            account: {
              profileId: "work",
              accentColor: "#ff0000",
              label: "Work",
            },
          },
          {
            ...segmentFixture(
              "codex",
              windowFixture({ windowKey: "codex:primary", usedPercent: 80 }),
            ),
            profileId: "personal",
            account: {
              profileId: "personal",
              accentColor: "#00ff00",
              label: "Personal",
            },
          },
          segmentFixture(
            "claude-code",
            windowFixture({
              windowKey: "claude-code:fiveHour",
              usedPercent: 57,
            }),
          ),
        ],
      };
    }

    function accountDotColor(segment: HTMLElement): string | undefined {
      return segment
        .querySelector('[data-testid="status-bar-provider-account-dot"]')
        ?.querySelector<HTMLElement>("span[style]")
        ?.style.getPropertyValue("--swatch");
    }

    it("draws one segment per account, each with its own accent dot and reading", () => {
      twoAccountCluster();
      renderScrollingCluster();

      const codexSegments = screen.getAllByTestId(
        "status-bar-provider-segment-codex",
      );
      expect(
        codexSegments.map((segment) => segment.getAttribute("data-profile-id")),
      ).toEqual(["work", "personal"]);
      expect(
        codexSegments.map(
          (segment) =>
            segment.querySelector('[data-testid="status-bar-provider-account"]')
              ?.textContent,
        ),
      ).toEqual(["Work", "Personal"]);
      expect(
        codexSegments.map(
          (segment) =>
            segment.querySelector(
              '[data-testid="status-bar-window-percent-codex:primary"]',
            )?.textContent,
        ),
      ).toEqual(["34%", "80%"]);
      // The dot is the account's identity mark, and a provider with one
      // account (claude here) draws none.
      expect(codexSegments.map(accountDotColor)).toEqual([
        "#ff0000",
        "#00ff00",
      ]);
      expect(
        accountDotColor(
          screen.getByTestId("status-bar-provider-segment-claude-code"),
        ),
      ).toBeUndefined();
      // The trigger's name tells the two accounts apart too.
      expect(
        screen.getByTestId(TRIGGER_TESTID).getAttribute("aria-label"),
      ).toBe(
        "Usage limits: Codex · Work 34% used, Codex · Personal 80% used, Claude Code 57% used",
      );
    });

    it("reads the clicked account again, forced, when its segment is offering a retry - and only then", () => {
      mocks.scope = { hostId: "host-a" };
      const transient: StatusBarProviderSegmentModel = {
        ...segmentFixture("codex", null),
        state: "transient",
        reason: "timeout",
        retryOffered: true,
      };
      const httpTransient: StatusBarProviderSegmentModel = {
        ...segmentFixture("openrouter", null),
        state: "transient",
        reason: "connection_failed",
        retryOffered: true,
      };
      const refetch = vi.fn((): Promise<void> => Promise.resolve());
      mocks.cluster = {
        kind: "segments",
        segments: [transient, httpTransient, segmentFixture("cursor", null)],
      };
      mocks.refresh = {
        ...mocks.refresh,
        httpRefetches: [
          { providerId: "openrouter", profileId: null, refetch },
          // A second observer, so a keyed retry proves it reaches ITS own
          // account rather than every http account the cluster holds.
          {
            providerId: "cursor",
            profileId: null,
            refetch: vi.fn((): Promise<void> => Promise.resolve()),
          },
        ],
      };
      renderCluster({});

      fireEvent.click(screen.getByTestId("status-bar-provider-segment-codex"));

      // The ephemeral lane: one forced read of that account, through the one
      // function that may read it.
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(mocks.fetch.mock.calls[0][1]).toEqual({
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: null,
      });
      expect(mocks.fetch.mock.calls[0][2]).toEqual({ force: true });
      // The click is still the deep link it was.
      expect(useRateLimitPopoverStore.getState().revealProfile).toEqual({
        providerId: "codex",
        profileId: null,
      });

      // The http lane refetches its own observer instead, and no other.
      fireEvent.click(
        screen.getByTestId("status-bar-provider-segment-openrouter"),
      );
      expect(refetch).toHaveBeenCalledTimes(1);
      expect(mocks.fetch).toHaveBeenCalledTimes(1);

      // A segment that is not offering one reads nothing at all.
      fireEvent.click(screen.getByTestId("status-bar-provider-segment-cursor"));
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("stamps the retry bound when the read settles, on the host it went to, and not before", async () => {
      mocks.scope = { hostId: "host-a" };
      let settle = (): void => undefined;
      mocks.fetch.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            settle = () => resolve();
          }),
      );
      mocks.cluster = {
        kind: "segments",
        segments: [
          {
            ...segmentFixture("codex", null),
            state: "transient",
            reason: "timeout",
            retryOffered: true,
          },
        ],
      };
      const key = manualRateLimitRetryKey("host-a", "codex", null);
      renderCluster({});

      fireEvent.click(screen.getByTestId("status-bar-provider-segment-codex"));
      // While the read runs there is no stamp: a probe that fails after ninety
      // seconds has to be bounded from its failure, not from the click. The
      // segment is saying `Retrying...` and offering nothing meanwhile.
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(manualRateLimitRetryAt(key)).toBeNull();

      // `act` around the settle, so the `.then` that stamps has run and the
      // re-render it causes is committed before the assertion reads storage.
      await act(async () => {
        settle();
        await Promise.resolve();
      });
      expect(manualRateLimitRetryAt(key)).not.toBeNull();
      // Keyed by the host the read went to, so the same account elsewhere is
      // untouched.
      expect(
        manualRateLimitRetryAt(
          manualRateLimitRetryKey("host-b", "codex", null),
        ),
      ).toBeNull();
    });

    it("re-reads a transient account once, unforced, and does not keep re-reading it", () => {
      vi.useFakeTimers();
      mocks.scope = { hostId: "host-a" };
      mocks.retryTargets = [{ providerId: "codex", profileId: null }];
      mocks.cluster = {
        kind: "segments",
        segments: [
          {
            ...segmentFixture("codex", null),
            state: "transient",
            reason: "timeout",
            retryOffered: true,
          },
        ],
      };
      renderCluster({});

      expect(mocks.collect).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
      });
      // Through the COLLECTION path, which is the only unforced read that
      // reaches the host for an entry this renderer just wrote: a plain
      // `force: false` fetch is answered by the renderer's own freshness
      // guard, so the host never hears the question the words promise.
      expect(mocks.collect).toHaveBeenCalledTimes(1);
      expect(mocks.collect.mock.calls[0][1]).toEqual({
        providerId: "codex",
        accountContext: DEFAULT_ACCOUNT_CONTEXT,
        profileId: null,
      });
      expect(mocks.fetch).not.toHaveBeenCalled();

      // One, not a loop: the poll owns the cadence from here.
      act(() => {
        vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS * 10);
      });
      expect(mocks.collect).toHaveBeenCalledTimes(1);
    });

    it("starts a fresh timer when the strip is pointed at a different host, and never fires the old one against it", () => {
      vi.useFakeTimers();
      mocks.scope = { hostId: "host-a" };
      mocks.retryTargets = [{ providerId: "codex", profileId: null }];
      mocks.cluster = {
        kind: "segments",
        segments: [
          {
            ...segmentFixture("codex", null),
            state: "transient",
            reason: "timeout",
            retryOffered: true,
          },
        ],
      };
      const view = renderCluster({});

      act(() => {
        vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS / 2);
      });
      mocks.scope = { hostId: "host-b" };
      view.rerenderCluster();
      // Host A's half-spent timer went with the account it was started for:
      // at A's deadline nothing is read, because the read would have gone to
      // B's scope while counting A's wait.
      act(() => {
        vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS / 2);
      });
      expect(mocks.collect).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS / 2);
      });
      expect(mocks.collect).toHaveBeenCalledTimes(1);
      expect(mocks.collect.mock.calls[0][0]).toEqual({ hostId: "host-b" });
    });

    it("arms the panel to reveal the clicked account's card, on that provider's tab", () => {
      twoAccountCluster();
      renderScrollingCluster();

      const [, personal] = screen.getAllByTestId(
        "status-bar-provider-segment-codex",
      );
      fireEvent.click(personal);

      expect(useRateLimitPopoverStore.getState().activeTab).toBe("codex");
      expect(useRateLimitPopoverStore.getState().revealProfile).toEqual({
        providerId: "codex",
        profileId: "personal",
      });
      // And the click still reached the trigger, so the panel is opening.
      expect(
        screen.getByTestId(TRIGGER_TESTID).getAttribute("data-state"),
      ).toBe("open");
    });
  });

  it("keeps the trigger scrollable inside a real popover anchor, where Radix re-wraps it after the first commit", () => {
    // `AppStatusBar` anchors the popover on its own slot span via a real
    // `PopoverAnchor`, not the trigger - which flips `PopoverTrigger`'s
    // `hasCustomAnchor` context after mount and swaps its child out from
    // under a Popper `Anchor` wrapper on the second commit. The scroller sits
    // OUTSIDE the trigger, so the swap must leave the trigger inside the
    // scroller and the scroller still the one that scrolls.
    sixAccountCluster(null);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Popover>
            <PopoverAnchor asChild>
              <span data-testid="anchor-slot" />
            </PopoverAnchor>
            <StatusBarRateLimitCluster
              hostId="host-a"
              providers={[]}
              profileSelection={PROFILE_SELECTION}
              editing={false}
            />
          </Popover>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    const trigger = screen.getByTestId(TRIGGER_TESTID);
    expect(scroller().contains(trigger)).toBe(true);
    Object.defineProperties(scroller(), {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 24 },
      scrollWidth: { configurable: true, value: 900 },
    });
    fireEvent.wheel(trigger, { deltaY: 40, deltaMode: 0 });
    expect(scroller().scrollLeft).toBe(40);
  });
});
