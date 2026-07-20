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
import { toast } from "sonner";
import type {
  HostInstallResult,
  HostTrayCommand,
  IHostManagement,
  IHostTray,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
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
        includePreReleases: false,
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
  return createFakeRunnerHost({
    hostManagement: management,
    hostTray: tray,
  });
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
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
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

  it("closes the restart dialog optimistically on confirm while the mutation is still pending, and surfaces a later rejection via toast", async () => {
    const tray = createTray();
    let rejectRestart: (error: Error) => void = () => undefined;
    const management: IHostManagement = {
      ...makeManagement(),
      restartHost: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectRestart = reject;
          }),
      ),
    };
    renderListener(makeHost(tray.bridge, management));

    act(() => {
      tray.emit({ kind: "restartHost" });
    });

    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    // Closes synchronously at confirm time - this listener also lives
    // inside HostReadyGate and can unmount mid-restart, so the dialog must
    // not depend on the mutation's onSuccess/onError to close.
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    await waitFor(() => {
      expect(management.restartHost).toHaveBeenCalledTimes(1);
    });

    act(() => {
      rejectRestart(new Error("traycer host restart failed"));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't restart host",
        expect.objectContaining({
          description: "traycer host restart failed",
        }),
      );
    });
  });

  it("does not reopen the restart dialog while a restart is still pending, but does once it has settled", async () => {
    const tray = createTray();
    let resolveRestart: () => void = () => undefined;
    const management: IHostManagement = {
      ...makeManagement(),
      restartHost: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRestart = resolve;
          }),
      ),
    };
    renderListener(makeHost(tray.bridge, management));

    act(() => {
      tray.emit({ kind: "restartHost" });
    });
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    await waitFor(() => {
      expect(management.restartHost).toHaveBeenCalledTimes(1);
    });

    // The mutation is still pending here - a repeated command must not
    // reopen the dialog, since it would mount with isPending=true and lock
    // Cancel/Esc for the rest of the mutation's lifetime.
    act(() => {
      tray.emit({ kind: "restartHost" });
    });
    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(management.restartHost).toHaveBeenCalledTimes(1);

    act(() => {
      resolveRestart();
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Host restart requested");
    });

    // Once settled, the guard is scoped to "pending", not permanent - the
    // command must be able to reopen the dialog again.
    act(() => {
      tray.emit({ kind: "restartHost" });
    });
    await screen.findByTestId("confirm-destructive-dialog");
    expect(management.restartHost).toHaveBeenCalledTimes(1);
  });

  // Review P2: the reopen guard must close the race BEFORE any render/effect
  // runs - a native command queued in the same turn as confirm (no `await`
  // between them) must still be blocked. Reading `queryClient.isMutating`
  // (which reflects `mutate()` synchronously) rather than a ref synced from
  // an effect is what closes this specific window.
  it("does not reopen the restart dialog for a duplicate command delivered in the same turn as confirm", async () => {
    const tray = createTray();
    const management: IHostManagement = {
      ...makeManagement(),
      restartHost: vi.fn(() => new Promise<void>(() => {})),
    };
    renderListener(makeHost(tray.bridge, management));

    act(() => {
      tray.emit({ kind: "restartHost" });
    });
    await screen.findByTestId("confirm-destructive-dialog");

    act(() => {
      // No `await`/`waitFor` between the confirm click and the duplicate
      // command - both happen inside the same `act()` batch, before React
      // has re-rendered or run any effect.
      fireEvent.click(screen.getByTestId("confirm-action"));
      tray.emit({ kind: "restartHost" });
    });

    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    // `mutate()` invokes the mutation function on a later microtask, so
    // assert the eventual call count rather than immediately after the
    // synchronous act() block above.
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
