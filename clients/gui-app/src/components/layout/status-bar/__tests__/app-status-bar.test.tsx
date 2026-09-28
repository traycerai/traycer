import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { GlobalResourceProjection } from "@/stores/resources/resources-registry";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { StatusBarRateLimitCluster as StatusBarRateLimitClusterModel } from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import { useWatchHostStore } from "@/stores/host-scope/watch-host-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import type { LayoutArrangement } from "@/lib/layout/layout-arrangement";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  dispatchAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";

/**
 * The strip depends on the host SCOPE, not on the six hooks it composes, so
 * this suite mocks at that boundary — the same seam every host-scoped panel
 * suite uses, and for the same reason.
 */
let scope: HostScope = hostScopeFixture({});

/**
 * The rate-limit cluster mounts inside the strip now, so this suite has to
 * stand in for its whole hook chain the same way it already stands in for the
 * host-scope one above - otherwise `useHostClient()` throws over the `null`
 * binding this suite hands every other surface (see the `@/lib/host` mock
 * below).
 */
let windowedProviders: ReadonlyArray<ConfiguredRateLimitProvider> = [];
let rateLimitCluster: StatusBarRateLimitClusterModel = { kind: "no-providers" };

function resetRateLimitMocks(): void {
  windowedProviders = [];
  rateLimitCluster = { kind: "no-providers" };
}

vi.mock(
  "@/hooks/rate-limits/use-status-bar-rate-limit-segments",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-status-bar-rate-limit-segments")
      >();
    return {
      ...actual,
      useStatusBarWindowedProviders: () => windowedProviders,
      useStatusBarRateLimitSegments: () => ({
        cluster: rateLimitCluster,
        mountTargets: [],
        refresh: {
          ephemeralTargets: [],
          ephemeralFetching: false,
          httpRefetches: [],
          httpFetching: false,
        },
      }),
    };
  },
);

vi.mock(
  "@/hooks/rate-limits/use-rate-limit-profile-selection",
  async (original) => ({
    ...(await original<
      typeof import("@/hooks/rate-limits/use-rate-limit-profile-selection")
    >()),
    useRateLimitProfileSelection: () => ({
      shownProfiles: {},
      lastProfileByHarness: {},
    }),
  }),
);

vi.mock("@/hooks/rate-limits/use-provider-rate-limit-fetch-scope", () => ({
  useProviderRateLimitFetchScope: () => null,
}));

vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-mount", () => ({
  useRefreshProviderRateLimitsOnMount: () => undefined,
}));

interface PopoverStubProps {
  readonly side: "top" | "bottom";
  readonly align: "start" | "end";
}

let lastPopoverProps: PopoverStubProps | null = null;

vi.mock("@/components/layout/header/rate-limit-popover", async () => {
  const { PopoverContent } = await import("@/components/ui/popover");
  return {
    RateLimitPopover: (props: PopoverStubProps) => {
      lastPopoverProps = { side: props.side, align: props.align };
      return (
        <PopoverContent
          data-testid="rate-limit-popover-stub"
          data-side={props.side}
          data-align={props.align}
        />
      );
    },
  };
});

vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (original) => ({
    ...(await original<
      typeof import("@/components/settings/host-scope/use-host-scope")
    >()),
    useHostScopeFor: () => scope,
  }),
);

// Both re-providers resolve real transports. This suite is about WHICH
// children mount, so they stand down to the ambient binding — the same value
// production falls back to when a pick has not resolved its own client.
vi.mock("@/components/settings/host-scope/use-scoped-host-binding", () => ({
  useScopedHostBinding: () => null,
}));

vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));

// The popover owns the always-mounted `resources.subscribe` stream and a
// panel with its own host model; here it stands in for "the resource surface
// is mounted", with the segment it was handed rendered as its trigger.
//
// The trigger SEAM is reproduced rather than stubbed out: the real popover
// hands `triggerNode` to `PopoverTrigger asChild`, and that composition is
// what a wrapper placed between the two would break - the segment would still
// be on screen and would no longer open anything. So the stand-in opens a real
// popover from the node it was handed, and the left-click test below is a test
// of the strip's own composition.
vi.mock("@/components/resources/resource-monitor-popover", async () => {
  const { Popover, PopoverContent, PopoverTrigger } =
    await import("@/components/ui/popover");
  return {
    ResourceMonitorPopover: (props: {
      readonly trigger: string;
      readonly triggerNode: React.ReactElement;
      readonly contentSide?: string;
      readonly claimsOpenAction: boolean;
    }) => (
      <div
        data-testid="resource-monitor-popover"
        data-side={props.contentSide}
        // Whether THIS mount registers `app.resources.open` is the strip's
        // decision, made here and honoured there; the popover's own suite owns
        // the honouring half.
        data-claims-open-action={String(props.claimsOpenAction)}
      >
        <Popover>
          <PopoverTrigger asChild>{props.triggerNode}</PopoverTrigger>
          <PopoverContent data-testid="resource-monitor-panel" />
        </Popover>
      </div>
    ),
  };
});

// The quick-verb menu the resource segment now carries (L-144) reaches the
// router for "Customize layout...". Everything else in the module stays real.
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigateMock,
}));

// A projection and a desktop reading are the segment's data sources. Empty by
// default, so most suites never assert a number and the segment renders its
// dashes (`status-bar-resource-reading.test.ts` owns the readings themselves).
// A settable value lets the unresolved-pick suite prove attribution instead of
// just absence of a number.
const resourceProjection: { value: GlobalResourceProjection | null } = {
  value: null,
};

vi.mock("@/stores/resources/resources-registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/resources/resources-registry")
    >();
  return {
    ...actual,
    useGlobalResourceProjection: () =>
      resourceProjection.value ?? actual.EMPTY_GLOBAL_RESOURCE_PROJECTION,
  };
});

vi.mock("@/hooks/resources/use-desktop-app-resource-usage", () => ({
  useDesktopAppResourceUsage: () => null,
}));

vi.mock("@/hooks/resources/use-global-resources-unsupported", () => ({
  useGlobalResourcesUnsupported: () => false,
}));

import { AppStatusBar } from "@/components/layout/status-bar/app-status-bar";

const HOST_A = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
const HOST_B = hostScopeOptionFixture({
  hostId: "host-b",
  name: "Office Linux",
  isLocalMachine: false,
});

const GIB = 1024 * 1024 * 1024;

/**
 * A projection carrying real numbers, attributed to `hostId` - built the same
 * shape `status-bar-resource-segment.test.tsx` uses, so a foreign-host figure
 * ("12%") is unambiguous if it ever leaks through attribution.
 */
function liveHostTreeProjection(hostId: string): GlobalResourceProjection {
  return {
    hostId,
    sampledAt: 1,
    app: {
      sampledAt: 1,
      hostTotalMemoryBytes: 16 * GIB,
      process: null,
      processCount: 3,
      cpuPercent: 4,
      rssBytes: 256 * 1024 * 1024,
      pssBytes: null,
      privateBytes: null,
    },
    hostTree: {
      sampledAt: 1,
      processCount: 14,
      cpuPercent: 12,
      rssBytes: GIB,
      pssBytes: null,
      privateBytes: null,
    },
    other: null,
    restricted: null,
    owners: [],
    entries: [],
  };
}

// `app.rate-limits.open` has one dynamic handler slot; dispatching through
// this router is the same idiom the cluster suite used before its chord
// coverage moved to the bar, which now owns the registration.
const DYNAMIC_ACTION_ROUTER: KeybindingRouter = {
  getPathname: () => "/",
  navigateHome: () => undefined,
  navigateSettings: () => undefined,
  navigateToEpic: () => undefined,
  navigateToEpicTab: () => undefined,
  navigateToEpicList: () => undefined,
  navigateSettingsSection: () => undefined,
  navigateToTabIntent: () => undefined,
  goBack: () => undefined,
  goForward: () => undefined,
  isHistoryNavAvailable: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
};

afterEach(() => {
  lastPopoverProps = null;
});

describe("<AppStatusBar />", () => {
  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  afterEach(() => {
    cleanup();
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  it("renders the live resource surface while following the active host", () => {
    render(<AppStatusBar />);

    expect(screen.getByTestId("app-status-bar")).not.toBeNull();
    expect(screen.getByTestId("resource-monitor-popover")).not.toBeNull();
    expect(screen.getByTestId("status-bar-resource-segment")).not.toBeNull();
    expect(screen.queryByTestId("status-bar-host-unavailable")).toBeNull();
    // The left slot is reserved now so the right cluster does not shift when
    // the provider segments land.
    expect(screen.getByTestId("status-bar-rate-limit-slot")).not.toBeNull();
  });

  it("opens the resource panel upward, out of the strip", () => {
    render(<AppStatusBar />);

    expect(
      screen.getByTestId("resource-monitor-popover").getAttribute("data-side"),
    ).toBe("top");
  });

  it("owns the bottom safe-area inset without shrinking its own row", () => {
    // `#root` reserves the top and both sides app-wide and deliberately not the
    // bottom. `pb-safe-bottom` on an `h-6` box would make the inset EAT the row
    // rather than extend past it, so the two live on separate boxes.
    render(<AppStatusBar />);

    const bar = screen.getByTestId("app-status-bar");
    expect(bar.className).toContain("pb-safe-bottom");
    expect(bar.className).not.toContain("h-6");
    expect(bar.firstElementChild?.className).toContain("h-6");
  });

  it("keeps the resource popover and segment mounted beside the host notice for an unreachable pick", () => {
    // Gated on the PREFERENCE only, never the pick - the mirror of the usage
    // panel above. `ResourceMonitorPopover` is the sole registrant of
    // `app.resources.open` and the only thing that renders the resource
    // panel's own "can't reach this host" notice, so unmounting it under an
    // unresolved pick would take the chord and the explanation away exactly
    // when they are wanted. Nothing leaks by staying mounted: the popover
    // opens no stream under an unresolved pick (its own `streamBoundToScope`
    // gate - see `resource-monitor-popover.test.tsx`), and the segment reads
    // dashes rather than the active host's numbers (the test right below).
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A, HOST_B],
      host: HOST_B,
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "unreachable",
    });

    render(<AppStatusBar />);

    expect(screen.getByTestId("status-bar-host-unavailable")).not.toBeNull();
    expect(screen.getByText("Can't reach Office Linux")).not.toBeNull();
    expect(screen.getByTestId("resource-monitor-popover")).not.toBeNull();
    expect(screen.getByTestId("status-bar-resource-segment")).not.toBeNull();
    // The notice keeps its own way out: nothing else in the strip can drop the
    // pick, so hiding that button would strand the user here.
    expect(
      screen.getByTestId("status-bar-host-return-to-active"),
    ).not.toBeNull();
  });

  it("draws no numbers from the ambient projection under an unresolved pick", () => {
    // The registry publishes ONE projection for the window - the active
    // host's, since the picked host cannot serve a stream of its own here.
    // Attribution strips it before the segment ever reads a number: real
    // data, a foreign host id, dashes on screen - never Office Linux wearing
    // Host A's readings.
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A, HOST_B],
      host: HOST_B,
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "unreachable",
    });
    resourceProjection.value = liveHostTreeProjection("host-a");

    render(<AppStatusBar />);

    expect(screen.getAllByText("cpu: unavailable")).toHaveLength(1);
    expect(screen.queryByText("12%")).toBeNull();
  });

  it("names a vanished pick for what it is", () => {
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A],
      host: null,
      hostLabel: "Office Linux",
      vanishedHostId: "host-b",
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "vanished",
    });

    render(<AppStatusBar />);

    expect(
      screen.getByText("Office Linux is no longer connected"),
    ).not.toBeNull();
  });

  it("returns to the active host from the notice", () => {
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A, HOST_B],
      host: HOST_B,
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "unreachable",
      returnToActive: () => useWatchHostStore.getState().setScopedHostId(null),
    });

    render(<AppStatusBar />);
    fireEvent.click(screen.getByTestId("status-bar-host-return-to-active"));

    expect(useWatchHostStore.getState().scopedHostId).toBeNull();
  });

  it("offers no return while a pick is still connecting", () => {
    // `connecting` needs a moment, not an action - the difference the three
    // notice arms exist to carry.
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A, HOST_B],
      host: HOST_B,
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "connecting",
    });

    render(<AppStatusBar />);

    expect(screen.getByTestId("status-bar-host-connecting")).not.toBeNull();
    expect(screen.queryByTestId("status-bar-host-return-to-active")).toBeNull();
  });

  it("keeps the segments live for an unreachable ACTIVE host, with no pick", () => {
    // Without a pick there is no second host to confuse this one with, and an
    // `unreachable` active host is the routine blip the stream rides out.
    // Blanking here would cost every single-host user a working strip.
    scope = hostScopeFixture({ status: "unreachable" });

    render(<AppStatusBar />);

    expect(screen.getByTestId("status-bar-resource-segment")).not.toBeNull();
    expect(screen.queryByTestId("status-bar-host-unavailable")).toBeNull();
  });

  it("hides the resource segment when the preference is off", () => {
    useLayoutStore
      .getState()
      .setRegionValues("resourceMonitor", { shown: "hidden" });

    render(<AppStatusBar />);

    // The popover goes with it: it is the stream owner, so leaving it mounted
    // would keep sampling a host for a readout nobody asked for.
    expect(screen.queryByTestId("resource-monitor-popover")).toBeNull();
    // And the strip keeps its reserved usage slot rather than collapsing: the
    // segment is the only thing this preference governs.
    expect(screen.getByTestId("status-bar-rate-limit-slot")).not.toBeNull();
  });

  it("hides the rate-limit cluster when the preference is off, while the reserved slot stays", () => {
    windowedProviders = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ];
    rateLimitCluster = {
      kind: "segments",
      segments: [
        {
          providerId: "codex",
          profileId: null,
          account: null,
          hidden: false,
          state: "live",
          reason: null,
          windows: [],
          shown: [],
          tightest: null,
        },
      ],
    };
    useLayoutStore
      .getState()
      .setRegionValues("usageLimits", { shown: "hidden" });

    render(<AppStatusBar />);

    expect(screen.getByTestId("status-bar-rate-limit-slot")).not.toBeNull();
    expect(screen.queryByTestId("status-bar-rate-limit-trigger")).toBeNull();
  });
});

describe("<AppStatusBar /> usage panel chord", () => {
  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  afterEach(() => {
    cleanup();
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  // The panel and its chord live above the gate that hides the segments, so
  // it stays reachable in every state the segments themselves do not survive
  // - usage switched off in Settings, or a pick that cannot be reached.

  it("opens the panel through the chord while usageLimits.shown is hidden, with the cluster absent", () => {
    useLayoutStore
      .getState()
      .setRegionValues("usageLimits", { shown: "hidden" });

    render(<AppStatusBar />);

    expect(screen.queryByTestId("status-bar-rate-limit-trigger")).toBeNull();
    expect(screen.queryByTestId("rate-limit-popover-stub")).toBeNull();

    act(() => {
      expect(
        dispatchAction("app.rate-limits.open", DYNAMIC_ACTION_ROUTER),
      ).toBe(true);
    });

    expect(screen.getByTestId("rate-limit-popover-stub")).not.toBeNull();
  });

  it("opens the panel through the chord under an unresolved pick, with the notice showing and no cluster", () => {
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A, HOST_B],
      host: HOST_B,
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "unreachable",
    });

    render(<AppStatusBar />);

    expect(screen.getByTestId("status-bar-host-unavailable")).not.toBeNull();
    expect(screen.queryByTestId("status-bar-rate-limit-trigger")).toBeNull();
    expect(screen.queryByTestId("rate-limit-popover-stub")).toBeNull();

    act(() => {
      expect(
        dispatchAction("app.rate-limits.open", DYNAMIC_ACTION_ROUTER),
      ).toBe(true);
    });

    expect(screen.getByTestId("rate-limit-popover-stub")).not.toBeNull();
    expect(screen.getByTestId("status-bar-host-unavailable")).not.toBeNull();
  });

  it("hands the panel side=top and align=start, the strip's own placement", () => {
    render(<AppStatusBar />);

    act(() => {
      dispatchAction("app.rate-limits.open", DYNAMIC_ACTION_ROUTER);
    });

    expect(lastPopoverProps).toEqual({ side: "top", align: "start" });
  });

  it('suppresses title-bar dragging under the id "rate-limits" only while the usage panel is open', () => {
    render(<AppStatusBar />);

    expect(useTitleBarDragStore.getState().suppressors.has("rate-limits")).toBe(
      false,
    );

    act(() => {
      dispatchAction("app.rate-limits.open", DYNAMIC_ACTION_ROUTER);
    });

    expect(useTitleBarDragStore.getState().suppressors.has("rate-limits")).toBe(
      true,
    );

    // The header trigger's own id, and mutually exclusive by placement - the
    // strip owns it while its panel is open, and hands it back when the panel
    // closes, same as the resource popover does for its own key.
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(useTitleBarDragStore.getState().suppressors.has("rate-limits")).toBe(
      false,
    );
  });
});

describe("<AppStatusBar /> host controls", () => {
  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  afterEach(() => {
    cleanup();
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  it("carries no host switcher and names no host while the pick is resolved", () => {
    // The two panels the strip opens each end their list in a `HostSwitcher`
    // over this same pick, so a third control here would be a third writer of
    // one value - and a read-only name beside them would be a fourth reader of
    // it with no way to act on what it says.
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A, HOST_B],
      host: HOST_B,
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "ready",
    });
    resourceProjection.value = liveHostTreeProjection("host-b");

    render(<AppStatusBar />);

    // The readings prove the strip IS watching Office Linux - so the absent
    // name below is a deliberate omission rather than an unresolved pick.
    expect(screen.getByText("12%")).not.toBeNull();
    expect(screen.queryByTestId("settings-host-switcher")).toBeNull();
    expect(screen.queryByText("Office Linux")).toBeNull();
  });
});

describe("<AppStatusBar /> right-click visibility menu", () => {
  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
    useLayoutEditorStore.getState().endSession();
  });

  afterEach(() => {
    cleanup();
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
    useLayoutEditorStore.getState().endSession();
    navigateMock.mockClear();
  });

  function twoWindowedProviders(): ReadonlyArray<ConfiguredRateLimitProvider> {
    return [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
      {
        providerId: "claude-code",
        lane: "ephemeralProcess",
        profiles: [],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ];
  }

  it("opens on the bar's own surface and lists the watched host's windowed providers", () => {
    windowedProviders = twoWindowedProviders();
    render(<AppStatusBar />);

    fireEvent.contextMenu(screen.getByTestId("app-status-bar"));

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Codex" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Claude Code" }),
    ).not.toBeNull();
  });

  it("does not open from a right-click on the rate-limit trigger", () => {
    windowedProviders = twoWindowedProviders();
    rateLimitCluster = { kind: "hidden" };
    render(<AppStatusBar />);

    fireEvent.contextMenu(screen.getByTestId("status-bar-rate-limit-trigger"));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  /**
   * The resource readout answers with its OWN verbs (L-144).
   *
   * The bar's menu stands down over it - it is the resource popover's trigger,
   * and the bar's own quick verbs name `usageLimits`, the segment beside this
   * one - so for as long as the segment had no menu of its own it was the one
   * piece of the strip that answered no right-click at all.
   *
   * Nested Radix triggers do not both fire: the inner one defaults the shared
   * event prevented before the outer trigger's composed opener runs.
   */
  it("answers a right-click on the resource segment with the resource monitor's verbs", () => {
    windowedProviders = twoWindowedProviders();
    render(<AppStatusBar />);

    fireEvent.contextMenu(screen.getByTestId("status-bar-resource-segment"));

    expect(
      screen.getByTestId("layout-quick-verb-resourceMonitor-hide"),
    ).not.toBeNull();
    expect(screen.getByTestId("customize-layout-menu-item")).not.toBeNull();
    // The bar's menu, not the segment's: its provider checkboxes and its own
    // region's verbs are what must NOT be on screen here.
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Codex" }),
    ).toBeNull();
    expect(
      screen.queryByTestId("layout-quick-verb-usageLimits-hide"),
    ).toBeNull();
  });

  it("answers the same right-click while the layout editor is open", () => {
    // LV2-05 / L-129: the verbs are wanted in a session at least as much as at
    // rest, and that is where they used to be firewalled.
    windowedProviders = twoWindowedProviders();
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });
    render(<AppStatusBar />);

    fireEvent.contextMenu(screen.getByTestId("status-bar-resource-segment"));

    expect(
      screen.getByTestId("layout-quick-verb-resourceMonitor-hide"),
    ).not.toBeNull();
  });

  it("leaves the left click on the resource segment to the panel", () => {
    // The menu wraps the POPOVER, never the node the popover hands to
    // `PopoverTrigger asChild` - a Radix root in that slot would swallow the
    // trigger's props and the readout would open nothing.
    windowedProviders = twoWindowedProviders();
    render(<AppStatusBar />);
    expect(screen.queryByTestId("resource-monitor-panel")).toBeNull();

    fireEvent.click(screen.getByTestId("status-bar-resource-segment"));

    expect(screen.getByTestId("resource-monitor-panel")).not.toBeNull();
  });

  it("offers no providers for an unresolved pick, but still opens", () => {
    // The notice replaces the cluster for an unresolved pick, so the menu's
    // own provider list must reflect that too - offering providers the strip
    // cannot actually show would let the menu promise something the segments
    // beside it never deliver.
    windowedProviders = twoWindowedProviders();
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A, HOST_B],
      host: HOST_B,
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "unreachable",
    });

    render(<AppStatusBar />);

    fireEvent.contextMenu(screen.getByTestId("app-status-bar"));

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Codex" }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Claude Code" }),
    ).toBeNull();
    // The fixed items (unrelated to providers) stay.
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Resource monitor" }),
    ).not.toBeNull();
  });

  it("shows no per-provider checkboxes when rate limits are disabled in Settings, while Resource monitor stays", () => {
    // With usage switched off there is no segment for a per-provider checkbox
    // to govern - it would toggle a preference with no visible effect.
    windowedProviders = twoWindowedProviders();
    useLayoutStore
      .getState()
      .setRegionValues("usageLimits", { shown: "hidden" });

    render(<AppStatusBar />);

    fireEvent.contextMenu(screen.getByTestId("app-status-bar"));

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Codex" }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Claude Code" }),
    ).toBeNull();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Resource monitor" }),
    ).not.toBeNull();
  });

  it("does not open from a right-click on the notice's return-to-active button", () => {
    // Mirrors the two trigger exemptions above, and it is the last of the
    // three: the notice's own button is the one way out of this state, so the
    // bar's menu stands down over it too.
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A, HOST_B],
      host: HOST_B,
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "unreachable",
    });

    render(<AppStatusBar />);

    fireEvent.contextMenu(
      screen.getByTestId("status-bar-host-return-to-active"),
    );

    expect(screen.queryByRole("menu")).toBeNull();
  });
});

/**
 * The strip on a phone, where it is opt-in and the mobile header keeps its own
 * gauge beside it. It draws exactly what a desktop strip draws - the readings
 * scroll under a finger rather than being cut down for the width - and it
 * does not claim a chord the header is still holding.
 */
describe("<AppStatusBar /> on a mobile viewport", () => {
  const DESKTOP_VIEWPORT_WIDTH = 1280;
  const MOBILE_VIEWPORT_WIDTH = 390;

  function setViewportWidth(width: number): void {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: width,
    });
  }

  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  afterEach(() => {
    cleanup();
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  it("draws the same full readings on a phone as on a desktop window", () => {
    // Nothing about the viewport decides what the strip draws: every drawn
    // account's segment is in the DOM at every width, each printing every
    // part the display switches ask for, and what does not fit scrolls.
    windowedProviders = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
      {
        providerId: "claude-code",
        lane: "ephemeralProcess",
        profiles: [],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ];
    const codexWindow = {
      windowKey: "codex:primary",
      label: "5h",
      labelIsDuration: true,
      kind: "session",
      usedPercent: 34,
      resetsAt: null,
      severity: "healthy",
    } as const;
    const claudeWindow = {
      ...codexWindow,
      windowKey: "claude-code:fiveHour",
      usedPercent: 57,
    };
    rateLimitCluster = {
      kind: "segments",
      segments: [
        {
          providerId: "codex",
          profileId: null,
          account: null,
          hidden: false,
          state: "live",
          reason: null,
          windows: [codexWindow],
          shown: [codexWindow],
          tightest: codexWindow,
        },
        {
          providerId: "claude-code",
          profileId: null,
          account: null,
          hidden: false,
          state: "live",
          reason: null,
          windows: [claudeWindow],
          shown: [claudeWindow],
          tightest: claudeWindow,
        },
      ],
    };

    // The same readings, part by part, on both viewports: the percentage,
    // the mode word and the window's label in the text, and one mini bar per
    // reading - with every account drawn and none folded away.
    function expectFullReadings(): void {
      expect(
        screen
          .getAllByTestId(/^status-bar-provider-segment-/)
          .map((segment) => segment.getAttribute("data-provider-id")),
      ).toEqual(["codex", "claude-code"]);
      expect(screen.queryByTestId("status-bar-folded-providers")).toBeNull();
      expect(
        screen.getByTestId("status-bar-window-codex:primary").textContent,
      ).toBe("34% used 5h");
      expect(
        screen.getByTestId("status-bar-window-claude-code:fiveHour")
          .textContent,
      ).toBe("57% used 5h");
      expect(
        screen
          .getAllByTestId("status-bar-provider-mini-bar")
          .map((bar) => bar.getAttribute("data-window-key")),
      ).toEqual(["codex:primary", "claude-code:fiveHour"]);
    }

    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    const desktop = render(<AppStatusBar />);
    expectFullReadings();
    desktop.unmount();

    setViewportWidth(MOBILE_VIEWPORT_WIDTH);
    render(<AppStatusBar />);
    expectFullReadings();
  });

  it("leaves app.rate-limits.open to the header it is sharing the screen with", () => {
    // The slot holds ONE handler and an unregister clears only its own, so a
    // strip that registered here would displace the mobile header's and then
    // - unmounting for the keyboard or the drawer - take the chord away
    // outright, with the header button still on screen and its effect long
    // past re-running. Nothing is lost: the cluster's own trigger is a tap
    // away, and it opens the same panel.
    setViewportWidth(MOBILE_VIEWPORT_WIDTH);

    render(<AppStatusBar />);

    act(() => {
      expect(
        dispatchAction("app.rate-limits.open", DYNAMIC_ACTION_ROUTER),
      ).toBe(false);
    });

    expect(screen.queryByTestId("rate-limit-popover-stub")).toBeNull();
  });

  it("takes the chord back when the window is no longer narrow", () => {
    // The registration follows the viewport rather than the mount, so a
    // desktop window narrowed and widened again is not left chordless.
    setViewportWidth(MOBILE_VIEWPORT_WIDTH);
    const view = render(<AppStatusBar />);

    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    act(() => {
      view.rerender(<AppStatusBar />);
    });

    act(() => {
      expect(
        dispatchAction("app.rate-limits.open", DYNAMIC_ACTION_ROUTER),
      ).toBe(true);
    });

    expect(screen.getByTestId("rate-limit-popover-stub")).not.toBeNull();
  });
});

/**
 * Which mount holds `app.resources.open`, decided by the strip and handed to
 * the popover as a prop (the popover's own suite owns honouring it).
 *
 * The resource popover is mounted by the HEADER as well as by the strip, so
 * unlike the usage chord this cannot be a flat "stand down when narrow": with
 * the header's monitor switched off there is no other mount, and standing
 * down would leave the action with no owner at all.
 */
describe("<AppStatusBar /> resource action ownership", () => {
  const DESKTOP_VIEWPORT_WIDTH = 1280;
  const MOBILE_VIEWPORT_WIDTH = 390;

  function setViewportWidth(width: number): void {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: width,
    });
  }

  function claimsOpenAction(): string | null {
    return screen
      .getByTestId("resource-monitor-popover")
      .getAttribute("data-claims-open-action");
  }

  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  afterEach(() => {
    cleanup();
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  it("claims it on a desktop window, where placement keeps the two mounts apart", () => {
    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);

    render(<AppStatusBar />);

    expect(claimsOpenAction()).toBe("true");
  });

  it("stands down on a mobile viewport while the header draws its own monitor", () => {
    // Both are on screen there - the header keeps its monitor whatever the
    // footer does - and the header is the one that survives an open keyboard
    // or nav drawer, so the strip must not displace its handler and then
    // delete the slot on the way out. `resourceMonitor.shown` is one switch
    // now (L-48): the default "shown" is what both mounts read, so no
    // explicit set is needed to put the header's monitor on screen.
    setViewportWidth(MOBILE_VIEWPORT_WIDTH);

    render(<AppStatusBar />);

    expect(claimsOpenAction()).toBe("false");
  });

  // The old "header off, strip on" case is gone with it: `resourceMonitor` is
  // ONE switch (L-48) now, so turning the header's monitor off also drops the
  // strip's own segment - there is no longer a state where the strip has a
  // popover to claim ownership of while the header draws none.

  it("takes it back when the window is no longer narrow", () => {
    setViewportWidth(MOBILE_VIEWPORT_WIDTH);
    const view = render(<AppStatusBar />);
    expect(claimsOpenAction()).toBe("false");

    setViewportWidth(DESKTOP_VIEWPORT_WIDTH);
    act(() => {
      view.rerender(<AppStatusBar />);
    });

    expect(claimsOpenAction()).toBe("true");
  });
});

// The rest of the old "Customize editing" / "disabled-usage provider ghosts
// follow segmentOrder" suites were about the overlay/ghost/proxy technique
// the layout rework deleted outright: the editor decorates the app's OWN
// elements now, so there is no overlay, proxy or per-ghost popover left to
// assert about, and what replaced them is covered against the real canvas in
// `components/layout-editor/`. This ordering assertion is the one survivor:
// it never touched the ghost machinery, only where the two readings sit and
// plain DOM position.
describe("<AppStatusBar /> reading placement (L-156)", () => {
  function setViewportWidth(width: number): void {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: width,
    });
  }

  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  afterEach(() => {
    cleanup();
    // Restored HERE rather than at the end of the one case that narrows it:
    // a failing assertion would otherwise leave every case after it on a
    // phone, and the failure that follows names the wrong mechanism.
    setViewportWidth(1280);
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  function place(patch: Partial<LayoutArrangement>): void {
    useLayoutStore.getState().setArrangement({
      ...useLayoutStore.getState().arrangement,
      ...patch,
    });
  }

  /** The strip's own children, as the two readings and the row's grower. */
  function stripOrder(): ReadonlyArray<string> {
    const row = screen.getByTestId("app-status-bar").firstElementChild;
    return [...(row?.children ?? [])].map((child) => {
      if (child.getAttribute("data-testid") === "status-bar-rate-limit-slot") {
        return "usage";
      }
      return child.querySelector('[data-testid="status-bar-resource-segment"]')
        ? "resource"
        : "grower";
    });
  }

  it("draws each reading at the end of the strip it names", () => {
    render(<AppStatusBar />);
    expect(stripOrder()).toEqual(["usage", "grower", "resource"]);
    cleanup();

    place({ resourceSide: "left", usageSide: "right" });
    render(<AppStatusBar />);
    expect(stripOrder()).toEqual(["resource", "grower", "usage"]);
  });

  it("puts usage limits first where the two share one end", () => {
    place({ resourceSide: "left" });
    render(<AppStatusBar />);
    // Both are in the LEFT cluster, and the order is the model's: usage
    // limits lead. Before L-156 the monitor led here, because `resourceSide`
    // was read as "before or after the usage slot".
    expect(stripOrder()).toEqual(["usage", "resource", "grower"]);
    cleanup();

    place({ resourceSide: "right", usageSide: "right" });
    render(<AppStatusBar />);
    expect(stripOrder()).toEqual(["grower", "usage", "resource"]);
  });

  it("leaves the reading that moved to the header out, and keeps the other", () => {
    place({ usageHost: "header" });
    render(<AppStatusBar />);
    expect(screen.queryByTestId("status-bar-rate-limit-slot")).toBeNull();
    expect(screen.getByTestId("status-bar-resource-segment")).not.toBeNull();
    cleanup();

    place({ usageHost: "status-bar", resourceHost: "header" });
    render(<AppStatusBar />);
    expect(screen.getByTestId("status-bar-rate-limit-slot")).not.toBeNull();
    expect(screen.queryByTestId("status-bar-resource-segment")).toBeNull();
  });

  it("draws neither reading once both have named the header", () => {
    // The shell does not mount a strip in this state (`statusBarShown`), but
    // the strip must not draw half of one if something does: an empty row is
    // a bordered 24px band holding a spacer.
    place({ usageHost: "header", resourceHost: "header" });
    render(<AppStatusBar />);

    expect(stripOrder()).toEqual(["grower"]);
    expect(screen.queryByTestId("status-bar-rate-limit-slot")).toBeNull();
    expect(screen.queryByTestId("status-bar-resource-segment")).toBeNull();
  });

  it("draws both readings on a narrow viewport whatever bar they name", () => {
    // L-162: a phone has one bar. The footer is opt-in (`mobileFooter`) and
    // once it is on it draws both readings, because a footer that honoured a
    // header pick would drop a readout the mobile header does not replace.
    // The picks themselves survive for the next desktop window.
    setViewportWidth(390);
    place({ usageHost: "header", resourceHost: "header", mobileFooter: true });
    render(<AppStatusBar />);

    expect(stripOrder()).toEqual(["usage", "grower", "resource"]);
    expect(useLayoutStore.getState().arrangement.usageHost).toBe("header");
  });

  it("opens the usage panel at the end the cluster is on", () => {
    function openPanelAlign(): string | undefined {
      render(<AppStatusBar />);
      act(() => {
        dispatchAction("app.rate-limits.open", DYNAMIC_ACTION_ROUTER);
      });
      return (
        screen
          .getByTestId("rate-limit-popover-stub")
          .getAttribute("data-align") ?? undefined
      );
    }

    expect(openPanelAlign()).toBe("start");
    cleanup();

    place({ usageSide: "right" });
    expect(openPanelAlign()).toBe("end");
  });

  it("forgets an open usage panel when the cluster leaves the bar", () => {
    const view = render(<AppStatusBar />);
    act(() => {
      dispatchAction("app.rate-limits.open", DYNAMIC_ACTION_ROUTER);
    });
    expect(screen.getByTestId("rate-limit-popover-stub")).not.toBeNull();

    act(() => {
      place({ usageHost: "header" });
    });
    view.rerender(<AppStatusBar />);
    expect(screen.queryByTestId("rate-limit-popover-stub")).toBeNull();

    // And the request does not come back with the reading: the anchor and the
    // content unmount together, so Radix never reports the close, and a
    // remembered `true` would reopen a panel nobody asked for.
    act(() => {
      place({ usageHost: "status-bar" });
    });
    view.rerender(<AppStatusBar />);
    expect(screen.queryByTestId("rate-limit-popover-stub")).toBeNull();
  });

  it("owns each chord exactly while it draws the reading behind it", () => {
    // One handler slot per chord and two possible owners, exclusive by
    // placement on a desktop viewport: whatever this strip is not drawing,
    // the header is, and a handler registered here would take the chord away
    // from the button that owns the panel.
    const cases: ReadonlyArray<{
      readonly patch: Partial<LayoutArrangement>;
      readonly usage: boolean;
      readonly resources: boolean;
    }> = [
      { patch: {}, usage: true, resources: true },
      { patch: { usageHost: "header" }, usage: false, resources: true },
      { patch: { resourceHost: "header" }, usage: true, resources: false },
    ];
    for (const one of cases) {
      place(one.patch);
      render(<AppStatusBar />);

      expect(
        dispatchAction("app.rate-limits.open", DYNAMIC_ACTION_ROUTER),
        JSON.stringify(one.patch),
      ).toBe(one.usage);
      // The resource panel's owner is the popover the strip mounts, so its
      // presence IS the claim; the flag it carries is asserted beside it.
      expect(
        screen
          .queryByTestId("resource-monitor-popover")
          ?.getAttribute("data-claims-open-action") ?? null,
        JSON.stringify(one.patch),
      ).toBe(one.resources ? "true" : null);
      cleanup();
      useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
    }
  });
});
