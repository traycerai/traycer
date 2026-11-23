import {
  SettingsSidebar,
  type SettingsSidebarVariant,
} from "@/components/settings/settings-sidebar";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  SETTINGS_SECTION_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSectionGroupId,
  type SettingsSectionId,
} from "@/lib/settings-sections";
import { setMobileApp } from "@/lib/mobile-app";
import {
  resetEnvironmentSectionReads,
  windowHostRunsPersonal,
} from "@/components/settings/__tests__/environment-section-reads-fixture";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { getDefaultBindings } from "@/lib/keybindings/actions";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { useTabsStore } from "@/stores/tabs/store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { SANDBOXES_UNAVAILABLE_IN_STAGING } from "@traycer-clients/shared/host-client/sandbox-control";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  PERSONAL_PICK,
  UNRESOLVED_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { isConcealed } from "@/components/settings/host-scope/concealment-test-helpers";
import { useSectionServed } from "@/components/settings/personal/use-old-host-local-pick";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  recordNegotiatedHostManifest,
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { LocalMovePageOr } from "@/components/settings/environment/local-move-page";
import {
  pickOldHostLocal,
  recordOldHost,
} from "@/components/settings/__tests__/old-host-pick-fixture";
import { SettingsPanelForSection } from "@/components/settings/settings-modal-content";
import { SettingsSurface } from "@/components/settings/settings-surface";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import { useEffect, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sidebar's host group is headed by the one host switcher, which composes
// several host-runtime hooks. This suite is about NAVIGATION, so it mocks at
// the scope boundary rather than standing up a host runtime.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: { client: null },
}));
const globalScopeOverrides = vi.hoisted(
  (): { current: Record<string, unknown> } => ({
    current: { client: null },
  }),
);
const poolServes = vi.hoisted(() => ({ current: false }));
const soundtrackOfferedMock = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => soundtrackOfferedMock.value,
}));

// The process tier plan settles once per process; a case that needs a server
// pool sets it here so the others keep the no-pool plan.
vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    const { poolEntry } =
      await import("@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures");
    const poolPlan = original.createHostRpcTierPlan(poolEntry);
    return {
      ...original,
      readProcessHostRpcTierPlan: () =>
        poolServes.current ? poolPlan : original.readProcessHostRpcTierPlan(),
    };
  },
);

vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture(scopeOverrides.current);
  // One scope per override set, as the real hook's memoised scope is: a fresh
  // object per render would restart the picker model's effects every render.
  const scopes = new WeakMap<object, HostScope>();
  const useHostScopeFor = () => {
    const overrides = globalScopeOverrides.current;
    const known = scopes.get(overrides);
    if (known !== undefined) return known;
    const scope = hostScopeFixture(overrides);
    scopes.set(overrides, scope);
    return scope;
  };
  return {
    useHostScope,
    useHostScopeFor,
    WINDOW_HOST_SELECTION: {
      scopedHostId: null,
      setScopedHostId: () => undefined,
    },
    usePersonalHostScope: useHostScope,
    usePickHostScope: useHostScopeFor,
    useHostScopeForHostId: useHostScopeFor,
  };
});

// Reads this suite mounts no host runtime or query client for answer the
// honest "nothing has answered" from the shared fixture; the rows and pickers
// have their own suites. The registered statuses are one map for every render,
// as the real hook's memoised read: a fresh one would rebuild a Local default
// pick, and re-set it, on every render.
const noStatuses = vi.hoisted(() => new Map());
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => noStatuses,
}));
// The negotiated versions are the manifest registry's, which a case records
// per host; nothing records one by default, so no host has negotiated.
// Settings' Local move offer reads a host's client, which none of these hosts
// has.
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-client-for-host-id")
  >()),
  useHostClientForHostId: () => null,
}));
// Settings' pages are their own suites: the panels a search hit can land on
// are probes, and the frame around them passes its children through, except
// in the cases that turn `realFrame` on to follow a default pick resolving.
// The move offer, the pick upkeep and the search are the real ones.
const realFrame = vi.hoisted(() => ({ on: false }));
vi.mock(
  "@/components/settings/personal/personal-page-frame",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/personal/personal-page-frame")
      >();
    return {
      ...actual,
      PersonalPageFrame: (props: {
        readonly section: SettingsSectionId;
        readonly children: React.ReactNode;
      }) =>
        realFrame.on ? <actual.PersonalPageFrame {...props} /> : props.children,
    };
  },
);
// Each probe counts its mounts: a page that was never drawn mounted zero times.
const probeMounts = vi.hoisted((): Record<string, number> => ({}));
const probe = vi.hoisted(
  () =>
    async (name: string): Promise<() => React.ReactNode> => {
      const { createElement, useEffect } = await import("react");
      return function Probe() {
        useEffect(() => {
          probeMounts[name] = (probeMounts[name] ?? 0) + 1;
        }, []);
        return createElement("div", { "data-testid": `${name}-page-probe` });
      };
    },
);
vi.mock("@/components/settings/panels/providers-settings-panel", async () => ({
  McpServersSettingsPanel: await probe("mcp-servers"),
  ProvidersSettingsPanel: await probe("providers"),
  SkillsSettingsPanel: await probe("skills"),
}));
vi.mock(
  "@/components/settings/environment/members-settings-panel",
  async () => ({ MembersSettingsPanel: await probe("members") }),
);
vi.mock("@/components/settings/panels/secrets-settings-panel", async () => ({
  SecretsSettingsPanel: await probe("secrets"),
}));
vi.mock(
  "@/components/settings/panels/agent-memories-settings-panel",
  async () => ({ AgentMemoriesSettingsPanel: await probe("agent-memories") }),
);
// Agents' own panel is real, since it picks its body by the host: only what
// each body holds is a probe.
vi.mock(
  "@/components/settings/panels/agent-selection-guide-section",
  async () => ({ AgentSelectionGuideSection: await probe("agents-guide") }),
);
vi.mock("@/components/settings/panels/agent-definitions-tab", async () => ({
  AgentDefinitionsTab: await probe("agents-definitions"),
}));
// The surface the search navigates through: an overlay that swaps the section
// in place, which the test's own surface (below) implements. Nothing else
// publishes an API, so every other case keeps the real bridge.
const surfaceApi = vi.hoisted(
  (): { setSection: ((section: string) => void) | null } => ({
    setSection: null,
  }),
);
vi.mock("@/stores/tabs/system-tab-modal-bridge", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/stores/tabs/system-tab-modal-bridge")
    >();
  return {
    ...actual,
    getSystemTabModalApi: () =>
      surfaceApi.setSection === null
        ? actual.getSystemTabModalApi()
        : {
            isOverlayActive: () => true,
            setSection: surfaceApi.setSection,
            openSettings: () => undefined,
            active: null,
            close: () => undefined,
          },
  };
});
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
// The Guide group leaves the rail once every Getting started step is done;
// the real answer reads several `useQuery`s and this suite mounts no query
// client. Not done by default, as for a new account.
const guideComplete = vi.hoisted(() => ({ current: false }));
vi.mock("@/components/onboarding/getting-started-checklist", () => ({
  useGettingStartedGuideIsComplete: () => guideComplete.current,
}));

// The shared fixture answers "nothing observed" for the liveness poll, the
// picker rows' labels and update badges, and the balance banner: each reads a
// `useQuery` this navigation suite mounts no client for.
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

// The deployment offers Automations and no row exists yet: the one state the
// sidebar once drew an Automations / Start entry for.
vi.mock("@/hooks/sandboxes/use-sandbox-automation-query", () => ({
  useSandboxAutomation: () => ({ data: { available: true, sandbox: null } }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-automation-open-mutation", () => ({
  useSandboxAutomationOpen: () => ({ isPending: false, mutate: vi.fn() }),
}));

// What `IRunnerHost.sandboxControlUnavailableReason` reads as; a build that
// reaches the control plane (every test here but one) answers `null`.
const sandboxControl = vi.hoisted(() => ({
  reason: null as string | null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-control-unavailable-reason", () => ({
  useSandboxControlUnavailableReason: () => sandboxControl.reason,
}));

// The cloud road by default: a Personal pick offers the cloud's pages. A case
// that is about what the window's host scope says sets `realWindowHostRuns`
// to run the real hook over that scope.
const realWindowHostRuns = vi.hoisted(() => ({ current: false }));
vi.mock(
  "@/components/settings/personal/use-window-host-runs-personal",
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import("@/components/settings/personal/use-window-host-runs-personal")
      >();
    const { windowHostRunsPersonalModule } =
      await import("@/components/settings/__tests__/environment-section-reads-fixture");
    return {
      useWindowHostRunsPersonal: (scope: HostScope) =>
        realWindowHostRuns.current
          ? real.useWindowHostRunsPersonal(scope)
          : windowHostRunsPersonalModule.useWindowHostRunsPersonal(),
    };
  },
);
// The real hook reads the window host's status through a `useQuery`; none is
// mounted, and the case that runs it answers on the scope's status alone.
vi.mock(
  "@/hooks/environment/use-environment-reads",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/environment/use-environment-reads")
    >()),
    useEnvironmentStatusRead: () => ({
      supported: null,
      data: null,
      isError: false,
    }),
  }),
);

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

afterEach(() => {
  soundtrackOfferedMock.value = false;
});

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

  // Application Diagnostics needs a desktop bridge. The host group's
  // Diagnostics row is a different section and stays; the two links share
  // the accessible name, so the row is the app-diagnostics test id.
  it("omits the Application Diagnostics entry in the installed mobile app", async () => {
    setMobileApp(true);
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    const diagnostics = screen.getAllByRole("link", { name: "Diagnostics" });
    expect(diagnostics.map((link) => link.getAttribute("href"))).toEqual([
      "/settings/diagnostics",
    ]);
  });

  it("renders the Application Diagnostics entry on other builds", async () => {
    setMobileApp(false);
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    const diagnostics = screen.getAllByRole("link", { name: "Diagnostics" });
    expect(diagnostics.map((link) => link.getAttribute("href"))).toEqual([
      "/settings/app-diagnostics",
      "/settings/diagnostics",
    ]);
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

  it("labels application sounds and alerts apart", () => {
    const sounds = SETTINGS_SECTIONS.find(
      (section) => section.id === "app-notifications",
    );
    const alerts = SETTINGS_SECTIONS.find((section) => section.id === "alerts");
    expect(sounds?.label).toBe("Sounds");
    expect(alerts?.label).toBe("Alerts");
    // Different controls, so different icons too (the rail-table rule).
    expect(sounds?.icon).not.toBe(alerts?.icon);
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

  it("keeps the Sandboxes availability message off the rail", async () => {
    sandboxControl.reason = SANDBOXES_UNAVAILABLE_IN_STAGING;
    useAuthStore.setState({ status: "signed-in" });
    renderSidebar();

    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    expect(screen.queryByTestId("settings-sandboxes-unavailable")).toBeNull();
    expect(screen.queryByTestId("settings-new-sandbox")).toBeNull();
  });

  it("shows neither the entry nor the line when signed out, whatever the build", async () => {
    sandboxControl.reason = "Sandboxes aren't available in staging builds.";
    useAuthStore.setState({ status: "signed-out" });
    renderSidebar();

    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    expect(screen.queryByTestId("settings-new-sandbox")).toBeNull();
    expect(screen.queryByTestId("settings-sandboxes-unavailable")).toBeNull();
  });

  it("draws no Automations entry, though the deployment offers it and no row exists", async () => {
    useAuthStore.setState({ status: "signed-in" });
    renderSidebar();

    expect(await screen.findByRole("link", { name: "General" })).toBeDefined();
    expect(screen.queryByText("Automations")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
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
  ["agent-memories", "personal"],
  ["agents", "personal"],
  ["fallback", "personal"],
  ["shell", "personal"],
  ["browser-agent-access", "personal"],
  ["secrets", "personal"],
  ["sandboxes", "personal"],
  ["storage", "personal"],
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
  host: "Hosts",
};

describe("<SettingsSidebar /> scope groups", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    setMobileApp(false);
    // A resolved pick: Secrets is offered once the pick is known to serve it.
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
  });

  afterEach(() => {
    cleanup();
    useSettingsEnvironmentPickStore.setState({ pick: null });
    scopeOverrides.current = { client: null };
    globalScopeOverrides.current = { client: null };
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

  it("orders the groups Guide, Application, Account, Environment, Hosts", () => {
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
    expect(headings).toEqual([
      "Application",
      "Account",
      "Environment",
      "Hosts",
    ]);
  });

  it.each([true, false])(
    "files each rendered row under its group's heading (soundtrack offered: %s)",
    async (soundtrackOffered) => {
      soundtrackOfferedMock.value = soundtrackOffered;
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
        // Sounds holds only the soundtrack, so a build without one has no row.
        if (id === "app-notifications" && !soundtrackOffered) continue;
        // Machine setup, Agent definitions, Browser agent access and
        // Notifications are retired from navigation; Members is a team's page, and the default pick is
        // Personal.
        if (
          id === "machine-setup" ||
          id === "agent-definitions" ||
          id === "browser-agent-access" ||
          id === "notifications" ||
          id === "members"
        ) {
          continue;
        }
        const heading = GROUP_HEADING_BY_ID[group];
        expected.set(heading, [...(expected.get(heading) ?? []), id]);
      }
      expect(Object.fromEntries(filed)).toEqual(Object.fromEntries(expected));
    },
  );

  it("does not list the retired Notifications page, on any build", async () => {
    await renderRail();

    expect(
      screen.queryByTestId("settings-sidebar-item-notifications"),
    ).toBeNull();
    expect(screen.getByTestId("settings-sidebar-item-alerts")).toBeTruthy();
  });

  it("renders the host picker once, after Account and Environment and before the host rows", async () => {
    const aside = await renderRail();

    const pickers = screen.getAllByTestId("settings-host-switcher");
    expect(pickers).toHaveLength(1);
    const picker = pickers[0];
    expect(picker.textContent).toBe("host-a");
    const follows = (earlier: HTMLElement, later: HTMLElement): boolean =>
      (earlier.compareDocumentPosition(later) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
      0;

    for (const id of ["providers", "secrets", "devices"]) {
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

  it("keeps the Hosts group and introduces the rail picker", async () => {
    const { hostScopeOptionFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    const member = hostScopeOptionFixture({
      hostId: "host-member",
      name: "Member computer",
      isLocalMachine: false,
      isActive: true,
    });
    const outside = hostScopeOptionFixture({
      hostId: "host-outside",
      name: "Other environment",
      isLocalMachine: false,
      isActive: false,
    });
    scopeOverrides.current = {
      hosts: [member],
      host: member,
      hostId: member.hostId,
    };
    globalScopeOverrides.current = {
      hosts: [member, outside],
      host: member,
      hostId: member.hostId,
    };
    await renderRail();

    expect(screen.getByRole("heading", { name: "Hosts" })).not.toBeNull();
    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    expect(screen.getByText("Look at another host")).not.toBeNull();
    expect(
      screen.getByText("Changes what this window shows. Nothing is created."),
    ).not.toBeNull();
    expect(screen.queryByText("View host")).toBeNull();
    expect(
      screen.getByTestId("settings-host-switcher-option-host-member"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId("settings-host-switcher-option-host-outside"),
    ).toBeNull();
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
      "agent-memories",
      "sandboxes",
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
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
  });

  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: PERSONAL_PICK,
    });
    scopeOverrides.current = { client: null };
    resetNegotiatedManifests();
    resetEnvironmentSectionReads();
    poolServes.current = false;
    realWindowHostRuns.current = false;
    globalScopeOverrides.current = { client: null };
    useSettingsSearchStore.setState({ query: "" });
    setMobileApp(false);
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

  /** The Environment group's rows, in rail order. */
  function environmentRowElements(): HTMLElement[] {
    const heading = Array.from(document.querySelectorAll("h2")).find(
      (node) => node.textContent === "Environment",
    );
    const next = Array.from(document.querySelectorAll("h2")).find(
      (node) => node.textContent === "Hosts",
    );
    if (heading === undefined || next === undefined) {
      throw new Error("the Environment group did not render");
    }
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-testid^='settings-sidebar-item-']",
      ),
    ).filter(
      (row) =>
        (heading.compareDocumentPosition(row) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0 &&
        (next.compareDocumentPosition(row) &
          Node.DOCUMENT_POSITION_PRECEDING) !==
          0,
    );
  }

  /** The Environment group's rows by label, in rail order. */
  function environmentRows(): string[] {
    return environmentRowElements().map((row) => row.textContent);
  }

  const LOCAL_PICK = {
    kind: "local",
    hostId: "host-old",
    hostName: "Old laptop",
  } as const;
  const SECRETS_LIST = "environment.secrets.list";
  /** The window's host list names the picked computer, as a listed one is. */
  function listLocalPickHost(): void {
    globalScopeOverrides.current = {
      client: null,
      hosts: [
        hostScopeOptionFixture({ hostId: "host-a" }),
        hostScopeOptionFixture({ hostId: LOCAL_PICK.hostId }),
      ],
    };
  }
  const secretsHit = (): Element | null =>
    document.querySelector("[data-testid^='settings-search-result-secrets:']");

  const PERSONAL_ROWS = [
    "Providers",
    "MCP servers",
    "Skills",
    "Permissions",
    "Memories",
    "Agents",
    "Model routing",
    "Variables & shells",
    "Secrets",
    "Sandboxes",
    "Storage",
  ];

  it("lists Personal's Environment rows exactly, with no retired page and no Members", async () => {
    await renderRail();

    expect(environmentRows()).toEqual(PERSONAL_ROWS);
    expect(present("machine-setup")).toBe(false);
    expect(present("agent-definitions")).toBe(false);
    expect(present("browser-agent-access")).toBe(false);
    expect(present("credits")).toBe(true);
  });

  it("keeps MCP servers, Skills, Sandboxes and Storage visible under a Local pick, and hides Members", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK });
    listLocalPickHost();
    recordNegotiatedHostMethods(LOCAL_PICK.hostId, [
      "environment.status",
      SECRETS_LIST,
    ]);

    await renderRail();

    expect(environmentRows()).toEqual(PERSONAL_ROWS);
  });

  const OLD_HOST_PICK = {
    kind: "local",
    hostId: "host-old",
    hostName: "Old laptop",
  } as const;

  /**
   * The rail beside a body that is the real Local move offer for the section
   * the route names, inside the query client that offer reads through.
   */
  async function renderRailWithPages() {
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <SettingsSidebar mode={{ kind: "route" }} variant="rail" />
          <Outlet />
        </>
      ),
    });
    const settingsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/$section",
      component: function Body() {
        const section = useLocation().pathname.split("/")[2];
        const id =
          SETTINGS_SECTIONS.find((candidate) => candidate.id === section)?.id ??
          "general";
        return (
          <LocalMovePageOr section={id}>
            <div data-testid="settings-body" />
          </LocalMovePageOr>
        );
      },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([settingsRoute]),
      history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KeybindingProvider router={router}>
          <RouterProvider router={router} />
        </KeybindingProvider>
      </QueryClientProvider>,
    );
    await screen.findByTestId("settings-body");
    return router;
  }

  /** Presses the rail's row for `id` until the route names that section. */
  async function openFromRail(router: AnyRouter, id: string): Promise<void> {
    const links = await screen.findAllByTestId(`settings-sidebar-item-${id}`);
    fireEvent.click(links[links.length - 1]);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/settings/${id}`);
    });
  }

  it("lists every Environment row but Members under a Local pick on a host whose methods lack environment.status", async () => {
    pickOldHostLocal();

    await renderRail();

    expect(environmentRows()).toEqual(PERSONAL_ROWS);
  });

  it("keeps every Local row for a host that advertises environment.status", async () => {
    recordNegotiatedHostManifest("host-old", {
      "environment.status": { major: 1, minor: 3 },
      [SECRETS_LIST]: { major: 1, minor: 0 },
    });
    listLocalPickHost();
    useSettingsEnvironmentPickStore.setState({ pick: OLD_HOST_PICK });

    await renderRail();

    expect(environmentRows()).toEqual(PERSONAL_ROWS);
  });

  it("opens the Move offer from the same rail on a Local pick of a host that advertises environment.status", async () => {
    recordNegotiatedHostManifest("host-old", {
      "environment.status": { major: 1, minor: 3 },
    });
    useSettingsEnvironmentPickStore.setState({ pick: OLD_HOST_PICK });
    const router = await renderRailWithPages();

    await openFromRail(router, "mcp-servers");

    expect(screen.getByTestId("local-move-page")).toBeTruthy();
    expect(screen.getByTestId("local-move-page-move")).toBeTruthy();
  });

  it("shows Members when a team is picked", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-team" },
    });

    await renderRail();

    expect(environmentRows()).toEqual([...PERSONAL_ROWS, "Members"]);
  });

  it("lists the Secrets row under a Local pick whose computer the host list does not name, though the pool serves the list", async () => {
    poolServes.current = true;
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK });
    globalScopeOverrides.current = {
      client: null,
      hosts: [hostScopeOptionFixture({ hostId: "host-a" })],
    };
    recordNegotiatedHostMethods(POOL_HOST_ID, [SECRETS_LIST]);

    await renderRail();

    expect(environmentRows()).toEqual(PERSONAL_ROWS);
  });

  it("lists the Secrets row under a Local pick whose host answered without the list", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK });
    listLocalPickHost();
    recordNegotiatedHostMethods(LOCAL_PICK.hostId, ["environment.status"]);

    await renderRail();

    expect(environmentRows()).toEqual(PERSONAL_ROWS);
  });

  it("keeps the rail's rows the same when an old host's manifest lands under a remembered Local pick of it", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK });
    await renderRail();
    const before = environmentRows();

    act(() => {
      recordOldHost();
    });

    expect(before).toEqual(PERSONAL_ROWS);
    expect(environmentRows()).toEqual(before);
  });

  it.each([
    { name: "serves the list", methods: ["environment.status", SECRETS_LIST] },
    { name: "lacks the list", methods: ["environment.status"] },
  ])(
    "keeps the rail's rows the same when a current host that $name lands its manifest under a Local pick of it",
    async ({ methods }) => {
      useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK });
      listLocalPickHost();
      await renderRail();
      const before = environmentRows();

      act(() => {
        recordNegotiatedHostMethods(LOCAL_PICK.hostId, methods);
      });

      expect(before).toEqual(PERSONAL_ROWS);
      expect(environmentRows()).toEqual(before);
    },
  );

  it.each([
    { name: "unknown", runs: null, served: false },
    {
      name: "a host that runs Personal and serves the list",
      runs: true,
      served: true,
    },
    {
      name: "a host that runs Personal and does not serve the list",
      runs: true,
      served: false,
    },
    { name: "a host that does not run Personal", runs: false, served: false },
  ])(
    "lists Personal's Secrets row, with the window's host being $name",
    async ({ runs, served }) => {
      windowHostRunsPersonal.current = runs;
      recordNegotiatedHostMethods(
        "host-a",
        served ? [SECRETS_LIST] : ["environment.status"],
      );

      await renderRail();

      expect(present("secrets")).toBe(true);
    },
  );

  it("offers a team's Secrets row whatever its window's host serves", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-team" },
    });
    recordNegotiatedHostMethods("host-a", ["environment.status"]);

    await renderRail();

    expect(present("secrets")).toBe(true);
  });

  it("offers Personal's Secrets row while the window's host is unreachable, since the page reads the cloud", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: { kind: "personal" } });
    realWindowHostRuns.current = true;
    globalScopeOverrides.current = { status: "unreachable" };
    recordNegotiatedHostMethods("host-a", ["environment.status"]);

    await renderRail();

    expect(present("secrets")).toBe(true);
  });

  it("lists a Secrets search result under a Local pick before its host answers and after, whatever it serves", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK });
    listLocalPickHost();
    const router = buildRouter("/settings/general");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    const input = await screen.findByRole("combobox", {
      name: "Search settings",
    });

    fireEvent.change(input, { target: { value: "secrets" } });

    expect(secretsHit()).not.toBeNull();

    act(() => {
      recordNegotiatedHostMethods(LOCAL_PICK.hostId, ["environment.status"]);
    });

    expect(secretsHit()).not.toBeNull();
  });

  it("lists the phone's settings list a Secrets row under a Local pick before its host answers and after, whatever it serves", async () => {
    setMobileApp(true);
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK });
    listLocalPickHost();
    const router = buildVariantRouter(["/settings"], "mobile-list");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    await screen.findByTestId("settings-sidebar-item-providers");

    expect(present("secrets")).toBe(true);

    act(() => {
      recordNegotiatedHostMethods(LOCAL_PICK.hostId, ["environment.status"]);
    });

    expect(present("secrets")).toBe(true);
  });
});

describe("<SettingsSidebar /> the section held under an old host's Local pick", () => {
  const HIDDEN_PAGES = [
    ["mcp-servers", "MCP servers"],
    ["skills", "Skills"],
    ["secrets", "Secrets"],
    ["agent-memories", "Memories"],
    ["sandboxes", "Sandboxes"],
    ["storage", "Storage"],
  ] as const;

  /** The modal's own wiring: the sidebar, and the page for the section the surface holds. */
  function SettingsSurfaceHarness(props: {
    readonly initialSection: SettingsSectionId;
  }) {
    const [section, setSection] = useState<SettingsSectionId>(
      props.initialSection,
    );
    useEffect(() => {
      surfaceApi.setSection = (next) => {
        const found = SETTINGS_SECTIONS.find(
          (candidate) => candidate.id === next,
        );
        if (found !== undefined) setSection(found.id);
      };
      return () => {
        surfaceApi.setSection = null;
      };
    }, []);
    return (
      <>
        <SettingsSidebar
          mode={{ kind: "modal", activeSection: section, onSelect: setSection }}
          variant="rail"
        />
        <div data-section={section} data-testid="held-section" />
        <SettingsPanelForSection section={section} />
      </>
    );
  }

  beforeEach(() => {
    for (const name of Object.keys(probeMounts)) delete probeMounts[name];
    realFrame.on = false;
    cleanup();
    window.localStorage.clear();
    useKeybindingStore.setState({ bindings: getDefaultBindings() });
    setMobileApp(false);
  });

  afterEach(() => {
    cleanup();
    resetNegotiatedManifests();
    useSettingsSearchStore.setState({ query: "" });
    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: PERSONAL_PICK,
      defaultHostId: null,
    });
    useSelectionAuthorityStore.getState().reset();
    scopeOverrides.current = { client: null };
    globalScopeOverrides.current = { client: null };
  });

  async function renderSurface(initialSection: SettingsSectionId) {
    const rootRoute = createRootRoute({
      component: () => (
        <SettingsSurfaceHarness initialSection={initialSection} />
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KeybindingProvider router={router}>
          <RouterProvider router={router} />
        </KeybindingProvider>
      </QueryClientProvider>,
    );
    return screen.findByRole("combobox", { name: "Search settings" });
  }

  function hitFor(id: string): HTMLElement | undefined {
    return screen
      .queryAllByRole("option")
      .find((option) =>
        option.dataset.testid?.startsWith(`settings-search-result-${id}:`),
      );
  }

  it.each(HIDDEN_PAGES)(
    "lists a search hit for %s, and choosing it holds that section on the rail",
    async (id, label) => {
      pickOldHostLocal();
      const input = await renderSurface("providers");

      fireEvent.change(input, { target: { value: label } });
      const hit = hitFor(id);
      expect(hit).toBeDefined();
      if (hit !== undefined) fireEvent.click(hit);
      act(() => {
        useSettingsSearchStore.setState({ query: "" });
      });

      expect(highlightedRows()).toEqual([`settings-sidebar-item-${id}`]);
    },
  );

  it("still lists a hit for a page the old host has", async () => {
    pickOldHostLocal();
    const input = await renderSurface("providers");

    fireEvent.change(input, { target: { value: "Permissions" } });

    expect(hitFor("permissions")).toBeDefined();
  });

  const PROBED_HIDDEN_PAGES = [
    "mcp-servers",
    "skills",
    "secrets",
    "agent-memories",
  ] as const;

  /** The routed Settings tab: the real surface, whose section comes from the route or the remembered path. */
  async function renderRoutedTab(path: string, lastPath: string | null) {
    const rootRoute = createRootRoute({
      component: () => <SettingsSurface lastPath={lastPath} />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([]),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <KeybindingProvider router={router}>
          <RouterProvider router={router} />
        </KeybindingProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("combobox", { name: "Search settings" });
    return router;
  }

  it.each(PROBED_HIDDEN_PAGES)(
    "holds %s on the rail when a link reaches it through navigateToSettingsSection",
    async (id) => {
      pickOldHostLocal();
      await renderSurface("providers");

      act(() => {
        navigateToSettingsSection(id);
      });

      expect(highlightedRows()).toEqual([`settings-sidebar-item-${id}`]);
      expect(probeMounts[id] ?? 0).toBe(0);
    },
  );

  it.each(PROBED_HIDDEN_PAGES)(
    "holds %s on the rail when a deep link opens the routed tab on it",
    async (id) => {
      pickOldHostLocal();

      await renderRoutedTab(`/settings/${id}`, null);

      expect(highlightedRows()).toEqual([`settings-sidebar-item-${id}`]);
      expect(probeMounts[id] ?? 0).toBe(0);
    },
  );

  it("never mounts a hidden page when the routed tab's remembered path names it", async () => {
    pickOldHostLocal();

    await renderRoutedTab("/epics", "/settings/skills");

    expect(probeMounts["skills"] ?? 0).toBe(0);
    expect(screen.queryByTestId("local-move-page")).toBeNull();
  });

  /** The window's host is the old computer and no default pick is stored yet: the dropdown resolves it. */
  function arriveInOldHostWindow(): void {
    recordNegotiatedHostMethods("host-old", ["host.status"]);
    useSelectionAuthorityStore.setState({ effectiveHostId: "host-old" });
    globalScopeOverrides.current = {
      host: hostScopeOptionFixture({ hostId: "host-old", name: "Old laptop" }),
      client: null,
    };
    useSettingsEnvironmentPickStore.setState({
      defaultPick: { kind: "unresolved" },
      defaultHostId: null,
    });
    realFrame.on = true;
  }

  /** The default pick has resolved to the old host's Local row. */
  async function defaultPickResolved(): Promise<void> {
    await waitFor(() => {
      expect(useSettingsEnvironmentPickStore.getState().defaultPick.kind).toBe(
        "local",
      );
    });
  }

  it("holds Skills on the rail when a routed tab's default pick resolves to the old host's row", async () => {
    arriveInOldHostWindow();

    await renderRoutedTab("/settings/skills", null);
    await defaultPickResolved();

    expect(highlightedRows()).toEqual(["settings-sidebar-item-skills"]);
    expect(probeMounts["skills"] ?? 0).toBe(0);
  });

  it("holds Skills on the rail when a window opening on it resolves to the old host's row", async () => {
    arriveInOldHostWindow();

    await renderSurface("skills");
    await defaultPickResolved();

    expect(highlightedRows()).toEqual(["settings-sidebar-item-skills"]);
    expect(probeMounts["skills"] ?? 0).toBe(0);
  });

  function highlightedRows(): string[] {
    return screen
      .getAllByTestId(/^settings-sidebar-item-/)
      .filter((row) => row.classList.contains("bg-accent"))
      .map((row) => row.dataset["testid"] ?? "");
  }

  function heldSection(): string | undefined {
    return screen.getByTestId("held-section").dataset["section"];
  }

  /** Presses the rail picker's row, with the dropdown opened as a pointer does. */
  function pickFromRailPicker(rowTestId: string): void {
    fireEvent.pointerDown(screen.getByTestId("environment-picker-trigger"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    act(() => {
      fireEvent.click(screen.getByTestId(rowTestId));
    });
  }

  it("keeps the modal on Secrets when the old host's Local row is picked from the rail's picker", async () => {
    recordOldHost();
    globalScopeOverrides.current = {
      client: null,
      hosts: [
        hostScopeOptionFixture({ hostId: "host-old", name: "Old laptop" }),
      ],
    };
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    await renderSurface("secrets");

    pickFromRailPicker("environment-picker-local-host-old");

    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "local",
      hostId: "host-old",
      hostName: "Old laptop",
    });
    expect(heldSection()).toBe("secrets");
    expect(highlightedRows()).toEqual(["settings-sidebar-item-secrets"]);
  });

  it("keeps the modal on Members when Personal is picked from the rail's picker", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-team" },
    });
    await renderSurface("members");

    pickFromRailPicker("environment-picker-personal");

    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
      PERSONAL_PICK,
    );
    expect(heldSection()).toBe("members");
  });

  it.each(["secrets", "mcp-servers"] as const)(
    "highlights %s, and not Providers, when the modal holds it under an old host's Local pick",
    async (id) => {
      pickOldHostLocal();

      await renderSurface(id);

      expect(highlightedRows()).toEqual([`settings-sidebar-item-${id}`]);
    },
  );

  it.each(["secrets", "mcp-servers"] as const)(
    "highlights %s, and not Providers, when a deep link opens the routed tab on it under an old host's Local pick",
    async (id) => {
      pickOldHostLocal();

      await renderRoutedTab(`/settings/${id}`, null);

      expect(highlightedRows()).toEqual([`settings-sidebar-item-${id}`]);
    },
  );

  it("still draws a hidden page under a Personal pick on the same host", async () => {
    recordNegotiatedHostMethods("host-old", ["host.status"]);
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });

    await renderSurface("skills");

    await screen.findByTestId("skills-page-probe");
    expect(screen.queryByTestId("providers-page-probe")).toBeNull();
    expect(highlightedRows()).toEqual(["settings-sidebar-item-skills"]);
  });

  const OLD_HOST_OPTION = hostScopeOptionFixture({
    hostId: "host-old",
    name: "Old laptop",
  });
  const NEW_HOST_OPTION = hostScopeOptionFixture({
    hostId: "host-new",
    name: "New laptop",
  });
  const NEW_HOST_PICK = {
    kind: "local",
    hostId: "host-new",
    hostName: "New laptop",
  } as const;
  const LOCAL_PICK_OLD = {
    kind: "local",
    hostId: "host-old",
    hostName: "Old laptop",
  } as const;
  const SECRETS_LIST = "environment.secrets.list";

  /** The window's host scope, and the scope the pick reads through, are one. */
  function scopeOn(overrides: Record<string, unknown>): void {
    scopeOverrides.current = { client: null, ...overrides };
    globalScopeOverrides.current = scopeOverrides.current;
  }

  const cardText = (testId: string): string =>
    screen.getByTestId(testId).textContent;
  /** Concealed or absent: the page stays mounted beneath the away notice, out of view. */
  function expectHiddenFromView(node: Element | null): void {
    expect(node === null || isConcealed(node)).toBe(true);
  }
  const sectionHeading = (name: string): HTMLElement =>
    screen.getByRole("heading", { name });

  it("answers Secrets with the update card under the old host's Local pick, under Secrets' own heading and with the route kept", async () => {
    pickOldHostLocal();
    scopeOn({ host: OLD_HOST_OPTION });

    await renderSurface("secrets");

    expect(sectionHeading("Secrets")).toBeTruthy();
    expect(screen.getByText("Values and logins your agents use.")).toBeTruthy();
    expect(cardText("page-not-on-computer-update")).toContain(
      "Not on Old laptop",
    );
    expect(cardText("page-not-on-computer-update")).toContain(
      "Update Old laptop to use Secrets.",
    );
    expect(heldSection()).toBe("secrets");
    expect(screen.queryByTestId("providers-page-probe")).toBeNull();
    expect(screen.queryByTestId("secrets-page-probe")).toBeNull();
  });

  it("answers MCP servers with the update card, not the move offer, under the old host's Local pick", async () => {
    pickOldHostLocal();
    scopeOn({ host: OLD_HOST_OPTION });

    await renderSurface("mcp-servers");

    expect(cardText("page-not-on-computer-update")).toContain(
      "Update Old laptop to use MCP servers.",
    );
    expect(screen.queryByTestId("local-move-page")).toBeNull();
    expect(screen.queryByTestId("mcp-servers-page-probe")).toBeNull();
  });

  it("draws the Providers page, with no card, under the old host's Local pick", async () => {
    pickOldHostLocal();
    scopeOn({ host: OLD_HOST_OPTION });

    await renderSurface("providers");

    expect(screen.getByTestId("providers-page-probe")).toBeTruthy();
    expect(screen.queryByTestId("page-not-on-computer")).toBeNull();
  });

  it("keeps the move offer for MCP servers, and draws Secrets, under a current host's Local pick that serves the list", async () => {
    recordNegotiatedHostManifest("host-new", {
      "environment.status": { major: 1, minor: 3 },
      [SECRETS_LIST]: { major: 1, minor: 0 },
    });
    useSettingsEnvironmentPickStore.setState({ pick: NEW_HOST_PICK });
    scopeOn({ host: NEW_HOST_OPTION });

    await renderSurface("mcp-servers");

    expect(screen.getByTestId("local-move-page")).toBeTruthy();
    expect(screen.queryByTestId("page-not-on-computer")).toBeNull();

    cleanup();
    await renderSurface("secrets");

    expect(screen.getByTestId("secrets-page-probe")).toBeTruthy();
    expect(screen.queryByTestId("page-not-on-computer")).toBeNull();
  });

  it("answers Secrets with the update card under a current host's Local pick whose handshake lacks the list", async () => {
    recordNegotiatedHostManifest("host-new", {
      "environment.status": { major: 1, minor: 3 },
    });
    useSettingsEnvironmentPickStore.setState({ pick: NEW_HOST_PICK });
    scopeOn({ host: NEW_HOST_OPTION });

    await renderSurface("secrets");

    expect(cardText("page-not-on-computer-update")).toContain(
      "Update New laptop to use Secrets.",
    );
    expect(screen.queryByTestId("secrets-page-probe")).toBeNull();
  });

  it("says a Local pick's computer is not connected to this app once the host list has loaded without it, with no action", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK_OLD });
    scopeOn({ host: null, isLoading: false });

    await renderSurface("secrets");

    expect(cardText("page-not-on-computer-unlisted")).toContain(
      "Not on Old laptop",
    );
    expect(cardText("page-not-on-computer-unlisted")).toContain(
      "Old laptop isn't connected to this app.",
    );
    expect(
      within(screen.getByTestId("page-not-on-computer-unlisted")).queryByRole(
        "button",
      ),
    ).toBeNull();
  });

  it("shows Connecting for a Local pick's computer while the host list is loading", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK_OLD });
    scopeOn({ host: null, isLoading: true });

    await renderSurface("secrets");

    expect(cardText("host-scope-connecting")).toContain(
      "Connecting to Old laptop",
    );
    expect(screen.queryByTestId("page-not-on-computer-unlisted")).toBeNull();
  });

  it("turns Connecting into the update card, with the route and heading unchanged, when a remembered Local pick's handshake lands old", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK_OLD });
    scopeOn({ host: OLD_HOST_OPTION });

    const router = await renderRoutedTab("/settings/secrets", null);

    expect(cardText("host-scope-connecting")).toContain(
      "Connecting to Old laptop",
    );
    expect(sectionHeading("Secrets")).toBeTruthy();

    act(() => {
      recordOldHost();
    });

    expect(cardText("page-not-on-computer-update")).toContain(
      "Update Old laptop to use Secrets.",
    );
    expect(screen.queryByTestId("host-scope-connecting")).toBeNull();
    expect(sectionHeading("Secrets")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/settings/secrets");
  });

  it("keeps Agents on Connecting, never the current host's tabs, until a listed old computer's handshake lands, then draws the guide alone", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: LOCAL_PICK_OLD });
    scopeOn({ host: OLD_HOST_OPTION });

    const router = await renderRoutedTab("/settings/agents", null);

    expect(cardText("host-scope-connecting")).toContain(
      "Connecting to Old laptop",
    );
    expect(screen.queryByTestId("agents-tab-definitions")).toBeNull();
    expect(probeMounts["agents-guide"] ?? 0).toBe(0);

    act(() => {
      recordOldHost();
    });

    expect(screen.queryByTestId("host-scope-connecting")).toBeNull();
    expect(screen.getByTestId("agents-guide-page-probe")).toBeTruthy();
    expect(screen.queryByTestId("agents-tab-definitions")).toBeNull();
    expect(screen.queryByTestId("agents-guide-caption")).toBeNull();
    // One mount: no current-host body held the guide before this one.
    expect(probeMounts["agents-guide"]).toBe(1);
    expect(router.state.location.pathname).toBe("/settings/agents");
  });

  it.each(["secrets", "mcp-servers"] as const)(
    "shows only the away notice on %s under a Local pick of an unreachable old host, never the update card",
    async (section) => {
      pickOldHostLocal();
      scopeOn({ host: OLD_HOST_OPTION, status: "unreachable" });

      await renderSurface(section);

      expect(cardText("host-scope-unreachable")).toContain(
        "Can't reach Old laptop from here",
      );
      expectHiddenFromView(screen.queryByTestId("page-not-on-computer-update"));
    },
  );

  it("shows only the away notice, not the move offer, on MCP servers under a Local pick of an unreachable current host", async () => {
    recordNegotiatedHostManifest("host-new", {
      "environment.status": { major: 1, minor: 3 },
      [SECRETS_LIST]: { major: 1, minor: 0 },
    });
    useSettingsEnvironmentPickStore.setState({ pick: NEW_HOST_PICK });
    scopeOn({ host: NEW_HOST_OPTION, status: "unreachable" });

    await renderSurface("mcp-servers");

    expect(cardText("host-scope-unreachable")).toContain(
      "Can't reach New laptop from here",
    );
    expectHiddenFromView(screen.queryByTestId("local-move-page"));
  });

  it("answers Members under Personal with the team-only card, under Members' own heading", async () => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });

    await renderSurface("members");

    expect(sectionHeading("Members")).toBeTruthy();
    expect(cardText("page-not-on-computer-team-only")).toContain(
      "Only a team has members",
    );
    expect(screen.queryByTestId("members-page-probe")).toBeNull();
  });

  it("draws the Members page under a team pick", async () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-team" },
    });

    await renderSurface("members");

    expect(screen.getByTestId("members-page-probe")).toBeTruthy();
    expect(screen.queryByTestId("page-not-on-computer")).toBeNull();
  });

  /** What `useSectionServed` answered at each render, for a pick and section. */
  function servedHistory(
    pick: EnvironmentPick,
    section: SettingsSectionId,
  ): { readonly answers: string[]; readonly rerender: () => void } {
    const answers: string[] = [];
    const view = renderHook(() => {
      const answer = useSectionServed(pick, section);
      answers.push(answer);
      return answer;
    });
    return { answers, rerender: () => view.rerender() };
  }

  it("reads an unresolved pick, and a Local pick with no handshake, as pending", () => {
    scopeOn({ host: OLD_HOST_OPTION });

    expect(servedHistory(UNRESOLVED_PICK, "secrets").answers).toEqual([
      "pending",
    ]);
    expect(servedHistory(LOCAL_PICK_OLD, "secrets").answers).toEqual([
      "pending",
    ]);
  });

  it("reads Secrets as not served for an old host's Local pick, without ever reading it as served while the handshake lands", () => {
    scopeOn({ host: OLD_HOST_OPTION });
    const history = servedHistory(LOCAL_PICK_OLD, "secrets");

    act(() => {
      recordOldHost();
    });

    expect(history.answers.at(-1)).toBe("not-served");
    expect(history.answers).not.toContain("served");
  });

  it("reads Personal on a host that does not run Personal as served", () => {
    windowHostRunsPersonal.current = false;
    scopeOn({ host: NEW_HOST_OPTION });

    expect(servedHistory(PERSONAL_PICK, "secrets").answers).toEqual(["served"]);
  });
});
