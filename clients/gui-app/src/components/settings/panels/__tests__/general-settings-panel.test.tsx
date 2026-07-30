import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { GeneralSettingsPanel } from "@/components/settings/panels/general-settings-panel";
import { modLabel } from "@/lib/keybindings/platform";
import { clearAllPersistedStores } from "@/lib/persist";
import {
  useMigrationRunStore,
  type MigrationRunState,
} from "@/stores/migration/migration-run-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  localSnapshotClearScopeKey,
  useLocalSnapshotClearStore,
} from "@/stores/settings/local-snapshot-clear-store";

interface CapturedHostQueryArgs {
  readonly method: string;
  readonly client: TestHostClient | null;
}

interface ClearLocalSnapshotsContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

interface CapturedClearLocalSnapshotsOptions {
  readonly onMutate: () => ClearLocalSnapshotsContext;
  readonly onSuccess: (
    result: { readonly clearedBytes: number },
    variables: Record<string, never>,
    context: ClearLocalSnapshotsContext,
  ) => void;
}

interface CapturedHostMutationArgs {
  readonly method: string;
  readonly client: TestHostClient | null;
  readonly options: CapturedClearLocalSnapshotsOptions;
}

interface HostQueryMocks {
  queryResult: {
    data: { readonly bytes: number } | undefined;
    isPending: boolean;
    isError: boolean;
  };
  mutationResult: {
    mutate: Mock<(params: Record<string, never>) => void>;
    isPending: boolean;
  };
  capturedQueryArgs: CapturedHostQueryArgs | null;
  capturedMutationArgs: CapturedHostMutationArgs | null;
  getActiveHostId: Mock<() => string | null>;
  activeHostId: string;
  lastTransientTarget: { readonly hostId: string } | null;
  directoryEntries: ReadonlyArray<{
    readonly hostId: string;
    readonly label: string;
    readonly status: string;
    readonly websocketUrl: string;
  }>;
}

interface TestHostClient {
  readonly getActiveHostId: () => string | null;
}

const INITIAL_COUNTS = {
  taskChainsComplete: 0,
  taskChainsSkipped: 0,
  taskChainsFailed: 0,
  epicsComplete: 0,
  epicsFailed: 0,
  replaysIncomplete: 0,
};

const idleState: MigrationRunState = {
  status: "idle",
  totals: null,
  counts: INITIAL_COUNTS,
  finalSuccess: null,
  remoteRunning: false,
};

const runningState: MigrationRunState = {
  status: "running",
  totals: { totalTaskChains: 7, totalLocalEpics: 3 },
  counts: { ...INITIAL_COUNTS, taskChainsComplete: 2 },
  finalSuccess: null,
  remoteRunning: false,
};

const migrationStart = vi.hoisted(() => ({ fn: vi.fn() }));
const navigateMock = vi.hoisted(() => vi.fn());

interface TestPerWindowSnapshot {
  readonly epicTabs: readonly unknown[];
  readonly activeTabId: string | null;
  readonly canvasByTabId: Readonly<Record<string, unknown>>;
  readonly landingDrafts: readonly unknown[];
  readonly activeLandingDraftId: string | null;
}

interface TestWindowsBridge {
  readonly perWindowState: {
    clear?: () => Promise<void>;
    get?: () => Promise<TestPerWindowSnapshot>;
    update?: (patch: Record<string, unknown>) => Promise<void>;
  };
}

const windowsBridgeMock = vi.hoisted(
  (): { current: TestWindowsBridge | null } => ({ current: null }),
);

interface TestRunnerHost {
  hostManagement: { uninstallTraycer: Mock } | null;
}

interface TestFeatureSettingsBridge {
  readonly get: Mock<() => Promise<{ readonly agentRoles: boolean }>>;
  readonly setAgentRolesEnabled: Mock<
    (enabled: boolean) => Promise<{ readonly agentRoles: boolean }>
  >;
}

const runnerHostMock = vi.hoisted((): { current: TestRunnerHost } => ({
  current: { hostManagement: null },
}));

const hostQueryMocks = vi.hoisted((): HostQueryMocks => ({
  queryResult: {
    data: { bytes: 432 * 1024 * 1024 },
    isPending: false,
    isError: false,
  },
  mutationResult: {
    mutate: vi.fn(),
    isPending: false,
  },
  capturedQueryArgs: null,
  capturedMutationArgs: null,
  getActiveHostId: vi.fn(() => "host-test"),
  activeHostId: "host-test",
  lastTransientTarget: null,
  directoryEntries: [
    {
      hostId: "host-test",
      label: "Local host",
      status: "available",
      websocketUrl: "ws://local.invalid",
    },
    {
      hostId: "remote-host",
      label: "Remote host",
      status: "available",
      websocketUrl: "ws://remote.invalid",
    },
  ],
}));

vi.mock("@/components/migration/migration-run-handle", () => ({
  startMigrationRun: () => {
    migrationStart.fn();
  },
  isMigrationRunStartReady: () => true,
  setMigrationStartHandle: () => undefined,
  getMigrationStartHandle: () => null,
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: hostQueryMocks.getActiveHostId,
  }),
  useHostBinding: () => null,
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => hostQueryMocks.activeHostId,
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: hostQueryMocks.directoryEntries }),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (target: { readonly hostId: string } | null) => {
    hostQueryMocks.lastTransientTarget = target;
    if (target === null) return null;
    return {
      getActiveHostId: () => target.hostId,
    };
  },
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: CapturedHostQueryArgs) => {
    hostQueryMocks.capturedQueryArgs = args;
    return hostQueryMocks.queryResult;
  },
  useHostMutation: (args: CapturedHostMutationArgs) => {
    hostQueryMocks.capturedMutationArgs = args;
    return hostQueryMocks.mutationResult;
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/persist")>();
  return {
    ...actual,
    clearAllPersistedStores: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("@/providers/windows-bridge-context", () => ({
  useWindowsBridge: () => windowsBridgeMock.current,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHostMock.current,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const clearAllPersistedStoresMock = vi.mocked(clearAllPersistedStores);

function makeBridgeWithClear(): TestWindowsBridge {
  return {
    perWindowState: { clear: vi.fn(() => Promise.resolve()) },
  };
}

function makeBridgeWithoutClear(snapshot: TestPerWindowSnapshot): {
  bridge: TestWindowsBridge;
  get: Mock<() => Promise<TestPerWindowSnapshot>>;
  update: Mock<(patch: Record<string, unknown>) => Promise<void>>;
} {
  const get = vi.fn(() => Promise.resolve(snapshot));
  const update = vi.fn(() => Promise.resolve());
  return { bridge: { perWindowState: { get, update } }, get, update };
}

describe("GeneralSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMigrationRunStore.setState(idleState);
    hostQueryMocks.queryResult = {
      data: { bytes: 432 * 1024 * 1024 },
      isPending: false,
      isError: false,
    };
    hostQueryMocks.mutationResult.isPending = false;
    hostQueryMocks.capturedQueryArgs = null;
    hostQueryMocks.capturedMutationArgs = null;
    hostQueryMocks.activeHostId = "host-test";
    hostQueryMocks.lastTransientTarget = null;
    hostQueryMocks.getActiveHostId.mockReturnValue("host-test");
    hostQueryMocks.directoryEntries = [
      {
        hostId: "host-test",
        label: "Local host",
        status: "available",
        websocketUrl: "ws://local.invalid",
      },
      {
        hostId: "remote-host",
        label: "Remote host",
        status: "available",
        websocketUrl: "ws://remote.invalid",
      },
    ];
    navigateMock.mockReset();
    windowsBridgeMock.current = null;
    runnerHostMock.current = { hostManagement: null };
    clearAllPersistedStoresMock.mockClear();
    clearAllPersistedStoresMock.mockResolvedValue(undefined);
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "owner-test",
        userName: "Owner Test",
        email: "owner@example.com",
      },
      contextMetadata: {
        userId: "owner-test",
        username: "owner",
      },
    });
    useLocalSnapshotClearStore.setState({ clearedAtByScope: {} });
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    useSettingsStore.setState({
      showGlobalResourceMonitor: true,
      showNavigatorResourceStats: false,
      pinContextUsageBreakdown: false,
      quoteReplyEnabled: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAuthStore.getState().setSignedOut();
    useLocalSnapshotClearStore.setState({ clearedAtByScope: {} });
    useOnboardingStore.setState({ completedAt: null, step: 0 });
    delete (globalThis as { runnerHost?: unknown }).runnerHost;
  });

  it("hydrates and updates Agent roles under Experimental", async () => {
    let agentRoles = false;
    const bridge: TestFeatureSettingsBridge = {
      get: vi.fn(() => Promise.resolve({ agentRoles })),
      setAgentRolesEnabled: vi.fn((enabled) => {
        agentRoles = enabled;
        return Promise.resolve({ agentRoles });
      }),
    };
    (globalThis as { runnerHost?: unknown }).runnerHost = {
      platform: { featureSettings: bridge },
    };

    renderPanel();

    expect(screen.getByText("Experimental")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Agent roles" });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(bridge.setAgentRolesEnabled).toHaveBeenCalledWith(true),
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    await waitFor(() => expect(bridge.get).toHaveBeenCalledTimes(2));
  });

  it("surfaces feature-settings read failures and keeps Agent roles disabled", async () => {
    const bridge: TestFeatureSettingsBridge = {
      get: vi.fn(() => Promise.reject(new Error("invalid config"))),
      setAgentRolesEnabled: vi.fn((enabled) =>
        Promise.resolve({ agentRoles: enabled }),
      ),
    };
    (globalThis as { runnerHost?: unknown }).runnerHost = {
      platform: { featureSettings: bridge },
    };

    renderPanel();

    expect(
      await screen.findByText(/Couldn't read feature settings/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Agent roles" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(bridge.setAgentRolesEnabled).not.toHaveBeenCalled();
  });

  it("preserves the Agent roles value when the settings write fails", async () => {
    const bridge: TestFeatureSettingsBridge = {
      get: vi.fn(() => Promise.resolve({ agentRoles: false })),
      setAgentRolesEnabled: vi.fn(() =>
        Promise.reject(new Error("write failed")),
      ),
    };
    (globalThis as { runnerHost?: unknown }).runnerHost = {
      platform: { featureSettings: bridge },
    };

    renderPanel();

    const toggle = screen.getByRole("switch", { name: "Agent roles" });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(bridge.setAgentRolesEnabled).toHaveBeenCalledWith(true),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders the Data migration row and starts the stream on click", () => {
    renderPanel();

    expect(screen.getByText("Data migration")).toBeTruthy();
    const button = screen.getByRole("button", {
      name: "Re-attempt migration",
    });

    fireEvent.click(button);

    expect(migrationStart.fn).toHaveBeenCalledTimes(1);
  });

  it("renders the pinned context usage breakdown row and toggles the setting", () => {
    renderPanel();

    expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(false);
    const toggle = screen.getByRole("switch", {
      name: "Pin context usage breakdown",
    });

    fireEvent.click(toggle);

    expect(useSettingsStore.getState().pinContextUsageBreakdown).toBe(true);
  });

  it("renders resource display rows and toggles their settings", () => {
    renderPanel();

    const globalToggle = screen.getByRole("switch", {
      name: "Show global resources button",
    });
    const navigatorToggle = screen.getByRole("switch", {
      name: "Show navigator resource stats",
    });

    expect(useSettingsStore.getState().showGlobalResourceMonitor).toBe(true);
    expect(useSettingsStore.getState().showNavigatorResourceStats).toBe(false);

    fireEvent.click(globalToggle);
    fireEvent.click(navigatorToggle);

    expect(useSettingsStore.getState().showGlobalResourceMonitor).toBe(false);
    expect(useSettingsStore.getState().showNavigatorResourceStats).toBe(true);
  });

  it("renders the quote reply row and toggles the setting", () => {
    renderPanel();

    expect(useSettingsStore.getState().quoteReplyEnabled).toBe(true);
    const toggle = screen.getByRole("switch", {
      name: "Quote reply on text selection",
    });

    fireEvent.click(toggle);

    expect(useSettingsStore.getState().quoteReplyEnabled).toBe(false);
  });

  it("labels the steering chord with the platform modifier", () => {
    renderPanel();

    const chord = `${modLabel()}+Enter`;
    expect(
      screen.getByRole("switch", { name: `Steer with ${chord}` }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `While a turn is running on a supported harness, ${chord} sends the composer text as a same-turn steering message that jumps the queue. Plain Enter keeps queueing.`,
      ),
    ).toBeTruthy();
  });

  it("navigates to replay onboarding without clearing first-run completion", () => {
    useOnboardingStore.setState({ completedAt: 123, step: 4 });

    renderPanel();

    fireEvent.click(screen.getByTestId("settings-replay-onboarding"));

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/onboarding",
      search: { replay: true },
    });
    expect(useOnboardingStore.getState().completedAt).toBe(123);
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("disables the button and renders inline progress while running", () => {
    useMigrationRunStore.setState(runningState);

    renderPanel();

    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Re-attempt migration",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByTestId("settings-reattempt-migration-spinner"),
    ).toBeTruthy();
    expect(
      screen.getByText("Migrating tasks - tasks 2/7, epics 0/3"),
    ).toBeTruthy();
  });

  it("renders file edit snapshot storage size from the host query", () => {
    renderPanel();

    expect(screen.getByText("File Edit Snapshots")).toBeTruthy();
    expect(
      screen.getByTestId("settings-local-snapshots-size").textContent,
    ).toBe("432 MB");
    expect(hostQueryMocks.capturedQueryArgs?.method).toBe(
      "snapshots.getLocalStorageSize",
    );
  });

  it("opens confirmation and clears file edit snapshots through the mutation", () => {
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear file edit snapshots" }),
    );

    expect(
      screen.getByText("Clear file edit snapshots for Local host?"),
    ).toBeTruthy();
    fireEvent.click(getDialogButton("Clear file edit snapshots"));

    expect(hostQueryMocks.mutationResult.mutate).toHaveBeenCalledWith({});
    expect(hostQueryMocks.capturedMutationArgs?.method).toBe(
      "snapshots.clearLocalSnapshots",
    );
  });

  it("switches file edit snapshots to a panel-local host without changing the active host", async () => {
    const queryClient = renderPanel();
    expect(queryClient).toBeTruthy();
    expect(
      screen
        .getByTestId("active-host-probe")
        .getAttribute("data-bound-host-id"),
    ).toBe("host-test");

    fireEvent.click(
      screen.getByRole("combobox", { name: "File edit snapshots host" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Remote host" }));

    await waitFor(() => {
      expect(hostQueryMocks.lastTransientTarget?.hostId).toBe("remote-host");
      expect(hostQueryMocks.capturedQueryArgs?.client?.getActiveHostId()).toBe(
        "remote-host",
      );
    });
    expect(
      screen
        .getByTestId("active-host-probe")
        .getAttribute("data-bound-host-id"),
    ).toBe("host-test");
    expect(
      screen.getByText(
        "Pre-edit file snapshots for Undo and cached long plan content on Remote host. This data stays local and is not synced.",
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear file edit snapshots" }),
    );

    expect(
      screen.getByText("Clear file edit snapshots for Remote host?"),
    ).toBeTruthy();
    const captured = hostQueryMocks.capturedMutationArgs;
    if (captured === null) {
      throw new Error("expected snapshots mutation");
    }
    expect(captured.options.onMutate()).toEqual({
      hostId: "remote-host",
      userId: "owner-test",
    });
  });

  it("disables clearing and shows an unavailable notice when the picked host vanishes from the directory", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <GeneralSettingsPanel />
      </QueryClientProvider>,
    );

    fireEvent.click(
      screen.getByRole("combobox", { name: "File edit snapshots host" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Remote host" }));

    await waitFor(() => {
      expect(hostQueryMocks.lastTransientTarget?.hostId).toBe("remote-host");
    });

    // The picked host is deregistered - it drops out of the directory
    // entirely (not merely marked "unavailable" while still listed).
    hostQueryMocks.directoryEntries = [hostQueryMocks.directoryEntries[0]];
    rerender(
      <QueryClientProvider client={queryClient}>
        <GeneralSettingsPanel />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      // The label can no longer be resolved once the entry drops out of the
      // directory - `settingsHostLabelFor` falls back to the raw hostId.
      expect(
        screen.getByTestId("settings-file-edit-snapshots-host-unavailable")
          .textContent,
      ).toBe(
        "remote-host is no longer available - pick a different host above.",
      );
    });
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Clear file edit snapshots",
      }).disabled,
    ).toBe(true);
    // Must not silently fall back to reading/writing through the active host.
    expect(hostQueryMocks.capturedQueryArgs?.client).toBeNull();
  });

  it("invalidates size and shows a toast after clearing file edit snapshots", () => {
    const queryClient = renderPanel();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const now = vi.spyOn(Date, "now").mockReturnValue(9000);
    const captured = hostQueryMocks.capturedMutationArgs;
    if (captured === null) {
      throw new Error("expected snapshots mutation");
    }

    const context = captured.options.onMutate();
    captured.options.onSuccess({ clearedBytes: 1024 }, {}, context);

    expect(context).toEqual({
      hostId: "host-test",
      userId: "owner-test",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["host", "host-test", "snapshots.getLocalStorageSize", {}],
    });
    expect(toast.success).toHaveBeenCalledWith("Cleared file edit snapshots", {
      description: "1 KB removed.",
    });
    expect(
      useLocalSnapshotClearStore.getState().clearedAtByScope[
        localSnapshotClearScopeKey("owner-test", "host-test")
      ],
    ).toBe(9000);
    now.mockRestore();
  });

  it("renders the local app state action distinct from snapshots", () => {
    renderPanel();

    const button = screen.getByRole("button", {
      name: "Clear local app state",
    });
    expect(button).toBeTruthy();
    // Distinct control from the host-side snapshot clear.
    expect(
      screen.getByRole("button", { name: "Clear file edit snapshots" }),
    ).not.toBe(button);
  });

  it("opens the confirm dialog when clicking Clear local app state", () => {
    renderPanel();

    expect(clearAllPersistedStoresMock).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Clear local app state" }),
    );

    expect(screen.getByText("Clear local app state?")).toBeTruthy();
    // Opening the dialog must not trigger the wipe.
    expect(clearAllPersistedStoresMock).not.toHaveBeenCalled();
  });

  it("does nothing when the confirm dialog is cancelled", () => {
    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear local app state" }),
    );
    fireEvent.click(getDialogButton("Cancel"));

    expect(clearAllPersistedStoresMock).not.toHaveBeenCalled();
  });

  it("calls clearAllPersistedStores with a hostClear function when the bridge exposes clear", async () => {
    const bridge = makeBridgeWithClear();
    windowsBridgeMock.current = bridge;

    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear local app state" }),
    );
    fireEvent.click(getDialogButton("Clear local app state"));

    await waitFor(() => {
      expect(clearAllPersistedStoresMock).toHaveBeenCalledTimes(1);
    });
    const arg = clearAllPersistedStoresMock.mock.calls[0]?.[0];
    const hostClear = arg.hostClear;
    expect(typeof hostClear).toBe("function");

    if (hostClear !== null) {
      void hostClear();
    }
    expect(bridge.perWindowState.clear).toHaveBeenCalledTimes(1);
  });

  it("clears desktop per-window state via get + update when the bridge lacks clear", async () => {
    const { bridge, get, update } = makeBridgeWithoutClear({
      epicTabs: [{ id: "tab-1" }],
      activeTabId: "tab-1",
      canvasByTabId: { "tab-1": { foo: 1 }, "tab-2": { bar: 2 } },
      landingDrafts: [{ id: "draft-1" }],
      activeLandingDraftId: "draft-1",
    });
    windowsBridgeMock.current = bridge;

    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear local app state" }),
    );
    fireEvent.click(getDialogButton("Clear local app state"));

    await waitFor(() => {
      expect(clearAllPersistedStoresMock).toHaveBeenCalledTimes(1);
    });
    // The fallback resolves a host clear function (NOT null) that degrades
    // through get + update instead of leaving host state intact.
    const hostClear = clearAllPersistedStoresMock.mock.calls[0]?.[0].hostClear;
    expect(typeof hostClear).toBe("function");

    if (hostClear !== null) {
      await hostClear();
    }
    expect(get).toHaveBeenCalledTimes(1);
    // Deletes every existing canvas key by sending `null`, and resets the rest.
    expect(update).toHaveBeenCalledWith({
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: { "tab-1": null, "tab-2": null },
      landingDrafts: [],
      activeLandingDraftId: null,
    });
  });

  it("calls clearAllPersistedStores with hostClear null in web mode (no bridge)", async () => {
    windowsBridgeMock.current = null;

    renderPanel();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear local app state" }),
    );
    fireEvent.click(getDialogButton("Clear local app state"));

    await waitFor(() => {
      expect(clearAllPersistedStoresMock).toHaveBeenCalledTimes(1);
    });
    expect(clearAllPersistedStoresMock.mock.calls[0]?.[0]).toEqual({
      hostClear: null,
    });
  });

  it("keeps local destructive actions visible when host management is unavailable", () => {
    runnerHostMock.current = { hostManagement: null };
    renderPanel();
    expect(screen.getByTestId("settings-danger-zone")).toBeTruthy();
    expect(screen.getByText("File Edit Snapshots")).toBeTruthy();
    expect(screen.getByText("Local app state")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Traycer" })).toBeNull();
  });

  it("removes Traycer from the Danger Zone after confirmation", async () => {
    const uninstallTraycer = vi.fn(() =>
      Promise.resolve({
        removedHost: true,
        deregisteredService: true,
        removedLoginItem: true,
      }),
    );
    runnerHostMock.current = { hostManagement: { uninstallTraycer } };
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Remove Traycer" }));
    fireEvent.click(getDialogButton("Remove Traycer"));

    await waitFor(() => {
      expect(uninstallTraycer).toHaveBeenCalledTimes(1);
    });
    // The remove row switches to the success/quit state.
    await screen.findByText("Traycer removed");
    expect(screen.getByRole("button", { name: "Quit Traycer" })).toBeTruthy();
  });

  it("renders the four named section headers in order", () => {
    renderPanel();

    const chat = screen.getByText("Chat & composer");
    const running = screen.getByText("Running agents");
    const setup = screen.getByText("Setup & migration");
    const danger = screen.getByText("Danger Zone");

    expect(documentPosition(chat, running)).toBe("before");
    expect(documentPosition(running, setup)).toBe("before");
    expect(documentPosition(setup, danger)).toBe("before");
  });

  it("renders named sections as h2 headings outside separate bordered cards", () => {
    renderPanel();

    // SettingsGroup renders real <h2> labels, not row-shaped bands inside a
    // single shared card. Each group is its own <section>; the h2 and the
    // bordered rows-container are siblings.
    const sectionTitles = [
      "Chat & composer",
      "Running agents",
      "Setup & migration",
      "Danger Zone",
    ] as const;

    const headings = sectionTitles.map((title) =>
      screen.getByRole("heading", { level: 2, name: title }),
    );

    for (const heading of headings) {
      const section = heading.closest("section");
      expect(section).not.toBeNull();
      // Heading sits outside the bordered card (sibling of the card div).
      expect(heading.closest("div.rounded-lg")).toBeNull();
      expect(section?.contains(heading)).toBe(true);
    }

    // Representative rows live inside each section's card, not the heading.
    const voice = screen.getByText("Voice input");
    const preventSleep = screen.getByText("Prevent sleep while running");
    const productTour = screen.getByText("Product tour");
    const snapshots = screen.getByText("File Edit Snapshots");

    const chatHeading = headings[0];
    const runningHeading = headings[1];
    const setupHeading = headings[2];
    const dangerHeading = headings[3];

    // Heading and its rows do NOT share the closest bordered card.
    expect(chatHeading.closest("div.rounded-lg")).toBeNull();
    expect(voice.closest("div.rounded-lg")).not.toBeNull();
    expect(voice.closest("div.rounded-lg")).not.toBe(
      chatHeading.closest("div.rounded-lg"),
    );

    // Two rows in the same group DO share the bordered card.
    const quote = screen.getByText("Quote reply on text selection");
    expect(voice.closest("div.rounded-lg")).toBe(
      quote.closest("div.rounded-lg"),
    );

    // Rows from different groups do NOT share a card.
    expect(voice.closest("div.rounded-lg")).not.toBe(
      preventSleep.closest("div.rounded-lg"),
    );
    expect(preventSleep.closest("div.rounded-lg")).not.toBe(
      productTour.closest("div.rounded-lg"),
    );
    expect(productTour.closest("div.rounded-lg")).not.toBe(
      snapshots.closest("div.rounded-lg"),
    );

    // Each heading's section owns its representative row.
    expect(chatHeading.closest("section")).toBe(voice.closest("section"));
    expect(runningHeading.closest("section")).toBe(
      preventSleep.closest("section"),
    );
    expect(setupHeading.closest("section")).toBe(
      productTour.closest("section"),
    );
    expect(dangerHeading.closest("section")).toBe(snapshots.closest("section"));
    // Distinct sections per group.
    expect(chatHeading.closest("section")).not.toBe(
      runningHeading.closest("section"),
    );
  });

  it("places representative rows under the correct section headers", () => {
    renderPanel();

    const chat = screen.getByText("Chat & composer");
    const running = screen.getByText("Running agents");
    const setup = screen.getByText("Setup & migration");
    const danger = screen.getByText("Danger Zone");

    const voice = screen.getByText("Voice input");
    const quote = screen.getByText("Quote reply on text selection");
    const pin = screen.getByText("Pin context usage breakdown");
    const preventSleep = screen.getByText("Prevent sleep while running");
    const globalResources = screen.getByText("Show global resources button");
    const productTour = screen.getByText("Product tour");
    const dataMigration = screen.getByText("Data migration");
    const snapshots = screen.getByText("File Edit Snapshots");

    // Chat & composer rows sit between that header and Running agents.
    expect(documentPosition(chat, voice)).toBe("before");
    expect(documentPosition(voice, quote)).toBe("before");
    expect(documentPosition(quote, pin)).toBe("before");
    expect(documentPosition(pin, running)).toBe("before");

    // Running agents rows sit between that header and Setup & migration.
    expect(documentPosition(running, preventSleep)).toBe("before");
    expect(documentPosition(preventSleep, globalResources)).toBe("before");
    expect(documentPosition(globalResources, setup)).toBe("before");
    // Prevent sleep is not still in Chat & composer.
    expect(documentPosition(chat, preventSleep)).toBe("before");
    expect(documentPosition(preventSleep, running)).not.toBe("before");

    // Setup & migration: Product tour before Data migration.
    expect(documentPosition(setup, productTour)).toBe("before");
    expect(documentPosition(productTour, dataMigration)).toBe("before");
    expect(documentPosition(dataMigration, danger)).toBe("before");

    // Danger Zone content after its header.
    expect(documentPosition(danger, snapshots)).toBe("before");
  });

  it("does not render the Worktree branch prefix row (moved to Worktrees)", () => {
    renderPanel();

    // Current accessible name is "Branch prefix" (compact strip on Worktrees).
    // The obsolete "Worktree branch prefix" name alone would miss a regression
    // that re-mounted WorktreeBranchPrefixSection on General.
    expect(screen.queryByRole("textbox", { name: "Branch prefix" })).toBeNull();
    expect(
      screen.queryByTestId("worktree-branch-prefix-saving-spinner"),
    ).toBeNull();
    expect(
      screen.queryByTestId("worktree-branch-prefix-saved-check"),
    ).toBeNull();
    expect(screen.queryByText("Worktree branch prefix")).toBeNull();
  });
});

function documentPosition(
  earlier: HTMLElement,
  later: HTMLElement,
): "before" | "after" | "unrelated" {
  const relation = earlier.compareDocumentPosition(later);
  if ((relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return "before";
  if ((relation & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return "after";
  return "unrelated";
}

function getDialogButton(name: string): HTMLElement {
  return within(screen.getByRole("dialog")).getByRole("button", { name });
}

function renderPanel(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <span
        aria-hidden
        data-testid="active-host-probe"
        data-bound-host-id={hostQueryMocks.activeHostId}
      />
      <GeneralSettingsPanel />
    </QueryClientProvider>,
  );
  return queryClient;
}
