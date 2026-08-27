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
import { InstallGuidanceDialog } from "@/components/layout/dialogs/install-guidance-dialog";
import {
  HostReadinessControllerContext,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateChannelChange,
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
  cancel?: ToastAction | null;
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
  const message = vi.fn<ToastCall>();
  return Object.assign(toast, {
    dismiss: vi.fn(),
    error,
    info: vi.fn<ToastCall>(),
    message,
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
  allowPrerelease: false,
  latestVersion: null,
  latestCompatibilityEpoch: null,
  downloadProgress: null,
  installBlockedReason: null,
  installGuidance: null,
  installInFlight: false,
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
  // Annotated with the full change type. Inference from this default narrows
  // `outcome` to the literal `"changed"`, which then rejects a
  // `mockResolvedValue` for `refused-update-pending` - the macOS standing
  // refusal, which is exactly the case worth testing.
  readonly setAllowPrerelease = vi.fn(
    (): Promise<DesktopAppUpdateChannelChange> =>
      Promise.resolve({ outcome: "changed", snapshot: this.snapshot }),
  );
  readonly resolveCompatRecovery = vi.fn(() =>
    Promise.resolve({
      route: "manual" as const,
      rcCandidateVersion: null,
      stagedVersion: null,
    }),
  );
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
    allowPrerelease: false,
    latestVersion: "1.2.3",
    latestCompatibilityEpoch: null,
    downloadProgress: null,
    installBlockedReason: null,
    installGuidance: null,
    installInFlight: false,
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
    latestCompatibilityEpoch: null,
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

const READY_READINESS: SurfaceReadiness = { kind: "ready" };
const LOADING_HOST_READINESS: SurfaceReadiness = { kind: "loading-host" };

const READINESS_STUB_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
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

function readinessController(
  readiness: SurfaceReadiness,
): HostReadinessController {
  return {
    readinessFor: () => readiness,
    defaultHostPresentation: READINESS_STUB_PRESENTATION,
    hasBeenDefaultHostReady: false,
  };
}

interface ReadinessHarness {
  readonly rerenderReadiness: (next: SurfaceReadiness) => void;
}

function renderWithReadiness(
  ui: ReactElement,
  appUpdates: DesktopAppUpdatesBridge,
  readiness: SurfaceReadiness,
): ReadinessHarness {
  const host = makeHost(appUpdates);
  function tree(forReadiness: SurfaceReadiness): ReactElement {
    return (
      <RunnerHostProvider runnerHost={host}>
        <TooltipProvider>
          <HostReadinessControllerContext.Provider
            value={readinessController(forReadiness)}
          >
            {ui}
          </HostReadinessControllerContext.Provider>
        </TooltipProvider>
      </RunnerHostProvider>
    );
  }
  const view = render(tree(readiness));
  return {
    rerenderReadiness: (next) => {
      view.rerender(tree(next));
    },
  };
}

describe("desktop app update UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDesktopDialogStore.getState().close();
    useDesktopDialogStore.setState({ reportIssueAvailable: false });
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

  it("keeps the restart tick inert when a ready update is blocked", async () => {
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
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
  });

  it("restarts to install directly when the ready tick is clicked, without a second confirmation", async () => {
    const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
    const track = vi.spyOn(Analytics.getInstance(), "track");
    renderWithHost(<AppUpdateHeaderButton />, bridge);

    const button = await screen.findByRole("button", {
      name: /Restart to update/i,
    });

    fireEvent.click(button);

    // The click IS the confirmation - no modal is opened in between. AWAITED
    // because the install door now asks MAIN for the unsyncable set across
    // every window before it authorizes a restart that quits the whole app.
    await waitFor(() => {
      expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
    });
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    // The event the deleted modal used to own now rides the gesture.
    expect(track).toHaveBeenCalledWith(AnalyticsEvent.UpdateRestartRequested, {
      source: "direct_ui",
    });
  });

  it("disarms the ready tick while an install is in flight", async () => {
    const bridge = new FakeAppUpdatesBridge(readySnapshot(1));
    renderWithHost(<AppUpdateHeaderButton />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    // Main publishes the in-flight install; the quit it triggers drains first,
    // so the tick is still on screen and must not fire a second install.
    act(() => {
      bridge.emit({ ...readySnapshot(2), installInFlight: true });
    });

    const button = screen.getByTestId("app-update-header-button");
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    // `disabled` alone is silent - the pending state is announced.
    screen.getByRole("status", { name: /Restarting to install the update/i });
  });

  it("re-arms the ready tick when the install fails back to an error", async () => {
    const bridge = new FakeAppUpdatesBridge({
      ...readySnapshot(1),
      installInFlight: true,
    });
    renderWithHost(<AppUpdateHeaderButton />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });
    expect(
      screen.getByTestId("app-update-header-button").hasAttribute("disabled"),
    ).toBe(true);

    act(() => {
      bridge.emit(errorSnapshot(2));
    });

    // A failed install drops out of "ready" entirely, so the affordance goes
    // away rather than wedging disabled forever.
    expect(screen.queryByTestId("app-update-header-button")).toBeNull();
  });

  it("disarms the header tick after the toast's Restart starts the install", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
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

    act(() => {
      bridge.emit(readySnapshot(1));
    });
    const [message] = toastMock.mock.lastCall ?? [];
    if (message === undefined) {
      throw new Error("Expected update ready toast content");
    }
    render(<>{message}</>);

    // Both restart affordances are on screen at once: the toast dismisses
    // itself on click, but the header tick does not - main has to disarm it.
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => {
      expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
    });
    act(() => {
      bridge.emit({ ...readySnapshot(2), installInFlight: true });
    });

    const tick = screen.getByTestId("app-update-header-button");
    expect(tick.hasAttribute("disabled")).toBe(true);
    fireEvent.click(tick);
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
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
        {
          id: "traycer-app-update",
          description: null,
          duration: 4000,
          cancel: null,
        },
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
    expect(options.cancel).toBeNull();
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

  it("shows download progress in the shared closable toast", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(downloadingSnapshot(1, 50));
    });
    await waitFor(() => {
      expect(toastMock.message).toHaveBeenCalledWith(
        "Downloading update…",
        expect.objectContaining({
          id: "traycer-app-update",
          description: "50% complete",
          closeButton: true,
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
      expect(toastMock.message).toHaveBeenCalledWith(
        "Downloading update…",
        expect.objectContaining({
          id: "traycer-app-update",
          description: "0% complete",
          closeButton: true,
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

  it("offers Restart on the ready toast, installing without a confirmation modal", async () => {
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
    expect(options.cancel).toBeNull();
    render(<>{message}</>);
    screen.getByText("Update ready to install");
    screen.getByText("Restart Traycer to finish updating.");

    const track = vi.spyOn(Analytics.getInstance(), "track");
    const restart = screen.getByRole("button", { name: "Restart" });
    fireEvent.click(restart);
    fireEvent.click(restart);
    // The toast button is the confirmation - it installs once, with no modal.
    // ONCE still holds now that the door is async, and not by luck: the
    // content's `actionHandledRef` latch is set synchronously before
    // `onAction()`, so the second click returns before any round trip starts.
    await waitFor(() => {
      expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
    });
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    expect(toastMock.dismiss).toHaveBeenCalledWith("traycer-app-update");
    expect(track).toHaveBeenCalledWith(AnalyticsEvent.UpdateRestartRequested, {
      source: "direct_ui",
    });
  });

  it("replaces the ready toast with progress once the install is in flight", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit({ ...readySnapshot(1), installInFlight: true });
    });

    // Not the action toast: a second "Restart" button here could fire a
    // duplicate install, and the drain would otherwise show no feedback.
    await waitFor(() => {
      expect(toastMock.message).toHaveBeenCalledWith(
        "Restarting to install update…",
        expect.objectContaining({
          id: "traycer-app-update",
          description: "Traycer will reopen once the update is applied.",
        }),
      );
    });
    render(<>{toastMock.mock.lastCall?.[0]}</>);
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
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
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
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
    expect(options.cancel).toBeNull();
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
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "Could not update Traycer",
      message: null,
      code: null,
      source: "App update",
    });
  });

  it("offers View instructions alongside Report an issue when a live install failure has guidance", async () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
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
    const reportIssue = screen.getByRole("button", {
      name: "Report an issue",
    });
    expect(viewInstructions.getAttribute("data-variant")).toBe("default");
    expect(reportIssue.getAttribute("data-variant")).toBe("secondary");
    expect(useDesktopDialogStore.getState().activeDialog).toBeNull();
    fireEvent.click(viewInstructions);
    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "install-guidance",
    );
  });

  it("does not offer reporting when the support capability is unavailable", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(errorSnapshot(1));
    });
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalled();
    });

    const [, options] = toastMock.error.mock.lastCall ?? [];
    if (options === undefined) {
      throw new Error("Expected update error toast options");
    }
    render(<>{options.description}</>);

    screen.getByText(
      "Traycer couldn't reach the update service right now. Please try again in a little while.",
    );
    expect(
      screen.queryByRole("button", { name: "Report an issue" }),
    ).toBeNull();
  });

  it("updates the current error toast when reporting becomes available", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithHost(<AppUpdateToastController />, bridge);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(errorSnapshot(1));
    });
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledTimes(2);
    });

    const [, options] = toastMock.error.mock.lastCall ?? [];
    if (options === undefined) {
      throw new Error("Expected update error toast options");
    }
    render(<>{options.description}</>);
    expect(
      screen.getByRole("button", { name: "Report an issue" }),
    ).not.toBeNull();
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

  it("suppresses the update toast while the window narrator owns the frame", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    const harness = renderWithReadiness(
      <AppUpdateToastController />,
      bridge,
      READY_READINESS,
    );
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    // Positive baseline first: the harness can show a toast at all when the
    // narrator does not own the frame, so the assertion below isn't passing
    // on a broken harness.
    act(() => {
      bridge.emit(availableSnapshot(1));
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledTimes(1);
    });

    toastMock.mockClear();
    harness.rerenderReadiness(LOADING_HOST_READINESS);

    act(() => {
      bridge.emit(availableSnapshot(2));
    });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("re-emits the deferred update once the narrator releases the frame, with no new snapshot or sequence bump", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    const harness = renderWithReadiness(
      <AppUpdateToastController />,
      bridge,
      LOADING_HOST_READINESS,
    );
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(availableSnapshot(1));
    });
    expect(toastMock).not.toHaveBeenCalled();

    // Release: readiness flips to `ready` with no new snapshot arriving and
    // no sequence bump - the effect's `narrated` dependency is the only thing
    // that changes.
    harness.rerenderReadiness(READY_READINESS);

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledTimes(1);
    });
    const [message, options] = toastMock.mock.lastCall ?? [];
    expect(options?.id).toBe("traycer-app-update");

    // The whole point of re-emitting rather than unfreezing in place is that
    // the user gets an affordance at a moment they can act on it - the toast
    // carries `cancel: null` everywhere in this controller, so Sonner's own
    // close button does not exist on it, and the only way to clear it is the
    // control this element renders itself. If the re-emitted payload didn't
    // carry a working one, the premise behind choosing "re-emit" over
    // "unfreeze" would be false even though the toast reappeared.
    if (message === undefined) {
      throw new Error("Expected the re-emitted toast to carry content");
    }
    render(<>{message}</>);
    const laterButton = screen.getByRole("button", { name: "Later" });
    fireEvent.click(laterButton);
    expect(toastMock.dismiss).toHaveBeenCalledWith("traycer-app-update");
  });

  it("shows the toast exactly as before when the narrator never owns the frame", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderWithReadiness(<AppUpdateToastController />, bridge, READY_READINESS);
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(availableSnapshot(1));
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledTimes(1);
    });
    const [, options] = toastMock.mock.lastCall ?? [];
    expect(options?.id).toBe("traycer-app-update");
  });

  it("does not double-emit after a deferred update has already been re-emitted on release", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    const harness = renderWithReadiness(
      <AppUpdateToastController />,
      bridge,
      LOADING_HOST_READINESS,
    );
    await waitFor(() => {
      expect(bridge.subscriptionCount()).toBe(1);
    });

    act(() => {
      bridge.emit(availableSnapshot(1));
    });
    expect(toastMock).not.toHaveBeenCalled();

    harness.rerenderReadiness(READY_READINESS);
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledTimes(1);
    });

    toastMock.mockClear();
    // An unrelated re-render at the same readiness must not re-fire it.
    harness.rerenderReadiness(READY_READINESS);
    // Neither should the same snapshot arriving again.
    act(() => {
      bridge.emit(availableSnapshot(1));
    });
    expect(toastMock).not.toHaveBeenCalled();
  });
});
