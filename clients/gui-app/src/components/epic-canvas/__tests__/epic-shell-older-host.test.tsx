/**
 * A task tab whose computer falls below the minimum host version, through the
 * real session controller, the real durable-stream opener (which refuses a row
 * below the floor) and the real `EpicShell`. Only the network boundary under
 * the opener, the canvas and the shell's own chrome are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { EpicShell } from "@/components/epic-canvas/epic-shell";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import { HostReadinessControllerContext } from "@/components/layout/host-readiness-controller-context";
import type {
  DefaultHostReadinessPresentation,
  HostReadinessController,
} from "@/components/layout/host-readiness-controller-context";
import { setMobileApp } from "@/lib/mobile-app";
import {
  noteHostDoorState,
  useHostDoorStateStore,
} from "@/stores/host/host-door-state-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TestEpicSessionTab } from "@/lib/registries/test-support/test-epic-session-tab";
import { setTestEpicSessionHostClientResolver } from "@/lib/registries/test-support/epic-session-controller-test-support";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __setEpicRuntimeWorkerFactoryForTests,
  getEpicRuntimeWorkerFactoryOverride,
} from "@/lib/registries/epic-runtime-worker-factory-slot";
import { createInProcessEpicRuntimeWorker } from "@/stores/epics/open-epic/test-support/in-process-epic-runtime-worker";
import type { RuntimeWorkerLike } from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";
import {
  clearSessionCreatedEpics,
  markEpicCreatedThisSession,
} from "@/lib/epics/session-created-epics";
import { resetFakeDurableStreamTransports } from "@/lib/host/test-support/fake-durable-stream-transport";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const EPIC_ID = "epic-older-host";
const TAB_ID = "epic-older-host-tab";
const WINDOW_HOST_ID = "window-host";
const TAB_HOST_ID = "tab-host";
const USER_ID = "user-older-host";
const RELAY_URL = "wss://relay.test/attach";

const seams = vi.hoisted(() => ({
  minimumHostVersion: "0.0.0",
  effectiveHostId: "window-host",
  rows: new Map<string, unknown>(),
  openAttempts: [] as string[],
  carriedHostIds: [] as string[],
  openedSettings: [] as unknown[],
}));

vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return {
      ...actual,
      get MINIMUM_HOST_VERSION(): string {
        return seams.minimumHostVersion;
      },
    };
  },
);

const hostClient = vi.hoisted(() => ({
  getActiveHostId: () => "host-test",
  getActiveHost: () => null,
  getRequestContextUserId: (): string | null => "user-older-host",
  getRequestContext: () => null,
  onChange: () => () => undefined,
  onBearerRotated: (_listener: () => void) => () => undefined,
  onCloudVerdictChanged: (_listener: () => void) => () => undefined,
  notifyHostAvailabilityRecovered: (_hostId: string, _kind: string) =>
    undefined,
  request: () => Promise.resolve({ tasks: [], hasMore: false }),
}));

const directory = vi.hoisted(() => ({
  findById: (hostId: string): unknown =>
    seams.rows.get(hostId) ?? {
      hostId,
      label: hostId,
      kind: "remote",
      websocketUrl: "wss://relay.test/attach",
      version: "1.0.0",
      transportDialability: "dialable",
      publicKey: "pubkey-default",
      owner: null,
      relayFuseGrace: false,
      sandbox: null,
      remoteStatus: {
        connectivity: "connectable",
        viewerReachability: "ok",
        clientCloud: "ok",
        updateState: "current",
        appVersion: null,
        lastSeenAt: null,
      },
    },
  onChange: (_listener: () => void) => ({ dispose: () => undefined }),
  // What the window's narration reads off the directory.
  hasConcludedDiscovery: () => true,
  getLocalHostId: (): string | null => null,
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => hostClient,
  useHostRuntimeClient: () => hostClient,
  useOptionalHostClient: () => hostClient,
  useHostBinding: () => ({ hostClient, directory }),
  useHostDirectory: () => directory,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" }),
  }),
}));

// One client per host, answering the row the case published: the controller
// reads the session host's floor off `getActiveHost()`.
const sessionHostClients = vi.hoisted(
  () => new Map<string, Record<string, unknown>>(),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null) return null;
    const known = sessionHostClients.get(hostId);
    if (known !== undefined) return known;
    const created = {
      request: vi.fn(),
      getActiveHost: () => seams.rows.get(hostId) ?? null,
      getActiveHostId: () => hostId,
      getRequestContextUserId: () => "user-older-host",
    };
    sessionHostClients.set(hostId, created);
    return created;
  },
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => seams.effectiveHostId,
}));

vi.mock("@/hooks/host/use-selection-authority-attached", () => ({
  useSelectionAuthorityAttached: () => true,
}));

// The real opener runs; what it is given below it is supplied here.
vi.mock("@/providers/use-runner-host", async () => {
  const { MockRunnerHost } =
    await import("@traycer-clients/shared/host-client/mock/mock-runner-host");
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: null,
  });
  return {
    useRunnerHost: () => runnerHost,
    useRunnerHostOrNull: () => runnerHost,
  };
});

vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    const { fakeDurableStreamTransports: fakes } =
      await import("@/lib/host/test-support/fake-durable-stream-transport");
    return {
      ...actual,
      createRemoteHostTransport: (options: { readonly hostId: string }) => ({
        session: { start: () => undefined },
        streamClient: fakes().opener(options.hostId).wsStreamClient,
      }),
    };
  },
);

// Counts every attempt to open a transport, whether the real opener refuses it
// or not: "no further attempt" is the claim of the ladder cases.
vi.mock("@/lib/host/use-durable-stream-transport", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/host/use-durable-stream-transport")
    >();
  const { useMemo } = await import("react");
  return {
    ...actual,
    useDurableStreamTransportFactory: () => {
      const real = actual.useDurableStreamTransportFactory();
      return useMemo(
        () => (hostId: string) => {
          seams.openAttempts.push(hostId);
          return real(hostId);
        },
        [real],
      );
    },
  };
});

// The jump behind "Update now", observed at the two seams it ends in.
vi.mock(
  "@/components/settings/host-scope/carry-viewed-host-into-settings",
  () => ({
    carryViewedHostIntoSettingsScope: (hostId: string) => {
      seams.carriedHostIds.push(hostId);
    },
  }),
);
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: (target: unknown) => {
      seams.openedSettings.push(target);
    },
  }),
}));

vi.mock("@/components/epic-canvas/chat-stream-prewarm", () => ({
  ChatStreamPrewarm: () => null,
}));
vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
    data: undefined,
    variables: undefined,
  }),
}));
vi.mock("@/components/epic-canvas/panels/epic-connection-pill", () => ({
  EpicConnectionPill: () => null,
}));
vi.mock("@/components/epic-canvas/panels/epic-connection-toasts", () => ({
  EpicConnectionToasts: () => null,
}));
vi.mock("@/components/epic-canvas/canvas/tile-canvas", () => ({
  TileCanvas: () => <div data-testid="tile-canvas-stub" />,
}));
vi.mock("@/providers/resources-stream-mount", () => ({
  EpicResourcesFallbackMount: () => null,
}));

function remoteRow(
  hostId: string,
  appVersion: string,
): RemoteHostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "remote",
    websocketUrl: RELAY_URL,
    version: "1.0.0",
    transportDialability: "dialable",
    publicKey: "pubkey-tab",
    owner: null,
    relayFuseGrace: false,
    sandbox: null,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion,
      lastSeenAt: null,
    },
  };
}

let previousWorkerFactory: (() => RuntimeWorkerLike) | null = null;
const emitRowChanged = vi.hoisted(() => ({ run: () => undefined }));

/** Streams the session's worker opened, and how many it closed. */
function installStreams(): { readonly opened: () => number } {
  let opened = 0;
  previousWorkerFactory = getEpicRuntimeWorkerFactoryOverride();
  __setEpicRuntimeWorkerFactoryForTests(() =>
    createInProcessEpicRuntimeWorker({
      streamClientFactory: () => {
        opened += 1;
        return {
          applyUpdate: () => undefined,
          awareness: () => undefined,
          applyArtifactRoomUpdate: () => undefined,
          artifactRoomAwareness: () => undefined,
          retryMigration: () => undefined,
          close: () => undefined,
        };
      },
      laneSelection: null,
    }).createWorker(),
  );
  return { opened: () => opened };
}

function publishTabRow(appVersion: string): void {
  seams.rows.set(TAB_HOST_ID, remoteRow(TAB_HOST_ID, appVersion));
  act(() => {
    emitRowChanged.run();
  });
}

function installRows(): void {
  const listeners = new Set<() => void>();
  installHostConnectionRegistrySource({
    directory: {
      findById: (hostId) => (directory.findById(hostId) ?? null) as never,
      onDirectoryChanged: (listener) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    },
    leases: null,
  });
  emitRowChanged.run = () => {
    for (const listener of [...listeners]) listener();
  };
}

const EMPTY_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  ensureFailure: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

const READY_CONTROLLER: HostReadinessController = {
  readinessFor: () => ({ kind: "ready" }),
  defaultHostPresentation: EMPTY_PRESENTATION,
  hasBeenDefaultHostReady: true,
};

/** The tab on the window's own computer, with the window's cover mounted. */
function renderTabOnTheWindowsComputer(): void {
  seams.effectiveHostId = TAB_HOST_ID;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // The window is attached to this computer, which no lease serves.
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: null,
      targetHostId: TAB_HOST_ID,
      effectiveHostId: TAB_HOST_ID,
      leases: [],
      selectionRevision: 1,
    });
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <HostReadinessControllerContext.Provider value={READY_CONTROLLER}>
          <TestEpicSessionTab epicId={EPIC_ID} tabId={TAB_ID}>
            <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
          </TestEpicSessionTab>
          <WindowHostModalHost bypassed={false} />
        </HostReadinessControllerContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderTabOnAnotherComputer(): void {
  // The tab's own computer, not the window's: the create-host seed names it.
  markEpicCreatedThisSession(EPIC_ID, TAB_HOST_ID);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TestEpicSessionTab epicId={EPIC_ID} tabId={TAB_ID}>
          <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
        </TestEpicSessionTab>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function waitForTaskShown(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("tile-canvas-stub")).toBeTruthy();
  });
}

describe("a task tab whose computer falls below the minimum host version", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    seams.minimumHostVersion = "2.0.0";
    seams.rows.clear();
    seams.openAttempts.length = 0;
    seams.carriedHostIds.length = 0;
    seams.openedSettings.length = 0;
    sessionHostClients.clear();
    resetHostConnectionRegistryForTest();
    resetFakeDurableStreamTransports();
    clearSessionCreatedEpics();
    __getOpenEpicRegistryForTests().disposeAll();
    useAuthStore.setState({
      status: "signed-in",
      profile: { userId: USER_ID, userName: USER_ID, email: USER_ID },
      contextMetadata: { userId: USER_ID, username: USER_ID },
    });
    setTestEpicSessionHostClientResolver((hostId) => {
      const resolved = sessionHostClients.get(hostId) ?? null;
      if (resolved !== null) return resolved as never;
      return null;
    });
    installRows();
    // Rows the controller resolves a client for before the hook ran.
    for (const hostId of [WINDOW_HOST_ID, TAB_HOST_ID]) {
      sessionHostClients.set(hostId, {
        request: vi.fn(),
        getActiveHost: () => seams.rows.get(hostId) ?? null,
        getActiveHostId: () => hostId,
        getRequestContextUserId: () => USER_ID,
      });
    }
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicRuntimeWorkerFactoryForTests(previousWorkerFactory);
    clearSessionCreatedEpics();
    seams.minimumHostVersion = "0.0.0";
    vi.useRealTimers();
    useSelectionAuthorityStore.getState().reset();
    useHostDoorStateStore.setState({ byHost: new Map() });
    seams.effectiveHostId = WINDOW_HOST_ID;
    setMobileApp(false);
  });

  it("shows Host update needed with one Update now and no Retry", async () => {
    installStreams();
    publishTabRow("2.0.0");
    renderTabOnAnotherComputer();
    await waitForTaskShown();

    publishTabRow("1.5.4");

    const card = await screen.findByTestId("epic-repoint-failure");
    expect(within(card).getByText("Host update needed")).toBeTruthy();
    // The card's one action is Update now; "Open on original host" is the
    // re-point's own way back, present because this tab has an original host.
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Update now", "Open on original host"]);
    expect(within(card).queryByText(/Retry/)).toBeNull();
    expect(screen.queryByText(/Couldn't load this task/)).toBeNull();
    expect(screen.queryByTestId("tile-canvas-stub")).toBeNull();
  });

  it("starts no further rebuild while the row stays below the floor, past fifteen minutes", async () => {
    installStreams();
    publishTabRow("2.0.0");
    renderTabOnAnotherComputer();
    await waitForTaskShown();
    expect(seams.openAttempts).toEqual([TAB_HOST_ID]);
    publishTabRow("1.5.4");
    await screen.findByTestId("epic-repoint-failure");
    const attemptsAtFailure = [...seams.openAttempts];

    // The ladder's first rung would fall due after a minute; the card is still
    // the answer then, and no transport was opened for it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(seams.openAttempts).toEqual(attemptsAtFailure);
    expect(screen.getByTestId("epic-repoint-failure")).toBeTruthy();

    // No later rung opens one either, up to and past the ladder's longest wait.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16 * 60_000);
    });
    expect(seams.openAttempts).toEqual(attemptsAtFailure);
  });

  it("acquires once and shows the task again when the row rises back to the floor", async () => {
    const streams = installStreams();
    publishTabRow("2.0.0");
    renderTabOnAnotherComputer();
    await waitForTaskShown();
    publishTabRow("1.5.4");
    await screen.findByTestId("epic-repoint-failure");
    const attemptsBefore = seams.openAttempts.length;
    const streamsBefore = streams.opened();

    publishTabRow("2.0.0");

    await waitForTaskShown();
    expect(screen.queryByTestId("epic-repoint-failure")).toBeNull();
    expect(seams.openAttempts).toHaveLength(attemptsBefore + 1);
    expect(streams.opened()).toBe(streamsBefore + 1);
  });

  it("opens Settings, Host, Updates for the tab's computer from Update now", async () => {
    installStreams();
    publishTabRow("2.0.0");
    renderTabOnAnotherComputer();
    await waitForTaskShown();
    publishTabRow("1.5.4");
    const card = await screen.findByTestId("epic-repoint-failure");

    fireEvent.click(within(card).getByRole("button", { name: "Update now" }));

    expect(seams.carriedHostIds).toEqual([TAB_HOST_ID]);
    expect(seams.openedSettings).toEqual([
      {
        section: "host",
        resetToGeneral: false,
        tab: "updates",
        draft: null,
        hostId: null,
      },
    ]);
  });
  describe.each([
    {
      form: "the desktop's modal",
      mobile: false,
      cover: "window-host-modal",
    },
    {
      form: "the phone's startup card",
      mobile: true,
      cover: "window-host-startup-card",
    },
  ])("when the tab's computer is the window's own, on $form", (testCase) => {
    it("narrates in the window's cover and draws no task card", async () => {
      setMobileApp(testCase.mobile);
      installStreams();
      publishTabRow("2.0.0");
      renderTabOnTheWindowsComputer();
      await waitForTaskShown();

      act(() => {
        noteHostDoorState({
          hostId: TAB_HOST_ID,
          kind: "older-host",
          detail: null,
        });
      });
      publishTabRow("1.5.4");

      const cover = await screen.findByTestId(testCase.cover);
      expect(within(cover).getByText("Host update needed")).toBeTruthy();
      await waitFor(() => {
        expect(screen.queryByTestId("tile-canvas-stub")).toBeNull();
      });
      expect(screen.queryByTestId("epic-repoint-failure")).toBeNull();
      // An empty body, not the loading skeleton.
      expect(screen.queryByTestId("tile-canvas-loading")).toBeNull();
    });
  });
});
