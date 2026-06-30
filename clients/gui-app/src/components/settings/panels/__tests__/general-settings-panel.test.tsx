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
    hostQueryMocks.getActiveHostId.mockReturnValue("host-test");
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
    useSettingsStore.setState({ pinContextUsageBreakdown: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useAuthStore.getState().setSignedOut();
    useLocalSnapshotClearStore.setState({ clearedAtByScope: {} });
    useOnboardingStore.setState({ completedAt: null, step: 0 });
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

    expect(screen.getByText("Clear file edit snapshots?")).toBeTruthy();
    fireEvent.click(getDialogButton("Clear file edit snapshots"));

    expect(hostQueryMocks.mutationResult.mutate).toHaveBeenCalledWith({});
    expect(hostQueryMocks.capturedMutationArgs?.method).toBe(
      "snapshots.clearLocalSnapshots",
    );
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
});

function getDialogButton(name: string): HTMLElement {
  return within(screen.getByRole("dialog")).getByRole("button", { name });
}

function renderPanel(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <GeneralSettingsPanel />
    </QueryClientProvider>,
  );
  return queryClient;
}
