import {
  SettingsSidebar,
  type SettingsSidebarVariant,
} from "@/components/settings/settings-sidebar";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { setMobileApp } from "@/lib/mobile-app";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useTabsStore } from "@/stores/tabs/store";
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

// The sidebar's host group is headed by the one host switcher, which composes several host-runtime hooks. This
// suite is about navigation, so it mocks at the scope boundary rather than standing up a host runtime.
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

// This suite mocks `useHostScope` wholesale and renders no `QueryClientProvider`, so the real hook - which
// calls `useQuery` unconditionally - would throw for want of a query client.
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHostsPollLiveness: () => undefined,
}));

// The badge's own behaviour is covered where it belongs (the host-option row and per-host isolation suites);
// stubbing it here keeps a navigation test from silently becoming a fleet-polling test.
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
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    scopeOverrides.current = { client: null };
    setMobileApp(false);
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

  // The panel is the display end of a pairing whose scanner end is the mobile app itself, so that build does not
  // offer it either.
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

  // The machine console is labelled "Overview" now - it sits under the host switcher, which supplies the
  // machine's name, so repeating "Host" in the entry would name the container twice.
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

  it("labels the agent-selection section for selection, not the Task's Agents", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    const labels = SETTINGS_SECTIONS.map((section) => section.label);
    // The id stays `agents` (compatibility identifier + `/settings/agents`
    // route); only the product copy moves.
    expect(ids).toContain("agents");
    expect(labels).toContain("Agent selection");
    expect(labels).not.toContain("Agents");
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

  // `config.*` / `diagnostics.*` made both sections work for whichever host the picker names, so a remote pick
  // must render them identically to any other always-available section.
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
    // Neither active (not the current route) - so an undimmed, inactive row is exactly the plain
    // `text-foreground/70` class every other section's inactive row carries, not a dimmed variant of it.
    for (const link of [shellLink, diagnosticsLink]) {
      expect(link.className).not.toContain("text-foreground/40");
      expect(link.className).toContain("text-foreground/70");
    }
    // The two assertions above already pin the property under test.
  });
});

// The two variants want opposite history semantics from the same Link: the rail's sections are peers on one
// screen, so switching sections must not grow the stack (back leaves settings in one step).
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

  // Byte-symmetric with the mobile-list case above: same initial entries, same clicked link - the only variable
  // is the variant, so the two tests together pin that the variant alone flips the history semantics.
  it("rail replaces the section entry, so back leaves settings in one step", async () => {
    const router = buildVariantRouter(["/task-stub", "/settings"], "rail");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    // Clicked through a fresh query on every poll: the rail re-renders its rows as it settles (an exiting copy can
    // coexist with the live one for a frame), so a node captured once can be detached by the time the click lands.
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
