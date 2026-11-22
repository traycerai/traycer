import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import {
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  resetEnvironmentSectionReads,
  windowHostRunsPersonal,
} from "@/components/settings/__tests__/environment-section-reads-fixture";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The sidebar's host group is headed by the one host switcher, which composes
// several host-runtime hooks, and its rows read queries this suite does not
// mount. This suite is about SEARCH, so it mocks at the scope boundary and
// stubs those reads with the shared fixtures.
vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).personalHostScopeModule,
);
vi.mock(
  "@/components/settings/personal/use-window-host-runs-personal",
  async () =>
    (
      await import("@/components/settings/__tests__/environment-section-reads-fixture")
    ).windowHostRunsPersonalModule,
);
vi.mock(
  "@/hooks/environment/use-registered-host-environment-statuses",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).registeredHostEnvironmentStatusesModule,
);
vi.mock(
  "@/hooks/host/use-host-negotiated-method-version",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).negotiatedMethodVersionModule,
);
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).hostsRunningConfigurationModule,
);
vi.mock(
  "@/hooks/bots/use-environment-list-query",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).environmentListQueryModule,
);
vi.mock(
  "@/components/settings/move-sheet",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).moveSheetModule,
);
vi.mock(
  "@/components/settings/environment/team-pick-label",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).teamPickLabelModule,
);
vi.mock(
  "@/components/settings/environment/team-rows",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).teamRowsModule,
);
vi.mock(
  "@/components/settings/members/invite-accept-dialog",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).inviteAcceptDialogModule,
);
vi.mock(
  "@/components/onboarding/getting-started-checklist",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).gettingStartedChecklistModule,
);
vi.mock(
  "@/components/settings/host-scope/add-host-dialog",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).addHostDialogModule,
);
vi.mock(
  "@/hooks/auth/use-registered-hosts-query",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).registeredHostsLivenessModule,
);
vi.mock(
  "@/hooks/bots/use-host-environment-labels",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).hostEnvironmentLabelsModule,
);
vi.mock(
  "@/hooks/host/use-fleet-update-views",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).fleetUpdateViewsModule,
);
vi.mock(
  "@/components/hosts/sandbox-balance-banner",
  async () =>
    (
      await import("@/components/settings/__tests__/settings-sidebar-rail-mocks-fixture")
    ).sandboxBalanceBannerModule,
);

function buildRouter() {
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
  return createRouter({
    routeTree: rootRoute.addChildren([settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
  });
}

/** Whether a search for the viewer role offers the Members page. */
async function searchOffersMembers(pick: EnvironmentPick): Promise<boolean> {
  useSettingsEnvironmentPickStore.setState({ pick });
  const router = buildRouter();
  render(
    <KeybindingProvider router={router}>
      <RouterProvider router={router} />
    </KeybindingProvider>,
  );
  const input = await screen.findByRole("combobox", {
    name: "Search settings",
  });

  fireEvent.change(input, { target: { value: "viewer" } });

  return (
    document.querySelector(
      "[data-testid^='settings-search-result-members:']",
    ) !== null
  );
}

// Members is a team's page: the rail already leaves it off any other pick, and
// search says the same.
describe("<SettingsSidebar /> search, Members", () => {
  afterEach(() => {
    cleanup();
    useSettingsSearchStore.setState({ query: "" });
    useSettingsEnvironmentPickStore.setState({ pick: null });
    resetNegotiatedManifests();
    resetEnvironmentSectionReads();
  });

  it("offers a Members result to a team", async () => {
    expect(
      await searchOffersMembers({ kind: "team", environmentId: "env-team" }),
    ).toBe(true);
  });

  it("offers no Members result under Personal", async () => {
    // Personal's page is read from the window's host: with the list served,
    // the only thing left to hide the result is the page being a team's.
    windowHostRunsPersonal.current = true;
    recordNegotiatedHostMethods("host-a", ["environment.secrets.list"]);

    expect(await searchOffersMembers(PERSONAL_PICK)).toBe(false);
  });

  it("offers no Members result under a Local pick", async () => {
    recordNegotiatedHostMethods("host-a", ["environment.secrets.list"]);

    expect(
      await searchOffersMembers({
        kind: "local",
        hostId: "host-a",
        hostName: "Old laptop",
      }),
    ).toBe(false);
  });
});
