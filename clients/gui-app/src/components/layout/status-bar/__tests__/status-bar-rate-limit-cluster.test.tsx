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
import type { StatusBarUsageDetail } from "@/components/layout/status-bar/status-bar-usage-ladder";
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
 * that is CURRENTLY watching a node, after Radix has swapped the trigger's
 * DOM subtree - has no way to run without a controllable replacement.
 * Installed at MODULE LOAD, before any test body, the technique
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

  // Pinned as its own structural check: the control that refreshes these
  // numbers has to sit BESIDE them, not a screen away against the resource
  // readout, and the room's spare width has to land to the right of both -
  // which only holds if the reserved box lives INSIDE the room, after the
  // trigger, rather than as the room's sibling. Checked by DOM structure
  // rather than class strings, since a class rename should not silently
  // stop this from failing.
  it("nests the reserved refresh box inside the room, right after the trigger", () => {
    renderCluster({});

    const room = screen.getByTestId("status-bar-rate-limit-room");
    const trigger = screen.getByTestId("status-bar-rate-limit-trigger");
    const reserved = screen.getByTestId("status-bar-rate-limit-reserved");

    expect(room.contains(trigger)).toBe(true);
    expect(room.contains(reserved)).toBe(true);
    expect(
      Boolean(
        trigger.compareDocumentPosition(reserved) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    // The default (no-providers) cluster disables the refresh with a
    // reason, but it is still rendered - and still inside the reserved box.
    const refreshButton = screen.getByRole("button", {
      name: "Refresh usage — nothing to refresh",
    });
    expect(reserved.contains(refreshButton)).toBe(true);
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
 * The collapse ladder replaces the fade this cluster used to paint over its
 * own overflow: instead of hiding what does not fit, it drops one kind of
 * detail at a time until what is left fits the room the strip has.
 *
 * jsdom reports 0 for `scrollWidth`/`clientWidth`, so a prototype override
 * keyed on the room's and content's own test ids is what lets a test put them
 * into a persistent (or non-overflowing) state before any measurement runs -
 * a value every incarnation of those boxes reads identically, remount or
 * not, which is what settles the state instead of bouncing it. The values
 * here are stubbed INDEPENDENTLY of each other, because this describe block
 * is about the ladder's WALK - the step-down sequence, folding, hysteresis -
 * not about the box model. The coupled-layout modelling that proves the box
 * CHOICE is what fixes the ratchet lives in its own describe block below.
 * The mock `ResizeObserver` never fires on its own, so every step down or up
 * in these tests is either the one automatic measurement taken on ref
 * attach, or a manually fired `act(() => instance.callback([], instance))`.
 */
describe("<StatusBarRateLimitCluster /> usage ladder", () => {
  const ROOM_TESTID = "status-bar-rate-limit-room";
  const CONTENT_TESTID = "status-bar-rate-limit-content";
  const TRIGGER_TESTID = "status-bar-rate-limit-trigger";
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
  // The room's `clientWidth` (how much room the strip has) and the content's
  // `scrollWidth` (how wide the readings want to be) are exactly the two
  // numbers the ladder reads - see `useStatusBarUsageLadder`.
  let roomClientWidth: number | null = null;
  let contentScrollWidth: number | null = null;

  beforeEach(() => {
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (
          contentScrollWidth !== null &&
          this.getAttribute("data-testid") === CONTENT_TESTID
        ) {
          return contentScrollWidth;
        }
        return readOriginalWidth(originalScrollWidth, this);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (
          roomClientWidth !== null &&
          this.getAttribute("data-testid") === ROOM_TESTID
        ) {
          return roomClientWidth;
        }
        return readOriginalWidth(originalClientWidth, this);
      },
    });
  });

  afterEach(() => {
    cleanup();
    roomClientWidth = null;
    contentScrollWidth = null;
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
  // folded-providers tooltip via `pointerMove` runs against the provider's
  // `delayDuration`, and these tests want that to be instant rather than
  // racing a real 500ms timer.
  function renderLadderCluster(props: {
    readonly tooltipDelayDuration: number;
  }) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={props.tooltipDelayDuration}>
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

  function trigger(): HTMLElement {
    return screen.getByTestId(TRIGGER_TESTID);
  }

  function room(): HTMLElement {
    return screen.getByTestId(ROOM_TESTID);
  }

  function content(): HTMLElement {
    return screen.getByTestId(CONTENT_TESTID);
  }

  function usageDetail(): string | null {
    return trigger().getAttribute("data-usage-detail");
  }

  // The observer currently watching `node` - never assumed to be the
  // last-created instance, so a reattachment bug (an old observer left on a
  // stale node) fails this lookup instead of silently exercising the wrong
  // instance.
  function observerFor(node: Element): ControllableResizeObserver {
    const instance = resizeObserverInstances.find((candidate) =>
      candidate.observed.has(node),
    );
    if (instance === undefined) {
      throw new Error("no ResizeObserver is currently observing this node");
    }
    return instance;
  }

  function isObserving(node: Element): boolean {
    return resizeObserverInstances.some((candidate) =>
      candidate.observed.has(node),
    );
  }

  // The ladder measures the ROOM for a window resize - a countdown re-render
  // is what the content's own observer is for.
  function fireRoomResize(): void {
    const instance = observerFor(room());
    act(() => {
      instance.callback([], instance);
    });
  }

  function setOverflowing(): void {
    roomClientWidth = 200;
    contentScrollWidth = 300;
  }

  function singleSegmentCluster(): void {
    mocks.cluster = {
      kind: "segments",
      segments: [
        segmentFixture(
          "codex",
          windowFixture({ windowKey: "codex:primary", usedPercent: 40 }),
        ),
      ],
    };
  }

  it("walks every rung as the room keeps overflowing", () => {
    singleSegmentCluster();
    renderLadderCluster({ tooltipDelayDuration: 0 });
    // Not overflowing yet (jsdom's default 0/0 box), so the strip starts at
    // its most detailed rung.
    expect(usageDetail()).toBe("full");

    setOverflowing();
    const sequence = [
      "no-mode-word",
      "no-bars",
      "no-timers",
      "percent-only",
      "icon-only",
    ];
    for (const expected of sequence) {
      fireRoomResize();
      expect(usageDetail()).toBe(expected);
    }
  });

  it("skips a rung whose own setting is already off", () => {
    // With the bar switched off in Settings, `no-bars` renders exactly what
    // `no-mode-word` already does, so the ladder never stands on it.
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: { ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits, showBar: false },
      },
    });
    singleSegmentCluster();
    renderLadderCluster({ tooltipDelayDuration: 0 });
    expect(usageDetail()).toBe("full");

    setOverflowing();
    fireRoomResize();
    expect(usageDetail()).toBe("no-mode-word");

    fireRoomResize();
    expect(usageDetail()).toBe("no-timers");
  });

  describe("folding", () => {
    function threeSegmentCluster(): void {
      mocks.cluster = {
        kind: "segments",
        segments: [
          segmentFixture(
            "codex",
            windowFixture({ windowKey: "codex:primary", usedPercent: 34 }),
          ),
          segmentFixture(
            "claude-code",
            windowFixture({
              windowKey: "claude-code:fiveHour",
              usedPercent: 57,
            }),
          ),
          segmentFixture(
            "grok",
            windowFixture({ windowKey: "grok:period", usedPercent: 12 }),
          ),
        ],
      };
    }

    function walkPastIconOnly(steps: number): void {
      setOverflowing();
      for (let i = 0; i < steps; i += 1) {
        fireRoomResize();
      }
    }

    it("folds the rightmost provider first, as a +1 chip", () => {
      threeSegmentCluster();
      renderLadderCluster({ tooltipDelayDuration: 0 });

      // full -> no-mode-word -> no-bars -> no-timers -> percent-only ->
      // icon-only -> icon-only+1 fold is six steps down from full.
      walkPastIconOnly(6);

      expect(usageDetail()).toBe("icon-only");
      const chip = screen.getByTestId("status-bar-folded-providers");
      expect(chip.textContent).toBe("+1");
      expect(
        screen.getByTestId("status-bar-provider-segment-codex"),
      ).not.toBeNull();
      expect(
        screen.getByTestId("status-bar-provider-segment-claude-code"),
      ).not.toBeNull();
      // Folded from the right: the last-configured provider is the first to
      // go, not codex.
      expect(
        screen.queryByTestId("status-bar-provider-segment-grok"),
      ).toBeNull();
    });

    it("folds a second provider as the chip advances to +2", () => {
      threeSegmentCluster();
      renderLadderCluster({ tooltipDelayDuration: 0 });

      walkPastIconOnly(7);

      const chip = screen.getByTestId("status-bar-folded-providers");
      expect(chip.textContent).toBe("+2");
      expect(
        screen.getByTestId("status-bar-provider-segment-codex"),
      ).not.toBeNull();
      expect(
        screen.queryByTestId("status-bar-provider-segment-claude-code"),
      ).toBeNull();
      expect(
        screen.queryByTestId("status-bar-provider-segment-grok"),
      ).toBeNull();
    });

    it("lists each folded provider with its tightest reading in the chip's tooltip", async () => {
      threeSegmentCluster();
      renderLadderCluster({ tooltipDelayDuration: 0 });

      walkPastIconOnly(7);

      const chip = screen.getByTestId("status-bar-folded-providers");
      fireEvent.pointerMove(chip);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe(
        `${providerDisplayName("claude-code")} ${windowPercentText(57, "used")}` +
          `${providerDisplayName("grok")} ${windowPercentText(12, "used")}`,
      );
    });
  });

  describe("step-up hysteresis", () => {
    it("holds the rung at exactly the slack boundary, then steps up one past it, and never oscillates at the boundary", () => {
      singleSegmentCluster();
      renderLadderCluster({ tooltipDelayDuration: 0 });
      expect(usageDetail()).toBe("full");

      // Step down twice, both recorded at the same room width.
      setOverflowing();
      fireRoomResize();
      fireRoomResize();
      expect(usageDetail()).toBe("no-bars");

      // Exactly the slack boundary (recorded 200 + 24 = 224): held, not
      // overflowing, so no step is taken in either direction.
      roomClientWidth = 224;
      contentScrollWidth = 224;
      fireRoomResize();
      expect(usageDetail()).toBe("no-bars");

      // Firing the same boundary again must not oscillate.
      fireRoomResize();
      fireRoomResize();
      expect(usageDetail()).toBe("no-bars");

      // One pixel past the boundary (225): the step is given back.
      roomClientWidth = 225;
      contentScrollWidth = 225;
      fireRoomResize();
      expect(usageDetail()).toBe("no-mode-word");
    });
  });

  it("keeps the trigger's accessible name the same summary at every rung, including while folded", () => {
    mocks.cluster = {
      kind: "segments",
      segments: [
        segmentFixture(
          "codex",
          windowFixture({ windowKey: "codex:primary", usedPercent: 34 }),
        ),
        segmentFixture(
          "claude-code",
          windowFixture({
            windowKey: "claude-code:fiveHour",
            usedPercent: 57,
          }),
        ),
      ],
    };
    renderLadderCluster({ tooltipDelayDuration: 0 });
    const expectedName = `Usage limits: ${providerDisplayName("codex")} ${windowPercentText(
      34,
      "used",
    )}, ${providerDisplayName("claude-code")} ${windowPercentText(57, "used")}`;
    expect(trigger().getAttribute("aria-label")).toBe(expectedName);

    setOverflowing();
    for (let i = 0; i < 6; i += 1) {
      fireRoomResize();
    }
    // Folded down to a +1 chip by now, and the name has not moved - a screen
    // reader hears the same summary regardless of how wide the window is.
    expect(screen.getByTestId("status-bar-folded-providers")).not.toBeNull();
    expect(trigger().getAttribute("aria-label")).toBe(expectedName);
  });

  it("still opens the popover on click at icon-only and while folded", () => {
    mocks.cluster = {
      kind: "segments",
      segments: [
        segmentFixture(
          "codex",
          windowFixture({ windowKey: "codex:primary", usedPercent: 34 }),
        ),
        segmentFixture(
          "claude-code",
          windowFixture({
            windowKey: "claude-code:fiveHour",
            usedPercent: 57,
          }),
        ),
      ],
    };
    renderLadderCluster({ tooltipDelayDuration: 0 });
    setOverflowing();
    for (let i = 0; i < 6; i += 1) {
      fireRoomResize();
    }
    expect(usageDetail()).toBe("icon-only");
    expect(screen.getByTestId("status-bar-folded-providers")).not.toBeNull();

    expect(trigger().getAttribute("data-state")).toBe("closed");
    fireEvent.click(trigger());
    expect(trigger().getAttribute("data-state")).toBe("open");
  });

  it("keeps observing the content after Radix swaps the trigger's subtree", () => {
    // `AppStatusBar` anchors the popover on its own slot span via a real
    // `PopoverAnchor`, not the trigger - and that is what actually flips
    // `PopoverTrigger`'s `hasCustomAnchor` context after mount, swapping its
    // child out from under a Popper `Anchor` wrapper on the second commit
    // (verified against this exact radix-ui version: a bare `Popover` with
    // no `PopoverAnchor` anywhere never triggers the swap at all, since
    // `hasCustomAnchor` then starts AND stays `false`). Reproducing that
    // sibling here is what actually exercises the detached-node bug, rather
    // than a `Popover` shape the swap never happens under.
    //
    // The room span sits OUTSIDE `PopoverTrigger` now, so it is never inside
    // the swapped subtree - it is the content span, nested inside the
    // trigger button `PopoverTrigger` renders, that has to survive the swap.
    singleSegmentCluster();
    setOverflowing();
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

    // Already stepped down from the persistent overflow (the initial attach
    // and the anchor swap's own reattachment both measure), which is only
    // possible if the observer followed the swap rather than being left on
    // the discarded node.
    const detailBefore = usageDetail();
    expect(detailBefore).not.toBe("full");

    // Looked up by which node it actually observes, not by creation order -
    // an observer left behind on a node Radix discarded would make this
    // lookup fail instead of silently exercising the wrong instance.
    const instance = observerFor(content());
    act(() => {
      instance.callback([], instance);
    });

    expect(usageDetail()).not.toBe(detailBefore);
  });

  it("leaves no clip affordance or mask class behind, at any rung", () => {
    singleSegmentCluster();
    renderLadderCluster({ tooltipDelayDuration: 0 });
    expect(
      screen.queryByTestId("status-bar-rate-limit-clip-affordance"),
    ).toBeNull();
    expect(trigger().className).not.toContain("mask-image");

    setOverflowing();
    for (let i = 0; i < 5; i += 1) {
      fireRoomResize();
    }
    expect(usageDetail()).toBe("icon-only");
    expect(
      screen.queryByTestId("status-bar-rate-limit-clip-affordance"),
    ).toBeNull();
    expect(trigger().className).not.toContain("mask-image");
  });

  it("S1: never measures while the cluster shows no segments, however the boxes are sized, and starts fresh at full once real segments land", () => {
    // Before the `enabled` gate, this hook measured the placeholder sentence
    // unconditionally: a width recorded against "Connect a supported
    // provider..." or "Usage hidden" would then be applied to the first
    // frame of the real segments that arrive next - a hide-all/unhide round
    // trip repainting at whatever rung that stale record implied, `icon-only`
    // in the worst case.
    mocks.cluster = { kind: "hidden" };
    setOverflowing();
    const view = renderLadderCluster({ tooltipDelayDuration: 0 });

    expect(usageDetail()).toBe("full");
    expect(isObserving(room())).toBe(false);
    expect(isObserving(content())).toBe(false);

    mocks.cluster = {
      kind: "segments",
      segments: [
        segmentFixture(
          "codex",
          windowFixture({ windowKey: "codex:primary", usedPercent: 40 }),
        ),
        segmentFixture(
          "claude-code",
          windowFixture({
            windowKey: "claude-code:fiveHour",
            usedPercent: 57,
          }),
        ),
      ],
    };
    // A room comfortably wider than the content it is about to measure, so
    // the fresh attach's own evaluate() finds nothing to drop - isolating
    // "did the reset happen" from "does a genuinely narrow room still work",
    // which the rest of this describe block already covers.
    roomClientWidth = 900;
    contentScrollWidth = 300;
    view.rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <TooltipProvider delayDuration={0}>
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

    expect(usageDetail()).toBe("full");
    expect(isObserving(room())).toBe(true);
    expect(isObserving(content())).toBe(true);
  });

  it("S2: the content box may shrink (min-w-0, no shrink-0) in the zero states, and is pinned to its natural width (shrink-0) once segments render", () => {
    mocks.cluster = { kind: "no-providers" };
    const view = renderLadderCluster({ tooltipDelayDuration: 0 });
    expect(content().className).toContain("min-w-0");
    expect(content().className).not.toContain("shrink-0");

    mocks.cluster = { kind: "hidden" };
    view.rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <TooltipProvider delayDuration={0}>
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
    expect(content().className).toContain("min-w-0");
    expect(content().className).not.toContain("shrink-0");

    mocks.cluster = {
      kind: "segments",
      segments: [
        segmentFixture(
          "codex",
          windowFixture({ windowKey: "codex:primary", usedPercent: 40 }),
        ),
      ],
    };
    view.rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false },
              mutations: { retry: false },
            },
          })
        }
      >
        <TooltipProvider delayDuration={0}>
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
    expect(content().className).toContain("shrink-0");
    expect(content().className).not.toContain("min-w-0");
  });
});

/**
 * The regression the review specifically asked for: a harness where
 * `clientWidth` is DERIVED from the rendered content and a controllable
 * available width, never stubbed as an independent number - the property a
 * pair of independent stubs (the describe block above, deliberately) cannot
 * exercise, because real boxes do not have independently adjustable widths.
 *
 * `availableWidth` stands in for the window's width. `currentContentWidth`
 * stands in for real text metrics: it reads the trigger's own
 * `data-usage-detail` and how many `status-bar-provider-segment-*` elements
 * are currently rendered, then looks the resulting width up in a fixed
 * table - a stand-in the suite documents rather than hides.
 */
describe("<StatusBarRateLimitCluster /> usage ladder - coupled layout", () => {
  const ROOM_TESTID = "status-bar-rate-limit-room";
  const CONTENT_TESTID = "status-bar-rate-limit-content";
  const TRIGGER_TESTID = "status-bar-rate-limit-trigger";
  const RESERVED_TESTID = "status-bar-rate-limit-reserved";

  // The refresh control plus its `pl-1` gap - a fixed-size box the hook
  // reads rather than observes, so a constant stand-in is exact here in a
  // way the content table's numbers only need to be ordered.
  const RESERVED_WIDTH = 24;

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

  // The window's width, as far as this fake layout is concerned - the one
  // number the test controls directly. Every box below derives its own
  // numbers from this and from what is CURRENTLY rendered.
  let availableWidth = 0;

  // A stand-in for real text metrics: how wide each rung's reading is at one
  // provider, and how much narrower the strip gets per provider folded into
  // the `+N` chip. Not calibrated to any real font - only the ORDERING
  // (each rung narrower than the last) is load-bearing for these tests.
  const DETAIL_CONTENT_WIDTH: Record<StatusBarUsageDetail, number> = {
    full: 900,
    "no-mode-word": 800,
    "no-bars": 700,
    "no-timers": 600,
    "percent-only": 400,
    "icon-only": 200,
  };
  const PER_FOLDED_PROVIDER_WIDTH = 60;

  // Looked up rather than narrowed with a cast: the attribute is whatever the
  // DOM says, and a rung name the table does not know should read as the
  // widest form rather than as `undefined` arithmetic.
  function contentWidthForDetail(detail: string | null): number {
    const match = Object.entries(DETAIL_CONTENT_WIDTH).find(
      ([name]) => name === detail,
    );
    return match === undefined ? DETAIL_CONTENT_WIDTH.full : match[1];
  }

  function currentContentWidth(): number {
    const triggerNode = document.querySelector(
      `[data-testid="${TRIGGER_TESTID}"]`,
    );
    const renderedSegments = document.querySelectorAll(
      '[data-testid^="status-bar-provider-segment-"]',
    ).length;
    const totalSegments =
      mocks.cluster.kind === "segments" ? mocks.cluster.segments.length : 0;
    const foldedCount = Math.max(0, totalSegments - renderedSegments);
    return (
      contentWidthForDetail(
        triggerNode?.getAttribute("data-usage-detail") ?? null,
      ) -
      foldedCount * PER_FOLDED_PROVIDER_WIDTH
    );
  }

  beforeEach(() => {
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    availableWidth = 0;
    // The room's own `clientWidth` stays the FULL available width - the
    // subtraction for the reserved control happens inside the hook now, so
    // pre-subtracting it here would double-count it.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        const testId = this.getAttribute("data-testid");
        if (testId === ROOM_TESTID) return availableWidth;
        // The shrink-to-fit box the OLD implementation measured: it can never
        // report more than the room gives it, and never less than its own
        // content wants - which is exactly what makes it unusable for the
        // hysteresis once that content fits.
        if (testId === TRIGGER_TESTID) {
          return Math.min(availableWidth, currentContentWidth());
        }
        return readOriginalWidth(originalClientWidth, this);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        const testId = this.getAttribute("data-testid");
        if (testId === ROOM_TESTID) {
          return Math.max(availableWidth, currentContentWidth());
        }
        if (testId === CONTENT_TESTID || testId === TRIGGER_TESTID) {
          return currentContentWidth();
        }
        return readOriginalWidth(originalScrollWidth, this);
      },
    });
    // The reserved box is fixed-size and READ rather than observed, so a
    // constant stub is enough - there is no independent state for it to
    // drift out of sync with.
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("data-testid") === RESERVED_TESTID) {
          return RESERVED_WIDTH;
        }
        return readOriginalWidth(originalOffsetWidth, this);
      },
    });
  });

  afterEach(() => {
    cleanup();
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
    if (originalOffsetWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetWidth",
        originalOffsetWidth,
      );
    }
  });

  function renderCoupledCluster() {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={0}>
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

  function singleSegmentCluster(): void {
    mocks.cluster = {
      kind: "segments",
      segments: [
        segmentFixture(
          "codex",
          windowFixture({ windowKey: "codex:primary", usedPercent: 40 }),
        ),
      ],
    };
  }

  function trigger(): HTMLElement {
    return screen.getByTestId(TRIGGER_TESTID);
  }

  function room(): HTMLElement {
    return screen.getByTestId(ROOM_TESTID);
  }

  function usageDetail(): string | null {
    return trigger().getAttribute("data-usage-detail");
  }

  function observerFor(node: Element): ControllableResizeObserver {
    const instance = resizeObserverInstances.find((candidate) =>
      candidate.observed.has(node),
    );
    if (instance === undefined) {
      throw new Error("no ResizeObserver is currently observing this node");
    }
    return instance;
  }

  function fireRoomResize(): void {
    const instance = observerFor(room());
    act(() => {
      instance.callback([], instance);
    });
  }

  it("recovers all the way back to full once the room widens, one rung per delivery - fails against the old trigger-measuring placement", () => {
    // Settling at a MODERATE rung (not the deepest one) is what makes this
    // scenario discriminate the old placement from the fix: once no-timers
    // fits, a shrink-to-fit trigger box stops being clipped by the room at
    // all and starts reporting its own content (600) instead - a number that
    // stays put however wide the room actually gets, which is precisely why
    // the old code could never climb back from here.
    singleSegmentCluster();
    const narrowWidth = 650;
    availableWidth = narrowWidth;
    renderCoupledCluster();
    for (let i = 0; i < 4; i += 1) {
      fireRoomResize();
    }
    expect(usageDetail()).toBe("no-timers");

    availableWidth = 5000;
    for (let i = 0; i < 4; i += 1) {
      fireRoomResize();
    }
    expect(usageDetail()).toBe("full");
  });

  it("bounds the shrink-to-fit trigger box by what was recorded, however wide the room later gets - the ratchet, stated as a property of the wrong box", () => {
    singleSegmentCluster();
    const narrowWidth = 650; // settles at no-timers (600) without oscillating
    availableWidth = narrowWidth;
    renderCoupledCluster();
    for (let i = 0; i < 4; i += 1) {
      fireRoomResize();
    }
    expect(usageDetail()).toBe("no-timers");

    // The window grows, but nothing has re-evaluated the ladder yet - this is
    // the instant right after a real resize event, before the next
    // `ResizeObserver` delivery.
    availableWidth = 5000;

    const contentWidthNow = currentContentWidth();
    // The trigger is shrink-to-fit: once its content fits the room, it
    // reports its OWN content rather than the room's new size - which is
    // bounded by the width that was recorded for the current rung, and can
    // therefore never itself justify climbing back up.
    expect(trigger().clientWidth).toBe(contentWidthNow);
    expect(trigger().clientWidth).toBeLessThanOrEqual(narrowWidth);
    // The room, by contrast, reports the real, much larger available width -
    // which is what lets the ladder recover in the test above.
    expect(room().clientWidth).toBe(availableWidth);
  });

  it("still settles when narrowed, with no oscillation under coupled widths", () => {
    singleSegmentCluster();
    availableWidth = 1000; // wide enough that "full" fits comfortably
    renderCoupledCluster();
    expect(usageDetail()).toBe("full");

    availableWidth = 650;
    for (let i = 0; i < 3; i += 1) {
      fireRoomResize();
    }
    expect(usageDetail()).toBe("no-timers");

    // Firing more resizes at the same width must not oscillate - the widths
    // are genuinely coupled here, unlike the independent stubs the rest of
    // this file uses to test the ladder's walk in isolation.
    for (let i = 0; i < 5; i += 1) {
      fireRoomResize();
    }
    expect(usageDetail()).toBe("no-timers");
  });

  it("the reservation is load-bearing: a room between the content width and content width + reserved forces a step down that ignoring the reservation would not", () => {
    // Room strictly between the full rung's content width (900) and that
    // same width plus the reserved control (924): the readings alone would
    // fit this room untouched, but not once the refresh control's reserved
    // width is taken out of it first.
    singleSegmentCluster();
    const contentWidth = DETAIL_CONTENT_WIDTH.full;
    availableWidth = contentWidth + Math.floor(RESERVED_WIDTH / 2);
    expect(availableWidth).toBeGreaterThan(contentWidth);
    expect(availableWidth).toBeLessThan(contentWidth + RESERVED_WIDTH);

    renderCoupledCluster();

    // A room this size never overflows on its own - it is only once the
    // hook subtracts the reserved control's width that the readings no
    // longer fit, which is exactly the step this test pins.
    expect(usageDetail()).toBe("no-mode-word");
  });
});
