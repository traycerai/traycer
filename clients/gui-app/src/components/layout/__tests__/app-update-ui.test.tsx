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
import { RestartUpdateDialog } from "@/components/layout/dialogs/restart-update-dialog";
import { InstallGuidanceDialog } from "@/components/layout/dialogs/install-guidance-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateGuidance,
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

type ToastCall = (
  message: ReactNode,
  options: ToastOptions | undefined,
) => void;

const toastMock = vi.hoisted(() => {
  const actions: {
    action: (() => void) | null;
  } = { action: null };
  const toast = vi.fn<ToastCall>((_message, options) => {
    actions.action = options?.action?.onClick ?? null;
  });
  const error = vi.fn<ToastCall>();
  return Object.assign(toast, {
    dismiss: vi.fn(),
    error,
    info: vi.fn<ToastCall>(),
    success: vi.fn<ToastCall>(),
    loading: vi.fn<ToastCall>(),
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
  downloadProgress: null,
  installBlockedReason: null,
  installGuidance: null,
  errorMessage: null,
  lastCheckedAt: null,
  lastCheckIntent: null,
};

const READY_GUIDANCE: DesktopAppUpdateGuidance = {
  summary: "Traycer downloaded v1.2.3, but this install needs one manual step.",
  steps: [
    "Open a terminal.",
    "Run the command below to install the update.",
    "Restart Traycer once it completes.",
  ],
  command: 'sudo dpkg -i "/home/user/.cache/updater/pending/traycer.deb"',
  releaseUrl: "https://github.com/traycerai/traycer/releases",
};

class FakeAppUpdatesBridge implements DesktopAppUpdatesBridge {
  snapshot: DesktopAppUpdateSnapshot;
  readonly downloadUpdate = vi.fn(() => Promise.resolve(this.snapshot));
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
    ((snapshot: DesktopAppUpdateSnapshot) => void) | null = null;

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
    downloadProgress: null,
    installBlockedReason: null,
    installGuidance: null,
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
      <TooltipProvider>{ui}</TooltipProvider>
    </RunnerHostProvider>,
  );
}

function availableSnapshot(sequence: number): DesktopAppUpdateSnapshot {
  return {
    ...IDLE_SNAPSHOT,
    sequence,
    status: "available",
    latestVersion: "1.2.3",
    lastCheckedAt: "2026-06-15T00:00:00.000Z",
    lastCheckIntent: "automatic",
  };
}

function downloadingSnapshot(
  sequence: number,
  downloadProgress: number,
): DesktopAppUpdateSnapshot {
  return {
    ...availableSnapshot(sequence),
    status: "downloading",
    downloadProgress,
  };
}

describe("desktop app update UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDesktopDialogStore.getState().close();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a download button when an update is available", async () => {
    const bridge = new FakeAppUpdatesBridge(availableSnapshot(1));
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    const button = await screen.findByRole("button", {
      name: /Download update/i,
    });
    fireEvent.click(button);

    expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("surfaces download progress in the button accessible name", async () => {
    const bridge = new FakeAppUpdatesBridge(downloadingSnapshot(1, 42));
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    await screen.findByRole("button", { name: /Downloading 42%/i });
  });

  it("disables the download button with a reason when updates are blocked", async () => {
    const bridge = new FakeAppUpdatesBridge({
      ...availableSnapshot(1),
      installBlockedReason:
        "Move Traycer to your Applications folder to install updates.",
    });
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    const button = await screen.findByRole("button", {
      name: /Move Traycer to your Applications folder/i,
    });
    expect(button.hasAttribute("disabled")).toBe(true);

    fireEvent.click(button);
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();
  });

  it("disables the restart tick (no confirm modal) when a ready update is blocked", async () => {
    const bridge = new FakeAppUpdatesBridge({
      ...readySnapshot(1),
      installBlockedReason:
        "Move Traycer to your Applications folder to install updates.",
    });
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    const button = await screen.findByRole("button", {
      name: /Move Traycer to your Applications folder/i,
    });
    expect(button.hasAttribute("disabled")).toBe(true);

    fireEvent.click(button);
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
  });

  it("opens the restart-confirmation modal when the ready tick is clicked", async () => {
    const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    const button = await screen.findByRole("button", {
      name: /Restart to update/i,
    });
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();

    fireEvent.click(button);

    // The tick opens the shared confirmation modal rather than restarting.
    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "confirm-restart-update",
    );
  });

  it("opens install guidance instead of the restart confirmation when the ready update needs a manual step", async () => {
    const bridge = new FakeAppUpdatesBridge({
      ...readySnapshot(1),
      installGuidance: READY_GUIDANCE,
    });
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    const button = await screen.findByRole("button", {
      name: /Finish update/i,
    });
    // Unlike the blocked-location case, this button stays enabled - the
    // update can still be applied, just not fully automatically.
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();

    fireEvent.click(button);

    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "install-guidance",
    );
  });

  it("runs the restart action only after the modal is confirmed", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <RestartUpdateDialog
        open
        onOpenChange={onOpenChange}
        latestVersion="1.2.3"
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Restart now/i }));
    fireEvent.click(screen.getByRole("button", { name: /Restart now/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("button", { name: /Restart now/i })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("status", {
        name: /Restart request in progress/i,
      }),
    ).toBeTruthy();
    rerender(
      <RestartUpdateDialog
        open={false}
        onOpenChange={onOpenChange}
        latestVersion="1.2.3"
        onConfirm={onConfirm}
      />,
    );
    rerender(
      <RestartUpdateDialog
        open
        onOpenChange={onOpenChange}
        latestVersion="1.2.3"
        onConfirm={onConfirm}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Later" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getByRole("button", { name: /Restart now/i })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Restart now/i }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("renders the manual-install steps and command, and opens the release page", () => {
    const host = makeHost(new FakeAppUpdatesBridge(readySnapshot(1)));
    const openExternalLink = vi
      .spyOn(host, "openExternalLink")
      .mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <RunnerHostProvider runnerHost={host}>
        <TooltipProvider>
          <InstallGuidanceDialog
            open
            onOpenChange={onOpenChange}
            guidance={READY_GUIDANCE}
          />
        </TooltipProvider>
      </RunnerHostProvider>,
    );

    screen.getByText(READY_GUIDANCE.summary);
    for (const step of READY_GUIDANCE.steps) {
      screen.getByText(step);
    }
    screen.getByText(READY_GUIDANCE.command ?? "");

    fireEvent.click(screen.getByRole("button", { name: "View release page" }));
    expect(openExternalLink).toHaveBeenCalledWith(READY_GUIDANCE.releaseUrl);

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
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

  it("shows manual-check feedback toasts", async () => {
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
        { id: "traycer-app-update", description: null, duration: 4000 },
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
  });

  it("announces an available update with a Download action", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(availableSnapshot(1));
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "traycer-app-update" }),
      );
    });

    const [message, options] = toastMock.mock.lastCall ?? [];
    if (message === undefined || options === undefined) {
      throw new Error("Expected update available toast content");
    }
    expect(options.action).toBeUndefined();
    expect(options.cancel).toBeUndefined();
    render(<>{message}</>);
    screen.getByText("Update available");
    screen.getByText("Version 1.2.3 is ready to download.");

    const downloadButton = screen.getByRole("button", {
      name: "Download",
    });
    const laterButton = screen.getByRole("button", { name: "Later" });
    fireEvent.click(downloadButton);
    fireEvent.click(downloadButton);
    expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(downloadButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(laterButton);
    expect(toastMock.dismiss).toHaveBeenCalledWith("traycer-app-update");
  });

  it("explains why a blocked update can't be installed instead of offering Download", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit({
        ...availableSnapshot(1),
        installBlockedReason:
          "Move Traycer to your Applications folder to install updates.",
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        "Update available",
        expect.objectContaining({
          id: "traycer-app-update",
          description:
            "Move Traycer to your Applications folder to install updates.",
        }),
      );
    });

    // No actionable Download was offered.
    expect(toastMock.actions.action).toBeNull();
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();
  });

  it("shows download progress in a loading toast", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(downloadingSnapshot(1, 50));
    });
    await waitFor(() => {
      expect(toastMock.loading).toHaveBeenCalledWith(
        "Downloading update…",
        expect.objectContaining({
          id: "traycer-app-update",
          description: "50% complete",
        }),
      );
    });
  });

  it("clears stale download progress copy when the update becomes ready", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(downloadingSnapshot(1, 0));
    });
    await waitFor(() => {
      expect(toastMock.loading).toHaveBeenCalledWith(
        "Downloading update…",
        expect.objectContaining({
          id: "traycer-app-update",
          description: "0% complete",
        }),
      );
    });

    act(() => {
      bridge.emit(readySnapshot(2));
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: "traycer-app-update",
          description: null,
        }),
      );
    });
  });

  it("offers Restart on the ready toast, opening the confirmation modal", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(readySnapshot(1));
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "traycer-app-update" }),
      );
    });

    const [message, options] = toastMock.mock.lastCall ?? [];
    if (message === undefined || options === undefined) {
      throw new Error("Expected update ready toast content");
    }
    expect(options.action).toBeUndefined();
    expect(options.cancel).toBeUndefined();
    render(<>{message}</>);
    screen.getByText("Update ready to install");
    screen.getByText("Restart Traycer to finish updating.");

    const restart = screen.getByRole("button", { name: "Restart" });
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    fireEvent.click(restart);
    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "confirm-restart-update",
    );
  });

  it("offers View instructions on the ready toast when a manual step is needed", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit({ ...readySnapshot(1), installGuidance: READY_GUIDANCE });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: "traycer-app-update" }),
      );
    });

    const [message] = toastMock.mock.lastCall ?? [];
    if (message === undefined) {
      throw new Error("Expected update ready toast content");
    }
    render(<>{message}</>);
    screen.getByText("Update downloaded");

    const viewInstructions = screen.getByRole("button", {
      name: "View instructions",
    });
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    fireEvent.click(viewInstructions);
    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "install-guidance",
    );
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

  it("offers View instructions alongside Report an issue when a live install failure has guidance", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit({ ...errorSnapshot(1), installGuidance: READY_GUIDANCE });
    });
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Couldn't update Traycer",
        expect.objectContaining({ id: "traycer-app-update" }),
      );
    });

    const [, options] = toastMock.error.mock.lastCall ?? [];
    if (options === undefined) {
      throw new Error("Expected update error toast options");
    }
    render(<>{options.description}</>);
    const viewInstructions = screen.getByRole("button", {
      name: "View instructions",
    });
    screen.getByRole("button", { name: "Report an issue" });
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    fireEvent.click(viewInstructions);
    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "install-guidance",
    );
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
