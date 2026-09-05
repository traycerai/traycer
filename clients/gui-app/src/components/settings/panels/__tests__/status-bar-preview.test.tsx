import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { RateLimitFetchLane } from "@/lib/rate-limit-providers";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

// The preview must register no dynamic keybinding handler while mounted (it
// owns no shortcut of its own) - mocked here, preserving every other export,
// so the assertion below can tell "never called" from "not exercised because
// the mock swallowed the call".
vi.mock("@/lib/keybindings/dispatch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/keybindings/dispatch")>();
  return {
    ...actual,
    registerDynamicActionHandler: vi.fn(),
  };
});

// ── module-level mock state ─────────────────────────────────────────────────

interface MockState {
  providers: ReadonlyArray<ConfiguredRateLimitProvider>;
  envelopes: Record<string, ProviderRateLimitEnvelope>;
  /** Every `options.enabled` the mocked host-query hook was called with. */
  recordedEnabled: boolean[];
  /** How many times anything asked to SUBSCRIBE the desktop-app sampler. */
  desktopSamplerSubscriptions: number;
}

const mocks = vi.hoisted<MockState>(() => ({
  providers: [],
  envelopes: {},
  recordedEnabled: [],
  desktopSamplerSubscriptions: 0,
}));

// The seam the "does the page start a 1 Hz IPC poll" assertion reads. Counting
// `enabled: true` calls rather than spying on the module-level timer, because
// what the preview owes is not to ASK - the sampler's own contract is written
// in terms of its subscribers.
vi.mock("@/hooks/resources/use-desktop-app-resource-usage", () => ({
  useDesktopAppResourceUsage: (enabled: boolean) => {
    if (enabled) mocks.desktopSamplerSubscriptions += 1;
    return null;
  },
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

interface RateLimitQueryOptions {
  readonly enabled: boolean;
}

function resultKey(providerId: string, profileId: string | null): string {
  return profileId === null ? providerId : `${providerId}:${profileId}`;
}

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueriesWithResponseMap: (args: {
    readonly requests: ReadonlyArray<{
      readonly params: RateLimitRequestParams;
    }>;
    readonly options: RateLimitQueryOptions | null;
  }) => {
    mocks.recordedEnabled.push(args.options !== null && args.options.enabled);
    return args.requests.map((request) => ({
      data: mocks.envelopes[
        resultKey(request.params.providerId, request.params.profileId)
      ],
      isPending: false,
      isFetching: false,
      isError: false,
      dataUpdatedAt: 0,
      refetch: () => Promise.resolve({}),
    }));
  },
}));

// `useHostClient` is never actually exercised: every real read behind it is
// mocked above, so this only needs to satisfy the hook's call site.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => null,
  };
});

import { StatusBarPreview } from "@/components/settings/panels/layout/status-bar-preview";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";

/**
 * The harness's global `MockResizeObserver` never invokes its callback, so the
 * coupled-layout block at the bottom of this file - which has to deliver a
 * resize to the ladder's own observer - needs a controllable replacement.
 * Installed at MODULE LOAD, the technique `status-bar-rate-limit-cluster.test.tsx`
 * and `status-bar-density.test.tsx` use. Every other test here leaves it idle,
 * which is exactly how the global mock behaves.
 */
class ControllableResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObserverInstances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }
}

let resizeObserverInstances: ControllableResizeObserver[] = [];

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ControllableResizeObserver,
});

/**
 * The same treatment for `IntersectionObserver`: the harness's global mock
 * never calls back, and the sticky block's `data-stuck` is written from exactly
 * one of those callbacks.
 */
class ControllableIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = "";
  readonly scrollMargin: string = "";
  readonly thresholds: ReadonlyArray<number> = [];
  readonly callback: IntersectionObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    intersectionObserverInstances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

let intersectionObserverInstances: ControllableIntersectionObserver[] = [];

Object.defineProperty(globalThis, "IntersectionObserver", {
  configurable: true,
  writable: true,
  value: ControllableIntersectionObserver,
});

// ── fixtures ─────────────────────────────────────────────────────────────

const NO_PROFILES: ReadonlyArray<ProviderProfile> = [];

function configuredProvider(
  providerId: "codex" | "opencode" | "claude-code",
  lane: RateLimitFetchLane,
): ConfiguredRateLimitProvider {
  return {
    providerId,
    lane,
    profiles: NO_PROFILES,
    fetchEligibility: { ambient: true, managedProfiles: true },
  };
}

function codexRateLimits(primary: {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly durationMinutes: number;
}): Extract<ProviderRateLimits, { provider: "codex" }> {
  return {
    provider: "codex",
    available: true,
    planType: "pro_5x",
    limitId: null,
    limitName: null,
    primary,
    secondary: null,
    extraWindows: [],
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType: null,
  };
}

function claudeRateLimits(
  usedPercent: number,
): Extract<ProviderRateLimits, { provider: "claude-code" }> {
  return {
    provider: "claude-code",
    available: true,
    subscriptionType: "max",
    fiveHour: { usedPercent, resetsAt: null, durationMinutes: 300 },
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
        lastGoodAt: Date.now(),
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
  mocks.providers = [];
  mocks.envelopes = {};
  mocks.recordedEnabled = [];
  mocks.desktopSamplerSubscriptions = 0;
  resizeObserverInstances = [];
  intersectionObserverInstances = [];
  vi.mocked(registerDynamicActionHandler).mockClear();
}

/** Deliver one measurement to the ladder's own observer over the room. */
function fireRoomResize(): void {
  const room = screen.getByTestId("status-bar-preview-usage");
  const instance = resizeObserverInstances.find((candidate) =>
    candidate.observed.has(room),
  );
  if (instance === undefined) {
    throw new Error("no ResizeObserver is currently observing the room");
  }
  act(() => {
    instance.callback([], instance);
  });
}

beforeEach(resetAll);
afterEach(() => {
  cleanup();
  resetAll();
});

function renderPreview(hasExplicitPick: boolean): void {
  render(
    <StatusBarPreview
      scope={hostScopeFixture({})}
      hasExplicitPick={hasExplicitPick}
    />,
  );
}

function windowText(windowKey: string): string {
  return screen.getByTestId(`status-bar-window-${windowKey}`).textContent;
}

describe("<StatusBarPreview />", () => {
  it("registers no dynamic keybinding handler and mounts no refresh control or popover trigger", () => {
    mocks.providers = [configuredProvider("codex", "ephemeralProcess")];
    mocks.envelopes = {
      codex: envelopeFor(
        codexRateLimits({
          usedPercent: 40,
          resetsAt: null,
          durationMinutes: 300,
        }),
      ),
    };

    renderPreview(false);

    expect(registerDynamicActionHandler).not.toHaveBeenCalled();
    // Queried by testid, not by role: everything in the frame is
    // `aria-hidden`, so a role query skips it and would pass whether or not
    // the control were there.
    expect(document.querySelector('[aria-label="Refresh usage"]')).toBeNull();
    expect(screen.queryByTestId("status-bar-rate-limit-trigger")).toBeNull();
  });

  it("mounts every usage observer with enabled: false, even for an httpFetch-lane provider a live reader would enable", () => {
    // opencode is httpFetch-lane and fetch-eligible, so a `live` reader would
    // have produced `enabled: true` for it - proving this really is the
    // passive mode and not an accident of codex's own ephemeralProcess lane,
    // which is disabled either way.
    mocks.providers = [
      configuredProvider("codex", "ephemeralProcess"),
      configuredProvider("opencode", "httpFetch"),
    ];
    mocks.envelopes = {};

    renderPreview(false);

    expect(mocks.recordedEnabled.length).toBeGreaterThan(0);
    expect(mocks.recordedEnabled.some((enabled) => enabled)).toBe(false);
  });

  describe("mirrors the store, without remounting", () => {
    it("percentMode, showModeWord, showBar, hiddenWindowKeys and hiddenProviders", () => {
      // `resetsAt: null` sidesteps the wall-clock entirely for this test -
      // the label always falls back to the static duration regardless of
      // `showTimer`, so the countdown itself is covered separately below.
      mocks.providers = [configuredProvider("codex", "ephemeralProcess")];
      mocks.envelopes = {
        codex: envelopeFor(
          codexRateLimits({
            usedPercent: 40,
            resetsAt: null,
            durationMinutes: 300,
          }),
        ),
      };

      renderPreview(false);

      expect(windowText("codex:primary")).toBe("40% used 5h");

      act(() => {
        useLayoutStore.getState().setStatusBarPercentMode("remaining");
      });
      expect(windowText("codex:primary")).toBe("60% remaining 5h");

      act(() => {
        useLayoutStore.getState().setStatusBarShowModeWord(false);
      });
      expect(windowText("codex:primary")).toBe("60% 5h");

      expect(screen.getByTestId("status-bar-provider-mini-bar")).toBeTruthy();
      act(() => {
        useLayoutStore.getState().setStatusBarShowBar(false);
      });
      expect(screen.queryByTestId("status-bar-provider-mini-bar")).toBeNull();

      act(() => {
        useLayoutStore.getState().toggleStatusBarWindow("codex:primary");
      });
      expect(
        screen.queryByTestId("status-bar-window-codex:primary"),
      ).toBeNull();
      act(() => {
        useLayoutStore.getState().toggleStatusBarWindow("codex:primary");
      });
      expect(windowText("codex:primary")).toBe("60% 5h");

      act(() => {
        useLayoutStore.getState().toggleStatusBarProvider("codex");
      });
      expect(
        screen.queryByTestId("status-bar-provider-segment-codex"),
      ).toBeNull();
      act(() => {
        useLayoutStore.getState().toggleStatusBarProvider("codex");
      });
      expect(
        screen.getByTestId("status-bar-provider-segment-codex"),
      ).toBeTruthy();
    });

    it("showTimer: the countdown gives way to the static label when it is turned off", () => {
      // A real `resetsAt`, computed here rather than at module load and given
      // a five-second buffer, the same technique the cluster suite's own
      // ladder tests use to keep a countdown string stable for the life of
      // one synchronous test.
      const resetsAt = Date.now() + (4 * 60 + 15) * 60_000 + 5_000;
      mocks.providers = [configuredProvider("codex", "ephemeralProcess")];
      mocks.envelopes = {
        codex: envelopeFor(
          codexRateLimits({ usedPercent: 40, resetsAt, durationMinutes: 300 }),
        ),
      };

      renderPreview(false);

      // showTimer defaults to true, so the mount already renders the countdown.
      expect(windowText("codex:primary")).toBe("40% used 4h 15m");

      act(() => {
        useLayoutStore.getState().setStatusBarShowTimer(false);
      });
      expect(windowText("codex:primary")).toBe("40% used 5h");
    });

    it("rateLimits.enabled", () => {
      mocks.providers = [configuredProvider("codex", "ephemeralProcess")];
      mocks.envelopes = {
        codex: envelopeFor(
          codexRateLimits({
            usedPercent: 40,
            resetsAt: null,
            durationMinutes: 300,
          }),
        ),
      };

      renderPreview(false);
      expect(screen.getByTestId("status-bar-preview-usage")).toBeTruthy();

      act(() => {
        useLayoutStore.getState().setStatusBarRateLimitsEnabled(false);
      });
      expect(screen.queryByTestId("status-bar-preview-usage")).toBeNull();
    });

    it("resources.enabled and resources.metrics", () => {
      mocks.providers = [];

      renderPreview(false);

      expect(screen.getByTestId("status-bar-resource-segment")).toBeTruthy();
      expect(screen.getByTestId("status-bar-resource-metric-cpu")).toBeTruthy();

      act(() => {
        useLayoutStore.getState().toggleStatusBarResourceMetric("cpu");
      });
      expect(screen.queryByTestId("status-bar-resource-metric-cpu")).toBeNull();

      act(() => {
        useLayoutStore.getState().toggleStatusBarResourceMetric("cpu");
      });
      expect(screen.getByTestId("status-bar-resource-metric-cpu")).toBeTruthy();

      act(() => {
        useLayoutStore.getState().setStatusBarResourcesEnabled(false);
      });
      expect(screen.queryByTestId("status-bar-resource-segment")).toBeNull();
    });
  });

  describe("notes outside the inert frame", () => {
    // `inert` removes the frame from hit testing, so no tooltip inside it can
    // ever open - and the states those tooltips exist for are the ones a
    // preview reads as broken without them.
    it("carries the resource segment's unavailable reason, outside the frame", () => {
      mocks.providers = [];

      renderPreview(false);

      const note = screen.getByTestId("status-bar-preview-resource-note");
      expect(note.textContent).toContain("Waiting for resource data.");
      expect(
        screen.getByTestId("status-bar-preview-frame").contains(note),
      ).toBe(false);
    });

    it("names a provider whose reading is not live, and stops once it is", () => {
      mocks.providers = [configuredProvider("codex", "ephemeralProcess")];
      mocks.envelopes = {};

      const { rerender } = render(
        <StatusBarPreview
          scope={hostScopeFixture({})}
          hasExplicitPick={false}
        />,
      );

      expect(
        screen.getByTestId("status-bar-preview-notes").textContent,
      ).toContain("Codex · no reading yet");

      mocks.envelopes = {
        codex: envelopeFor(
          codexRateLimits({
            usedPercent: 40,
            resetsAt: null,
            durationMinutes: 300,
          }),
        ),
      };
      rerender(
        <StatusBarPreview
          scope={hostScopeFixture({})}
          hasExplicitPick={false}
        />,
      );

      expect(screen.queryByTestId("status-bar-preview-notes")).toBeNull();
    });

    it("drops each half with the switch that hides the segment it describes", () => {
      mocks.providers = [configuredProvider("codex", "ephemeralProcess")];
      mocks.envelopes = {};

      renderPreview(false);

      act(() => {
        useLayoutStore.getState().setStatusBarRateLimitsEnabled(false);
      });
      expect(screen.queryByTestId("status-bar-preview-notes")).toBeNull();
      expect(
        screen.getByTestId("status-bar-preview-resource-note"),
      ).toBeTruthy();

      act(() => {
        useLayoutStore.getState().setStatusBarResourcesEnabled(false);
      });
      expect(
        screen.queryByTestId("status-bar-preview-resource-note"),
      ).toBeNull();
    });

    it("does not subscribe the desktop-app sampler while the resource monitor is off", () => {
      // Reading the resource reason costs a SUBSCRIPTION, and subscribing is
      // what starts a 1 Hz IPC poll of the shell. With the monitor off nothing
      // on screen draws those numbers, so nothing may ask for them - which is
      // why the note is its own component rather than a gated result.
      useLayoutStore.setState({
        statusBar: {
          ...DEFAULT_STATUS_BAR_LAYOUT,
          resources: {
            ...DEFAULT_STATUS_BAR_LAYOUT.resources,
            enabled: false,
            scope: "desktop-app",
          },
        },
      });
      mocks.providers = [];

      renderPreview(false);

      expect(mocks.desktopSamplerSubscriptions).toBe(0);

      act(() => {
        useLayoutStore.getState().setStatusBarResourcesEnabled(true);
      });

      // The positive control: with the monitor on, the same page does ask.
      expect(mocks.desktopSamplerSubscriptions).toBeGreaterThan(0);
    });
  });

  describe("width control", () => {
    it("defaults to Wide - the only option that can measure past the compact threshold", () => {
      // Wide rather than Normal because `max-w-[900px]` minus the frame's
      // border and padding measures 882, which is `compact`, whose ladder
      // ceiling drops the mode word, the mini bar and the countdown whatever
      // the store says. Opening there would answer "this does nothing" to the
      // first three Display switches a user tries.
      renderPreview(false);
      const frame = screen.getByTestId("status-bar-preview-frame");

      expect(frame.getAttribute("data-preview-width")).toBe("wide");
      expect(frame.className).toContain("max-w-full");
    });

    it("changes data-preview-width and the applied max-width class", () => {
      renderPreview(false);
      const frame = () => screen.getByTestId("status-bar-preview-frame");

      fireEvent.click(screen.getByRole("button", { name: "Narrow" }));
      expect(frame().getAttribute("data-preview-width")).toBe("narrow");
      expect(frame().className).toContain("max-w-[480px]");

      fireEvent.click(screen.getByRole("button", { name: "Normal" }));
      expect(frame().getAttribute("data-preview-width")).toBe("normal");
      expect(frame().className).toContain("max-w-[900px]");

      fireEvent.click(screen.getByRole("button", { name: "Wide" }));
      expect(frame().getAttribute("data-preview-width")).toBe("wide");
      expect(frame().className).toContain("max-w-full");
    });
  });

  describe("honest states", () => {
    it("renders the strip's connect-a-provider copy when no provider is configured", () => {
      mocks.providers = [];

      renderPreview(false);

      expect(
        screen.getByText("Connect a supported provider to see usage here."),
      ).toBeTruthy();
    });

    it("renders the cold track for a configured provider with no envelope yet", () => {
      mocks.providers = [configuredProvider("codex", "ephemeralProcess")];
      mocks.envelopes = {};

      renderPreview(false);

      expect(screen.getByTestId("status-bar-provider-cold-track")).toBeTruthy();
    });
  });

  describe("header placement", () => {
    it("dims the frame and shows the deferred caption under header placement", () => {
      mocks.providers = [];
      useLayoutStore.setState({
        statusBar: { ...DEFAULT_STATUS_BAR_LAYOUT, placement: "header" },
      });

      render(
        <StatusBarPreview
          scope={hostScopeFixture({ hostLabel: "My Mac" })}
          hasExplicitPick={false}
        />,
      );

      expect(
        screen.getByTestId("status-bar-preview-frame").className,
      ).toContain("opacity-50");
      // The notes dim with it: they explain a strip that is not the one
      // currently drawn, and full-strength explanations under a greyed picture
      // read as the two disagreeing about which of them is live.
      expect(
        screen.getByTestId("status-bar-preview-resource-note").className,
      ).toContain("opacity-50");
      expect(
        screen.getByText("Shown when placement is Status bar."),
      ).toBeTruthy();
      expect(screen.getByText(/Live data from My Mac/)).toBeTruthy();
    });

    it("does not dim the frame or show the deferred caption under status-bar placement", () => {
      mocks.providers = [];
      useLayoutStore.setState({
        statusBar: { ...DEFAULT_STATUS_BAR_LAYOUT, placement: "status-bar" },
      });

      render(
        <StatusBarPreview
          scope={hostScopeFixture({ hostLabel: "My Mac" })}
          hasExplicitPick={false}
        />,
      );

      expect(
        screen.getByTestId("status-bar-preview-frame").className,
      ).not.toContain("opacity-50");
      expect(
        screen.getByTestId("status-bar-preview-resource-note").className,
      ).not.toContain("opacity-50");
      expect(
        screen.queryByText("Shown when placement is Status bar."),
      ).toBeNull();
      expect(screen.getByText(/Live data from My Mac/)).toBeTruthy();
    });
  });

  describe("narrow viewport", () => {
    // `useIsMobileViewport` reads `window.innerWidth` directly (the global
    // `matchMedia` shim always reports `false`), so setting it before render is
    // enough to put a desktop build below `md` - a split screen, a dragged-in
    // edge - where `AppShell` declines to mount the strip whatever the
    // placement says.
    beforeEach(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 400,
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1024,
      });
    });

    it("dims the frame under status-bar placement and says the WIDTH is why, not the placement", () => {
      mocks.providers = [];
      useLayoutStore.setState({
        statusBar: { ...DEFAULT_STATUS_BAR_LAYOUT, placement: "status-bar" },
      });

      renderPreview(false);

      expect(
        screen.getByTestId("status-bar-preview-frame").className,
      ).toContain("opacity-50");
      expect(
        screen.getByTestId("status-bar-preview-resource-note").className,
      ).toContain("opacity-50");
      expect(
        screen.getByText(
          "The strip is not shown at this window width; the header keeps its controls.",
        ),
      ).toBeTruthy();
      // The placement sentence would be a false promise here: flipping
      // placement changes nothing at this width.
      expect(
        screen.queryByText("Shown when placement is Status bar."),
      ).toBeNull();
    });

    it("does not pin the block, which here is a dimmed picture of a strip that is not drawn", () => {
      // Class-level rather than computed, because jsdom has no layout engine:
      // what can be asserted is that nothing pins UNCONDITIONALLY. A block
      // this tall - header row, frame, notes, two captions, all wrapping -
      // pinned to a landscape phone's scrollport would take most of it, and a
      // sticky box taller than its scrollport pins its top, so its own last
      // caption becomes unreachable.
      mocks.providers = [];
      useLayoutStore.setState({
        statusBar: { ...DEFAULT_STATUS_BAR_LAYOUT, placement: "status-bar" },
      });

      renderPreview(false);
      const classes = screen
        .getByTestId("status-bar-preview-block")
        .className.split(" ");

      expect(classes).not.toContain("sticky");
      expect(classes).not.toContain("top-0");
      expect(classes).toContain("md:sticky");
    });
  });

  describe("sticky within the group", () => {
    it("pins the block from md up and flips data-stuck from the sentinel, never from a render", () => {
      mocks.providers = [];

      renderPreview(false);
      const block = screen.getByTestId("status-bar-preview-block");

      // Every pin class carries the breakpoint, and so does everything the
      // stuck attribute drives: below `md` the block never leaves flow, so a
      // sentinel that has scrolled away must not repaint it mid-card.
      expect(block.className).toContain("md:sticky");
      expect(block.className).toContain("md:top-0");
      expect(block.className).toContain("md:data-[stuck=true]:bg-background");
      expect(
        block.className
          .split(" ")
          .filter((name) => name.startsWith("data-[stuck")),
      ).toEqual([]);
      expect(block.getAttribute("data-stuck")).toBe("false");

      // The sentinel sits where the block sits unpinned, so it leaving the
      // scroll container IS the block pinning.
      fireSentinelIntersection(false);
      expect(block.getAttribute("data-stuck")).toBe("true");

      fireSentinelIntersection(true);
      expect(block.getAttribute("data-stuck")).toBe("false");
    });
  });
});

/** One delivery to the sentinel's observer, as the scroll container would. */
function fireSentinelIntersection(isIntersecting: boolean): void {
  const instance = intersectionObserverInstances.find(
    (candidate) => candidate.observed.size > 0,
  );
  if (instance === undefined) {
    throw new Error("no IntersectionObserver is currently observing anything");
  }
  const entries = [...instance.observed].map((target) => {
    const rect = target.getBoundingClientRect();
    return {
      boundingClientRect: rect,
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: rect,
      isIntersecting,
      rootBounds: null,
      target,
      time: 0,
    };
  });
  act(() => {
    instance.callback(entries, instance);
  });
}

/**
 * The `+N` chip's tooltip, said outside the frame.
 *
 * Its own room stubs rather than the coupled block's: folding only starts once
 * the readings overflow at the LAST rung, which is a room narrower than any of
 * the three width options can produce against that block's content table.
 */
describe("<StatusBarPreview /> folded providers", () => {
  const originalScrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth",
  );
  const originalClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );

  beforeEach(() => {
    // A room nothing fits in, at any rung: the ladder walks to its last stop,
    // which is one folded provider (the last one never folds - a chip alone
    // would name no reading at all).
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === "status-bar-preview-usage"
          ? 80
          : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === "status-bar-preview-content"
          ? 400
          : 0;
      },
    });
  });

  afterEach(() => {
    if (originalScrollWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollWidth",
        originalScrollWidth,
      );
    }
    if (originalClientWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        originalClientWidth,
      );
    }
  });

  it("names the folded provider and its reading in the notes, outside the inert frame", () => {
    mocks.providers = [
      configuredProvider("codex", "ephemeralProcess"),
      configuredProvider("claude-code", "ephemeralProcess"),
    ];
    mocks.envelopes = {
      codex: envelopeFor(
        codexRateLimits({
          usedPercent: 40,
          resetsAt: null,
          durationMinutes: 300,
        }),
      ),
      "claude-code": envelopeFor(claudeRateLimits(22)),
    };

    renderPreview(false);
    // One rung per delivery, by design - walk the cascade out.
    for (let index = 0; index < 8; index += 1) {
      fireRoomResize();
    }

    expect(screen.getByTestId("status-bar-folded-providers").textContent).toBe(
      "+1",
    );
    const notes = screen.getByTestId("status-bar-preview-notes");
    expect(notes.textContent).toContain("Folded: Claude Code 22% used");
    expect(screen.getByTestId("status-bar-preview-frame").contains(notes)).toBe(
      false,
    );
  });
});

/**
 * The width control's return leg, against a fake layout whose two boxes are
 * genuinely coupled - the room reports the room, the readings report their own
 * natural width at whatever rung is currently rendered.
 *
 * This is the property a class assertion cannot reach and the one that broke
 * first: the ladder records the width at which it stepped down and only gives
 * that step back when the room beats it. Measure a shrink-to-fit box instead
 * and the recorded width can never be beaten, so Narrow is a one-way trip and
 * the preview stays collapsed until Settings is closed and reopened.
 *
 * Density is deliberately NOT driven here (its own observer is left idle), so
 * the ceiling stays `full` and what the rungs answer to is the ROOM.
 */
describe("<StatusBarPreview /> ladder - coupled layout", () => {
  const ROOM_TESTID = "status-bar-preview-usage";
  const CONTENT_TESTID = "status-bar-preview-content";
  const RESERVED_TESTID = "status-bar-preview-reserved";

  /**
   * The refresh control's box, which the preview reserves without drawing and
   * the ladder subtracts from the room - `pl-1` plus the button's `size-5`,
   * the two numbers the strip composes it from.
   */
  const RESERVED_WIDTH_PX = 24;

  const originalScrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth",
  );
  const originalClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );
  const originalOffsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
  );
  function readOriginalWidth(
    descriptor: PropertyDescriptor | undefined,
    element: HTMLElement,
  ): number {
    const value: unknown = descriptor?.get?.call(element);
    return typeof value === "number" ? value : 0;
  }

  /** What each width option leaves the room, once the frame's chrome is off. */
  const ROOM_WIDTH_PX: Record<string, number> = {
    narrow: 478,
    normal: 898,
    wide: 5000,
  };

  /**
   * A stand-in for real text metrics: how wide one provider's reading is at
   * each rung. Not calibrated to any font - only the ORDERING is load-bearing,
   * with one exception. `percent-only` sits between the Narrow room (478) and
   * what the ladder actually measures against it (478 − 24), so it is the rung
   * that can tell the reserved box apart from nothing at all: drop the
   * placeholder and this width fits, and the preview keeps a rung the strip has
   * already given up.
   */
  const DETAIL_CONTENT_WIDTH: Record<string, number> = {
    full: 900,
    "no-mode-word": 800,
    "no-bars": 700,
    "no-timers": 600,
    "percent-only": 470,
    "icon-only": 200,
  };

  function currentDetail(): string | null {
    return (
      document
        .querySelector("[data-usage-detail]")
        ?.getAttribute("data-usage-detail") ?? null
    );
  }

  function currentContentWidth(): number {
    const match = Object.entries(DETAIL_CONTENT_WIDTH).find(
      ([name]) => name === currentDetail(),
    );
    return match === undefined ? DETAIL_CONTENT_WIDTH.full : match[1];
  }

  function roomWidth(): number {
    const width = screen
      .getByTestId("status-bar-preview-frame")
      .getAttribute("data-preview-width");
    const match = Object.entries(ROOM_WIDTH_PX).find(
      ([name]) => name === width,
    );
    return match === undefined ? ROOM_WIDTH_PX.wide : match[1];
  }

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("data-testid") === RESERVED_TESTID) {
          return RESERVED_WIDTH_PX;
        }
        return readOriginalWidth(originalOffsetWidth, this);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("data-testid") === ROOM_TESTID)
          return roomWidth();
        return readOriginalWidth(originalClientWidth, this);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("data-testid") === CONTENT_TESTID) {
          return currentContentWidth();
        }
        return readOriginalWidth(originalScrollWidth, this);
      },
    });
  });

  afterEach(() => {
    if (originalOffsetWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetWidth",
        originalOffsetWidth,
      );
    }
    if (originalScrollWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollWidth",
        originalScrollWidth,
      );
    }
    if (originalClientWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        originalClientWidth,
      );
    }
  });

  function pickWidth(label: string): void {
    fireEvent.click(screen.getByRole("button", { name: label }));
    // One rung per delivery, by design - walk the cascade out.
    for (let index = 0; index < 6; index += 1) {
      fireRoomResize();
    }
  }

  it("collapses down the ladder on Narrow and climbs all the way back on Wide", () => {
    mocks.providers = [configuredProvider("codex", "ephemeralProcess")];
    mocks.envelopes = {
      codex: envelopeFor(
        codexRateLimits({
          usedPercent: 40,
          resetsAt: null,
          durationMinutes: 300,
        }),
      ),
    };

    renderPreview(false);
    expect(currentDetail()).toBe("full");

    // `icon-only` rather than `percent-only`, and the 24px reserved box is the
    // whole difference: 470 fits the Narrow room and does not fit the room less
    // the box the strip's `↻` occupies. A preview that reserved nothing would
    // stop a rung above the strip, at the one width the control exists to show
    // what collapses first.
    pickWidth("Narrow");
    expect(currentDetail()).toBe("icon-only");

    // The return leg, and the whole point of measuring the room rather than
    // the readings. Against a content-sized room this stays where it is: once
    // `percent-only` fits, a shrink-to-fit box reports its own 400 forever,
    // which never beats the 478 recorded on the way down, so the step is never
    // given back. Stubbing this block's room width as `Math.min(room,
    // content)` - what such a box really reports - is what makes this fail.
    pickWidth("Wide");
    expect(currentDetail()).toBe("full");
  });
});
