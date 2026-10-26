import {
  SettingsSidebar,
  type SettingsSidebarVariant,
} from "@/components/settings/settings-sidebar";
import {
  SETTINGS_SECTION_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSectionGroupId,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import { setMobileApp } from "@/lib/mobile-app";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useTabsStore } from "@/stores/tabs/store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { SANDBOXES_UNAVAILABLE_IN_STAGING } from "@traycer-clients/shared/host-client/sandbox-control";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The preview-features verdict per feature; a case sets it, every other runs on.
const previewVerdict = vi.hoisted(
  (): { current: Record<"environments" | "sandboxes" | "bots", "on" | "off" | "unread"> } => ({
    current: { environments: "on", sandboxes: "on", bots: "on" },
  }),
);
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: (feature: "environments" | "sandboxes" | "bots") =>
    previewVerdict.current[feature],
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
// client. Not done by default, as for a new account.
const guideComplete = vi.hoisted(() => ({ current: false }));
vi.mock("@/components/onboarding/getting-started-checklist", () => ({
  useGettingStartedGuideIsComplete: () => guideComplete.current,
}));

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
// The environment label resolver is a per-host query hook (Tracy Bots);
// mocked here for the same reason the fleet views are: this suite mounts no
// QueryClient and the label is not what it tests.
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
// does not mount. It is irrelevant to navigation (it renders nothing for an
// account with no sandboxes), and has its own suite.
vi.mock("@/components/hosts/sandbox-balance-banner", () => ({
  SandboxBalanceBanner: () => <div data-testid="sandbox-balance-warning" />,
}));
// Same reasoning: the Automations entry reads its own `useQuery`; its own
// suite covers what it renders, this one covers when the sidebar mounts it.
vi.mock("@/components/hosts/automations-host-entry", () => ({
  AutomationsHostEntry: () => <div data-testid="automations-entry-probe" />,
}));

// What `IRunnerHost.sandboxControlUnavailableReason` reads as; a build that
// reaches the control plane (every test here but one) answers `null`.
const sandboxControl = vi.hoisted(() => ({
  reason: null as string | null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-control-unavailable-reason", () => ({
  useSandboxControlUnavailableReason: () => sandboxControl.reason,
}));

// The Secrets and GitHub entry renders only with a runner host (it needs the
// platform origin), and the existing cases in this suite have none. The
// default stays `null` so they are unaffected; the sandbox cases below set it.
// `browserView` is read by the sidebar too, and stays absent.
interface RunnerHostStub {
  readonly signInUrl: string;
  readonly browserView: null;
}
const runnerHostStub = vi.hoisted(() => ({
  current: null as RunnerHostStub | null,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => runnerHostStub.current,
}));

const openLinkMock = vi.hoisted(() => ({
  open: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkMock.open,
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

describe("<SettingsSidebar /> leader hints", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    // The settings section leader now gates on the actual focused ref, so seed
    // the Settings tab as the focused layout item (the real on-/settings state).
    useTabsStore.setState({
      version: 2,
      items: [],
      activeItemId: null,
      stripOrder: [],
      systemTabs: { history: null, settings: null },
    });
    useTabsStore.getState().openSystemTab({
      kind: "settings",
      name: "Settings",
      lastPath: "/settings/general",
    });
    useOnboardingStore.setState({
      completedAt: null,
      setupProgress: { agents: -1, appearance: -1, cookies: -1 },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    scopeOverrides.current = { client: null };
    setMobileApp(false);
    guideComplete.current = false;
  });

  // Chord capture is keyboard-only, so the installed mobile app does not offer
  // the section at all - and the rail is what offers it.
  it("omits the Keybindings entry in the installed mobile app", async () => {
    setMobileApp(true);
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Keybindings" })).toBeNull();
  });

  // The panel is the DISPLAY end of a pairing whose scanner end is the mobile
  // app itself, so that build does not offer it either.
  it("omits the Link mobile app entry in the installed mobile app", async () => {
    setMobileApp(true);
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Link mobile app" })).toBeNull();
    // Its Account-group sibling stays, so what is asserted is one row's
    // absence rather than a group that failed to render.
    expect(screen.getByRole("link", { name: "Sessions" })).toBeDefined();
  });

  it("renders the Link mobile app entry on other builds", async () => {
    setMobileApp(false);
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(
      await screen.findByRole("link", { name: "Link mobile app" }),
    ).toBeDefined();
  });

  it("renders the Keybindings entry on other builds", async () => {
    setMobileApp(false);
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(
      await screen.findByRole("link", { name: "Keybindings" }),
    ).toBeDefined();
  });

  // The machine console is labelled "Overview" now - it sits under the host
  // switcher, which supplies the machine's name, so repeating "Host" in the
  // entry would name the container twice. Its `id` and route are unchanged.
  it("renders the machine Overview entry and not the legacy Service entry", async () => {
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(await screen.findByRole("link", { name: "Overview" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "Service" })).toBeNull();
  });

  it("Overview entry links to /settings/host", async () => {
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    const link = await screen.findByRole<HTMLAnchorElement>("link", {
      name: "Overview",
    });
    expect(link.getAttribute("href")).toBe("/settings/host");
  });

  it("Sessions entry links to the compatibility /settings/devices route", async () => {
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    const link = await screen.findByRole("link", { name: "Sessions" });
    expect(link.getAttribute("href")).toBe("/settings/devices");
  });

  it("SETTINGS_SECTIONS does not contain the legacy Service id", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(ids).toContain("host");
    expect(ids).not.toContain("service");
  });

  it("labels the agents section Agents; the id stays the compatibility identifier", () => {
    const section = SETTINGS_SECTIONS.find(({ id }) => id === "agents");
    expect(section?.label).toBe("Agents");
  });

  it("labels application sounds and alerts apart from host notification events", () => {
    const sounds = SETTINGS_SECTIONS.find(
      (section) => section.id === "app-notifications",
    );
    const alerts = SETTINGS_SECTIONS.find((section) => section.id === "alerts");
    const host = SETTINGS_SECTIONS.find(
      (section) => section.id === "notifications",
    );
    expect(sounds?.label).toBe("Sounds");
    expect(alerts?.label).toBe("Alerts");
    expect(host?.label).toBe("Notifications");
    // Different controls, so different icons too (the rail-table rule).
    expect(new Set([sounds?.icon, alerts?.icon, host?.icon]).size).toBe(3);
  });

  it("puts Getting started before General in the application settings order", () => {
    expect(SETTINGS_SECTIONS.slice(0, 2).map((section) => section.id)).toEqual([
      "getting-started",
      "general",
    ]);
  });

  it("shows Getting started completion progress in the sidebar", async () => {
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    const progress = await screen.findByRole("progressbar", {
      name: "Getting started",
    });
    expect(progress.getAttribute("aria-valuenow")).toBe("0");
    // Three, not four: this shell has no browser view, so the browser
    // sign-ins guide is not offered and is left out of the count.
    expect(progress.getAttribute("aria-valuemax")).toBe("3");

    useOnboardingStore.getState().complete();

    expect(
      (
        await screen.findByRole("progressbar", {
          name: "Getting started",
        })
      ).getAttribute("aria-valuenow"),
    ).toBe("1");
  });

  it("drops the Guide group once every Getting started step is done", async () => {
    guideComplete.current = true;
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    await screen.findByTestId("settings-sidebar-item-general");
    expect(
      screen.queryByTestId("settings-sidebar-item-getting-started"),
    ).toBeNull();
  });

  it("delays sub-leader digit badges in settings navigation", async () => {
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(await screen.findByText("General")).toBeDefined();
    vi.useFakeTimers();
    expect(screen.queryByTestId("settings-section-digit-1")).toBeNull();

    fireEvent.keyDown(window, {
      code: "AltLeft",
      key: "Alt",
      altKey: true,
    });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(screen.queryByTestId("settings-section-digit-1")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("settings-section-digit-1")).toBeDefined();
  });

  // Guards the `requiresLocalHost` removal: Shell and Diagnostics used to be
  // dimmed for a remote host (the on-disk config store the local CLI bridge
  // read could only ever describe THIS computer). `config.*` / `diagnostics.*`
  // made both sections work for whichever host the picker names, so a remote
  // pick must render them identically to any other always-available section.
  it("does not dim the Shell and Diagnostics rows while a remote host is scoped", async () => {
    const { hostScopeOptionFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    scopeOverrides.current = {
      client: null,
      host: hostScopeOptionFixture({
        hostId: "host-remote",
        name: "Remote Box",
        isLocalMachine: false,
      }),
    };
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    const shellLink = await screen.findByTestId("settings-sidebar-item-shell");
    const diagnosticsLink = screen.getByTestId(
      "settings-sidebar-item-diagnostics",
    );
    // Neither active (not the current route) - so an undimmed, inactive row
    // is exactly the plain `text-foreground/70` class every other section's
    // inactive row carries, not a dimmed variant of it.
    for (const link of [shellLink, diagnosticsLink]) {
      expect(link.className).not.toContain("text-foreground/40");
      expect(link.className).toContain("text-foreground/70");
    }
    // Deliberately NOT `expect(shellLink.className).toBe(diagnosticsLink
    // .className)`. The two assertions above already pin the property under
    // test; whole-class-string equality additionally demands the two rows stay
    // byte-identical forever, so any row-specific class either gains later
    // would fail this test for a reason it does not care about.
  });
});

// The two variants want OPPOSITE history semantics from the same Link: the
// rail's sections are peers on one screen, so switching sections must not
// grow the stack (back leaves settings in one step); the mobile list is a
// drill-down, so entering a section must push (back returns to the list, not
// to whatever preceded settings). These assert through the history itself -
// the user-observable anchor is where back() lands - rather than through the
// Link's props.
describe("<SettingsSidebar /> section navigation history", () => {
  function buildVariantRouter(
    initialEntries: Array<string>,
    variant: SettingsSidebarVariant,
  ) {
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <SettingsSidebar mode={{ kind: "route" }} variant={variant} />
          <Outlet />
        </>
      ),
    });
    const taskRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/task-stub",
      component: () => <div data-testid="task-stub" />,
    });
    const settingsIndexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings",
      component: () => <div data-testid="settings-list" />,
    });
    const settingsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/$section",
      component: () => <div data-testid="settings-body" />,
    });
    const routeTree = rootRoute.addChildren([
      taskRoute,
      settingsIndexRoute,
      settingsRoute,
    ]);
    return createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries }),
    });
  }

  it("mobile list pushes a section, so back returns to the list", async () => {
    const router = buildVariantRouter(
      ["/task-stub", "/settings"],
      "mobile-list",
    );
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    fireEvent.click(await screen.findByRole("link", { name: "General" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/general");
    });

    act(() => {
      router.history.back();
    });
    expect(router.state.location.pathname).toBe("/settings");
  });

  // Byte-symmetric with the mobile-list case above: same initial entries,
  // same clicked link - the only variable is the variant, so the two tests
  // together pin that the variant alone flips the history semantics.
  it("rail replaces the section entry, so back leaves settings in one step", async () => {
    const router = buildVariantRouter(["/task-stub", "/settings"], "rail");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    // Clicked through a fresh query on every poll: the rail re-renders its
    // rows as it settles (an exiting copy can coexist with the live one for
    // a frame), so a node captured once can be detached by the time the
    // click lands. Clicking the LAST currently-rendered instance until the
    // navigation commits keeps the test on the real Link.
    await waitFor(() => {
      const links = screen.getAllByTestId("settings-sidebar-item-general");
      fireEvent.click(links[links.length - 1]);
      expect(router.state.location.pathname).toBe("/settings/general");
    });

    act(() => {
      router.history.back();
    });
    expect(router.state.location.pathname).toBe("/task-stub");
  });
});

describe("<SettingsSidebar /> search", () => {
  // The navigation-history cases above leave their trees mounted.
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
    useSettingsSearchStore.setState({ query: "" });
  });

  // The query lives in the store so the modal frame can see a search running,
  // but a visit's search must not greet the next one.
  it("replaces the section list while searching and forgets the query on unmount", async () => {
    const router = buildRouter("/settings/general");
    const view = render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    const input = await screen.findByRole("combobox", {
      name: "Search settings",
    });

    fireEvent.change(input, { target: { value: "theme" } });

    expect(useSettingsSearchStore.getState().query).toBe("theme");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "General" })).toBeNull();

    view.unmount();

    expect(useSettingsSearchStore.getState().query).toBe("");
  });
});

describe("<SettingsSidebar /> new sandbox entry", () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({ status: "signed-out" });
    sandboxControl.reason = null;
    runnerHostStub.current = null;
    scopeOverrides.current = { client: null };
    openLinkMock.open.mockClear();
  });

  function renderSidebar(): void {
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
  }

  it("offers no New sandbox… entry: creation happens from the pickers", async () => {
    useAuthStore.setState({ status: "signed-in" });
    renderSidebar();

    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    expect(screen.queryByTestId("settings-new-sandbox")).toBeNull();
  });

  it("says why on a build that cannot reach the control plane", async () => {
    sandboxControl.reason = SANDBOXES_UNAVAILABLE_IN_STAGING;
    useAuthStore.setState({ status: "signed-in" });
    renderSidebar();

    const line = await screen.findByTestId("settings-sandboxes-unavailable");
    expect(line.textContent).toBe(
      "Sandboxes aren't available in staging builds.",
    );
    expect(screen.queryByTestId("settings-new-sandbox")).toBeNull();
  });

  it("shows no unavailable line when the control plane is reachable", async () => {
    useAuthStore.setState({ status: "signed-in" });
    renderSidebar();

    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    expect(screen.queryByTestId("settings-sandboxes-unavailable")).toBeNull();
  });

  it("shows neither the entry nor the line when signed out, whatever the build", async () => {
    sandboxControl.reason = "Sandboxes aren't available in staging builds.";
    useAuthStore.setState({ status: "signed-out" });
    renderSidebar();

    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    expect(screen.queryByTestId("settings-new-sandbox")).toBeNull();
    expect(screen.queryByTestId("settings-sandboxes-unavailable")).toBeNull();
  });

  it("mounts the Automations entry for a signed-in user on a build that reaches the control plane", async () => {
    useAuthStore.setState({ status: "signed-in" });
    renderSidebar();

    expect(await screen.findByTestId("automations-entry-probe")).toBeDefined();
  });

  it("mounts no Automations entry on a build that cannot reach the control plane, or signed out", async () => {
    sandboxControl.reason = "Sandboxes aren't available in staging builds.";
    useAuthStore.setState({ status: "signed-in" });
    renderSidebar();
    expect(
      await screen.findByTestId("settings-sandboxes-unavailable"),
    ).toBeDefined();
    expect(screen.queryByTestId("automations-entry-probe")).toBeNull();
    cleanup();

    sandboxControl.reason = null;
    useAuthStore.setState({ status: "signed-out" });
    renderSidebar();
    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    expect(screen.queryByTestId("automations-entry-probe")).toBeNull();
  });

  it("offers no Secrets and GitHub row to a signed-in user", async () => {
    runnerHostStub.current = {
      signInUrl: "https://platform.example.dev/sign-in",
      browserView: null,
    };
    useAuthStore.setState({ status: "signed-in" });
    renderSidebar();

    // The rest of the rail rendered, so the row's absence is the assertion.
    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    expect(screen.queryByTestId("settings-secrets-and-github")).toBeNull();
    expect(screen.queryByText("Secrets and GitHub")).toBeNull();
  });
});

// The scope model, pinned. Every section's group is written out here, so
// moving a section (or adding one) without deciding where it belongs fails
// this suite rather than silently changing which picker, if any, it sits
// under.
const EXPECTED_SECTION_GROUPS: ReadonlyArray<
  readonly [SettingsSectionId, SettingsSectionGroupId]
> = [
  ["getting-started", "guide"],
  ["general", "app"],
  ["appearance", "app"],
  ["browser", "app"],
  ["opening-behavior", "app"],
  ["app-notifications", "app"],
  ["alerts", "app"],
  ["keybindings", "app"],
  ["layout", "app"],
  ["app-diagnostics", "app"],
  ["devices", "account"],
  ["link-phone", "account"],
  ["usage", "account"],
  ["credits", "account"],
  ["notifications", "account"],
  ["delete-account", "account"],
  ["providers", "personal"],
  ["mcp-servers", "personal"],
  ["skills", "personal"],
  ["permissions", "personal"],
  ["agents", "personal"],
  ["fallback", "personal"],
  ["shell", "personal"],
  ["browser-agent-access", "personal"],
  ["secrets", "personal"],
  ["sandboxes", "personal"],
  ["members", "personal"],
  ["agent-definitions", "personal"],
  ["machine-setup", "personal"],
  // Dev-only proof pages: offered whenever `import.meta.env.DEV` holds, which
  // is every vitest run, and withheld from production builds.
  ["dev-artifact-proof", "app"],
  ["dev-canvas-proof", "app"],
  ["host", "host"],
  ["worktrees", "host"],
  ["diagnostics", "host"],
];

const GROUP_HEADING_BY_ID: Readonly<Record<SettingsSectionGroupId, string>> = {
  guide: "Guide",
  app: "Application",
  personal: "Environment",
  account: "Account",
  host: "Host",
};

describe("<SettingsSidebar /> scope groups", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    setMobileApp(false);
  });

  afterEach(() => {
    cleanup();
    scopeOverrides.current = { client: null };
    setMobileApp(false);
  });

  async function renderRail(): Promise<HTMLElement> {
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    await screen.findByTestId("settings-sidebar-item-general");
    const aside = document.querySelector<HTMLElement>(
      "[data-settings-sidebar]",
    );
    if (aside === null) throw new Error("settings sidebar did not render");
    return aside;
  }

  it("orders the groups Guide, Application, Account, Environment, Host", () => {
    expect(SETTINGS_SECTION_GROUPS.map((group) => group.id)).toEqual([
      "guide",
      "app",
      "account",
      "personal",
      "host",
    ]);
    expect(SETTINGS_SECTION_GROUPS.map((group) => group.label)).toEqual([
      "Guide",
      "Application",
      "Account",
      "Environment",
      "Host",
    ]);
  });

  it.each(EXPECTED_SECTION_GROUPS)(
    "files the %s section under the %s group",
    (id, group) => {
      expect(
        SETTINGS_SECTIONS.find((section) => section.id === id)?.group,
      ).toBe(group);
    },
  );

  it("lists exactly the sections the group table names, in the same order", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual(
      EXPECTED_SECTION_GROUPS.map(([id]) => id),
    );
  });

  it("renders a heading for every group but Guide, in order", async () => {
    const aside = await renderRail();

    const headings = Array.from(aside.querySelectorAll("h2")).map(
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["Application", "Account", "Environment", "Host"]);
  });

  it("files each rendered row under its group's heading", async () => {
    const aside = await renderRail();

    // Walk the rail in document order, filing every row under the heading
    // above it. Guide has no heading, so its rows are the ones before the
    // first.
    const filed = new Map<string, Array<string>>();
    let current = GROUP_HEADING_BY_ID.guide;
    filed.set(current, []);
    for (const node of aside.querySelectorAll<HTMLElement>(
      "h2, [data-testid^='settings-sidebar-item-']",
    )) {
      if (node.tagName === "H2") {
        current = node.textContent;
        filed.set(current, []);
        continue;
      }
      filed
        .get(current)
        ?.push(
          node.dataset.testid?.replace("settings-sidebar-item-", "") ?? "",
        );
    }

    // Desktop: Delete account is offered by the installed mobile app only.
    const expected = new Map<string, Array<string>>();
    for (const [id, group] of EXPECTED_SECTION_GROUPS) {
      if (id === "delete-account") continue;
      // Machine setup, Agent definitions and Browser agent access are retired
      // from navigation; Members is a team's page, and the default pick is
      // Personal.
      if (
        id === "machine-setup" ||
        id === "agent-definitions" ||
        id === "browser-agent-access" ||
        id === "members"
      ) {
        continue;
      }
      const heading = GROUP_HEADING_BY_ID[group];
      expected.set(heading, [...(expected.get(heading) ?? []), id]);
    }
    expect(Object.fromEntries(filed)).toEqual(Object.fromEntries(expected));
  });

  it("renders the host picker once, after Account and Environment and before the host rows", async () => {
    const aside = await renderRail();

    const pickers = screen.getAllByTestId("settings-host-switcher");
    expect(pickers).toHaveLength(1);
    const picker = pickers[0];
    const follows = (earlier: HTMLElement, later: HTMLElement): boolean =>
      (earlier.compareDocumentPosition(later) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0;

    for (const id of ["providers", "secrets", "devices", "notifications"]) {
      expect(
        follows(screen.getByTestId(`settings-sidebar-item-${id}`), picker),
        id,
      ).toBe(true);
    }
    for (const id of ["host", "worktrees", "diagnostics"]) {
      expect(
        follows(picker, screen.getByTestId(`settings-sidebar-item-${id}`)),
        id,
      ).toBe(true);
    }
    expect(aside.contains(picker)).toBe(true);
  });

  it("indents only the host rows under the picker, never Environment or Account", async () => {
    await renderRail();

    // The rows' own column is the nearest flex column around them; the host
    // group's carries the indent that says "these are the picker's contents".
    const columnOf = (id: string): HTMLElement => {
      const column = screen
        .getByTestId(`settings-sidebar-item-${id}`)
        .closest<HTMLElement>("div.flex-col");
      if (column === null) throw new Error(`no column around ${id}`);
      return column;
    };
    for (const id of ["host", "worktrees", "diagnostics"]) {
      expect(columnOf(id).className, id).toContain("ml-4");
    }
    for (const id of [
      "general",
      "providers",
      "mcp-servers",
      "skills",
      "fallback",
      "shell",
      "agents",
      "secrets",
      "devices",
      "usage",
      "credits",
      "permissions",
      "sandboxes",
      "notifications",
    ]) {
      expect(columnOf(id).className, id).not.toContain("ml-4");
    }
    // And the picker is not the container of any Environment or Account row.
    const picker = screen.getByTestId("settings-host-switcher");
    for (const id of ["providers", "devices", "credits"]) {
      expect(
        picker.contains(screen.getByTestId(`settings-sidebar-item-${id}`)),
        id,
      ).toBe(false);
    }
  });
});

describe("<SettingsSidebar /> Environment pick", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    setMobileApp(false);
  });

  afterEach(() => {
    cleanup();
    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: PERSONAL_PICK,
    });
    scopeOverrides.current = { client: null };
  });

  async function renderRail(): Promise<void> {
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    await screen.findByTestId("settings-sidebar-item-general");
  }

  const present = (id: string): boolean =>
    screen.queryByTestId(`settings-sidebar-item-${id}`) !== null;

  /** The Environment group's rows by label, in rail order. */
  function environmentRows(): string[] {
    const heading = Array.from(document.querySelectorAll("h2")).find(
      (node) => node.textContent === "Environment",
    );
    const next = Array.from(document.querySelectorAll("h2")).find(
      (node) => node.textContent === "Host",
    );
    if (heading === undefined || next === undefined) {
      throw new Error("the Environment group did not render");
    }
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-testid^='settings-sidebar-item-']",
      ),
    )
      .filter(
        (row) =>
          (heading.compareDocumentPosition(row) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
            0 &&
          (next.compareDocumentPosition(row) &
            Node.DOCUMENT_POSITION_PRECEDING) !==
            0,
      )
      .map((row) => row.textContent);
  }

  const PERSONAL_ROWS = [
    "Providers",
    "MCP servers",
    "Skills",
    "Permissions",
    "Agents",
    "Model routing",
    "Variables & shells",
    "Secrets",
    "Sandboxes",
  ];

  it("lists Personal's Environment rows exactly, with no retired page and no Members", async () => {
    await renderRail();

    expect(environmentRows()).toEqual(PERSONAL_ROWS);
    expect(present("machine-setup")).toBe(false);
    expect(present("agent-definitions")).toBe(false);
    expect(present("browser-agent-access")).toBe(false);
    expect(present("credits")).toBe(true);
  });

  it("hides MCP servers, Skills, Sandboxes and Members while a Local row is picked", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-old", hostName: "Old laptop" },
    });

    await renderRail();

    expect(environmentRows()).toEqual([
      "Providers",
      "Permissions",
      "Agents",
      "Model routing",
      "Variables & shells",
      "Secrets",
    ]);
  });

  it("shows Members when a team is picked", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-team" },
    });

    await renderRail();

    expect(environmentRows()).toEqual([...PERSONAL_ROWS, "Members"]);
  });
});

describe("<SettingsSidebar /> preview features", () => {
  const ALL_ON = { environments: "on", sandboxes: "on", bots: "on" } as const;

  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    setMobileApp(false);
    previewVerdict.current = { ...ALL_ON };
  });

  afterEach(() => {
    cleanup();
    previewVerdict.current = { ...ALL_ON };
    useAuthStore.setState({ status: "signed-out" });
    sandboxControl.reason = null;
    scopeOverrides.current = { client: null };
  });

  async function renderRail(): Promise<void> {
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    await screen.findByTestId("settings-sidebar-item-general");
  }

  const present = (id: string): boolean =>
    screen.queryByTestId(`settings-sidebar-item-${id}`) !== null;
  const headings = (): string[] =>
    Array.from(document.querySelectorAll("h2")).map((node) => node.textContent);

  it.each(["off", "unread"] as const)(
    "has no rows for the gated pages, no Environment picker and an Agent settings heading while the verdict reads %s",
    async (state) => {
      previewVerdict.current = { environments: state, sandboxes: state, bots: state };
      await renderRail();

      for (const id of ["secrets", "members", "machine-setup", "agent-definitions", "sandboxes"]) {
        expect(present(id)).toBe(false);
      }
      expect(present("providers")).toBe(true);
      expect(screen.queryByTestId("environment-picker-trigger")).toBeNull();
      expect(headings()).toContain("Agent settings");
      expect(headings()).not.toContain("Environment");
    },
  );

  it("brings the rows, the picker and the Environment heading back with the verdict on", async () => {
    await renderRail();

    expect(present("secrets")).toBe(true);
    expect(present("sandboxes")).toBe(true);
    expect(screen.getByTestId("environment-picker-trigger")).toBeTruthy();
    expect(headings()).toContain("Environment");
    expect(headings()).not.toContain("Agent settings");
  });

  it("drops only the Sandboxes row when sandboxes read off and environments and bots read on", async () => {
    previewVerdict.current = { environments: "on", sandboxes: "off", bots: "on" };
    await renderRail();

    expect(present("sandboxes")).toBe(false);
    expect(present("secrets")).toBe(true);
    expect(screen.getByTestId("environment-picker-trigger")).toBeTruthy();
  });

  describe("the host picker's sandbox entries", () => {
    it.each(["off", "unread"] as const)(
      "draws no sandboxes link, Automations entry, balance warning or unavailable note while sandboxes read %s",
      async (state) => {
        previewVerdict.current = { environments: "on", sandboxes: state, bots: "on" };
        useAuthStore.setState({ status: "signed-in" });
        await renderRail();
        cleanup();
        sandboxControl.reason = SANDBOXES_UNAVAILABLE_IN_STAGING;
        await renderRail();

        for (const id of [
          "settings-host-picker-sandboxes",
          "automations-entry-probe",
          "sandbox-balance-warning",
          "settings-sandboxes-unavailable",
        ]) {
          expect(screen.queryByTestId(id)).toBeNull();
        }
      },
    );

    it("draws the link, the Automations entry and the balance warning with sandboxes on, and the note on a build that cannot reach the control plane", async () => {
      useAuthStore.setState({ status: "signed-in" });
      await renderRail();

      expect(screen.getByTestId("settings-host-picker-sandboxes")).toBeTruthy();
      expect(screen.getByTestId("automations-entry-probe")).toBeTruthy();
      expect(screen.getByTestId("sandbox-balance-warning")).toBeTruthy();
      cleanup();

      sandboxControl.reason = SANDBOXES_UNAVAILABLE_IN_STAGING;
      await renderRail();
      expect(screen.getByTestId("settings-sandboxes-unavailable")).toBeTruthy();
    });
  });
});
