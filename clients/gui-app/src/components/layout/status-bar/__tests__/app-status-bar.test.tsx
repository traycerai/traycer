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
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";
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
        refresh: { queueTargets: [], httpRefetches: [], httpFetching: false },
      }),
    };
  },
);

vi.mock("@/hooks/rate-limits/use-rate-limit-profile-selection", () => ({
  useRateLimitProfileSelection: () => ({
    activeChatSettings: null,
    lastProfileByHarness: {},
  }),
}));

vi.mock("@/hooks/rate-limits/use-rate-limit-queue-scope", () => ({
  useRateLimitQueueScope: () => null,
}));

vi.mock("@/hooks/rate-limits/use-rate-limit-queue-target-phase", () => ({
  useAnyRateLimitQueueTargetFetching: () => false,
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
// children mount and what the chip does, so they stand down to the ambient
// binding — the same value production falls back to when a pick has not
// resolved its own client.
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
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: (props: {
    readonly trigger: string;
    readonly triggerNode?: React.ReactNode;
    readonly contentSide?: string;
  }) => (
    <div data-testid="resource-monitor-popover" data-side={props.contentSide}>
      {props.triggerNode}
    </div>
  ),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
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
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  afterEach(() => {
    cleanup();
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
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
    // The chip stays: a notice whose only way out is hidden strands the user.
    expect(screen.getByTestId("settings-host-switcher")).not.toBeNull();
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
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        resources: { ...DEFAULT_STATUS_BAR_LAYOUT.resources, enabled: false },
      },
    });

    render(<AppStatusBar />);

    // The popover goes with it: it is the stream owner, so leaving it mounted
    // would keep sampling a host for a readout nobody asked for.
    expect(screen.queryByTestId("resource-monitor-popover")).toBeNull();
    expect(screen.getByTestId("settings-host-switcher")).not.toBeNull();
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
          state: "live",
          reason: null,
          windows: [],
          tightest: null,
        },
      ],
    };
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: { ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits, enabled: false },
      },
    });

    render(<AppStatusBar />);

    expect(screen.getByTestId("status-bar-rate-limit-slot")).not.toBeNull();
    expect(screen.queryByTestId("status-bar-rate-limit-trigger")).toBeNull();
  });
});

describe("<AppStatusBar /> usage panel chord", () => {
  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  afterEach(() => {
    cleanup();
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  // The panel and its chord live above the gate that hides the segments, so
  // it stays reachable in every state the segments themselves do not survive
  // - usage switched off in Settings, or a pick that cannot be reached.

  it("opens the panel through the chord while statusBar.rateLimits.enabled is false, with the cluster absent", () => {
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: { ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits, enabled: false },
      },
    });

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

describe("<AppStatusBar /> host chip", () => {
  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  afterEach(() => {
    cleanup();
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  function openHostList(): void {
    fireEvent.click(screen.getByTestId("settings-host-switcher"));
  }

  it("offers Activate for a watched host that is not the active one", () => {
    const makeActive = vi.fn();
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A, HOST_B],
      host: HOST_B,
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "ready",
      makeActive,
    });

    render(<AppStatusBar />);
    openHostList();

    fireEvent.click(screen.getByTestId("settings-host-switcher-activate"));
    expect(makeActive).toHaveBeenCalledWith("host-b");
  });

  it("points at Settings instead when the watched host is already active", () => {
    // Activating the host you are already on is a control whose only outcome
    // is the state you are in.
    render(<AppStatusBar />);
    openHostList();

    expect(screen.getByTestId("settings-host-switcher-manage")).not.toBeNull();
    expect(screen.queryByTestId("settings-host-switcher-activate")).toBeNull();
  });

  it("withholds Activate while one is already in flight", () => {
    const makeActive = vi.fn();
    useWatchHostStore.setState({ scopedHostId: "host-b" });
    scope = hostScopeFixture({
      hosts: [HOST_A, HOST_B],
      host: HOST_B,
      activeHostId: "host-a",
      activeHost: HOST_A,
      isViewingActive: false,
      status: "ready",
      isActivating: true,
      makeActive,
    });

    render(<AppStatusBar />);
    openHostList();

    const row = screen.getByTestId("settings-host-switcher-activate");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row);
    expect(makeActive).not.toHaveBeenCalled();
  });

  it("falls back to Settings when no host resolved at all", () => {
    // The switcher's zero-host branch renders the trailing action as a plain
    // button with no pending state, and there is no host to activate anyway.
    scope = hostScopeFixture({
      hosts: [],
      host: null,
      activeHostId: null,
      activeHost: null,
      isViewingActive: false,
      status: "unreachable",
    });

    render(<AppStatusBar />);

    expect(
      screen.getByTestId("settings-host-switcher-empty-manage"),
    ).not.toBeNull();
  });
});

describe("<AppStatusBar /> right-click visibility menu", () => {
  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    resetRateLimitMocks();
    resourceProjection.value = null;
  });

  afterEach(() => {
    cleanup();
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
    resetRateLimitMocks();
    resourceProjection.value = null;
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

  it("does not open from a right-click on the host chip", () => {
    windowedProviders = twoWindowedProviders();
    render(<AppStatusBar />);

    fireEvent.contextMenu(screen.getByTestId("settings-host-switcher"));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not open from a right-click on the rate-limit trigger", () => {
    windowedProviders = twoWindowedProviders();
    rateLimitCluster = { kind: "hidden" };
    render(<AppStatusBar />);

    fireEvent.contextMenu(screen.getByTestId("status-bar-rate-limit-trigger"));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not open from a right-click on the resource segment", () => {
    windowedProviders = twoWindowedProviders();
    render(<AppStatusBar />);

    fireEvent.contextMenu(screen.getByTestId("status-bar-resource-segment"));

    expect(screen.queryByRole("menu")).toBeNull();
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
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        rateLimits: { ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits, enabled: false },
      },
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
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Resource monitor" }),
    ).not.toBeNull();
  });

  it("does not open from a right-click on the notice's return-to-active button", () => {
    // Mirrors the chip / trigger / resource-segment exemptions above: the
    // notice's own button is the one way out of this state, so the bar's menu
    // stands down over it too.
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
