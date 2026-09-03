import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import type {
  StatusBarProviderSegmentModel,
  StatusBarRateLimitCluster as StatusBarRateLimitClusterModel,
  StatusBarRateLimitRefreshModel,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import { windowPercentText } from "@/lib/rate-limits/status-bar-window-text";
import { providerDisplayName } from "@/lib/provider-ordering";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

interface MockState {
  cluster: StatusBarRateLimitClusterModel;
  refresh: StatusBarRateLimitRefreshModel;
}

const mocks = vi.hoisted<MockState>(() => ({
  cluster: { kind: "no-providers" },
  refresh: { queueTargets: [], httpRefetches: [], httpFetching: false },
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
        refresh: mocks.refresh,
      }),
    };
  },
);

vi.mock("@/hooks/rate-limits/use-rate-limit-queue-scope", () => ({
  useRateLimitQueueScope: () => null,
}));

vi.mock("@/hooks/rate-limits/use-rate-limit-queue-target-phase", () => ({
  useAnyRateLimitQueueTargetFetching: () => false,
}));

vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-mount", () => ({
  useRefreshProviderRateLimitsOnMount: () => undefined,
}));

import { StatusBarRateLimitCluster } from "@/components/layout/status-bar/status-bar-rate-limit-cluster";

/**
 * The harness's global `MockResizeObserver` never invokes its callback, so
 * the detached-node regression guard below - firing a resize on the observer
 * that is CURRENTLY watching the trigger, after Radix has swapped its DOM
 * node - has no way to run without a controllable replacement. Installed at
 * MODULE LOAD, before any test body, the technique
 * `status-bar-density.test.tsx` and `stable-tile-surface-host.test.tsx` use.
 */
class ControllableResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();
  disconnectCount = 0;

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
    this.disconnectCount += 1;
    this.observed.clear();
  }
}

let resizeObserverInstances: ControllableResizeObserver[] = [];

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: ControllableResizeObserver,
});

const PROFILE_SELECTION: RateLimitProfileSelection = {
  activeChatSettings: null,
  lastProfileByHarness: {},
};

function segmentFixture(
  providerId: ConfiguredRateLimitProvider["providerId"],
  tightest: StatusBarRateLimitWindow | null,
): StatusBarProviderSegmentModel {
  return {
    providerId,
    state: "live",
    reason: null,
    windows: tightest === null ? [] : [tightest],
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
    severity: "healthy",
  };
}

function renderCluster(props: {
  readonly providers?: ReadonlyArray<ConfiguredRateLimitProvider>;
  readonly density?: "full" | "compact" | "icon-only";
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
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
            providers={props.providers ?? []}
            density={props.density ?? "full"}
            profileSelection={PROFILE_SELECTION}
          />
        </Popover>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
});

afterEach(() => {
  cleanup();
  mocks.cluster = { kind: "no-providers" };
  mocks.refresh = { queueTargets: [], httpRefetches: [], httpFetching: false };
  useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
});

describe("<StatusBarRateLimitCluster />", () => {
  it("opens the panel its trigger is wired to when clicked", () => {
    renderCluster({});

    const trigger = screen.getByTestId("status-bar-rate-limit-trigger");
    expect(trigger.getAttribute("data-state")).toBe("closed");

    fireEvent.click(trigger);

    expect(trigger.getAttribute("data-state")).toBe("open");
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
        queueTargets: [{ providerId: "codex", profileId: null }],
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
      useLayoutStore.setState({
        statusBar: {
          ...DEFAULT_STATUS_BAR_LAYOUT,
          rateLimits: {
            ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
            percentMode: "remaining",
          },
        },
      });
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
 * `useStatusBarContentOverflow`'s `useLayoutEffect` has NO dependency array,
 * so it re-measures on every commit - and the trigger button is remounted
 * once regardless of any of that: Radix's `PopoverTrigger` registers its
 * Popper anchor in an effect, wrapping its child in that anchor only from the
 * SECOND commit onward, which changes the element type at that DOM position
 * and forces React to discard the first button and mount a fresh one
 * underneath the ref. A one-shot `Object.defineProperty` on that node is lost
 * the instant that happens, so instead of poking one instance this suite
 * overrides `scrollWidth`/`clientWidth` on `HTMLElement.prototype` for the
 * trigger's own test id - a value every incarnation of that button reads
 * identically, remount or not, which is what settles the state instead of
 * bouncing it.
 */
describe("<StatusBarRateLimitCluster /> content-overflow clip", () => {
  const TRIGGER_TESTID = "status-bar-rate-limit-trigger";
  const AFFORDANCE_TESTID = "status-bar-rate-limit-clip-affordance";
  const originalScrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth",
  );
  const originalClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );
  function readOriginalWidth(
    descriptor: PropertyDescriptor | undefined,
    element: HTMLElement,
  ): number {
    const value: unknown = descriptor?.get?.call(element);
    return typeof value === "number" ? value : 0;
  }
  let triggerBoxWidths: {
    readonly scrollWidth: number;
    readonly clientWidth: number;
  } | null = null;

  beforeEach(() => {
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    mocks.cluster = {
      kind: "segments",
      segments: [
        segmentFixture(
          "codex",
          windowFixture({ windowKey: "codex:primary", usedPercent: 40 }),
        ),
      ],
    };
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (
          triggerBoxWidths !== null &&
          this.getAttribute("data-testid") === TRIGGER_TESTID
        ) {
          return triggerBoxWidths.scrollWidth;
        }
        return readOriginalWidth(originalScrollWidth, this);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (
          triggerBoxWidths !== null &&
          this.getAttribute("data-testid") === TRIGGER_TESTID
        ) {
          return triggerBoxWidths.clientWidth;
        }
        return readOriginalWidth(originalClientWidth, this);
      },
    });
  });

  afterEach(() => {
    cleanup();
    triggerBoxWidths = null;
    resizeObserverInstances = [];
    mocks.cluster = { kind: "no-providers" };
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
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

  // A dedicated helper rather than reusing `renderCluster`: opening the
  // affordance's tooltip via `pointerMove` (Radix's real open path, since the
  // affordance is `aria-hidden` and cannot take focus) runs against the
  // provider's `delayDuration`, and these tests want that to be instant
  // rather than racing a real 500ms timer.
  function renderClippableCluster(tooltipDelayDuration: number) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={tooltipDelayDuration}>
          <Popover>
            <StatusBarRateLimitCluster
              providers={[]}
              density="full"
              profileSelection={PROFILE_SELECTION}
            />
          </Popover>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it("clips the trigger and offers a tooltip carrying its own summary once it overflows", async () => {
    triggerBoxWidths = { scrollWidth: 300, clientWidth: 200 };
    renderClippableCluster(0);

    const trigger = screen.getByTestId(TRIGGER_TESTID);
    expect(trigger.getAttribute("data-clipped")).toBe("true");

    // The affordance, not the button, is the summary's trigger now - it is
    // `aria-hidden` and never focusable, so `pointerMove` is the only way in
    // (Radix opens a hover-driven tooltip on `pointermove`, not `mouseover`).
    fireEvent.pointerMove(screen.getByTestId(AFFORDANCE_TESTID));
    const tooltip = await screen.findByRole("tooltip");
    // The same sentence in both places on purpose - the tooltip gives back
    // exactly what the mask took, nothing more and nothing less.
    expect(tooltip.textContent).toBe(trigger.getAttribute("aria-label"));
  });

  it("leaves the trigger unclipped, still mounts the affordance, and opens nothing on its own", () => {
    triggerBoxWidths = { scrollWidth: 200, clientWidth: 200 };
    renderClippableCluster(0);

    const trigger = screen.getByTestId(TRIGGER_TESTID);
    expect(trigger.getAttribute("data-clipped")).toBe("false");

    // The affordance is CSS-gated (`pointer-events-none` unless
    // `group-data-[clipped=true]`), not React-gated, so it is present in the
    // DOM either way - only a real cursor's hit-testing would ever fail to
    // reach it while unclipped, which a synthetic `pointerMove` in this
    // environment does not model. What IS true regardless: nothing has
    // opened its tooltip without an interaction to open it.
    expect(screen.getByTestId(AFFORDANCE_TESTID)).not.toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("hovering a provider segment's icon opens only that segment's own tooltip while the trigger is clipped", async () => {
    triggerBoxWidths = { scrollWidth: 300, clientWidth: 200 };
    renderClippableCluster(0);

    const trigger = screen.getByTestId(TRIGGER_TESTID);
    expect(trigger.getAttribute("data-clipped")).toBe("true");

    const segment = screen.getByTestId("status-bar-provider-segment-codex");
    const icon = segment.querySelector("svg");
    if (icon === null) {
      throw new Error("provider segment did not render its icon");
    }
    fireEvent.pointerMove(icon);

    // With the summary anchored to the whole button, hovering any provider
    // icon used to open it alongside that segment's own tooltip, a few
    // pixels apart. The summary now hangs off the affordance alone, which
    // sits outside the segment's own DOM subtree, so only one opens.
    const tooltips = await screen.findAllByRole("tooltip");
    expect(tooltips).toHaveLength(1);
    expect(tooltips[0].textContent).toBe(providerDisplayName("codex"));
  });

  it("re-measures the currently mounted trigger after Radix replaces its DOM node", () => {
    // `AppStatusBar` anchors the popover on its own slot span via a real
    // `PopoverAnchor`, not the trigger - and that is what actually flips
    // `PopoverTrigger`'s `hasCustomAnchor` context after mount, swapping the
    // button out from under a Popper `Anchor` wrapper on the second commit
    // (verified against this exact radix-ui version: a bare `Popover` with
    // no `PopoverAnchor` anywhere never triggers the swap at all, since
    // `hasCustomAnchor` then starts AND stays `false`). Reproducing that
    // sibling here is what actually exercises the detached-node bug, rather
    // than a `Popover` shape the swap never happens under.
    triggerBoxWidths = { scrollWidth: 300, clientWidth: 200 };
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
              providers={[]}
              density="full"
              profileSelection={PROFILE_SELECTION}
            />
          </Popover>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    const trigger = screen.getByTestId(TRIGGER_TESTID);
    expect(trigger.getAttribute("data-clipped")).toBe("true");

    // Looked up by which node it actually observes, not by creation order -
    // an observer left behind on the button Radix discarded would make this
    // lookup fail instead of silently exercising the wrong instance. This is
    // what makes the assertion below fail against an implementation that
    // watches only the first-commit node: no currently-tracked observer
    // would have the CURRENT trigger in its `observed` set.
    const instance = resizeObserverInstances.find((candidate) =>
      candidate.observed.has(trigger),
    );
    if (instance === undefined) {
      throw new Error("no ResizeObserver is currently observing the trigger");
    }

    // A resize with no re-render in between: only the observer can catch
    // this, which is exactly the case `PopoverTrigger`'s anchor swap used to
    // break - an observer stuck on a detached node never fires again.
    triggerBoxWidths = { scrollWidth: 200, clientWidth: 200 };
    act(() => {
      instance.callback([], instance);
    });

    expect(trigger.getAttribute("data-clipped")).toBe("false");
  });
});
