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
  HostInstallResult,
  HostTrayCommand,
  IHostManagement,
  IHostTray,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import { HostTrayCommandListener } from "@/components/layout/bridges/host-tray-command-listener";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
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

function makeManagement(): IHostManagement {
  const installResult: HostInstallResult = {
    version: "1.5.0",
    installedAt: "2026-05-15T00:00:00Z",
    executablePath: "/tmp/fake/traycerd",
    source: { kind: "registry", value: "1.5.0" },
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
  return {
    installHost: vi.fn(() => Promise.resolve(installResult)),
    updateHost: vi.fn(() => Promise.resolve(installResult)),
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
    registerService: vi.fn(() => Promise.resolve()),
    ensureHost: vi.fn(() =>
      Promise.resolve({
        action: "already-ready" as const,
        running: true,
        version: null,
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
    getOperationStatus: vi.fn(() => Promise.resolve(null)),
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
  });
  afterEach(() => {
    cleanup();
  });

  it("subscribes to hostTray.onCommand and navigates on openSettingsHost", () => {
    const tray = createTray();
    const management = makeManagement();
    renderListener(makeHost(tray.bridge, management));

    act(() => {
      tray.emit({ kind: "openSettingsHost" });
    });

    expect(navigateMock).toHaveBeenCalledWith({ to: "/settings/host" });
  });

  it("opens a confirmation dialog for restartHost and only invokes restartHost after confirm", async () => {
    const tray = createTray();
    const management = makeManagement();
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

  it("opens a confirmation dialog previewing the version for installUpdate and only installs after confirm", async () => {
    const tray = createTray();
    const management = makeManagement();
    renderListener(makeHost(tray.bridge, management));

    act(() => {
      tray.emit({ kind: "installUpdate", version: "1.5.0" });
    });

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("v1.5.0");
    expect(management.installHost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(management.installHost).toHaveBeenCalledWith({
        version: "1.5.0",
        onProgress: null,
      });
    });
  });
});
