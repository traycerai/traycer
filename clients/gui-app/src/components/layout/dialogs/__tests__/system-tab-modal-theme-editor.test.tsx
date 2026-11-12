import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserSessionListItem } from "@traycer/protocol/auth/devices-sessions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SignOutConfirmDialog } from "@/components/auth/sign-out-confirm-dialog";
import { HostRuntimeTestProvider } from "@/lib/host/__tests__/host-runtime-test-provider";
import { SystemTabModalHost } from "@/components/layout/dialogs/system-tab-modal-host";
import { ThemeEditorHost } from "@/components/settings/themes/theme-editor-host";
import { ThemeProvider } from "@/providers/theme-provider";
import {
  useSystemTabModalController,
  resetSystemTabModalColdLoadForTests,
  type SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";
import { systemTabOverlaySearchSchema } from "@/lib/system-tab-overlay-search";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import { useTabsStore } from "@/stores/tabs/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";

const sessionState = vi.hoisted<{
  sessions: readonly UserSessionListItem[];
}>(() => ({ sessions: [] }));
const revokeSessionMock = vi.hoisted(() =>
  vi.fn(
    (input: {
      readonly familyId: string;
      readonly useStepUpCredential: boolean;
    }) => Promise.resolve({ familyId: input.familyId, revoked: true }),
  ),
);
const signOutMock = vi.hoisted(() =>
  vi.fn<() => Promise<boolean>>(() => Promise.resolve(false)),
);

vi.mock("@/hooks/auth/use-user-sessions-query", () => ({
  useAuthFetchUserSessions: () => ({
    data: { sessions: sessionState.sessions },
    isPending: false,
    isError: false,
    fetchStatus: "idle",
  }),
}));

vi.mock("@/hooks/auth/use-revoke-user-session-mutation", () => ({
  useAuthRevokeUserSession: () => ({
    isPending: false,
    mutateAsync: revokeSessionMock,
  }),
}));

vi.mock("@/hooks/auth/use-revoke-all-sessions-mutation", () => ({
  useAuthRevokeAllSessions: () => ({
    isPending: false,
    mutateAsync: () => Promise.resolve({ ok: true }),
  }),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useAuthService: () => ({ signOut: signOutMock }),
  useHostBinding: () => ({ auth: { signOut: signOutMock } }),
}));

vi.mock("@/hooks/runner/use-desktop-zoom-bridge", () => ({
  useDesktopZoomBridge: () => null,
}));

vi.mock("@/components/settings/host-scope/use-host-scope", () => {
  const useHostScope = () => ({
    hosts: [],
    host: null,
    hostId: null,
    hostLabel: "No host",
    vanishedHostId: null,
    vanishedSelection: null,
    returnToActive: () => {},
    activeHostId: null,
    activeHost: null,
    isViewingActive: true,
    status: "unreachable",
    client: null,
    localMaintenanceFallback: false,
    setHostId: () => {},
    makeActive: () => {},
    isActivating: false,
    isLoading: false,
    listsFailed: false,
    retryLists: () => {},
    nowMs: 0,
  });
  return {
    useHostScope,
    useHostScopeFor: useHostScope,
    WINDOW_HOST_SELECTION: {
      scopedHostId: null,
      setScopedHostId: () => undefined,
    },
    usePersonalHostScope: useHostScope,
  };
});

// History content is outside this regression's modal-lock boundary and needs
// the full host runtime. Keep the actual system modal shell while isolating
// that unrelated surface.
vi.mock("@/components/epics/history-modal-content", () => ({
  HistoryModalContent: () => null,
}));

const modalProbe: { current: SystemTabModalApi | null } = { current: null };

function modalLayerRank(element: HTMLElement): number {
  return Array.from(element.classList).reduce((rank, className) => {
    const match = /^z-\[?(\d+)\]?$/.exec(className);
    return match ? Number(match[1]) : rank;
  }, 0);
}

function ModalProbe() {
  const api = useSystemTabModalController();
  useEffect(() => {
    modalProbe.current = api;
  }, [api]);
  return null;
}

function buildRouter() {
  const rootRoute = createRootRoute({
    validateSearch: (raw) => systemTabOverlaySearchSchema.parse(raw),
    component: () => (
      <>
        <ModalProbe />
        <SystemTabModalHost />
        <Outlet />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="underlay" />,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function resetStores(): void {
  window.localStorage.clear();
  modalProbe.current = null;
  useAuthStore.setState({ status: "signed-out" });
  useSignOutConfirmStore.getState().setOpen(false);
  sessionState.sessions = [];
  revokeSessionMock.mockReset();
  revokeSessionMock.mockImplementation((input) =>
    Promise.resolve({ familyId: input.familyId, revoked: true }),
  );
  signOutMock.mockReset();
  signOutMock.mockResolvedValue(false);
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
}

function renderSystemTabModalHost(): void {
  const router = buildRouter();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider>
          <HostRuntimeTestProvider>
            <RouterProvider router={router} />
          </HostRuntimeTestProvider>
          <ThemeEditorHost />
          <SignOutConfirmDialog />
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("SystemTabModalHost theme editor integration", () => {
  beforeEach(() => {
    __resetTabNavigationControllerForTesting();
    resetSystemTabModalColdLoadForTests();
    resetStores();
  });

  afterEach(() => {
    cleanup();
    __resetTabNavigationControllerForTesting();
    resetSystemTabModalColdLoadForTests();
    document.body.style.pointerEvents = "";
    resetStores();
  });

  it("releases and restores the Settings modal lock around theme editing", async () => {
    const user = userEvent.setup();
    renderSystemTabModalHost();

    await waitFor(() => expect(modalProbe.current).not.toBeNull());
    modalProbe.current?.openSettings({
      section: "appearance",
      resetToGeneral: false,
      tab: null,
      draft: null,
      hostId: null,
    });

    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => {
      expect(document.body.style.pointerEvents).toBe("none");
    });

    // Static overlay bodies expose their controls with the frame: deferring
    // these bodies regressed boot and first-open timing in production builds.
    const darkPicker = within(settings).getByRole("button", {
      name: "Dark theme",
    });
    await user.click(darkPicker);
    const search = await screen.findByRole("combobox", {
      name: "Search dark themes",
    });
    const picker = search.closest('[data-slot="popover-content"]');
    expect(picker).not.toBeNull();
    expect(document.body.contains(picker)).toBe(true);
    expect(settings.contains(picker)).toBe(false);

    await user.type(search, "Nord");
    await user.click(screen.getByRole("option", { name: "Use Nord dark" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(
      screen.queryByRole("combobox", { name: "Search dark themes" }),
    ).toBeNull();

    const reopenedPicker = screen.getByRole("button", {
      name: "Dark theme",
    });
    await user.click(reopenedPicker);
    await screen.findByRole("combobox", { name: "Search dark themes" });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Dark theme" }),
      );
    });

    await user.click(
      within(settings).getByRole("button", { name: "Create theme" }),
    );

    const editor = await screen.findByRole("dialog", { name: "Theme editor" });
    await waitFor(() => {
      expect(document.body.style.pointerEvents).not.toBe("none");
    });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(document.activeElement).toBe(
      within(editor).getByLabelText("Theme name"),
    );

    await user.click(
      within(editor).getByRole("button", { name: "Save theme" }),
    );
    await waitFor(() => {
      expect(useThemeLibraryStore.getState().draft).toBeNull();
      expect(screen.queryByRole("dialog", { name: "Theme editor" })).toBeNull();
      expect(document.body.style.pointerEvents).toBe("none");
    });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();

    await user.click(
      within(screen.getByRole("dialog", { name: "Settings" })).getByRole(
        "button",
        { name: "Create theme" },
      ),
    );
    const historyDraftEditor = await screen.findByRole("dialog", {
      name: "Theme editor",
    });
    modalProbe.current?.openHistory();
    await screen.findByRole("dialog", { name: "History" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    const historyDraftName =
      within(historyDraftEditor).getByLabelText("Theme name");
    await user.clear(historyDraftName);
    await user.type(historyDraftName, "History draft");
    expect(historyDraftName.getAttribute("disabled")).toBeNull();

    await user.click(
      within(historyDraftEditor).getByRole("button", {
        name: "Cancel theme editing",
      }),
    );
    await waitFor(() => {
      expect(useThemeLibraryStore.getState().draft).toBeNull();
      expect(screen.queryByRole("dialog", { name: "Theme editor" })).toBeNull();
      expect(document.body.style.pointerEvents).toBe("none");
    });
    expect(screen.getByRole("dialog", { name: "History" })).toBeTruthy();
  });

  it("keeps real Settings sessions available after canceling a failed local sign-out", async () => {
    const user = userEvent.setup();
    const currentSession: UserSessionListItem = {
      familyId: "active-session",
      clientKind: "desktop",
      displayLabel: "This computer",
      platform: "macOS",
      appVersion: "1.2.3",
      location: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-07-08T12:00:00.000Z",
      revoked: false,
      revokedAt: null,
      revokedBy: null,
      current: true,
    };
    sessionState.sessions = [currentSession];
    useAuthStore.setState({ status: "signed-in" });
    renderSystemTabModalHost();

    await screen.findByTestId("underlay");
    modalProbe.current?.openSettings({
      section: "devices",
      resetToGeneral: false,
      tab: null,
      draft: null,
      hostId: null,
    });
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(
      within(settings).getByRole("heading", { name: "Signed-in sessions" }),
    ).toBeTruthy();
    await user.click(
      within(settings).getByRole("button", { name: "Sign out" }),
    );

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(revokeSessionMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledTimes(1);
    const question = screen.getByTestId("confirm-destructive-dialog");
    const settingsFrame = settings.closest<HTMLElement>(
      '[data-slot="dialog-content"]',
    );
    if (!settingsFrame) throw new Error("expected the Settings modal frame");
    expect(modalLayerRank(question)).toBeGreaterThanOrEqual(
      modalLayerRank(settingsFrame),
    );
    if (modalLayerRank(question) === modalLayerRank(settingsFrame)) {
      expect(
        settingsFrame.compareDocumentPosition(question) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    }

    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(settings);
    expect(
      within(settings).getByRole("heading", { name: "Signed-in sessions" }),
    ).toBeTruthy();
    expect(within(settings).getByText("This session")).toBeTruthy();
    expect(useAuthStore.getState().status).toBe("signed-in");
    expect(revokeSessionMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });
});
