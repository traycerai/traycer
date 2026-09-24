/**
 * The Rules editor's unsaved text across the SYSTEM-TAB MODAL's real shell
 * (`SystemTabModalHost`): the modal flipping to non-modal while the theme
 * editor is up (Radix remounts its content), promotion to the Settings tab,
 * tab eviction and reconstruction, and the frame where "Settings open" reads
 * false. Each path is named by its review id (H4).
 *
 * Drivers that are not real UI, and why:
 *  - section changes use the modal api's `setSection` (the real store action
 *    the rail's rows call), because the rail's row labels are not this
 *    suite's subject;
 *  - a Settings STRIP TAB is hosted by `TabStandIn` below, because
 *    `TopLevelTabHost` is too heavy. The stand-in does what its MRU does for
 *    the settings tab: it renders `<SettingsSurface lastPath={…}/>` while
 *    `useTabsStore` has `systemTabs.settings !== null` and it has not been
 *    evicted. Eviction is the test-controlled `tabHost.evicted` flag;
 *  - the promotion gap (test 7) holds the real `openSystemTab` store action
 *    back so the tab appears only on a later `act`.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readRulesEditForTests,
  resetRulesEditForTests,
  useRulesEditLifetime,
} from "@/components/settings/panels/permissions/rules-edit-store";
import type { AutoPolicyGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  SystemTabModalHost,
  SystemTabModalSurface,
} from "@/components/layout/dialogs/system-tab-modal-host";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import {
  EMPTY_AUTO_POLICY_SECTIONS,
  joinAutoPolicySections,
} from "@/components/settings/panels/auto-policy-document";
import { SettingsSurface } from "@/components/settings/settings-surface";
import { ThemeEditorHost } from "@/components/settings/themes/theme-editor-host";
import { ThemeProvider } from "@/providers/theme-provider";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import {
  armSettingsOpenIntent,
  resetSettingsOpenIntentForTests,
} from "@/stores/tabs/settings-open-intent-store";
import { useTabsStore } from "@/stores/tabs/store";
import {
  resetSystemTabModalColdLoadForTests,
  useSystemTabModalController,
  type SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";

vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: (): boolean => false,
  isMobileViewport: (): boolean => false,
}));
vi.mock("@/components/epics/history-modal-content", () => ({
  HistoryModalContent: () => <div data-testid="history-body" />,
}));

// ---- permissions boundary, as in settings-permissions-continuity ----------

vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () =>
    hostScopeFixture({ status: "following", hostId: "host-a" }),
}));
vi.mock(
  "@/components/settings/host-scope/use-scoped-host-binding",
  async () => {
    const { scopedHostBindingFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return {
      useScopedHostBinding: (scope: HostScope) =>
        scopedHostBindingFixture(scope),
    };
  },
);
vi.mock("@/hooks/host/use-host-capability-probe", () => ({
  useHostCapabilityProbe: (): void => undefined,
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatViewerId: (): string => "viewer-a",
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostSupportsMethod: () => true,
}));

const policy = vi.hoisted(
  (): { current: AutoPolicyGetResponse | undefined } => ({
    current: undefined,
  }),
);
vi.mock("@/hooks/auto-mode/use-auto-policy-query", () => ({
  useAutoPolicyQuery: () => ({
    data: policy.current,
    isError: false,
    refetch: (): Promise<{ readonly isError: boolean }> =>
      Promise.resolve({ isError: false }),
  }),
}));
vi.mock("@/hooks/auto-mode/use-auto-policy-set-mutation", () => ({
  useAutoPolicySetMutation: () => ({
    mutate: (): void => undefined,
    isPending: false,
  }),
}));
vi.mock("@/components/settings/panels/permissions/judge-tab", () => ({
  JudgeTab: (): ReactNode => <div data-testid="judge-body" />,
}));
vi.mock("@/components/settings/panels/permissions/activity-tab", () => ({
  ActivityTab: (): ReactNode => <div data-testid="activity-body" />,
}));

// ---- shell: real modal host, stand-in strip tab ---------------------------

const modalProbe: { current: SystemTabModalApi | null } = { current: null };

function ModalProbe(): ReactNode {
  const api = useSystemTabModalController();
  useEffect(() => {
    modalProbe.current = api;
  }, [api]);
  return null;
}

/** The test-controlled half of the tab host: has the MRU evicted the body? */
const tabHost: { evicted: boolean; listeners: Set<() => void> } = {
  evicted: false,
  listeners: new Set(),
};

function setEvicted(evicted: boolean): void {
  tabHost.evicted = evicted;
  for (const listener of [...tabHost.listeners]) listener();
}

function subscribeTabHost(listener: () => void): () => void {
  tabHost.listeners.add(listener);
  return () => {
    tabHost.listeners.delete(listener);
  };
}

function readEvicted(): boolean {
  return tabHost.evicted;
}

/**
 * Stands in for `TopLevelTabHost`'s MRU for the settings tab: the surface is
 * mounted while the tab exists and is not evicted, and unmounted otherwise
 * (the tab stays in the store when evicted).
 */
function TabStandIn(): ReactNode {
  const settingsTab = useTabsStore((state) => state.systemTabs.settings);
  const evicted = useSyncExternalStore(subscribeTabHost, readEvicted);
  if (settingsTab === null || evicted) return null;
  return (
    <div data-testid="settings-tab-standin">
      <SettingsSurface lastPath={settingsTab.lastPath} />
    </div>
  );
}

function buildRouter() {
  const rootRoute = createRootRoute({
    validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
    component: () => (
      <>
        <ModalProbe />
        <SystemTabModalHost />
        <TabStandIn />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="underlay" />,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function resetStores(): void {
  window.localStorage.clear();
  modalProbe.current = null;
  setEvicted(false);
  useSettingsSectionStore.setState({ section: null });
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useSettingsStore.setState({ theme: "light", themePreset: "neutral" });
  useThemeLibraryStore.setState({
    version: 2,
    themes: [],
    selected: { light: null, dark: null },
    draft: null,
    error: null,
  });
  useSettingsHostScopeStore.setState({ scopedHostId: null });
  useSettingsSearchStore.setState({ pendingReveal: null });
  resetSettingsOpenIntentForTests();
  resetRulesEditForTests();
}

// ---- helpers --------------------------------------------------------------

const STORED_ALLOW = "- Run the linter";
const TYPED = "typed edit";
const DRAFTED = "drafted rule";

function renderShell(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider>
          <RouterProvider router={buildRouter()} />
          <ThemeEditorHost />
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function modalApi(): SystemTabModalApi {
  const api = modalProbe.current;
  if (api === null) throw new Error("modal api not published");
  return api;
}

async function openSettingsModal(section: "permissions" | "appearance") {
  await waitFor(() => expect(modalProbe.current).not.toBeNull());
  act(() => {
    modalApi().openSettings({
      section,
      resetToGeneral: false,
      tab: null,
      draft: null,
      hostId: null,
    });
  });
  await screen.findByRole("dialog", { name: "Settings" });
}

function allowField(): HTMLTextAreaElement {
  const element = screen.getByTestId("auto-policy-input-allow");
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("auto-policy-input-allow is not a textarea");
  }
  return element;
}

async function openRules(): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId("permissions-tab-rules"));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function typeAndDeliverDraft(): Promise<void> {
  await openRules();
  fireEvent.change(allowField(), { target: { value: TYPED } });
  act(() => {
    armSettingsOpenIntent({
      section: "permissions",
      tab: "rules",
      draft: { section: "allow", text: DRAFTED },
      hostId: null,
      resetToGeneral: false,
    });
  });
  expect(allowField().value).toContain(TYPED);
  expect(allowField().value).toContain(DRAFTED);
}

function expectEditKeptOnce(): void {
  const value = allowField().value;
  expect(occurrences(value, TYPED)).toBe(1);
  expect(occurrences(value, DRAFTED)).toBe(1);
}

function expectRecordOnly(): void {
  expect(allowField().value).toBe(STORED_ALLOW);
}

function settingsDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Settings" });
}

async function goToSection(
  section: "permissions" | "appearance",
): Promise<void> {
  act(() => {
    modalApi().setSection(section);
  });
  await screen.findByRole("dialog", { name: "Settings" });
}

async function openThemeEditorThenCancel(): Promise<void> {
  const user = userEvent.setup();
  await user.click(
    within(settingsDialog()).getByRole("button", { name: "Create theme" }),
  );
  const editor = await screen.findByRole("dialog", { name: "Theme editor" });
  await user.click(
    within(editor).getByRole("button", { name: "Cancel theme editing" }),
  );
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Theme editor" })).toBeNull();
  });
}

describe("Rules edit through the system-tab modal shell", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    resetSystemTabModalColdLoadForTests();
    policy.current = {
      body: joinAutoPolicySections({
        ...EMPTY_AUTO_POLICY_SECTIONS,
        allow: STORED_ALLOW,
      }),
      updatedAt: "2026-09-10T00:00:00.000Z",
      source: "account",
      readState: "fresh",
    };
    resetStores();
  });

  afterEach(() => {
    cleanup();
    __resetTabNavigationControllerForTesting();
    resetSystemTabModalColdLoadForTests();
    document.body.style.pointerEvents = "";
    resetStores();
  });

  it("H4 modal remount: Rules -> Appearance -> Create theme -> cancel -> Rules keeps the edit once each", async () => {
    renderShell();
    await openSettingsModal("permissions");
    await typeAndDeliverDraft();

    await goToSection("appearance");
    // Editing a theme flips the Dialog to non-modal, and Radix remounts its
    // content on that change.
    await openThemeEditorThenCancel();
    await goToSection("permissions");
    await openRules();

    expectEditKeptOnce();
  });

  it("H4 close: the real close button, then reopen, shows only the record", async () => {
    const user = userEvent.setup();
    renderShell();
    await openSettingsModal("permissions");
    await typeAndDeliverDraft();

    await user.click(screen.getByTestId("system-tab-modal-close-settings"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    });
    await openSettingsModal("permissions");
    await openRules();

    expectRecordOnly();
  });

  it("H4 history: Settings -> History -> Settings resets the edit", async () => {
    renderShell();
    await openSettingsModal("permissions");
    await typeAndDeliverDraft();

    act(() => {
      modalApi().openHistory();
    });
    await screen.findByRole("dialog", { name: "History" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    await openSettingsModal("permissions");
    await openRules();

    expectRecordOnly();
  });

  it("H4 promotion: 'Open as tab' hands the edit to the tab's surface once each", async () => {
    const user = userEvent.setup();
    renderShell();
    await openSettingsModal("permissions");
    await typeAndDeliverDraft();

    await user.click(screen.getByTestId("system-tab-modal-promote-settings"));
    await screen.findByTestId("settings-tab-standin");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    });
    await openRules();

    expectEditKeptOnce();
  });

  it("H4 eviction: an evicted then reconstructed settings tab keeps the edit once each", async () => {
    // The tab exists in the store; the surface is mounted by the stand-in.
    // Eviction unmounts the surface with the tab still in the store, and
    // reconstruction remounts it.
    renderShell();
    act(() => {
      useTabsStore.getState().openSystemTab({
        kind: "settings",
        name: "Settings",
        lastPath: "/settings/permissions",
      });
    });
    await screen.findByTestId("settings-tab-standin");
    await typeAndDeliverDraft();

    act(() => {
      setEvicted(true);
    });
    expect(screen.queryByTestId("settings-tab-standin")).toBeNull();
    expect(useTabsStore.getState().systemTabs.settings).not.toBeNull();
    act(() => {
      setEvicted(false);
    });
    await screen.findByTestId("settings-tab-standin");
    await openRules();

    expectEditKeptOnce();
  });

  it("H4 tab close: closeSystemTab('settings') then reopen shows only the record", async () => {
    // Driven through the real store action `closeSystemTab`, the one the
    // strip's close button calls.
    renderShell();
    act(() => {
      useTabsStore.getState().openSystemTab({
        kind: "settings",
        name: "Settings",
        lastPath: "/settings/permissions",
      });
    });
    await screen.findByTestId("settings-tab-standin");
    await typeAndDeliverDraft();

    act(() => {
      useTabsStore.getState().closeSystemTab("settings");
    });
    expect(screen.queryByTestId("settings-tab-standin")).toBeNull();
    act(() => {
      useTabsStore.getState().openSystemTab({
        kind: "settings",
        name: "Settings",
        lastPath: "/settings/permissions",
      });
    });
    await screen.findByTestId("settings-tab-standin");
    await openRules();

    expectRecordOnly();
  });

  it("H4 promotion gap: a committed frame with neither modal nor tab still hands the edit over once each", async () => {
    const user = userEvent.setup();
    renderShell();
    await openSettingsModal("permissions");
    await typeAndDeliverDraft();

    // The coordinator commits the promoted tab through the store's
    // `replaceLayoutForTransaction`. Hold that one write back (the modal's
    // close is a router search write and is not held) so the tab appears on
    // a later act.
    const realReplace = useTabsStore.getState().replaceLayoutForTransaction;
    const held: Array<Parameters<typeof realReplace>[0]> = [];
    useTabsStore.setState({
      replaceLayoutForTransaction: (layout) => {
        if (layout.systemTabs.settings !== null) {
          held.push(layout);
          return;
        }
        realReplace(layout);
      },
    });

    await user.click(screen.getByTestId("system-tab-modal-promote-settings"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    });
    // The gap frame: no modal, no tab.
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(screen.queryByTestId("settings-tab-standin")).toBeNull();
    expect(useTabsStore.getState().systemTabs.settings).toBeNull();

    useTabsStore.setState({ replaceLayoutForTransaction: realReplace });
    expect(held).toHaveLength(1);
    act(() => {
      for (const layout of held) realReplace(layout);
    });
    await screen.findByTestId("settings-tab-standin");
    await openRules();

    expectEditKeptOnce();
  });

  it("H4 refused promotion: the handoffs end, and the modal's later real close still resets", async () => {
    // The real `promoteToTab` cannot be made to refuse in this shell, so the
    // real `SystemTabModalSurface` is rendered with an `onPromote` that runs
    // its `onRejected` at once, as a refused tab navigation does.
    const user = userEvent.setup();
    function Lifetime(props: { readonly open: boolean }): ReactNode {
      useRulesEditLifetime(props.open, false);
      return null;
    }
    const queryClient = new QueryClient();
    const view = (open: boolean): ReactNode => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Lifetime open={open} />
          <DialogPrimitive.Root open={open}>
            {open ? (
              <SystemTabModalSurface
                active={{ kind: "settings", section: "permissions" }}
                editingTheme={false}
                onClose={() => undefined}
                onPromote={(onRejected) => {
                  onRejected();
                }}
              />
            ) : null}
          </DialogPrimitive.Root>
        </TooltipProvider>
      </QueryClientProvider>
    );
    const mounted = render(view(true));
    await typeAndDeliverDraft();

    await user.click(screen.getByTestId("system-tab-modal-promote-settings"));

    expect(readRulesEditForTests().handoffPending).toBe(false);
    expect(useSettingsSearchStore.getState().handoffPending).toBe(false);
    expect(readRulesEditForTests().edit.snapshot).not.toBeNull();

    mounted.rerender(view(false));

    expect(readRulesEditForTests().edit.snapshot).toBeNull();
    expect(readRulesEditForTests().edit.drafts).toEqual([]);
  });
});
