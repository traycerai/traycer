import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { useWatchHostStore } from "@/stores/host-scope/watch-host-store";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

/**
 * The strip depends on the host SCOPE, not on the six hooks it composes, so
 * this suite mocks at that boundary — the same seam every host-scoped panel
 * suite uses, and for the same reason.
 */
let scope: HostScope = hostScopeFixture({});

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

// A projection and a desktop reading are the segment's data sources; this
// suite never asserts a number, so both stay empty and the segment renders its
// dashes. `status-bar-resource-reading.test.ts` owns the readings themselves.
vi.mock("@/stores/resources/resources-registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/resources/resources-registry")
    >();
  return {
    ...actual,
    useGlobalResourceProjection: () => actual.EMPTY_GLOBAL_RESOURCE_PROJECTION,
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

describe("<AppStatusBar />", () => {
  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  });

  afterEach(() => {
    cleanup();
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  });

  it("renders the live resource surface while following the active host", () => {
    render(<AppStatusBar />);

    expect(screen.getByTestId("app-status-bar")).not.toBeNull();
    expect(screen.getByTestId("resource-monitor-popover")).not.toBeNull();
    expect(screen.getByTestId("status-bar-resource-segment")).not.toBeNull();
    expect(screen.queryByTestId("status-bar-host-unavailable")).toBeNull();
    // T3's slot is reserved now so the right cluster does not shift when the
    // provider segments land.
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

  it("shows a notice instead of live segments for an unreachable pick", () => {
    // The ambient binding is what this subtree falls back to, so mounting the
    // segments here would draw the ACTIVE host's numbers beside a chip naming
    // the picked one - and would open a stream against a machine nobody asked
    // about.
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
    expect(screen.queryByTestId("resource-monitor-popover")).toBeNull();
    expect(screen.queryByTestId("status-bar-resource-segment")).toBeNull();
    // The chip stays: a notice whose only way out is hidden strands the user.
    expect(screen.getByTestId("settings-host-switcher")).not.toBeNull();
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
});

describe("<AppStatusBar /> host chip", () => {
  beforeEach(() => {
    scope = hostScopeFixture({});
    useWatchHostStore.setState({ scopedHostId: null });
    useLayoutStore.setState({ statusBar: DEFAULT_STATUS_BAR_LAYOUT });
  });

  afterEach(() => {
    cleanup();
    useWatchHostStore.setState({ scopedHostId: null });
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
