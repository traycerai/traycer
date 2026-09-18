import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { setMobileApp } from "@/lib/mobile-app";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The sidebar's host group is headed by the one host switcher, which composes
// several host-runtime hooks. This suite is about NAVIGATION, so it mocks at
// the scope boundary rather than standing up a host runtime.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: { client: null },
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

vi.mock("@/components/settings/host-scope/add-host-dialog", () => ({
  AddHostDialog: () => null,
}));

// The sidebar now opts into the liveness poll directly (see
// `useRegisteredHostsPollLiveness` in `settings-sidebar.tsx`). This suite
// mocks `useHostScope` wholesale and renders no `QueryClientProvider`, so the
// real hook — which calls `useQuery` unconditionally — would throw for want
// of a query client. It is also irrelevant to navigation, which is what this
// suite is about.
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHostsPollLiveness: () => undefined,
}));

// Same reasoning, one hook later: the picker now resolves each row's update
// badge through `useFleetUpdateViews`, which owns a `useQuery` for the fleet
// sweep and therefore needs a query client this navigation suite deliberately
// does not mount. Stubbed to the "nothing observed" answer — which is also the
// honest production answer for a fleet with no borrowable sessions, so the
// rows this suite asserts on render exactly as they would there.
//
// The badge's OWN behaviour is covered where it belongs (the host-option row
// and per-host isolation suites); stubbing it here keeps a navigation test from
// silently becoming a fleet-polling test.
// Returns the SHARED constant rather than a literal spelled out here. A mock
// factory is not type-checked against the module it replaces, so a hand-written
// view silently loses any field added later — and `undefined` is not `null`, so
// the row's badge would have read "last seen undefined" on every host while
// this navigation suite went on passing. The whole point of exporting
// `UNKNOWN_FLEET_UPDATE_VIEW` is that no caller, test or otherwise, writes one
// of these by hand.
vi.mock("@/hooks/host/use-fleet-update-views", async () => {
  const { UNKNOWN_FLEET_UPDATE_VIEW } =
    await import("@/lib/host/fleet-update/fleet-update-view");
  return { useFleetUpdateViews: () => () => UNKNOWN_FLEET_UPDATE_VIEW };
});

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <SettingsSidebar mode={{ kind: "route" }} variant="rail" />
    ),
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$section",
    component: () => <div data-testid="settings-body" />,
  });
  const routeTree = rootRoute.addChildren([settingsRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

async function renderRail(): Promise<void> {
  const router = buildRouter("/settings/general");
  render(<RouterProvider router={router} />);
  await screen.findByTestId("settings-sidebar-item-general");
}

describe("<SettingsSidebar /> Layout entry", () => {
  afterEach(() => {
    cleanup();
    setMobileApp(false);
    setWidth(1024);
    scopeOverrides.current = { client: null };
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
  });

  it("lists Layout with the editor off", async () => {
    await renderRail();

    expect(screen.getByTestId("settings-sidebar-item-layout")).toBeTruthy();
  });

  it("drops Layout, and only Layout, once the editor takes its rows over", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });

    await renderRail();

    expect(screen.queryByTestId("settings-sidebar-item-layout")).toBeNull();
    for (const neighbour of ["appearance", "app-diagnostics", "devices"]) {
      expect(
        screen.getByTestId(`settings-sidebar-item-${neighbour}`),
      ).toBeTruthy();
    }
  });

  it("keeps Layout at a narrow window even with the switch on", async () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    setWidth(500);

    await renderRail();

    expect(screen.getByTestId("settings-sidebar-item-layout")).toBeTruthy();
  });

  it("follows the switch live", async () => {
    await renderRail();
    expect(screen.getByTestId("settings-sidebar-item-layout")).toBeTruthy();

    useSettingsStore.setState({ visualLayoutEditorEnabled: true });

    await waitFor(() =>
      expect(screen.queryByTestId("settings-sidebar-item-layout")).toBeNull(),
    );
  });
});
