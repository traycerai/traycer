import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { setMobileApp } from "@/lib/mobile-app";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// These cases are about the environments-on behaviour.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));

// The sidebar's host group is headed by the one host switcher, which composes
// several host-runtime hooks. This suite is about NAVIGATION, so it mocks at
// the scope boundary rather than standing up a host runtime.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: { client: null },
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  return {
    useHostScope,
    usePersonalHostScope: useHostScope,
  };
});

// The Environment dropdown reads each registered computer's
// `environment.status` and negotiated version, and the footer's Sandboxes link
// reads the environment list: all `useQuery`s, and this suite mounts no query
// client. "No host has answered" is the honest empty answer; the picker's own
// rows are covered by environment-picker.test.tsx.
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => new Map(),
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: () => new Map(),
}));
// The picker's Personal row reads the hosts running Personal from one hook;
// these suites are about the sidebar around it.
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: [],
      state: "ready",
      collisions: [],
      retry: () => undefined,
    }),
  }),
);
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: undefined }),
}));
vi.mock("@/components/settings/move-sheet", () => ({
  MoveSheet: () => null,
}));
// The Team rows and the trigger's team label read the environment list
// through the window's host client, and this suite mounts no host runtime.
// The rows have their own suite; a Personal pick names no team.
vi.mock("@/components/settings/environment/team-pick-label", () => ({
  usePickedTeamLabel: () => null,
}));
vi.mock("@/components/settings/environment/team-rows", () => ({
  TeamRows: () => null,
}));
vi.mock("@/components/settings/members/invite-accept-dialog", () => ({
  InviteAcceptDialog: () => null,
}));
// The Guide group leaves the rail once every Getting started step is done;
// the real answer reads several `useQuery`s and this suite mounts no query
// client. Not done, as for a new account.
vi.mock("@/components/onboarding/getting-started-checklist", () => ({
  useGettingStartedGuideIsComplete: () => false,
}));

vi.mock("@/components/settings/host-scope/add-host-dialog", () => ({
  AddHostDialog: () => null,
}));

// The sidebar now opts into the liveness poll directly (see
// `useRegisteredHostsPollLiveness` in `settings-sidebar.tsx`). This suite
// mocks `useHostScope` wholesale and renders no `QueryClientProvider`, so the
// real hook - which calls `useQuery` unconditionally - would throw for want
// of a query client. It is also irrelevant to navigation, which is what this
// suite is about.
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHostsPollLiveness: () => undefined,
}));

// Same reasoning, one hook later: the picker now resolves each row's update
// badge through `useFleetUpdateViews`, which owns a `useQuery` for the fleet
// sweep and therefore needs a query client this navigation suite deliberately
// does not mount. Stubbed to the "nothing observed" answer - which is also the
// honest production answer for a fleet with no borrowable sessions, so the
// rows this suite asserts on render exactly as they would there.
//
// The badge's OWN behaviour is covered where it belongs (the host-option row
// and per-host isolation suites); stubbing it here keeps a navigation test from
// silently becoming a fleet-polling test.
// Returns the SHARED constant rather than a literal spelled out here. A mock
// factory is not type-checked against the module it replaces, so a hand-written
// view silently loses any field added later - and `undefined` is not `null`, so
// the row's badge would have read "last seen undefined" on every host while
// this navigation suite went on passing. The whole point of exporting
// `UNKNOWN_FLEET_UPDATE_VIEW` is that no caller, test or otherwise, writes one
// of these by hand.
// Mocked for the same reason the fleet views are: no QueryClient here, and
// the environment label is not what this suite tests.
vi.mock("@/hooks/bots/use-host-environment-labels", () => ({
  useHostEnvironmentLabelResolver: () => () => null,
}));
vi.mock("@/hooks/host/use-fleet-update-views", async () => {
  const { UNKNOWN_FLEET_UPDATE_VIEW } =
    await import("@/lib/host/fleet-update/fleet-update-view");
  return { useFleetUpdateViews: () => () => UNKNOWN_FLEET_UPDATE_VIEW };
});

// The host picker's balance banner reads the sandbox list through a
// `useQuery`, which needs a query client this navigation suite deliberately
// does not mount. It is irrelevant to navigation, and has its own suite.
vi.mock("@/components/hosts/sandbox-balance-banner", () => ({
  SandboxBalanceBanner: () => null,
}));
// Same reasoning: the Automations entry reads its own `useQuery`.
vi.mock("@/components/hosts/automations-host-entry", () => ({
  AutomationsHostEntry: () => <div data-testid="automations-entry-probe" />,
}));

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

/**
 * The Customize editor switch, and the gate that used to drop this entry once
 * the editor took the Layout page's rows over, are both gone: the Layout
 * sidebar entry is offered unconditionally now.
 */
describe("<SettingsSidebar /> Layout entry", () => {
  afterEach(() => {
    cleanup();
    setMobileApp(false);
    setWidth(1024);
    scopeOverrides.current = { client: null };
  });

  it("always lists Layout, alongside its neighbours", async () => {
    await renderRail();

    expect(screen.getByTestId("settings-sidebar-item-layout")).toBeTruthy();
    for (const neighbour of ["appearance", "app-diagnostics", "devices"]) {
      expect(
        screen.getByTestId(`settings-sidebar-item-${neighbour}`),
      ).toBeTruthy();
    }
  });

  it("keeps Layout at a narrow window", async () => {
    setWidth(500);

    await renderRail();

    expect(screen.getByTestId("settings-sidebar-item-layout")).toBeTruthy();
  });

  it("keeps Layout in the installed mobile app", async () => {
    setMobileApp(true);

    await renderRail();

    expect(screen.getByTestId("settings-sidebar-item-layout")).toBeTruthy();
  });
});
