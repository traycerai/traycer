import { useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "@/components/layout/header/app-header";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
} from "@/stores/settings/layout-store";

// R3: `HeaderClusterContextMenu` (app-header.tsx) used to conditionally return
// either `<ContextMenu>...</ContextMenu>` or `props.children` depending on
// `editing` / `visualLayoutEditorEnabled` / narrow-viewport, which changes the
// element type at that tree position and forces React to unmount+remount the
// whole subtree underneath - including the real `RateLimitIconButton` and
// `ResourceMonitorPopover` leaves - every time a Customize session starts or
// stops, or the setting is flipped. The fix keeps `<ContextMenu>` mounted
// always and only toggles `ContextMenuTrigger`'s `disabled` + whether
// `ContextMenuContent` renders. This test proves the leaves survive both
// kinds of flips by giving each leaf a mount id that only changes on a real
// new mount (a lazy `useState` initializer), and asserting the id painted to
// the DOM never changes across the transitions.
const mobileState = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => mobileState.value,
  isMobileViewport: () => mobileState.value,
}));
vi.mock("@/components/layout/header/mobile-app-header", () => ({
  MobileAppHeader: () => (
    <button type="button" aria-label="Open menu">
      menu
    </button>
  ),
}));
vi.mock("@/components/layout/tabs/tab-strip", () => ({
  TabStrip: () => <div role="tablist" aria-label="Open tabs" />,
}));
vi.mock("@/hooks/appearance/use-header-tab-appearance", () => ({
  useHeaderTabAppearance: () => null,
}));
vi.mock("@/components/layout/header/app-update-button", () => ({
  AppUpdateHeaderButton: () => null,
}));
vi.mock("@/components/layout/header/history-nav-buttons", () => ({
  HistoryNavButtons: () => null,
}));
vi.mock("@/components/layout/header/history-button", () => ({
  HistoryButton: () => null,
}));
vi.mock("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => null,
}));
vi.mock("@/components/auth/user-menu", () => ({
  UserMenu: () => null,
}));
vi.mock("@/components/layout/header/sign-in-button", () => ({
  SignInButton: () => null,
}));

const mountCounters = vi.hoisted(() => ({ rateLimit: 0, resourceMonitor: 0 }));
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => {
    const [mountId] = useState(() => ++mountCounters.rateLimit);
    return <div data-testid="rate-limit-leaf" data-mount-id={mountId} />;
  },
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => {
    const [mountId] = useState(() => ++mountCounters.resourceMonitor);
    return <div data-testid="resource-monitor-leaf" data-mount-id={mountId} />;
  },
}));

function mountId(testId: string): string | null {
  return screen.getByTestId(testId).getAttribute("data-mount-id");
}

describe("AppHeader usage cluster keeps its leaves mounted across Customize/setting flips", () => {
  beforeEach(() => {
    mobileState.value = false;
    mountCounters.rateLimit = 0;
    mountCounters.resourceMonitor = 0;
    useCustomizeStore.setState({ session: null, instances: new Map() });
    // `showGlobalResourceMonitor` already defaults true; only `placement` and
    // `rateLimits.enabled` need to be true so both leaves render regardless
    // of `editing`, which is what a mount-identity check needs.
    useLayoutStore.setState({
      statusBar: {
        ...DEFAULT_STATUS_BAR_LAYOUT,
        placement: "header",
        rateLimits: { ...DEFAULT_STATUS_BAR_LAYOUT.rateLimits, enabled: true },
      },
    });
    useSettingsStore.setState({
      showGlobalResourceMonitor: true,
      visualLayoutEditorEnabled: false,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("never remounts RateLimitIconButton/ResourceMonitorPopover across session enter/exit or the visualLayoutEditorEnabled switch", () => {
    render(<AppHeader variant="app" />);
    expect(screen.getByRole("tablist", { name: "Open tabs" })).not.toBeNull();

    const initialRateLimitId = mountId("rate-limit-leaf");
    const initialResourceMonitorId = mountId("resource-monitor-leaf");
    expect(initialRateLimitId).not.toBeNull();
    expect(initialResourceMonitorId).not.toBeNull();

    // Flip the runtime setting on, then start a Customize session, then exit
    // it, then flip the setting back off - each transition used to change
    // `HeaderClusterContextMenu`'s branch (bare children vs `<ContextMenu>`)
    // and remount everything underneath.
    act(() => {
      useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    });
    expect(mountId("rate-limit-leaf")).toBe(initialRateLimitId);
    expect(mountId("resource-monitor-leaf")).toBe(initialResourceMonitorId);

    act(() => {
      useCustomizeStore.setState({
        session: { scene: "in-place", opener: { kind: "none" }, startedAt: 0 },
        instances: new Map(),
        history: { past: [], future: [] },
        announcement: "",
      });
    });
    expect(mountId("rate-limit-leaf")).toBe(initialRateLimitId);
    expect(mountId("resource-monitor-leaf")).toBe(initialResourceMonitorId);

    act(() => {
      useCustomizeStore.setState({ session: null, instances: new Map() });
    });
    expect(mountId("rate-limit-leaf")).toBe(initialRateLimitId);
    expect(mountId("resource-monitor-leaf")).toBe(initialResourceMonitorId);

    act(() => {
      useSettingsStore.setState({ visualLayoutEditorEnabled: false });
    });
    expect(mountId("rate-limit-leaf")).toBe(initialRateLimitId);
    expect(mountId("resource-monitor-leaf")).toBe(initialResourceMonitorId);

    // Sanity: both counters only ever incremented once each, for the single
    // real mount - not once per transition.
    expect(mountCounters.rateLimit).toBe(1);
    expect(mountCounters.resourceMonitor).toBe(1);
  });

  it("keeps the header's DesktopMenuBar/HistoryNavButtons markers as inert `contents` wrappers", () => {
    const { container } = render(<AppHeader variant="app" />);
    // `app-header.tsx` wraps `<DesktopMenuBar />` and `<HistoryNavButtons />`
    // each in their own `data-customize-inert` + `className="contents"` div so
    // neither ever introduces a measurable box or a Customize hotspot -
    // `contents` boxes contribute no layout of their own. A THIRD
    // `data-customize-inert` marker exists too (the right-side identity/usage
    // cluster), but that one is a real flex box on purpose, so this only
    // asserts the `contents` ones are present, not that every inert marker is.
    const contentsMarkers = [
      ...container.querySelectorAll("[data-customize-inert]"),
    ].filter((marker) => marker.className === "contents");
    expect(contentsMarkers.length).toBe(2);
  });
});
