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
import { createInertSelectionAuthorityClient } from "@traycer-clients/shared/test-fixtures/selection-authority";
import type { TaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
  DesktopReportIssueForm,
  DesktopSubmitReportResult,
  DesktopSupportBridge,
  DesktopSupportBuildPublicDraftResult,
  DesktopWindowsBridge,
  DesktopSupportLogTarget,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";
import type { UnsyncedEditsEntry } from "@/stores/epics/open-epic/session-registry";
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
import {
  EMPTY_CHATS_SLICE,
  EMPTY_PROJECTED_SLICES,
} from "@/stores/epics/open-epic/types";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  knownField,
  setSupportContextSnapshot,
  __resetSupportContextRegistryForTests,
} from "@/lib/support-context-registry";

const cloudEpicTasks = vi.hoisted((): { data: TaskLight[] } => ({ data: [] }));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

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
  privateDeliveryAvailable: true,
};

const EPIC_A = { id: "e-a", name: "A", draft: false };

// A faithful-enough stand-in for `support:buildPublicDraft` (ticket 09/07):
// echoes the form back the way the real builder would with no
// `privateDiagnostics.cause` (these tests never attach one) - the derived
// title falls back to the user's own intent text (unmodified, since these
// fixtures never contain anything the scrubber would touch), always routed
// to the bug template. Good enough for assertions that check the opened
// URL's `title`/`what-happened` params; it does not model scrubbing or the
// 8 KiB truncation budget.
function echoPublicDraft(
  form: DesktopReportIssueForm,
): Promise<DesktopSupportBuildPublicDraftResult> {
  return Promise.resolve({
    template: "bug_report.yml",
    title: form.intent,
    fields: {
      "what-happened": form.intent,
      version: "1.2.3",
      os: "darwin (arm64)",
      component: "Desktop app",
      repro:
        "Not captured step-by-step - see the private support report rpt_test.",
    },
    truncated: false,
  });
}

function createSupportBridgeFixture(input: {
  readonly getSnapshot: () => Promise<DesktopSupportSnapshot>;
  readonly revealLog: DesktopSupportBridge["revealLog"];
  readonly submitReport: DesktopSupportBridge["submitReport"];
  readonly tailLog: DesktopSupportBridge["tailLog"];
  readonly saveDiagnosticBundle: DesktopSupportBridge["saveDiagnosticBundle"];
}): DesktopSupportBridge {
  return {
    getSnapshot: input.getSnapshot,
    revealLog: input.revealLog,
    submitReport: input.submitReport,
    tailLog: input.tailLog,
    freezeEvidence: () => Promise.resolve({ reportId: "rpt_test" }),
    discardFrozenEvidence: () => Promise.resolve(),
    readFrozenLogTail: (frozenInput) =>
      Promise.resolve({
        target: frozenInput.target,
        path: "",
        lines: [],
        truncated: false,
      }),
    saveDiagnosticBundle: input.saveDiagnosticBundle,
    getFingerprintOccurrence: () => Promise.resolve(null),
    buildPublicDraft: echoPublicDraft,
  };
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
    support: createSupportBridgeFixture({
      getSnapshot: () => Promise.resolve(snapshot),
      revealLog: (target: DesktopSupportLogTarget) => {
        revealed.push(target);
        return Promise.resolve({
          target,
          path:
            snapshot.logs.find((entry) => entry.target === target)?.path ?? "",
        });
      },
      submitReport: () =>
        Promise.resolve({ status: "delivered", reportId: "rpt_test" }),
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
      saveDiagnosticBundle: () => Promise.resolve({ path: "/tmp/bundle.json" }),
    }),
  });
}

function createRunnerHostWithSubmit(
  openedLinks: string[],
  submitReport: (
    form: DesktopReportIssueForm,
  ) => Promise<DesktopSubmitReportResult>,
): IRunnerHost {
  return Object.assign(createRunnerHost([], openedLinks, []), {
    support: createSupportBridgeFixture({
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
      saveDiagnosticBundle: () => Promise.resolve({ path: "/tmp/bundle.json" }),
    }),
  });
}

function createRunnerHostWithoutPrivateDelivery(
  openedLinks: string[],
  saveDiagnosticBundle: () => Promise<{ readonly path: string }>,
): IRunnerHost {
  return Object.assign(createRunnerHost([], openedLinks, []), {
    support: createSupportBridgeFixture({
      getSnapshot: () =>
        Promise.resolve({ ...snapshot, privateDeliveryAvailable: false }),
      revealLog: (target: DesktopSupportLogTarget) =>
        Promise.resolve({ target, path: "" }),
      submitReport: () => Promise.resolve({ status: "unavailable" as const }),
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
      saveDiagnosticBundle,
    }),
  });
}

function createBaseRunnerHost(): IRunnerHost {
  return {
    selectionAuthority: createInertSelectionAuthorityClient(),
    refreshHostFleet: () => Promise.resolve(),
    onRegisteredHostsChange: () => null,
    signInUrl: "https://auth.example.invalid/sign-in",
    authnBaseUrl: "https://auth.example.invalid",
    relayBaseUrl: "wss://relay.example.invalid/attach",
    hasLocalHost: true,
    validateAuthTokenIdentity: () =>
      Promise.resolve({ kind: "rejected" as const }),
    listRegisteredHosts: () =>
      Promise.resolve({ kind: "network-error" as const }),
    listUserSessions: () => Promise.resolve({ kind: "network-error" as const }),
    revokeUserSession: () =>
      Promise.resolve({ kind: "network-error" as const }),
    revokeAllSessions: () =>
      Promise.resolve({ kind: "network-error" as const }),
    mintHostCredential: () =>
      Promise.resolve({ kind: "network-error" as const }),
    requestStepUpChallenge: () =>
      Promise.resolve({ kind: "network-error" as const }),
    verifyStepUpChallenge: () =>
      Promise.resolve({ kind: "network-error" as const }),
    updateHostVersionPolicy: () =>
      Promise.resolve({ kind: "network-error" as const }),
    deregisterHostFromAccount: () =>
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
      show: () => Promise.resolve("presented" as const),
      onForegroundDisplay: () => ({ dispose: () => undefined }),
      onClick: () => ({ dispose: () => undefined }),
    },
    tray: {
      setEpics: () => Promise.resolve(),
      setIndicator: () => Promise.resolve(),
      onEpicSelected: () => ({ dispose: () => undefined }),
    },
    workspaceFolders: {
      canPickNatively: true,
      pickFolders: () => Promise.resolve([]),
    },
    fileDrops: {
      resolveDroppedFilePaths: () => Promise.resolve([]),
      copyDroppedFilePaths: (paths) => Promise.resolve(paths),
      readNativeClipboardFilePaths: () => Promise.resolve([]),
    },
    tokenStore: {
      get: () => Promise.resolve(null),
      signIn: () => Promise.resolve(),
      rotate: () =>
        Promise.resolve({ outcome: "deleted" as const, pair: null }),
      delete: () => Promise.resolve(),
      subscribe: () => ({ dispose: () => undefined }),
      migrateLegacyCredentials: () =>
        Promise.resolve("identity-unknown" as const),
    },
    onLocalHostChange: () => ({ dispose: () => undefined }),
    onSystemResumed: () => ({ dispose: () => undefined }),
    requestHostRespawn: () => Promise.resolve({ kind: "restarted" as const }),
    getLastKnownLocalHostId: () => Promise.resolve(null),
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
    chatRecords: EMPTY_CHATS_SLICE,
    chatRecordListAuthoritative: true,
    chatRetractions: {},
    artifactRooms: { stateByArtifactRoomId: {} },
    artifactRoomDirtyByArtifactRoomId: {},
    rootDirty: false,
    hasDirtySnapshotForOpenCycle: true,
    snapshotMeta: null,
    permissionRole: null,
    connectionStatus: "open",
    hostTransportStatus: "open",
    cloudSyncStatus: "connected",
    hasFreshCloudSyncStatus: true,
    hasConnectedOnce: true,
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
    applyChatRecords: () => undefined,
    markChatRecordListAuthoritative: () => undefined,
    applyChatRecordDelta: () => undefined,
    republishChatRecordsForCurrentUser: () => undefined,
    beginPendingChatCreation: () => undefined,
    clearPendingChatCreation: () => undefined,
    dispose: () => undefined,
    createArtifact: () => "fake-id",
    createTerminalChat: () => null,
    renameArtifact: () => false,
    deleteArtifact: () => false,
    reparentArtifact: () => false,
    setEpicTitle: () => false,
    readAttachmentBytes: () => Promise.resolve(null),
    hasAttachmentBytes: () => false,
    getArtifactFragment: () => null,
    getArtifactBodyAwareness: () => null,
    getArtifactBodyAvailability: () => "unavailable",
    getArtifactRoomId: () => null,
    acquireArtifactBodyLease: () => () => {},
    readArtifactTitle: () => null,
    detachTransport: () => undefined,
  }));
  return {
    epicId,
    userId: null,
    doc,
    awareness,
    store,
    dispose: () => undefined,
    detachTransport: () => undefined,
    requestFreshSnapshot: () => undefined,
    isClean: () => !store.getState().isDirty,
    hotArtifactRoomIdsForTests: () => [],
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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
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
  __resetSupportContextRegistryForTests();
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

  // Deeper interaction coverage (gate focus behavior, consent toggles,
  // type-chip routing, all four delivery states, confirmation persistence,
  // preview flow) lives in report-issue-capture-dialog.test.tsx - these are
  // wire-level smoke tests proving the store <-> dialog <-> support bridge
  // round trip still works after the ticket 07 rewrite.

  it("opens a true manual report with type chips and an empty intent field", async () => {
    useDesktopDialogStore.getState().openReportIssue();
    renderDesktopDialogHost(createRunnerHost([], [], []), "/");
    await flushDialogEffects();

    expect(screen.getByRole("radio", { name: "Bug" })).not.toBeNull();
    const intent = screen.getByRole("textbox", {
      name: "What were you trying to do, and what went wrong?",
    });
    if (!(intent instanceof HTMLTextAreaElement)) {
      throw new Error("Expected the intent textarea.");
    }
    expect(intent.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: null,
      reportIssueContext: null,
    });
  });

  it("shows a non-migrated report context as a captured-context row, never prefilled into the intent question (KB2)", async () => {
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

    const intent = screen.getByRole("textbox", {
      name: "What were you trying to do, and what went wrong?",
    });
    if (!(intent instanceof HTMLTextAreaElement)) {
      throw new Error("Expected the intent textarea.");
    }
    // Machine text answering the human question would both bury the actual
    // prompt and trivially satisfy the evidence gate with zero human signal.
    expect(intent.value).toBe("");
    expect(
      screen.getByText(
        "Area: Epic snapshot · Error code: RPC_ERROR · The host returned an unexpected response.",
      ),
    ).not.toBeNull();
  });

  it("keeps the evidence gate binding on a non-migrated legacy-context report with no user text (KB2/N1 interaction)", async () => {
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

    // Before KB2, the machine text above trivially satisfied the gate with
    // zero human signal - now that it's not in `form.intent`, Send with no
    // user-typed text must still be blocked.
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect(
      await screen.findByText(
        "Add a sentence, a screenshot, or pick where it happened - we need at least one to act on the report.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: "Report an issue" }),
    ).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Report sent" })).toBeNull();
  });

  it("shows a human label for the current route template in the location selector, never the raw path (KB3)", async () => {
    setSupportContextSnapshot({ routeTemplate: knownField("/") });
    useDesktopDialogStore.getState().openReportIssueWithContext(
      createReportIssueContext({
        title: "Something else went wrong",
        message: "Unexpected state",
        code: null,
        source: null,
      }),
    );

    renderDesktopDialogHost(createRunnerHost([], [], []), "/");
    await flushDialogEffects();

    fireEvent.click(screen.getByRole("combobox"));
    expect(
      await screen.findByRole("option", { name: "Start page (current)" }),
    ).not.toBeNull();
    expect(screen.queryByRole("option", { name: "/ (current)" })).toBeNull();
  });

  it("falls back to a generic label for an unmapped route template, never the raw path (KB3)", async () => {
    setSupportContextSnapshot({
      routeTemplate: knownField("/some/future/$routeId"),
    });
    useDesktopDialogStore.getState().openReportIssueWithContext(
      createReportIssueContext({
        title: "Something else went wrong",
        message: "Unexpected state",
        code: null,
        source: null,
      }),
    );

    renderDesktopDialogHost(createRunnerHost([], [], []), "/");
    await flushDialogEffects();

    fireEvent.click(screen.getByRole("combobox"));
    expect(
      await screen.findByRole("option", { name: "This screen (current)" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("option", { name: "/some/future/$routeId (current)" }),
    ).toBeNull();
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
      screen.queryByRole("heading", { name: "Report an issue" }),
    ).toBeNull();
    await waitFor(() => {
      expect(useDesktopDialogStore.getState()).toMatchObject({
        activeDialog: null,
        reportIssueAvailable: false,
        reportIssueContext: null,
      });
    });
  });

  it("blocks an unsatisfied manual bug submit, focuses the intent field, and never calls submitReport", async () => {
    const submitReport = vi.fn((): Promise<DesktopSubmitReportResult> =>
      Promise.resolve({ status: "delivered", reportId: "rpt_test" }),
    );
    useDesktopDialogStore.getState().openReportIssue();
    renderDesktopDialogHost(createRunnerHostWithSubmit([], submitReport), "/");
    await flushDialogEffects();

    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect(
      await screen.findByText(
        "Add a sentence, a screenshot, or pick where it happened - we need at least one to act on the report.",
      ),
    ).not.toBeNull();
    const intent = screen.getByRole("textbox", {
      name: "What were you trying to do, and what went wrong?",
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(intent);
    });
    expect(submitReport).not.toHaveBeenCalled();
  });

  it("shows the confirmation screen with a copyable report id after a satisfied manual submit", async () => {
    useDesktopDialogStore.getState().openReportIssue();
    renderDesktopDialogHost(
      createRunnerHostWithSubmit([], () =>
        Promise.resolve({ status: "delivered", reportId: "rpt_confirmed" }),
      ),
      "/",
    );
    await flushDialogEffects();

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "What were you trying to do, and what went wrong?",
      }),
      { target: { value: "Sending a message hangs forever" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect(
      await screen.findByRole("heading", { name: "Report sent" }),
    ).not.toBeNull();
    expect(screen.getByText(/rpt_confirmed/)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Also post publicly on GitHub" }),
    ).not.toBeNull();
  });

  it("keeps a failed submission's alert visible and preserves the typed intent", async () => {
    useDesktopDialogStore.getState().openReportIssue();
    renderDesktopDialogHost(
      createRunnerHostWithSubmit([], () =>
        Promise.reject(new Error("submit unavailable")),
      ),
      "/",
    );
    await flushDialogEffects();

    const intent = screen.getByRole("textbox", {
      name: "What were you trying to do, and what went wrong?",
    });
    fireEvent.change(intent, {
      target: { value: "Edited private-safe details" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Your report could not be sent. Nothing was lost - it is still here.",
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(alert);
    });
    expect(
      screen.getByDisplayValue("Edited private-safe details"),
    ).not.toBeNull();
    expect(useDesktopDialogStore.getState().activeDialog).toBe("report-issue");
    expect(
      screen.getByRole("button", { name: "Report on GitHub instead" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).not.toBeNull();
  });

  it("states the no-private-channel case up front, with no Send round-trip, when privateDeliveryAvailable is false", async () => {
    const openedLinks: string[] = [];
    const saveDiagnosticBundle = vi.fn(() =>
      Promise.resolve({ path: "/tmp/bundle.json" }),
    );
    useDesktopDialogStore.getState().openReportIssue();
    renderDesktopDialogHost(
      createRunnerHostWithoutPrivateDelivery(openedLinks, saveDiagnosticBundle),
      "/",
    );
    await flushDialogEffects();

    expect(
      screen.getByText(
        "Private reporting is not available in this build. You can save a diagnostic bundle and open a GitHub issue instead.",
      ),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // N1: the evidence gate guards every report-producing action, not just
    // Send - Case B's own primary actions need the same signal first.
    fireEvent.click(
      screen.getByRole("button", { name: "Save diagnostic bundle" }),
    );
    expect(
      await screen.findByText(
        "Add a sentence, a screenshot, or pick where it happened - we need at least one to act on the report.",
      ),
    ).not.toBeNull();
    expect(saveDiagnosticBundle).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Open a GitHub issue" }),
    );
    await flushDialogEffects();
    expect(openedLinks).toEqual([]);
    expect(
      screen.queryByRole("heading", { name: "Preview the public issue" }),
    ).toBeNull();

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "What were you trying to do, and what went wrong?",
      }),
      { target: { value: "No private channel, still worth reporting" } },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Save diagnostic bundle" }),
    );
    await waitFor(() => {
      expect(saveDiagnosticBundle).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Open a GitHub issue" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Preview the public issue" }),
      ).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Open GitHub draft" }));
    await waitFor(() => {
      expect(openedLinks).toHaveLength(1);
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

  describe("update-unsynced confirmation: Confirm re-checks before installing", () => {
    // The wiring half of `confirmAppUpdateInstall`'s contract: the dialog's
    // Confirm must route through the door (which re-runs the cross-window
    // check) and never call `installUpdate()` off the captured rows itself.
    // The unit suite proves the door's predicate; this proves the button
    // reaches it. The cross-window answer is stubbed at the seam the door
    // reads (`window.runnerHost.appLifecycle`).
    const IDLE: DesktopAppUpdateSnapshot = {
      sequence: 0,
      status: "idle",
      currentVersion: "1.0.0",
      allowPrerelease: false,
      latestVersion: null,
      downloadProgress: null,
      installBlockedReason: null,
      installGuidance: null,
      installInFlight: false,
      errorMessage: null,
      lastCheckedAt: null,
      lastCheckIntent: null,
    };

    class FakeAppUpdatesBridge implements DesktopAppUpdatesBridge {
      readonly installUpdate = vi.fn(() => Promise.resolve(IDLE));
      getSnapshot(): Promise<DesktopAppUpdateSnapshot> {
        return Promise.resolve(IDLE);
      }
      checkForUpdates(
        _intent: DesktopAppUpdateCheckIntent,
      ): Promise<DesktopAppUpdateSnapshot> {
        return Promise.resolve(IDLE);
      }
      setAllowPrerelease(_allow: boolean): Promise<DesktopAppUpdateSnapshot> {
        return Promise.resolve(IDLE);
      }
      downloadUpdate(): Promise<DesktopAppUpdateSnapshot> {
        return Promise.resolve(IDLE);
      }
      onChange(): { dispose(): void } {
        return { dispose: () => undefined };
      }
    }

    interface CrossWindowReport {
      readonly epics: ReadonlyArray<UnsyncedEditsEntry>;
      readonly otherWindowsUnknown: boolean;
    }
    interface WindowWithLifecycle {
      runnerHost?: {
        appLifecycle?: {
          unsyncableWorkAcrossWindows(): Promise<CrossWindowReport>;
        };
      };
    }
    function unsyncable(epicId: string, title: string): UnsyncedEditsEntry {
      return { epicId, title, queueSize: 1, isDirty: true, unsyncable: true };
    }
    function mainAnswers(report: CrossWindowReport): void {
      (window as WindowWithLifecycle).runnerHost = {
        appLifecycle: {
          unsyncableWorkAcrossWindows: () => Promise.resolve(report),
        },
      };
    }

    afterEach(() => {
      delete (window as WindowWithLifecycle).runnerHost;
    });

    it("re-asks with the fresh rows instead of installing when a new epic was retained since the dialog opened; installs on the second Confirm", async () => {
      const bridge = new FakeAppUpdatesBridge();
      const runnerHost = Object.assign(createRunnerHost([], [], []), {
        appUpdates: bridge,
      });
      useDesktopDialogStore.getState().openUpdateUnsyncedConfirm({
        epics: [unsyncable("e-a", "Alpha")],
        otherWindowsUnknown: false,
      });
      // Between open and Confirm, another window retained "Beta".
      mainAnswers({
        epics: [unsyncable("e-a", "Alpha"), unsyncable("e-b", "Beta")],
        otherWindowsUnknown: false,
      });
      renderDesktopDialogHost(runnerHost, "/");

      const dialog = await screen.findByTestId("confirm-destructive-dialog");
      expect(dialog.textContent).toContain("Alpha");
      expect(dialog.textContent).not.toContain("Beta");

      fireEvent.click(screen.getByTestId("confirm-action"));
      await flushDialogEffects();

      // OLD wiring: `installUpdate` fired here off the captured list.
      expect(bridge.installUpdate).not.toHaveBeenCalled();
      expect(useDesktopDialogStore.getState().activeDialog).toBe(
        "update-unsynced-confirm",
      );
      expect(
        useDesktopDialogStore
          .getState()
          .updateUnsyncedEpics.map((epic) => epic.epicId),
      ).toEqual(["e-a", "e-b"]);
      // The dialog now names what is new, and is no longer pending.
      const reasked = screen.getByTestId("confirm-destructive-dialog");
      expect(reasked.textContent).toContain("Beta");
      expect(
        screen.getByTestId("confirm-action").hasAttribute("disabled"),
      ).toBe(false);

      // Second Confirm against an unchanged set installs.
      fireEvent.click(screen.getByTestId("confirm-action"));
      await flushDialogEffects();
      expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
      expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    });

    it("installs straight away when the fresh check matches what was shown", async () => {
      const bridge = new FakeAppUpdatesBridge();
      const runnerHost = Object.assign(createRunnerHost([], [], []), {
        appUpdates: bridge,
      });
      useDesktopDialogStore.getState().openUpdateUnsyncedConfirm({
        epics: [unsyncable("e-a", "Alpha")],
        otherWindowsUnknown: false,
      });
      mainAnswers({
        epics: [unsyncable("e-a", "Alpha")],
        otherWindowsUnknown: false,
      });
      renderDesktopDialogHost(runnerHost, "/");
      await screen.findByTestId("confirm-destructive-dialog");

      fireEvent.click(screen.getByTestId("confirm-action"));
      await flushDialogEffects();

      expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
      expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    });
  });
});
