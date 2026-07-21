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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  HostControllerStatus,
  HostTrayCommand,
  IHostManagement,
  IHostTray,
  IRunnerHost,
  MutationOutcome,
  ServiceRegistrationOk,
} from "@traycer-clients/shared/platform/runner-host";
import { HostTrayCommandListener } from "@/components/layout/bridges/host-tray-command-listener";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: toastErrorMock,
    message: vi.fn(),
  },
}));

interface FakeTray {
  handler: ((command: HostTrayCommand) => void) | null;
  emit: (command: HostTrayCommand) => void;
  bridge: IHostTray;
}

function createTray(): FakeTray {
  const ref: FakeTray = {
    handler: null,
    emit(command) {
      ref.handler?.(command);
    },
    bridge: {
      onCommand: (h) => {
        ref.handler = h;
        return {
          dispose: () => {
            ref.handler = null;
          },
        };
      },
    },
  };
  return ref;
}

const READY_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: "1.4.0",
  latestVersion: "1.5.0",
  stagedVersion: "1.5.0",
  installedRuntimeVersion: null,
  runningRuntimeVersion: null,
  updateReady: true,
  activation: "activated",
  reachable: true,
  removedByUser: false,
  checkedAt: "2026-05-15T00:00:00Z",
};

const DEBT_STATUS: HostControllerStatus = {
  ...READY_STATUS,
  stagedVersion: null,
  updateReady: false,
  activation: "pendingActivation",
};

interface ManagementOverrides {
  readonly status?: HostControllerStatus;
  readonly getHostControllerStatus?: IHostManagement["getHostControllerStatus"];
  readonly applyStaged?: IHostManagement["applyStaged"];
  readonly activateInstalled?: IHostManagement["activateInstalled"];
}

function makeManagement(overrides: ManagementOverrides): IHostManagement {
  const status = overrides.status ?? READY_STATUS;
  return {
    getHostControllerStatus:
      overrides.getHostControllerStatus ?? vi.fn(() => Promise.resolve(status)),
    convergeReady: vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { running: true, version: status.installedVersion },
      }),
    ),
    applyStaged:
      overrides.applyStaged ??
      vi.fn(() =>
        Promise.resolve({
          kind: "ok" as const,
          value: { appliedVersion: "1.5.0", runningActivated: true },
        }),
      ),
    activateInstalled:
      overrides.activateInstalled ??
      vi.fn(() =>
        Promise.resolve({ kind: "ok" as const, value: { activated: true } }),
      ),
    installVersion: vi.fn(() =>
      Promise.resolve({
        kind: "ok" as const,
        value: { installedVersion: "1.5.0", runningActivated: true },
      }),
    ),
    uninstallHost: vi.fn(() =>
      Promise.resolve({
        removedInstallDir: true,
        deregisteredService: true,
      }),
    ),
    restartHost: vi.fn(() => Promise.resolve()),
    uninstallTraycer: vi.fn(() =>
      Promise.resolve({
        removedHost: true,
        deregisteredService: true,
        removedLoginItem: false,
      }),
    ),
    getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    clearRemoval: vi.fn(() => Promise.resolve()),
    getHostLogs: vi.fn(() => Promise.resolve({ path: null, tail: "" })),
    runDoctor: vi.fn(() => Promise.resolve({ issues: [], ranAt: "" })),
    availableVersions: vi.fn(() =>
      Promise.resolve({
        generatedAt: "",
        latest: "1.5.0",
        platformKey: "darwin-arm64",
        manifestUrl: "",
        versions: [],
      }),
    ),
    installedRecord: vi.fn(() => Promise.resolve(null)),
    registerService: vi.fn(() =>
      Promise.resolve<MutationOutcome<ServiceRegistrationOk>>({
        kind: "ok",
        value: { registered: true },
      }),
    ),
    deregisterService: vi.fn(() => Promise.resolve()),
    registryCheck: vi.fn(() =>
      Promise.resolve({
        checkedAt: null,
        latestVersion: null,
        installedVersion: null,
        updateAvailable: false,
        reachable: false,
        errorMessage: null,
      }),
    ),
    freePortAndRestart: vi.fn((input) => Promise.resolve(input)),
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
}

function makeHost(tray: IHostTray, management: IHostManagement): IRunnerHost {
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
      get isOpen(): boolean {
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
      readNativeClipboardFilePaths: () => Promise.resolve([]),
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
    hostManagement: management,
    hostTray: tray,
    zoom: null,
  };
}

function renderListener(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostTrayCommandListener />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("<HostTrayCommandListener /> - mounted in __root", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    toastErrorMock.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it("subscribes to hostTray.onCommand and navigates on openSettingsHost", () => {
    const tray = createTray();
    const management = makeManagement({});
    renderListener(makeHost(tray.bridge, management));

    act(() => {
      tray.emit({ kind: "openSettingsHost" });
    });

    expect(navigateMock).toHaveBeenCalledWith({ to: "/settings/host" });
  });

  it("opens a confirmation dialog for restartHost and only invokes restartHost after confirm", async () => {
    const tray = createTray();
    const management = makeManagement({});
    renderListener(makeHost(tray.bridge, management));

    act(() => {
      tray.emit({ kind: "restartHost" });
    });

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog).not.toBeNull();
    expect(management.restartHost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(management.restartHost).toHaveBeenCalledTimes(1);
    });
  });

  it("previews the version, submits applyStaged after confirm when a stage is updateReady", async () => {
    const tray = createTray();
    const management = makeManagement({ status: READY_STATUS });
    renderListener(makeHost(tray.bridge, management));

    // Let the controller-status query prime before the command lands, so the
    // updateReady-vs-debt branch reads real data rather than `undefined`.
    await waitFor(() => {
      expect(management.getHostControllerStatus).toHaveBeenCalled();
    });

    act(() => {
      tray.emit({ kind: "installUpdate", version: "1.5.0" });
    });

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("v1.5.0");
    expect(management.applyStaged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(management.applyStaged).toHaveBeenCalledWith("manual", false);
    });
    expect(management.activateInstalled).not.toHaveBeenCalled();
  });

  it("submits activateInstalled instead of applyStaged when only activation debt is present", async () => {
    const tray = createTray();
    const management = makeManagement({ status: DEBT_STATUS });
    renderListener(makeHost(tray.bridge, management));

    await waitFor(() => {
      expect(management.getHostControllerStatus).toHaveBeenCalled();
    });

    act(() => {
      tray.emit({ kind: "installUpdate", version: "1.4.0" });
    });

    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(management.activateInstalled).toHaveBeenCalledWith(false);
    });
    expect(management.applyStaged).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", { ...DEBT_STATUS, activation: "unavailable" as const }],
    ["activated", { ...DEBT_STATUS, activation: "activated" as const }],
    ["undefined", undefined],
  ] as const)(
    "dismisses and refetches an invalid %s status on confirm",
    async (_label, status) => {
      const tray = createTray();
      const getHostControllerStatus: IHostManagement["getHostControllerStatus"] =
        status === undefined
          ? () => new Promise<HostControllerStatus>(() => undefined)
          : () => Promise.resolve(status);
      const getStatusSpy = vi.fn(getHostControllerStatus);
      const management = makeManagement({
        status: READY_STATUS,
        getHostControllerStatus: getStatusSpy,
      });
      renderListener(makeHost(tray.bridge, management));
      await waitFor(() => expect(getStatusSpy).toHaveBeenCalledOnce());

      act(() => tray.emit({ kind: "installUpdate", version: "1.4.0" }));
      await screen.findByTestId("confirm-destructive-dialog");
      fireEvent.click(screen.getByTestId("confirm-action"));

      await waitFor(() => {
        // An unresolved initial query deduplicates the explicit refetch; the
        // fulfilled stale-status cases execute a second controller read.
        expect(getStatusSpy).toHaveBeenCalledTimes(
          status === undefined ? 1 : 2,
        );
      });
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
      expect(management.applyStaged).not.toHaveBeenCalled();
      expect(management.activateInstalled).not.toHaveBeenCalled();
    },
  );

  it("opens the Force/Defer dialog on a busy outcome, and Force re-submits with force:true", async () => {
    const tray = createTray();
    const applyStaged = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "busy" as const,
        continuation: "retry-with-force" as const,
        message: "Another Traycer process is applying an update.",
      })
      .mockResolvedValueOnce({
        kind: "ok" as const,
        value: { appliedVersion: "1.5.0", runningActivated: true },
      });
    const management = makeManagement({ status: READY_STATUS, applyStaged });
    renderListener(makeHost(tray.bridge, management));

    await waitFor(() => {
      expect(management.getHostControllerStatus).toHaveBeenCalled();
    });

    act(() => {
      tray.emit({ kind: "installUpdate", version: "1.5.0" });
    });
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    const busyDialog = await screen.findByTestId(
      "host-busy-force-defer-dialog",
    );
    expect(busyDialog.textContent).toContain(
      "Another Traycer process is applying an update.",
    );

    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledWith("manual", true);
    });
  });

  it("renders its own deferred-lock outcome as a toast, without hanging", async () => {
    const tray = createTray();
    const applyStaged = vi.fn(() =>
      Promise.resolve({
        kind: "deferred" as const,
        message: "Another Traycer process is managing the host.",
      }),
    );
    const management = makeManagement({ status: READY_STATUS, applyStaged });
    renderListener(makeHost(tray.bridge, management));

    await waitFor(() => {
      expect(management.getHostControllerStatus).toHaveBeenCalled();
    });

    act(() => {
      tray.emit({ kind: "installUpdate", version: "1.5.0" });
    });
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Another Traycer process is managing the host.",
      );
    });
    expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
  });
});
