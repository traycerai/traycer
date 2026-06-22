import "../../../../__tests__/test-browser-apis";
import type { ReactElement, ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AppUpdateToastController } from "@/components/layout/bridges/app-update-toast-controller";
import { AppUpdateHeaderButton } from "@/components/layout/header/app-update-button";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";

type ToastAction = {
  label: string;
  onClick: () => void;
};

type ToastOptions = {
  id?: string;
  description?: ReactNode;
  duration?: number;
  action?: ToastAction;
  cancel?: ToastAction;
};

type ToastCall = (message: string, options: ToastOptions | undefined) => void;

const toastMock = vi.hoisted(() => {
  const actions: {
    restart: (() => void) | null;
  } = { restart: null };
  const toast = vi.fn<ToastCall>((_message, options) => {
    actions.restart = options?.action?.onClick ?? null;
  });
  const error = vi.fn<ToastCall>();
  return Object.assign(toast, {
    dismiss: vi.fn(),
    error,
    info: vi.fn<ToastCall>(),
    success: vi.fn<ToastCall>(),
    actions,
  });
});

vi.mock("sonner", () => ({
  toast: toastMock,
}));

const IDLE_SNAPSHOT: DesktopAppUpdateSnapshot = {
  sequence: 0,
  status: "idle",
  currentVersion: "1.0.0",
  latestVersion: null,
  errorMessage: null,
  lastCheckedAt: null,
  lastCheckIntent: null,
};

class FakeAppUpdatesBridge implements DesktopAppUpdatesBridge {
  snapshot: DesktopAppUpdateSnapshot;
  readonly installUpdate = vi.fn(() => Promise.resolve(this.snapshot));
  private readonly handlers = new Set<
    (snapshot: DesktopAppUpdateSnapshot) => void
  >();

  constructor(snapshot: DesktopAppUpdateSnapshot) {
    this.snapshot = snapshot;
  }

  getSnapshot(): Promise<DesktopAppUpdateSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  checkForUpdates(
    _intent: DesktopAppUpdateCheckIntent,
  ): Promise<DesktopAppUpdateSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  onChange(handler: (snapshot: DesktopAppUpdateSnapshot) => void): {
    dispose(): void;
  } {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  emit(snapshot: DesktopAppUpdateSnapshot): void {
    this.snapshot = snapshot;
    for (const handler of this.handlers) {
      handler(snapshot);
    }
  }

  subscriptionCount(): number {
    return this.handlers.size;
  }
}

class DelayedSnapshotAppUpdatesBridge extends FakeAppUpdatesBridge {
  private resolveSnapshot:
    | ((snapshot: DesktopAppUpdateSnapshot) => void)
    | null = null;

  override getSnapshot(): Promise<DesktopAppUpdateSnapshot> {
    return new Promise((resolve) => {
      this.resolveSnapshot = resolve;
    });
  }

  resolveGetSnapshot(snapshot: DesktopAppUpdateSnapshot): void {
    if (this.resolveSnapshot === null) {
      throw new Error("Expected getSnapshot to be in flight");
    }
    this.snapshot = snapshot;
    this.resolveSnapshot(snapshot);
    this.resolveSnapshot = null;
  }
}

function readySnapshot(sequence: number): DesktopAppUpdateSnapshot {
  return {
    sequence,
    status: "ready",
    currentVersion: "1.0.0",
    latestVersion: "1.2.3",
    errorMessage: null,
    lastCheckedAt: "2026-06-15T00:00:00.000Z",
    lastCheckIntent: "automatic",
  };
}

function manualSnapshot(
  sequence: number,
  status: DesktopAppUpdateSnapshot["status"],
): DesktopAppUpdateSnapshot {
  return {
    ...IDLE_SNAPSHOT,
    sequence,
    status,
    lastCheckedAt: new Date(Date.now() + 1_000).toISOString(),
    lastCheckIntent: "manual",
  };
}

function errorSnapshot(sequence: number): DesktopAppUpdateSnapshot {
  return {
    ...manualSnapshot(sequence, "error"),
    errorMessage:
      "Traycer couldn't reach the update service right now. Please try again in a little while.",
  };
}

function makeHost(appUpdates: DesktopAppUpdatesBridge): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    appUpdates,
  });
}

function renderWithHost(
  ui: ReactElement,
  appUpdates: DesktopAppUpdatesBridge,
): void {
  render(
    <RunnerHostProvider runnerHost={makeHost(appUpdates)}>
      {ui}
    </RunnerHostProvider>,
  );
}

describe("desktop app update UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDesktopDialogStore.getState().close();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a restart button when a downloaded app update is ready", async () => {
    const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    const button = await screen.findByRole("button", {
      name: /Restart to update/i,
    });
    fireEvent.click(button);

    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("shares one desktop update subscription across update UI consumers", async () => {
    const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
    renderWithHost(
      <>
        <AppUpdateHeaderButton />
        <AppUpdateToastController />
      </>,
      bridge,
    );

    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });
  });

  it("keeps newer live update state when the initial snapshot resolves late", async () => {
    const bridge = new DelayedSnapshotAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateHeaderButton />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(readySnapshot(2));
    });
    await screen.findByRole("button", {
      name: /Restart to update/i,
    });

    await act(async () => {
      bridge.resolveGetSnapshot(manualSnapshot(1, "checking"));
      await Promise.resolve();
    });

    expect(
      screen.getByRole("button", { name: /Restart to update/i }),
    ).not.toBeNull();
  });

  it("shows manual-check and ready-to-install toasts", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(manualSnapshot(1, "checking"));
    });
    await waitFor(() => {
      expect(toastMock.info).toHaveBeenCalledWith(
        "Checking for Traycer updates...",
        { id: "traycer-app-update" },
      );
    });

    act(() => {
      bridge.emit(manualSnapshot(2, "up-to-date"));
    });
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith(
        "Traycer is up to date",
        expect.objectContaining({ id: "traycer-app-update" }),
      );
    });

    act(() => {
      bridge.emit(readySnapshot(3));
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        "Traycer update ready",
        expect.objectContaining({
          id: "traycer-app-update",
          description: "Restart Traycer to install v1.2.3.",
        }),
      );
    });

    const restartAction = toastMock.actions.restart;
    if (restartAction === null) {
      throw new Error("Expected restart action");
    }
    restartAction();
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("offers a Report an issue action that opens the report dialog on error", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(errorSnapshot(1));
    });

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Couldn't update Traycer",
        expect.objectContaining({
          id: "traycer-app-update",
        }),
      );
    });

    const [, options] = toastMock.error.mock.lastCall ?? [];
    if (options === undefined) {
      throw new Error("Expected update error toast options");
    }
    expect(options.action).toBeUndefined();
    expect(options.cancel).toBeUndefined();
    render(<>{options.description}</>);
    screen.getByText(
      "Traycer couldn't reach the update service right now. Please try again in a little while.",
    );
    const reportButton = screen.getByRole("button", {
      name: "Report an issue",
    });
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    fireEvent.click(reportButton);
    expect(useDesktopDialogStore.getState().activeDialog).toBe("report-issue");
  });

  it("does not replay stale manual-check results in a newly opened window", async () => {
    const bridge = new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      sequence: 7,
      status: "up-to-date",
      lastCheckedAt: "2000-01-01T00:00:00.000Z",
      lastCheckIntent: "manual",
    });
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
