import "../../../../__tests__/test-browser-apis";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  HostInstallResult,
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import { MenuCommandListener } from "@/components/layout/bridges/menu-command-listener";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import {
  setEpicCanvasDesktopProjectionBridge,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { useFindInPageStore } from "@/stores/find-in-page/find-in-page-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  setLandingDraftDesktopProjectionBridge,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  createUnavailableTileFindAdapter,
  useTileFindStore,
  type TileFindAdapter,
  type TileFindCapability,
  type TileFindStateSnapshot,
} from "@/stores/tile-find";
import { useTabsStore } from "@/stores/tabs/store";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import type { DesktopMenuCommandPayload } from "@/lib/windows/types";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

const navigateMock = vi.hoisted(() => vi.fn());
const routerState = vi.hoisted(() => ({ pathname: "/" }));
const authMock = vi.hoisted(() => ({
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({
    state: {
      location: {
        get pathname() {
          return routerState.pathname;
        },
      },
    },
  }),
  useRouterState: (options: {
    readonly select: (state: {
      readonly location: { readonly pathname: string };
    }) => unknown;
  }) => options.select({ location: { pathname: routerState.pathname } }),
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useAuthService: () => authMock,
}));

interface FakeDesktopMenu {
  handler: ((payload: DesktopMenuCommandPayload) => void) | null;
  onCommand(handler: (payload: DesktopMenuCommandPayload) => void): {
    dispose(): void;
  };
  emit(command: DesktopMenuCommandPayload["command"]): void;
}

interface FakeDesktopWindows {
  readonly requestNew: MockInstance<
    (initialRoute: string | null) => Promise<void>
  >;
  readonly requestClose: MockInstance<(windowId: string) => Promise<void>>;
}

interface FakeRunnerHost extends IRunnerHost {
  readonly windows: FakeDesktopWindows;
  readonly hostPickerRequestOpen: Mock<() => void>;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function createMenu(): FakeDesktopMenu {
  return {
    handler: null,
    onCommand(handler) {
      this.handler = handler;
      return {
        dispose: () => {
          this.handler = null;
        },
      };
    },
    emit(command) {
      this.handler?.({ command, windowId: "window-1" });
    },
  };
}

function createRunnerHost(menu: FakeDesktopMenu): FakeRunnerHost {
  const windows: FakeDesktopWindows = {
    requestNew: vi.fn<(_initialRoute: string | null) => Promise<void>>(
      (_initialRoute) => Promise.resolve(),
    ),
    requestClose: vi.fn<(_windowId: string) => Promise<void>>((_windowId) =>
      Promise.resolve(),
    ),
  };
  const hostPickerRequestOpen: Mock<() => void> = vi.fn();
  return Object.assign(
    {
      signInUrl: "https://auth.example.invalid/sign-in",
      authnBaseUrl: "https://auth.example.invalid",
      hasLocalHost: true,
      validateAuthToken: () => Promise.resolve({ kind: "rejected" as const }),
      validateAuthTokenIdentity: () =>
        Promise.resolve({ kind: "rejected" as const }),
      refreshAuthToken: () =>
        Promise.resolve({ kind: "network-error" as const }),
      openExternalLink: () => Promise.resolve(),
      getRegisteredUrlSchemes: () => Promise.resolve([]),
      requestMicrophoneAccess: () => Promise.resolve("granted" as const),
      openMicrophoneSettings: () => Promise.resolve(),
      beginAuthAttempt: () => undefined,
      onAuthCallback: () => ({ dispose: () => undefined }),
      deviceFlow: { start: () => Promise.resolve(null) },
      secureStorage: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      notifications: {
        show: () => Promise.resolve(),
        onClick: () => ({ dispose: () => undefined }),
      },
      tray: {
        setEpics: () => Promise.resolve(),
        setIndicator: () => Promise.resolve(),
        onEpicSelected: () => ({ dispose: () => undefined }),
      },
      hostPicker: {
        get isOpen() {
          return false;
        },
        requestOpen: hostPickerRequestOpen,
        requestClose: vi.fn(),
        onChange: () => ({ dispose: () => undefined }),
      },
      workspaceFolders: {
        pickFolders: () => Promise.resolve([]),
      },
      fileDrops: {
        resolveDroppedFilePaths: () => Promise.resolve([]),
        copyDroppedFilePaths: (paths) => Promise.resolve(paths),
      },
      tokenStore: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      onLocalHostChange: () => ({ dispose: () => undefined }),
      onSystemResumed: () => ({ dispose: () => undefined }),
      requestHostRespawn: vi.fn(() => Promise.resolve()),
      service: null,
      traycerCli: null,
      migration: null,
      hostManagement: null,
      hostTray: null,
    } satisfies IRunnerHost,
    {
      menu,
      windows,
      hostPickerRequestOpen,
    },
  );
}

interface EpicTab {
  readonly id: string;
  readonly name: string;
  readonly draft: boolean;
}

const EPIC_A: EpicTab = { id: "e-a", name: "A", draft: false };

function openEpicFixture(tab: EpicTab): string {
  const tabId = useEpicCanvasStore.getState().openEpicTab(tab.id, tab.name);
  useTabsStore.setState((state) => ({
    ...state,
    stripOrder: useEpicCanvasStore
      .getState()
      .openTabOrder.map((id) => ({ kind: "epic", id })),
  }));
  return tabId;
}

function resetStores(): void {
  setEpicCanvasDesktopProjectionBridge(null);
  setLandingDraftDesktopProjectionBridge(null);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useFindInPageStore.setState(useFindInPageStore.getInitialState(), true);
  useTileFindStore.getState().resetForTests();
  __getOpenEpicRegistryForTests().disposeAll();
}

function buildDirtyHandle(epicId: string): OpenEpicStoreHandle {
  const state = {
    isDirty: true,
    unsyncedQueueSize: 1,
    snapshotMeta: null,
    discardUnsyncedEdits: () => undefined,
  };
  const storeCallable = (_selector: unknown): unknown => state;
  const storeBase: unknown = Object.assign(storeCallable, {
    getState: () => state as never,
    subscribe: () => () => undefined,
  });
  return {
    epicId,
    userId: null,
    doc: {} as never,
    awareness: {} as never,
    store: storeBase as OpenEpicStoreHandle["store"],
    dispose: () => undefined,
    requestFreshSnapshot: () => undefined,
    isClean: () => false,
  };
}

const FIND_CAPABILITY = new Set<TileFindCapability>(["find"]);

interface MenuFindAdapter extends TileFindAdapter {
  readonly nextMock: Mock<() => void>;
  readonly previousMock: Mock<() => void>;
}

function createTileFindSnapshot(tileInstanceId: string): TileFindStateSnapshot {
  return {
    requestId: 0,
    status: "idle",
    capabilities: FIND_CAPABILITY,
    query: "",
    matchCase: false,
    replaceText: "",
    current: 0,
    total: 0,
    coverageMessage: null,
    errorMessage: null,
    activeUnitId: tileInstanceId,
    exactHighlight: "none",
  };
}

function createMenuFindAdapter(
  tileInstanceId: string,
  tileKind: TileFindAdapter["tileKind"],
): MenuFindAdapter {
  const nextMock = vi.fn();
  const previousMock = vi.fn();
  return {
    tileInstanceId,
    tileKind,
    getSnapshot: () => createTileFindSnapshot(tileInstanceId),
    subscribe: () => () => undefined,
    search: vi.fn(),
    next: nextMock,
    previous: previousMock,
    clear: vi.fn(),
    replace: null,
    nextMock,
    previousMock,
  };
}

function registerMenuFindTarget(
  adapter: TileFindAdapter,
  isEligible: boolean,
): void {
  useTileFindStore.getState().registerTarget({
    tileInstanceId: adapter.tileInstanceId,
    contentId: `${adapter.tileInstanceId}-content`,
    viewTabId: "view-1",
    tileId: `${adapter.tileInstanceId}-pane`,
    epicId: "epic-1",
    tileKind: adapter.tileKind,
    isEligible,
    adapter,
  });
}

function renderMenuCommandListener(menu: FakeDesktopMenu): void {
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RunnerHostProvider runnerHost={createRunnerHost(menu)}>
        <MenuCommandListener />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("<MenuCommandListener />", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    authMock.signIn.mockClear();
    authMock.signOut.mockClear();
    routerState.pathname = "/";
    resetStores();
    useDesktopDialogStore.getState().close();
  });

  afterEach(() => {
    cleanup();
    resetStores();
    useDesktopDialogStore.getState().close();
  });

  it("dispatches native menu commands to renderer-owned actions", () => {
    const menu = createMenu();
    const runnerHost = createRunnerHost(menu);

    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <MenuCommandListener />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    act(() => {
      menu.emit("app.openSettings");
      menu.emit("app.signIn");
      menu.emit("app.openLogs");
      menu.emit("app.aboutDetails");
      menu.emit("epic.openInNewWindow");
      menu.emit("epic.newWindow");
    });

    expect(navigateMock).toHaveBeenCalledWith({ to: "/settings/general" });
    expect(authMock.signIn).toHaveBeenCalledTimes(1);
    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "open-epic-in-new-window",
    );
    expect(runnerHost.windows.requestNew).toHaveBeenCalledWith(null);
    expect(runnerHost.hostPickerRequestOpen).not.toHaveBeenCalled();
  });

  it("requests close for the sender window from the native close-window command", () => {
    const menu = createMenu();
    const runnerHost = createRunnerHost(menu);

    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <MenuCommandListener />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    act(() => {
      menu.emit("window.closeWindow");
    });

    expect(runnerHost.windows.requestClose).toHaveBeenCalledWith("window-1");
  });

  it("routes find commands to the active tile-find owner", () => {
    const menu = createMenu();
    const activeAdapter = createMenuFindAdapter("active-tile", "ticket");
    const hiddenAdapter = createMenuFindAdapter("hidden-tile", "chat");
    registerMenuFindTarget(activeAdapter, true);
    registerMenuFindTarget(hiddenAdapter, false);

    renderMenuCommandListener(menu);

    act(() => {
      menu.emit("view.findInPage");
      menu.emit("view.findNext");
      menu.emit("view.findPrevious");
    });

    expect(
      useTileFindStore.getState().uiByTileInstanceId["active-tile"]?.isOpen,
    ).toBe(true);
    expect(
      useTileFindStore.getState().uiByTileInstanceId["hidden-tile"]?.isOpen,
    ).toBe(false);
    expect(activeAdapter.nextMock.mock.calls).toHaveLength(1);
    expect(activeAdapter.previousMock.mock.calls).toHaveLength(1);
    expect(hiddenAdapter.nextMock.mock.calls).toHaveLength(0);
    expect(hiddenAdapter.previousMock.mock.calls).toHaveLength(0);
    expect(useFindInPageStore.getState().isOpen).toBe(false);
    expect(useFindInPageStore.getState().advanceForwardNonce).toBe(0);
    expect(useFindInPageStore.getState().advanceBackwardNonce).toBe(0);
  });

  it("opens an unavailable tile-local bar without touching global find state", () => {
    const menu = createMenu();
    const unavailableAdapter = createUnavailableTileFindAdapter({
      tileInstanceId: "blank-tile",
      tileKind: "blank",
      message: null,
    });
    registerMenuFindTarget(unavailableAdapter, true);

    renderMenuCommandListener(menu);

    act(() => {
      menu.emit("view.findInPage");
    });

    const blankUi =
      useTileFindStore.getState().uiByTileInstanceId["blank-tile"];
    expect(blankUi?.isOpen).toBe(true);
    expect(blankUi?.lastSnapshot.status).toBe("unavailable");
    expect(blankUi?.lastSnapshot.coverageMessage).toBe(
      "Open a tile before using find.",
    );
    expect(useFindInPageStore.getState().isOpen).toBe(false);
  });

  it("respects owner blockers and does not fall back to legacy find", () => {
    const menu = createMenu();
    const activeAdapter = createMenuFindAdapter("blocked-tile", "spec");
    registerMenuFindTarget(activeAdapter, true);
    useTileFindStore.getState().setOwnerBlocker({
      reason: "app-dialog",
      ownerId: "app-dialog",
    });

    renderMenuCommandListener(menu);

    act(() => {
      menu.emit("view.findInPage");
      menu.emit("view.findNext");
    });

    expect(
      useTileFindStore.getState().uiByTileInstanceId["blocked-tile"]?.isOpen,
    ).toBe(false);
    expect(activeAdapter.nextMock.mock.calls).toHaveLength(0);
    expect(useFindInPageStore.getState().isOpen).toBe(false);
    expect(useFindInPageStore.getState().advanceForwardNonce).toBe(0);
  });

  it("closes a clean active Epic tab from the native menu command", () => {
    const tabId = openEpicFixture(EPIC_A);
    routerState.pathname = `/epics/e-a/${tabId}`;
    const menu = createMenu();

    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RunnerHostProvider runnerHost={createRunnerHost(menu)}>
          <MenuCommandListener />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    act(() => {
      menu.emit("epic.closeTab");
    });

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
  });

  it("uses the unsynced wait/discard guard for dirty Epic close commands", async () => {
    const tabId = openEpicFixture(EPIC_A);
    routerState.pathname = `/epics/e-a/${tabId}`;
    __getOpenEpicRegistryForTests().acquire(EPIC_A.id, () =>
      buildDirtyHandle(EPIC_A.id),
    );
    const menu = createMenu();

    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RunnerHostProvider runnerHost={createRunnerHost(menu)}>
          <MenuCommandListener />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    act(() => {
      menu.emit("epic.closeTab");
    });

    expect(
      await screen.findByTestId("epic-tab-unsynced-dialog"),
    ).not.toBeNull();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([tabId]);

    fireEvent.click(screen.getByTestId("epic-tab-unsynced-discard"));

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
  });

  it("invokes hostManagement.updateHost when host.installUpdate is dispatched", async () => {
    const menu = createMenu();
    const installResult: HostInstallResult = {
      version: "1.2.3",
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/tmp/fake/traycerd",
      source: { kind: "registry", value: "1.2.3" },
      archiveSha256: "",
      signatureKeyId: "",
      sizeBytes: 0,
      previousVersion: null,
      serviceLifecycle: {
        priorServiceState: "not-installed",
        stoppedBeforeSwap: false,
        postSwapAction: "install",
        postSwapError: null,
      },
    };
    const updateHost = vi.fn(() => Promise.resolve(installResult));
    const management: IHostManagement = {
      installHost: vi.fn(() => Promise.reject(new Error("not used"))),
      updateHost,
      uninstallHost: vi.fn(() => Promise.reject(new Error("not used"))),
      restartHost: vi.fn(() => Promise.resolve()),
      uninstallTraycer: vi.fn(() => Promise.reject(new Error("not used"))),
      getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
      clearRemoval: vi.fn(() => Promise.resolve()),
      getHostLogs: vi.fn(() => Promise.reject(new Error("not used"))),
      runDoctor: vi.fn(() => Promise.reject(new Error("not used"))),
      availableVersions: vi.fn(() => Promise.reject(new Error("not used"))),
      installedRecord: vi.fn(() => Promise.resolve(null)),
      registerService: vi.fn(() => Promise.resolve()),
      ensureHost: vi.fn(() =>
        Promise.resolve({
          action: "already-ready" as const,
          running: true,
          version: null,
        }),
      ),
      deregisterService: vi.fn(() => Promise.resolve()),
      registryCheck: vi.fn(() => Promise.reject(new Error("not used"))),
      getOperationStatus: vi.fn(() => Promise.resolve(null)),
      freePortAndRestart: vi.fn(() => Promise.reject(new Error("not used"))),
      cliManifest: vi.fn(() => Promise.resolve(null)),
      getHostName: vi.fn(() =>
        Promise.resolve({
          systemName: "test-host",
          customName: null,
          effectiveName: "test-host",
        }),
      ),
      setHostName: vi.fn((input: { readonly customName: string | null }) =>
        Promise.resolve({
          systemName: "test-host",
          customName: input.customName,
          effectiveName: input.customName ?? "test-host",
        }),
      ),
    };
    const baseHost = createRunnerHost(menu);
    const runnerHost: FakeRunnerHost = Object.assign(baseHost, {
      hostManagement: management,
    });

    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <MenuCommandListener />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    act(() => {
      menu.emit("host.installUpdate");
    });

    await waitFor(() => {
      expect(updateHost).toHaveBeenCalledTimes(1);
    });
    expect(updateHost).toHaveBeenCalledWith({ onProgress: null });
  });

  it("opens a confirmation dialog for host.restart and only respawns after confirm", async () => {
    const menu = createMenu();
    const requestHostRespawn = vi.fn(() => Promise.resolve());
    const runnerHost = Object.assign(createRunnerHost(menu), {
      requestHostRespawn,
    });

    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <MenuCommandListener />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    act(() => {
      menu.emit("host.restart");
    });

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("Restarting will stop");
    expect(requestHostRespawn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(requestHostRespawn).toHaveBeenCalledTimes(1);
    });
  });

  it("closes the landing draft from the native menu command", () => {
    routerState.pathname = "/draft/draft-a";
    const tabId = openEpicFixture(EPIC_A);
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "draft-a",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Continue" }],
              },
            ],
          },
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
        },
      ],
      activeDraftId: "draft-a",
    });
    useTabsStore.setState((state) => ({
      ...state,
      stripOrder: [...state.stripOrder, { kind: "draft", id: "draft-a" }],
    }));
    const menu = createMenu();

    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RunnerHostProvider runnerHost={createRunnerHost(menu)}>
          <MenuCommandListener />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    act(() => {
      menu.emit("epic.closeTab");
    });

    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([tabId]);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "e-a", tabId },
      search: {
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
      },
    });
  });
});
