import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
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
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  HostControllerStatus,
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import {
  HOST_UPDATED_SERVICE_DISABLED_MESSAGE,
  SERVICE_TASK_NOT_OWNED_MESSAGE,
} from "@traycer-clients/shared/platform/host-service-notices";
import { MenuCommandListener } from "@/components/layout/bridges/menu-command-listener";
import { SignOutConfirmDialog } from "@/components/auth/sign-out-confirm-dialog";
import { AnchoredDraftPopover } from "@/components/comments/anchored-draft-popover";
import { MigrationBlockingModalHost } from "@/components/layout/dialogs/migration-blocking-modal-host";
import { ThemeEditorHost } from "@/components/settings/themes/theme-editor-host";
import { ThemeGallery } from "@/components/settings/themes/theme-gallery";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/providers/theme-provider";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import {
  setEpicCanvasDesktopProjectionBridge,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { useFindInPageStore } from "@/stores/find-in-page/find-in-page-store";
import {
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
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
import { useMigrationRunStore } from "@/stores/migration/migration-run-store";
import { tabItemId } from "@/stores/tabs/layout";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import type { DesktopMenuCommandPayload } from "@/lib/windows/types";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";
import {
  useAnchoredDraftStore,
  type AnchoredCommentDraft,
} from "@/stores/comments/anchored-draft-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";
import {
  BOARD_PATH,
  quotedSelection,
} from "../../canvas-artifact/__tests__/canvas-edit-test-support";
import {
  composerEditorAt,
  typeIntoEditor,
} from "../../comments/__tests__/comment-submit-test-support";

vi.mock("@/components/canvas-artifact/use-artboard-edit", async () =>
  (
    await import("@/components/canvas-artifact/__tests__/canvas-edit-test-support")
  ).artboardEditModule(),
);

interface CapturedNavigate {
  readonly to: string;
  readonly params: unknown;
  readonly replace: boolean;
  readonly search: unknown;
  readonly state: unknown;
}

const navigateMock = vi.hoisted(() =>
  vi.fn<(options: CapturedNavigate) => void>(),
);
const routerState = vi.hoisted(() => ({ pathname: "/" }));
const authMock = vi.hoisted(() => ({
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
}));
// `false` by default, so the whole file's existing native-close-tab coverage
// keeps exercising `closeTabFlow.closeActiveTab` unchanged; only the chord
// test below flips it to prove the interception itself, without standing up
// a full layout editor session (that machinery is `editor-session.ts`'s own
// suite).
const closeLayoutEditorForCloseTabChordMock = vi.hoisted(() =>
  vi.fn(() => false),
);

vi.mock("@/lib/layout/editor-session", () => ({
  closeLayoutEditorForCloseTabChord: closeLayoutEditorForCloseTabChordMock,
}));

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    message: vi.fn(),
    error: toastMocks.error,
    warning: toastMocks.warning,
    info: toastMocks.info,
  },
}));

function latestNavigation(): CapturedNavigate {
  const call = navigateMock.mock.calls.at(-1);
  if (call === undefined) throw new Error("expected navigation");
  return call[0];
}

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

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
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
  return Object.assign(
    // Shared `IRunnerHost` stub base so this test never re-declares the whole
    // surface; only the facets it drives are overridden.
    createFakeRunnerHost({
      requestHostRespawn: vi.fn(() =>
        Promise.resolve({ kind: "restarted" as const }),
      ),
    }),
    {
      menu,
      windows,
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
    version: 2,
    items: useEpicCanvasStore.getState().openTabOrder.map((id) => ({
      kind: "tab" as const,
      id: tabItemId({ kind: "epic", id }),
      ref: { kind: "epic" as const, id },
    })),
    activeItemId: tabItemId({ kind: "epic", id: tabId }),
    stripOrder: useEpicCanvasStore
      .getState()
      .openTabOrder.map((id) => ({ kind: "epic" as const, id })),
  }));
  return tabId;
}

/**
 * An `unverified` session authn refused (`session-rejected`), as the store
 * holds it after startup or a demotion. `hostRefused` is the
 * `hostRefusedHeldBearer` flag `AuthService.noteHostRefusedHeldBearer` raises
 * once the bearer it holds has expired: set through the store's own reducer,
 * which accepts it only on exactly this state.
 */
function holdRefusedSession(hostRefused: boolean): void {
  const store = useAuthStore.getState();
  store.setUnverifiedSession(
    { userId: "user-1", userName: "User One", email: "user@example.com" },
    { userId: "user-1", username: "User One" },
  );
  store.setCloudVerdictLoss("session-rejected");
  if (hostRefused) {
    store.noteHostRefusedHeldBearer();
  }
}

function resetStores(): void {
  useAuthStore.getState().setSignedOut();
  __resetTabNavigationControllerForTesting();
  setEpicCanvasDesktopProjectionBridge(null);
  setLandingDraftDesktopProjectionBridge(null);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useFindInPageStore.setState(useFindInPageStore.getInitialState(), true);
  useTileFindStore.getState().resetForTests();
  __getOpenEpicRegistryForTests().disposeAll();
  useAnchoredDraftStore.setState({ byEpicId: {} });
}

function buildDirtyHandle(epicId: string): OpenEpicStoreHandle {
  const state = {
    isDirty: true,
    unsyncedQueueSize: 1,
    // The registry's eligibility key reads all three work fields and the
    // transport.
    writeCommands: [],
    hostTransportStatus: "open",
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
    hostId: "test-host",
    // A production handle has no `doc` / `awareness`: the replica lives on
    // the worker thread and a `Y.Doc` cannot cross a structured clone.
    projection: {
      accept: () => null,
      apply: () => {},
      reject: () => {},
    },
    body: { applyDocUpdate: () => {}, applyAwareness: () => {} },
    store: storeBase as OpenEpicStoreHandle["store"],
    dispose: () => undefined,
    detachTransport: () => undefined,
    requestFreshSnapshot: () => undefined,
    wakeTransport: () => undefined,
    isClean: () => false,
    hotArtifactRoomIdsForTests: () => [],
    ...INERT_ROOT_STATE_PORT,
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

const COMMENT_EPIC_ID = "comment-epic";
const COMMENT_ARTIFACT_ID = "comment-canvas";
const COMMENT_TILE_ID = "comment-tile";

function storeAnchoredDraft(overrides: Partial<AnchoredCommentDraft>): void {
  useAnchoredDraftStore.getState().setDraft(COMMENT_EPIC_ID, {
    draftId: "comment-draft",
    tileId: COMMENT_TILE_ID,
    artifactId: COMMENT_ARTIFACT_ID,
    artifactType: "canvas",
    anchor: {
      kind: "element",
      artboard: BOARD_PATH,
      elementId: "element",
      label: "Paragraph",
    },
    quotedText: "",
    rect: { x: 10, y: 10, width: 100, height: 20 },
    selection: quotedSelection("Hello big world", 6, 9, {
      tid: "element",
      tagName: "p",
      marker: 0,
    }),
    retargeted: false,
    ...overrides,
  });
}

function renderMenuWithAnchoredDraft(menu: FakeDesktopMenu): void {
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RunnerHostProvider runnerHost={createRunnerHost(menu)}>
        <>
          <MenuCommandListener />
          <SignOutConfirmDialog />
          <AnchoredDraftPopover
            epicId={COMMENT_EPIC_ID}
            artifactId={COMMENT_ARTIFACT_ID}
            tileId={COMMENT_TILE_ID}
            hostClient={null}
            onCreated={() => undefined}
            onClosed={() => undefined}
            sendToChat={null}
          />
          <button type="button">Outside comment</button>
        </>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function resetThemeStores(): void {
  window.localStorage.clear();
  useThemeLibraryStore.setState({
    version: 2,
    themes: [],
    selected: { light: null, dark: null },
    draft: null,
    error: null,
  });
  useSettingsStore.setState({ theme: "light", themePreset: "neutral" });
}

function renderMenuWithThemeEditor(
  menu: FakeDesktopMenu,
  onOutsideClick: () => void,
): void {
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RunnerHostProvider runnerHost={createRunnerHost(menu)}>
        <TooltipProvider>
          <ThemeProvider>
            <MenuCommandListener />
            <ThemeGallery />
            <ThemeEditorHost />
            <SignOutConfirmDialog />
            <button type="button" onClick={onOutsideClick}>
              Inspector target
            </button>
          </ThemeProvider>
        </TooltipProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("<MenuCommandListener />", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    authMock.signIn.mockClear();
    authMock.signOut.mockClear();
    authMock.signOut.mockResolvedValue(true);
    routerState.pathname = "/";
    toastMocks.error.mockClear();
    toastMocks.warning.mockClear();
    toastMocks.info.mockClear();
    resetStores();
    useDesktopDialogStore.getState().close();
    useDesktopDialogStore.setState({ reportIssueAvailable: false });
    closeLayoutEditorForCloseTabChordMock.mockReset();
    closeLayoutEditorForCloseTabChordMock.mockReturnValue(false);
    useSignOutConfirmStore.getState().setOpen(false);
    useMigrationRunStore.setState({ runs: new Map(), remoteRunning: false });
    resetThemeStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
    useDesktopDialogStore.getState().close();
    useDesktopDialogStore.setState({ reportIssueAvailable: false });
    useSignOutConfirmStore.getState().setOpen(false);
    useMigrationRunStore.setState({ runs: new Map(), remoteRunning: false });
    resetThemeStores();
  });

  it("dispatches native menu commands to renderer-owned actions", () => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "user-1",
        userName: "User One",
        email: "user@example.com",
      },
      { userId: "user-1", username: "User One" },
      [],
    );
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

    const navigation = latestNavigation();
    expect(navigation.to).toBe("/settings/general");
    expect(navigation.replace).toBe(false);
    expect(navigation.state).toEqual(expect.any(Function));
    expect(authMock.signIn).toHaveBeenCalledTimes(1);
    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "open-epic-in-new-window",
    );
    expect(runnerHost.windows.requestNew).toHaveBeenCalledWith(null);
    // The "no menu command opens a host picker" half of this pin used to be an
    // assertion on the shell-owned picker port. Its last caller was deleted
    // before the port itself, so the property is now
    // structural - there is no picker for a command to open, and a revival
    // would have to re-add the capability to `IRunnerHost` first.
  });

  it("opens the shared sign-out question when native sign-out fails", async () => {
    authMock.signOut.mockResolvedValue(false);
    useMigrationRunStore.setState({ runs: new Map(), remoteRunning: true });
    const menu = createMenu();
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RunnerHostProvider runnerHost={createRunnerHost(menu)}>
          <>
            <MenuCommandListener />
            <MigrationBlockingModalHost />
            <SignOutConfirmDialog />
          </>
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("migration-blocking-modal")).toBeTruthy();
    act(() => menu.emit("app.signOut"));

    await waitFor(() => {
      expect(authMock.signOut).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId("confirm-destructive-dialog")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't sign out. Please try again.",
    );
    expect(screen.queryByTestId("migration-blocking-modal")).toBeNull();
    expect(screen.queryByTestId("migration-blocking-overlay")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("migration-blocking-modal")).toBeTruthy();
  });

  it("lets the first Cancel close a failed native sign-out question without discarding an anchored draft", async () => {
    const user = userEvent.setup();
    authMock.signOut.mockResolvedValue(false);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const menu = createMenu();
    storeAnchoredDraft({});
    renderMenuWithAnchoredDraft(menu);
    typeIntoEditor(composerEditorAt(0), "Keep this comment draft");

    act(() => menu.emit("app.signOut"));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(authMock.signOut).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect({
      discardPromptCalls: confirm.mock.calls.length,
      signOutQuestionOpen:
        screen.queryByTestId("confirm-destructive-dialog") !== null,
      draftText: composerEditorAt(0).getText(),
      draftStored:
        useAnchoredDraftStore.getState().byEpicId[COMMENT_EPIC_ID] !==
        undefined,
    }).toEqual({
      discardPromptCalls: 0,
      signOutQuestionOpen: false,
      draftText: "Keep this comment draft",
      draftStored: true,
    });

    await user.click(screen.getByRole("button", { name: "Outside comment" }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(composerEditorAt(0).getText()).toBe("Keep this comment draft");
    expect(
      useAnchoredDraftStore.getState().byEpicId[COMMENT_EPIC_ID],
    ).toBeDefined();
  });

  it("conceals the theme editor for native sign-out and restores its state after cancel", async () => {
    const user = userEvent.setup();
    authMock.signOut.mockResolvedValue(false);
    const menu = createMenu();
    renderMenuWithThemeEditor(menu, vi.fn());

    fireEvent.click(screen.getByRole("button", { name: "Create theme" }));
    const editor = await screen.findByRole("dialog", { name: "Theme editor" });
    fireEvent.change(within(editor).getByLabelText("Theme name"), {
      target: { value: "Draft preserved" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "All colors" }));
    const search = within(editor).getByRole("textbox", {
      name: "Filter theme colors",
    });
    const accent = within(editor).getByRole("button", { name: "Accent color" });
    await user.click(accent);
    fireEvent.change(search, { target: { value: "primary" } });

    const header = editor.querySelector("header");
    if (!header) throw new Error("expected the theme editor header");
    Object.defineProperty(header, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    fireEvent.pointerDown(header, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 130, clientY: 125 });
    fireEvent.pointerUp(header, { pointerId: 1 });

    const draft = structuredClone(useThemeLibraryStore.getState().draft);
    const geometry = {
      left: editor.style.left,
      top: editor.style.top,
      width: editor.style.width,
      height: editor.style.height,
    };
    expect(geometry.left).not.toBe("");

    act(() => menu.emit("app.signOut"));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(editor.hasAttribute("inert")).toBe(true);
    expect(editor.classList.contains("invisible")).toBe(true);

    const question = screen.getByTestId("confirm-destructive-dialog");
    fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });

    expect(screen.getByRole("dialog", { name: "Theme editor" })).toBe(editor);
    expect(editor.hasAttribute("inert")).toBe(false);
    expect(editor.classList.contains("invisible")).toBe(false);
    expect(useThemeLibraryStore.getState().draft).toEqual(draft);
    expect(
      within(editor).getByLabelText("Theme name").getAttribute("value"),
    ).toBe("Draft preserved");
    expect(
      within(editor)
        .getByRole("textbox", { name: "Filter theme colors" })
        .getAttribute("value"),
    ).toBe("primary");
    expect(
      within(editor)
        .getByRole("button", { name: "Accent color" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect({
      left: editor.style.left,
      top: editor.style.top,
      width: editor.style.width,
      height: editor.style.height,
    }).toEqual(geometry);
  });

  it("lets the shared sign-out question receive clicks while theme inspection is active", async () => {
    authMock.signOut.mockResolvedValue(false);
    const menu = createMenu();
    const onOutsideClick = vi.fn();
    renderMenuWithThemeEditor(menu, onOutsideClick);

    fireEvent.click(screen.getByRole("button", { name: "Create theme" }));
    const editor = await screen.findByRole("dialog", { name: "Theme editor" });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Pick from interface" }),
    );
    expect(
      screen.getByText("Select an area to edit its color. Escape cancels."),
    ).toBeDefined();

    act(() => menu.emit("app.signOut"));
    expect(await screen.findByRole("alert")).toBeDefined();
    const inspectorStatusWhileQuestionOpen = screen.queryByText(
      "Select an area to edit its color. Escape cancels.",
    );

    const question = screen.getByTestId("confirm-destructive-dialog");
    fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(inspectorStatusWhileQuestionOpen).toBeNull();
    expect(
      screen.getByText("Select an area to edit its color. Escape cancels."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Inspector target" }));
    expect(onOutsideClick).not.toHaveBeenCalled();
  });

  describe("the Settings command when the shell may refuse admission", () => {
    function openSettingsFrom(
      runnerHost: FakeRunnerHost,
      menu: FakeDesktopMenu,
    ): void {
      render(
        <QueryClientProvider client={makeQueryClient()}>
          <RunnerHostProvider runnerHost={runnerHost}>
            <MenuCommandListener />
          </RunnerHostProvider>
        </QueryClientProvider>,
      );
      act(() => {
        menu.emit("app.openSettings");
      });
    }

    it("opens Settings on an unverified session no host has refused", () => {
      holdRefusedSession(false);
      const menu = createMenu();

      openSettingsFrom(createRunnerHost(menu), menu);

      // Control for the cases below: the same refused session, on the same
      // local-host shell, is admitted until the flag is up - so "navigates
      // nowhere" there is the flag's doing, not a harness that never fires.
      expect(latestNavigation().to).toBe("/settings/general");
    });

    it("navigates nowhere once a host has refused the bearer an unverified session holds: the sign-in page owns the shell", () => {
      holdRefusedSession(true);
      const menu = createMenu();

      openSettingsFrom(createRunnerHost(menu), menu);

      // `/when-you-quit` would not render over the sign-in page, and would
      // surface only once a sign-in began, in place of its device code.
      expect(navigateMock).not.toHaveBeenCalled();
    });

    it("navigates nowhere on an unverified session whose shell has no local host either", () => {
      holdRefusedSession(false);
      const menu = createMenu();

      openSettingsFrom(
        Object.assign(createRunnerHost(menu), { hasLocalHost: false }),
        menu,
      );

      expect(navigateMock).not.toHaveBeenCalled();
    });

    it("still sends a signed-out shell to the quit-behaviour route", () => {
      const menu = createMenu();

      openSettingsFrom(createRunnerHost(menu), menu);

      expect(navigateMock).toHaveBeenCalledWith({ to: "/when-you-quit" });
    });
  });

  it("gates the native report command on current support capability", () => {
    const menu = createMenu();
    renderMenuCommandListener(menu);

    act(() => {
      menu.emit("app.reportIssue");
    });
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();

    useDesktopDialogStore.setState({ reportIssueAvailable: true });
    act(() => {
      menu.emit("app.reportIssue");
    });
    expect(useDesktopDialogStore.getState().activeDialog).toBe("report-issue");
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

  // Item 3, `editor-session.ts`'s `closeLayoutEditorForCloseTabChord`: Cmd+W's
  // native counterpart (the File menu's "Close Tab") asks the chord first too,
  // whatever tab or tile has focus - closing a real tab under an open editor
  // is the one thing the user did not ask for.
  it("asks the layout editor's close chord before closing an Epic tab, and defers to it while a session is open", () => {
    closeLayoutEditorForCloseTabChordMock.mockReturnValue(true);
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

    expect(closeLayoutEditorForCloseTabChordMock).toHaveBeenCalledOnce();
    // Done ran instead: the tab under the editor is untouched.
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([tabId]);
    expect(navigateMock).not.toHaveBeenCalled();
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

  function makeHostManagementFixture(
    status: HostControllerStatus,
  ): IHostManagement {
    return {
      getHostControllerStatus: vi.fn(() => Promise.resolve(status)),
      convergeReady: vi.fn(() =>
        Promise.resolve({
          kind: "ok" as const,
          value: { running: true, version: status.installedVersion },
        }),
      ),
      applyStaged: vi.fn(() =>
        Promise.resolve({
          kind: "ok" as const,
          value: {
            appliedVersion: "1.2.3",
            runningActivated: true,
            applied: true,
          },
        }),
      ),
      activateInstalled: vi.fn(() =>
        Promise.resolve({ kind: "ok" as const, value: { activated: true } }),
      ),
      installVersion: vi.fn(() => Promise.reject(new Error("not used"))),
      uninstallHost: vi.fn(() => Promise.reject(new Error("not used"))),
      restartHost: vi.fn(() => Promise.resolve({ kind: "restarted" as const })),
      uninstallTraycer: vi.fn(() => Promise.reject(new Error("not used"))),
      getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
      clearRemoval: vi.fn(() => Promise.resolve()),
      getHostLogs: vi.fn(() => Promise.reject(new Error("not used"))),
      runDoctor: vi.fn(() => Promise.reject(new Error("not used"))),
      availableVersions: vi.fn(() => Promise.reject(new Error("not used"))),
      installedRecord: vi.fn(() => Promise.resolve(null)),
      registerService: vi.fn(() =>
        Promise.resolve({ kind: "ok" as const, value: { registered: true } }),
      ),
      deregisterService: vi.fn(() => Promise.resolve()),
      registryCheck: vi.fn(() => Promise.reject(new Error("not used"))),
      freePortAndRestart: vi.fn(() => Promise.reject(new Error("not used"))),
      runDoctorRepairQueued: vi.fn(() => Promise.reject(new Error("not used"))),
      freePortAndRestartIfIdle: vi.fn(() =>
        Promise.reject(new Error("not used")),
      ),
      cliManifest: vi.fn(() => Promise.resolve(null)),
      maintenanceUpdateCheck: vi.fn(() =>
        Promise.reject(new Error("not used")),
      ),
      maintenanceDoctor: vi.fn(() => Promise.reject(new Error("not used"))),
      maintenanceInstallationInfo: vi.fn(() =>
        Promise.reject(new Error("not used")),
      ),
      maintenanceInstallVersion: vi.fn(() =>
        Promise.reject(new Error("not used")),
      ),
      restartHostIfIdle: vi.fn(() => Promise.reject(new Error("not used"))),
      restartHostServiceIfHostIdle: vi.fn(() =>
        Promise.reject(new Error("not used")),
      ),
      runDoctorRepairIfIdle: vi.fn(() => Promise.reject(new Error("not used"))),
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
  }

  it("submits applyStaged when host.installUpdate is dispatched and a stage is updateReady", async () => {
    const menu = createMenu();
    const status: HostControllerStatus = {
      download: null,
      mutation: null,
      installedVersion: "1.1.0",
      latestVersion: "1.2.3",
      stagedVersion: "1.2.3",
      installedRuntimeVersion: null,
      runningRuntimeVersion: null,
      updateReady: true,
      activation: "activated",
      reachable: true,
      localAttempt: null,
      removedByUser: false,
      checkedAt: "2026-05-15T00:00:00Z",
      lastEnsureFailure: null,
      updateDeferral: null,
    };
    const management = makeHostManagementFixture(status);
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

    await waitFor(() => {
      expect(management.getHostControllerStatus).toHaveBeenCalled();
    });
    // Being *called* only proves the query fired - the component reads
    // `status` from the query's *result*, so the resolved promise and its
    // resulting re-render must also land before dispatching, or the command
    // is evaluated against the still-`undefined` initial status.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      menu.emit("host.installUpdate");
    });

    await waitFor(() => {
      expect(management.applyStaged).toHaveBeenCalledWith("manual", false);
    });
    expect(management.activateInstalled).not.toHaveBeenCalled();
  });

  // A disabled task the apply left off, or another Windows user's task, is a
  // notice (warning / info) - never `toast.error` - from the native menu too.
  it.each([
    [
      "a disabled task",
      HOST_UPDATED_SERVICE_DISABLED_MESSAGE,
      toastMocks.warning,
    ],
    [
      "another Windows user's task",
      SERVICE_TASK_NOT_OWNED_MESSAGE,
      toastMocks.info,
    ],
  ] as const)(
    "host.installUpdate over %s is a notice toast, never toast.error",
    async (_label, message, expectedToast) => {
      const menu = createMenu();
      const status: HostControllerStatus = {
        download: null,
        mutation: null,
        installedVersion: "1.1.0",
        latestVersion: "1.2.3",
        stagedVersion: "1.2.3",
        installedRuntimeVersion: null,
        runningRuntimeVersion: null,
        updateReady: true,
        activation: "activated",
        reachable: true,
        localAttempt: null,
        removedByUser: false,
        checkedAt: "2026-05-15T00:00:00Z",
        lastEnsureFailure: null,
        updateDeferral: null,
      };
      const management: IHostManagement = {
        ...makeHostManagementFixture(status),
        applyStaged: vi.fn(() =>
          Promise.resolve({ kind: "deferred" as const, message }),
        ),
      };
      const runnerHost: FakeRunnerHost = Object.assign(createRunnerHost(menu), {
        hostManagement: management,
      });
      render(
        <QueryClientProvider client={makeQueryClient()}>
          <RunnerHostProvider runnerHost={runnerHost}>
            <MenuCommandListener />
          </RunnerHostProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => {
        expect(management.getHostControllerStatus).toHaveBeenCalled();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      act(() => {
        menu.emit("host.installUpdate");
      });

      await waitFor(() => {
        expect(expectedToast).toHaveBeenCalledWith(message);
      });
      expect(toastMocks.error).not.toHaveBeenCalled();
    },
  );

  it("submits activateInstalled when host.installUpdate is dispatched with only activation debt", async () => {
    const menu = createMenu();
    const status: HostControllerStatus = {
      download: null,
      mutation: null,
      installedVersion: "1.1.0",
      latestVersion: "1.1.0",
      stagedVersion: null,
      installedRuntimeVersion: null,
      runningRuntimeVersion: null,
      updateReady: false,
      activation: "activationUnknown",
      reachable: true,
      localAttempt: null,
      removedByUser: false,
      checkedAt: "2026-05-15T00:00:00Z",
      lastEnsureFailure: null,
      updateDeferral: null,
    };
    const management = makeHostManagementFixture(status);
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

    await waitFor(() => {
      expect(management.getHostControllerStatus).toHaveBeenCalled();
    });
    // Being *called* only proves the query fired - the component reads
    // `status` from the query's *result*, so the resolved promise and its
    // resulting re-render must also land before dispatching, or the command
    // is evaluated against the still-`undefined` initial status.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      menu.emit("host.installUpdate");
    });

    await waitFor(() => {
      expect(management.activateInstalled).toHaveBeenCalledWith(false, false);
    });
    expect(management.applyStaged).not.toHaveBeenCalled();
  });

  it("does not treat an unavailable host as activation debt", async () => {
    const menu = createMenu();
    const status: HostControllerStatus = {
      download: null,
      mutation: null,
      installedVersion: null,
      latestVersion: null,
      stagedVersion: null,
      installedRuntimeVersion: null,
      runningRuntimeVersion: null,
      updateReady: false,
      activation: "unavailable",
      reachable: false,
      localAttempt: null,
      removedByUser: false,
      checkedAt: "2026-05-15T00:00:00Z",
      lastEnsureFailure: null,
      updateDeferral: null,
    };
    const management = makeHostManagementFixture(status);
    const runnerHost: FakeRunnerHost = Object.assign(createRunnerHost(menu), {
      hostManagement: management,
    });
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <MenuCommandListener />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(management.getHostControllerStatus).toHaveBeenCalled(),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => menu.emit("host.installUpdate"));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(management.applyStaged).not.toHaveBeenCalled();
    expect(management.activateInstalled).not.toHaveBeenCalled();
  });

  it("opens a confirmation dialog for host.restart and only respawns after confirm", async () => {
    const menu = createMenu();
    const requestHostRespawn = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const management = makeHostManagementFixture({
      download: null,
      mutation: null,
      installedVersion: "1.5.0",
      latestVersion: "1.5.0",
      stagedVersion: null,
      installedRuntimeVersion: "1.5.0",
      runningRuntimeVersion: "1.5.0",
      updateReady: false,
      activation: "activated",
      reachable: true,
      localAttempt: null,
      removedByUser: false,
      checkedAt: "2026-08-12T00:00:00Z",
      lastEnsureFailure: null,
      updateDeferral: null,
    });
    const runnerHost = Object.assign(createRunnerHost(menu), {
      requestHostRespawn,
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
      menu.emit("host.restart");
    });

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("Restarting will stop");
    expect(requestHostRespawn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(requestHostRespawn).toHaveBeenCalledTimes(1);
    });
    expect(management.restartHostIfIdle).not.toHaveBeenCalled();
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
          ...freshLandingMirrorState(),
        },
      ],
      activeDraftId: "draft-a",
    });
    useTabsStore.setState((state) => ({
      ...state,
      items: [
        ...state.items,
        {
          kind: "tab",
          id: tabItemId({ kind: "draft", id: "draft-a" }),
          ref: { kind: "draft", id: "draft-a" },
        },
      ],
      activeItemId: tabItemId({ kind: "draft", id: "draft-a" }),
      stripOrder: [
        ...state.stripOrder,
        { kind: "draft" as const, id: "draft-a" },
      ],
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

    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts[0].closed).toBe(true);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([tabId]);
    const navigation = latestNavigation();
    expect(navigation.to).toBe("/epics/$epicId/$tabId");
    expect(navigation.params).toEqual({ epicId: "e-a", tabId });
    // Closing the draft now routes through
    // `tabCommandCoordinator.closeRefAfterConfirmed`, which synchronously
    // promotes the epic tab to `activeItemId` as part of the close itself
    // (survivor-at-group-position). By the time the navigation controller
    // runs, the epic is already the coordinator's active item, so it
    // correctly resolves this as a replace (syncing the URL to already-
    // settled layout state) rather than a push.
    expect(navigation.replace).toBe(true);
    expect(navigation.state).toEqual(expect.any(Function));
    expect(navigation.search).toMatchObject({
      focusedAt: undefined,
      focusArtifactId: undefined,
      focusThreadId: undefined,
      migrationSource: undefined,
    });
  });
});
