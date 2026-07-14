import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { create } from "zustand";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { TaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type {
  DesktopReportIssueForm,
  DesktopSubmitReportResult,
  DesktopWindowsBridge,
  DesktopSupportLogTarget,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";
import {
  disposeAllOpenEpicSessions,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  OpenEpicState,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { EMPTY_PROJECTED_SLICES } from "@/stores/epics/open-epic/types";
import { createReportIssueContext } from "@/lib/report-issue-context";

const cloudEpicTasks = vi.hoisted((): { data: TaskLight[] } => ({ data: [] }));

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({
    hostId: "host-1",
    tasks: cloudEpicTasks.data,
    query: {
      data: { pages: [{ tasks: cloudEpicTasks.data, hasMore: false }] },
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    },
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

import { DesktopDialogHost } from "@/components/layout/dialogs/desktop-dialog-host";
import { ReportIssueDialogHost } from "@/components/layout/dialogs/report-issue-dialog-host";

const snapshot: DesktopSupportSnapshot = {
  appName: "Traycer",
  appVersion: "1.2.3",
  platform: "darwin",
  arch: "arm64",
  user: {
    status: "signed-in",
    userName: "Test User",
    email: "test@example.com",
  },
  versions: { electron: "30.0.0", chrome: "124.0.0", node: "22.0.0" },
  host: {
    status: "ready",
    version: "0.4.0",
    pid: 1234,
    hostId: "host-1",
  },
  logs: [
    {
      target: "desktop",
      label: "Desktop Log",
      path: "/tmp/traycer-desktop.log",
    },
    {
      target: "host",
      label: "Host Log",
      path: "/tmp/host.log",
    },
  ],
  links: [
    {
      id: "website",
      label: "Website",
      url: "https://traycer.ai",
    },
    {
      id: "documentation",
      label: "Documentation",
      url: "https://docs.traycer.ai",
    },
    {
      id: "release-notes",
      label: "Release Notes",
      url: "https://docs.traycer.ai/changelog",
    },
    {
      id: "discord",
      label: "Discord",
      url: "https://traycer.ai/discord",
    },
    {
      id: "support",
      label: "Contact Support",
      url: "mailto:support@traycer.ai",
    },
  ],
  supportEmail: "support@traycer.ai",
};

const EPIC_A = { id: "e-a", name: "A", draft: false };

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

function createRunnerHost(
  revealed: DesktopSupportLogTarget[],
  openedLinks: string[],
  logLines: readonly string[],
): IRunnerHost {
  return Object.assign(createBaseRunnerHost(), {
    openExternalLink: (url: string) => {
      openedLinks.push(url);
      return Promise.resolve();
    },
    support: {
      getSnapshot: () => Promise.resolve(snapshot),
      revealLog: (target: DesktopSupportLogTarget) => {
        revealed.push(target);
        return Promise.resolve({
          target,
          path:
            snapshot.logs.find((entry) => entry.target === target)?.path ?? "",
        });
      },
      submitReport: () => Promise.resolve({ reportId: "rpt_test" }),
      tailLog: (input: {
        readonly target: DesktopSupportLogTarget;
        readonly tailLines: number;
      }) =>
        Promise.resolve({
          target: input.target,
          path:
            snapshot.logs.find((entry) => entry.target === input.target)
              ?.path ?? "",
          lines: logLines.slice(-input.tailLines),
          truncated: logLines.length > input.tailLines,
        }),
    },
  });
}

function createRunnerHostWithSubmit(
  openedLinks: string[],
  submitReport: (
    form: DesktopReportIssueForm,
  ) => Promise<DesktopSubmitReportResult>,
): IRunnerHost {
  return Object.assign(createRunnerHost([], openedLinks, []), {
    support: {
      getSnapshot: () => Promise.resolve(snapshot),
      revealLog: (target: DesktopSupportLogTarget) =>
        Promise.resolve({ target, path: "" }),
      submitReport,
      tailLog: (input: {
        readonly target: DesktopSupportLogTarget;
        readonly tailLines: number;
      }) =>
        Promise.resolve({
          target: input.target,
          path: "",
          lines: [],
          truncated: false,
        }),
    },
  });
}

function createBaseRunnerHost(): IRunnerHost {
  return {
    signInUrl: "https://auth.example.invalid/sign-in",
    authnBaseUrl: "https://auth.example.invalid",
    hasLocalHost: true,
    validateAuthToken: () => Promise.resolve({ kind: "rejected" as const }),
    validateAuthTokenIdentity: () =>
      Promise.resolve({ kind: "rejected" as const }),
    refreshAuthToken: () => Promise.resolve({ kind: "network-error" as const }),
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
      requestOpen: () => undefined,
      requestClose: () => undefined,
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
    requestHostRespawn: () => Promise.resolve(),
    service: null,
    traycerCli: null,
    migration: null,
    hostManagement: null,
    hostTray: null,
    zoom: null,
  };
}

function createDesktopWindowsBridgeForTests(calls: {
  readonly openInNewWindow: Array<{
    readonly epicId: string;
    readonly title: string;
    readonly tabId: string;
  }>;
}): DesktopWindowsBridge {
  return {
    windowId: "window-a",
    list: () => Promise.resolve([]),
    onChange: () => ({ dispose: () => undefined }),
    requestNew: () => Promise.resolve(),
    requestFocus: () => Promise.resolve(),
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: (epicId, title, tabId) => {
      calls.openInNewWindow.push({ epicId, title, tabId });
      return Promise.resolve({
        result: "moved" as const,
        windowId: "window-b",
      });
    },
    ownership: {
      snapshot: () => Promise.resolve([]),
      claim: () => Promise.resolve({ ok: true as const }),
      release: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    perWindowState: {
      get: () =>
        Promise.resolve({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
      update: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    authSession: {
      get: () =>
        Promise.resolve({
          status: "signed-out" as const,
          token: null,
          profile: null,
        }),
      set: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function createDirtyEpicHandle(
  epicId: string,
  unsyncedQueueSize: number,
): OpenEpicStoreHandle {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const store = create<OpenEpicState>()((set) => ({
    epicId,
    doc,
    awareness,
    bindingVersion: 0,
    ...EMPTY_PROJECTED_SLICES,
    artifactRooms: { stateByArtifactRoomId: {} },
    snapshotMeta: null,
    permissionRole: null,
    connectionStatus: "open",
    accessLost: false,
    epicDeleted: null,
    snapshotLoaded: true,
    snapshotFetchError: null,
    migration: {
      status: "idle",
      phase: null,
      chunksDone: 0,
      chunksTotal: 0,
    },
    isDirty: true,
    dirtyWatermarkStateVectorBase64: null,
    latestHostStateVectorBase64: null,
    unsyncedQueueSize,
    lastFocusedArtifactId: null,
    lastFocusedThreadId: null,
    setLastFocusedArtifactId: (artifactId) => {
      set({ lastFocusedArtifactId: artifactId });
    },
    setLastFocusedThreadId: (threadId) => {
      set({ lastFocusedThreadId: threadId });
    },
    applyLocalUpdate: () => undefined,
    sendAwareness: () => undefined,
    discardUnsyncedEdits: () => {
      set({ isDirty: false, unsyncedQueueSize: 0 });
    },
    requestFreshSnapshot: () => undefined,
    retryMigration: () => undefined,
    dispose: () => undefined,
    createArtifact: () => "fake-id",
    createTerminalChat: () => null,
    renameArtifact: () => false,
    deleteArtifact: () => false,
    reparentArtifact: () => false,
    setEpicTitle: () => false,
    readAttachmentBytes: () => Promise.resolve(null),
    getArtifactFragment: () => null,
    getArtifactBodyAwareness: () => null,
    getArtifactBodyAvailability: () => "unavailable",
    readArtifactTitle: () => null,
  }));
  return {
    epicId,
    userId: null,
    doc,
    awareness,
    store,
    dispose: () => undefined,
    requestFreshSnapshot: () => undefined,
    isClean: () => !store.getState().isDirty,
  };
}

function buildEpicTask(
  epicId: string,
  title: string,
  updatedAt: number,
): TaskLight {
  return {
    epic: {
      light: {
        id: epicId,
        title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "open",
        createdAt: updatedAt,
        updatedAt,
        createdBy: "test-user",
        version: "v1",
      },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
  };
}

function buildRouter(runnerHost: IRunnerHost, initialPath: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <RunnerHostProvider runnerHost={runnerHost}>
        <DesktopDialogHost />
        <ReportIssueDialogHost />
      </RunnerHostProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    validateSearch: (
      search: Record<string, unknown>,
    ): { focusedAt: number | undefined } => ({
      focusedAt:
        typeof search.focusedAt === "number" ? search.focusedAt : undefined,
    }),
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, epicRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function renderDesktopDialogHost(runnerHost: IRunnerHost, initialPath: string) {
  const router = buildRouter(runnerHost, initialPath);
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

async function flushNav(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function flushDialogEffects(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  });
}

function resetStores(): void {
  cloudEpicTasks.data = [];
  useDesktopDialogStore.getState().close();
  useDesktopDialogStore.setState({
    reportIssueAvailable: false,
    reportIssueDraftId: 0,
  });
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
    artifactTreeByEpicId: {},
  });
  setDesktopEpicOwnershipBridge(null);
  disposeAllOpenEpicSessions();
}

describe("<DesktopDialogHost />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it("renders About Details from the desktop support snapshot", async () => {
    useDesktopDialogStore.getState().openAboutDetails();
    const openedLinks: string[] = [];

    renderDesktopDialogHost(createRunnerHost([], openedLinks, []), "/");
    await flushDialogEffects();

    expect(screen.getByText("1.2.3")).not.toBeNull();
    expect(screen.getByText("Test User <test@example.com>")).not.toBeNull();
    expect(screen.getByText("support@traycer.ai")).not.toBeNull();
    expect(screen.getByText("darwin arm64")).not.toBeNull();
    expect(screen.getByText("0.4.0 (pid 1234)")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Documentation/i }));
    fireEvent.click(screen.getByRole("button", { name: /Release Notes/i }));

    await waitFor(() => {
      expect(openedLinks).toEqual([
        "https://docs.traycer.ai",
        "https://docs.traycer.ai/changelog",
      ]);
    });
  });

  it("shows the selected log tail and reveals the selected log target", async () => {
    const revealed: DesktopSupportLogTarget[] = [];
    useDesktopDialogStore.getState().openLogs();

    renderDesktopDialogHost(
      createRunnerHost(revealed, [], ["host boot", "host ready"]),
      "/",
    );
    await flushDialogEffects();

    expect(screen.getByText("Host Log")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Host Log/i }));

    await waitFor(() => {
      expect(screen.getByText(/host boot/)).not.toBeNull();
      expect(screen.getByText(/host ready/)).not.toBeNull();
    });

    const revealButtons = screen.getAllByRole("button", { name: /Reveal/i });
    fireEvent.click(revealButtons[1]);

    await waitFor(() => {
      expect(revealed).toEqual(["host"]);
    });
  });

  it("prefills a contextual report and clears it when the dialog closes", async () => {
    useDesktopDialogStore.getState().openReportIssueWithContext(
      createReportIssueContext({
        title: "Failed to load epic",
        message: "The host returned an unexpected response.",
        code: "RPC_ERROR",
        source: "Epic snapshot",
      }),
    );

    renderDesktopDialogHost(createRunnerHost([], [], []), "/");
    await flushDialogEffects();

    const title = screen.getByRole("textbox", { name: "Title" });
    if (!(title instanceof HTMLInputElement)) {
      throw new Error("Expected the report title field.");
    }
    expect(title.value).toBe("Failed to load epic");
    const whatHappened = screen.getByRole("textbox", {
      name: "What happened?",
    });
    if (!(whatHappened instanceof HTMLTextAreaElement)) {
      throw new Error("Expected the report description field.");
    }
    expect(whatHappened.value).toBe(
      "Area: Epic snapshot\n\nError code: RPC_ERROR\n\nThe host returned an unexpected response.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: null,
      reportIssueContext: null,
    });
  });

  it("replaces an edited draft when a later report context is selected", async () => {
    useDesktopDialogStore.getState().openReportIssueWithContext(
      createReportIssueContext({
        title: "Earlier error",
        message: null,
        code: null,
        source: "Earlier area",
      }),
    );
    renderDesktopDialogHost(createRunnerHost([], [], []), "/");
    await flushDialogEffects();

    const titleInput = screen.getByPlaceholderText(
      "Short summary of the issue",
    );
    if (!(titleInput instanceof HTMLInputElement)) {
      throw new Error("Expected the report title input.");
    }
    fireEvent.change(titleInput, { target: { value: "My edited draft" } });
    expect(titleInput.value).toBe("My edited draft");

    act(() => {
      useDesktopDialogStore.getState().openReportIssueWithContext(
        createReportIssueContext({
          title: "Most recent error",
          message: "A fixed safe message.",
          code: "RPC_ERROR",
          source: "Latest area",
        }),
      );
    });

    expect(await screen.findByDisplayValue("Most recent error")).not.toBeNull();
    expect(screen.queryByDisplayValue("My edited draft")).toBeNull();
  });

  it("refuses and closes report state when desktop support is unavailable", async () => {
    useDesktopDialogStore.setState({
      activeDialog: "report-issue",
      reportIssueContext: createReportIssueContext({
        title: "Unsupported report",
        message: null,
        code: null,
        source: "Test",
      }),
      reportIssueDraftId: 1,
    });

    renderDesktopDialogHost(createBaseRunnerHost(), "/");

    expect(
      screen.queryByRole("heading", { name: "Report an Issue" }),
    ).toBeNull();
    await waitFor(() => {
      expect(useDesktopDialogStore.getState()).toMatchObject({
        activeDialog: null,
        reportIssueAvailable: false,
        reportIssueContext: null,
      });
    });
  });

  it("keeps a failed submission inline, focused, and preserves the form", async () => {
    useDesktopDialogStore.getState().openReportIssueWithContext(
      createReportIssueContext({
        title: "Original title",
        message: "Original details",
        code: null,
        source: "Test",
      }),
    );
    renderDesktopDialogHost(
      createRunnerHostWithSubmit([], () =>
        Promise.reject(new Error("submit unavailable")),
      ),
      "/",
    );
    await flushDialogEffects();

    const title = screen.getByPlaceholderText("Short summary of the issue");
    const whatHappened = screen.getByPlaceholderText(
      "A clear description of the bug. Include any error messages you saw.",
    );
    fireEvent.change(title, { target: { value: "Edited title" } });
    fireEvent.change(whatHappened, {
      target: { value: "Edited private-safe details" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Failed to submit report. Please try again.",
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(alert);
    });
    expect(screen.getByDisplayValue("Edited title")).not.toBeNull();
    expect(
      screen.getByDisplayValue("Edited private-safe details"),
    ).not.toBeNull();
    expect(useDesktopDialogStore.getState().activeDialog).toBe("report-issue");
  });

  it("opens an older successful submission without closing a newer draft", async () => {
    const deferred = createDeferred<DesktopSubmitReportResult>();
    const openedLinks: string[] = [];
    useDesktopDialogStore.getState().openReportIssueWithContext(
      createReportIssueContext({
        title: "Draft A",
        message: null,
        code: null,
        source: "Test A",
      }),
    );
    renderDesktopDialogHost(
      createRunnerHostWithSubmit(openedLinks, () => deferred.promise),
      "/",
    );
    await flushDialogEffects();
    fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));

    const draftBContext = createReportIssueContext({
      title: "Draft B",
      message: "Newer details",
      code: null,
      source: "Test B",
    });
    act(() => {
      useDesktopDialogStore
        .getState()
        .openReportIssueWithContext(draftBContext);
    });
    const draftBTitle = await screen.findByDisplayValue("Draft B");
    fireEvent.change(draftBTitle, { target: { value: "Edited Draft B" } });

    await act(async () => {
      deferred.resolve({ reportId: "rpt_a" });
      await deferred.promise;
    });
    await waitFor(() => {
      expect(openedLinks).toHaveLength(1);
    });

    expect(
      new URL(openedLinks[0], "https://github.com").searchParams.get("title"),
    ).toBe("Draft A");
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: draftBContext,
    });
    expect(screen.getByDisplayValue("Edited Draft B")).not.toBeNull();
  });

  it("does not surface an older failed submission in a newer draft", async () => {
    const deferred = createDeferred<DesktopSubmitReportResult>();
    useDesktopDialogStore.getState().openReportIssueWithContext(
      createReportIssueContext({
        title: "Draft A",
        message: null,
        code: null,
        source: "Test A",
      }),
    );
    renderDesktopDialogHost(
      createRunnerHostWithSubmit([], () => deferred.promise),
      "/",
    );
    await flushDialogEffects();
    fireEvent.click(screen.getByRole("button", { name: "Submit Report" }));

    const draftBContext = createReportIssueContext({
      title: "Draft B",
      message: "Newer details",
      code: null,
      source: "Test B",
    });
    act(() => {
      useDesktopDialogStore
        .getState()
        .openReportIssueWithContext(draftBContext);
    });
    await screen.findByDisplayValue("Draft B");

    await act(async () => {
      deferred.reject(new Error("Draft A failed"));
      await deferred.promise.catch(() => undefined);
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByDisplayValue("Draft B")).not.toBeNull();
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: draftBContext,
    });
  });

  it("keeps queued wait-for-sync move semantics after the global picker closes", async () => {
    const calls: {
      openInNewWindow: Array<{
        readonly epicId: string;
        readonly title: string;
        readonly tabId: string;
      }>;
    } = { openInNewWindow: [] };
    setDesktopEpicOwnershipBridge(createDesktopWindowsBridgeForTests(calls));
    cloudEpicTasks.data = [buildEpicTask(EPIC_A.id, EPIC_A.name, 1_700_000)];
    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab(EPIC_A.id, EPIC_A.name);
    const handle = createDirtyEpicHandle(EPIC_A.id, 2);
    getOpenEpicRegistry().acquire(EPIC_A.id, () => handle);
    useDesktopDialogStore.getState().openEpicInNewWindow();

    const router = renderDesktopDialogHost(
      createRunnerHost([], [], []),
      `/epics/e-a/${tabId}`,
    );
    fireEvent.click(
      await screen.findByTestId(`open-epic-new-window-row-${EPIC_A.id}`),
    );

    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    expect(screen.queryByTestId("open-epic-new-window-rows")).toBeNull();
    expect(await screen.findByTestId("epic-move-unsynced-dialog")).not.toBe(
      null,
    );
    expect(calls.openInNewWindow).toEqual([]);

    fireEvent.click(screen.getByTestId("epic-move-unsynced-wait"));
    expect(calls.openInNewWindow).toEqual([]);

    act(() => {
      handle.store.setState({ isDirty: false, unsyncedQueueSize: 0 });
    });
    await flushNav();

    expect(calls.openInNewWindow).toEqual([
      { epicId: EPIC_A.id, title: EPIC_A.name, tabId },
    ]);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(router.state.location.pathname).toBe("/");
  });
});
