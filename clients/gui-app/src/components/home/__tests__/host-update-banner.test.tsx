import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostUpdateBanner } from "@/components/home/host-update-banner";
import { HostControllerStatusListener } from "@/components/layout/bridges/host-controller-status-listener";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  HOST_UPDATE_BANNER_SNOOZE_MS,
  useHostUpdateBannerStore,
} from "@/stores/settings/host-update-banner-store";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  HostControllerStatus,
  IHostManagement,
  IRunnerHost,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { DesktopHostControllerStatusBridge } from "@/lib/windows/types";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

interface Overrides {
  readonly status?: HostControllerStatus;
  readonly applyStaged?: () => Promise<MutationOutcome<ApplyStagedOk>>;
  readonly activateInstalled?: () => Promise<
    MutationOutcome<ActivateInstalledOk>
  >;
}

const UP_TO_DATE_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: "1.4.1",
  latestVersion: "1.4.1",
  stagedVersion: null,
  installedRuntimeVersion: null,
  runningRuntimeVersion: null,
  updateReady: false,
  activation: "activated",
  reachable: true,
  removedByUser: false,
  checkedAt: "2026-05-15T00:00:00Z",
};

const READY_STATUS: HostControllerStatus = {
  ...UP_TO_DATE_STATUS,
  latestVersion: "1.4.2",
  stagedVersion: "1.4.2",
  updateReady: true,
};

function makeManagement(overrides: Overrides): IHostManagement {
  const notImplemented = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`${method} not implemented`));
  const status = overrides.status ?? UP_TO_DATE_STATUS;
  return {
    getHostControllerStatus: vi.fn(() => Promise.resolve(status)),
    convergeReady: vi.fn(notImplemented("convergeReady")),
    applyStaged: vi.fn(overrides.applyStaged ?? notImplemented("applyStaged")),
    activateInstalled: vi.fn(
      overrides.activateInstalled ?? notImplemented("activateInstalled"),
    ),
    installVersion: vi.fn(notImplemented("installVersion")),
    uninstallHost: vi.fn(notImplemented("uninstallHost")),
    restartHost: vi.fn(() => Promise.resolve()),
    uninstallTraycer: vi.fn(notImplemented("uninstallTraycer")),
    getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    clearRemoval: vi.fn(() => Promise.resolve()),
    getHostLogs: vi.fn(() => Promise.resolve({ path: null, tail: "" })),
    runDoctor: vi.fn(() => Promise.resolve({ issues: [], ranAt: "" })),
    availableVersions: vi.fn(notImplemented("availableVersions")),
    installedRecord: vi.fn(() => Promise.resolve(null)),
    registerService: vi.fn(notImplemented("registerService")),
    deregisterService: vi.fn(notImplemented("deregisterService")),
    registryCheck: vi.fn(notImplemented("registryCheck")),
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

function makeHost(management: IHostManagement | null): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  // Preserve MockRunnerHost's prototype methods (signIn, signOut, …) while
  // overriding the readonly fields the test needs to vary. Spreading a class
  // instance only copies own enumerable fields, so we keep the prototype
  // chain via Object.create.
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    hostManagement: management,
    hostTray: null,
  });
}

function renderBanner(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostUpdateBanner className={undefined} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function renderBannerWithStatusListener(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostControllerStatusListener />
        <HostUpdateBanner className={undefined} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function createStatusBridge(): {
  readonly bridge: DesktopHostControllerStatusBridge;
  readonly emit: (status: HostControllerStatus) => void;
} {
  const handlers = new Set<(status: HostControllerStatus) => void>();
  return {
    bridge: {
      onChange: (handler) => {
        handlers.add(handler);
        return {
          dispose: () => {
            handlers.delete(handler);
          },
        };
      },
    },
    emit: (status) => {
      for (const handler of handlers) {
        handler(status);
      }
    },
  };
}

function findHostUpdateBanner(): Promise<HTMLElement> {
  return screen.findByRole("status", {
    name: /Traycer host update available: 1\.4\.2/i,
  });
}

function queryHostUpdateBanner(): HTMLElement | null {
  return screen.queryByRole("status", {
    name: /Traycer host update/i,
  });
}

describe("HostUpdateBanner (Host Update Layer Redesign, D4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset persistent zustand state so a snooze written by one test does
    // not leak into the next.
    useHostUpdateBannerStore.setState({ snoozeUntilByVersion: {} });
  });
  afterEach(() => {
    cleanup();
  });

  it("renders 'Update now' when the status is updateReady", async () => {
    const management = makeManagement({ status: READY_STATUS });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
    expect(screen.getByText(/1\.4\.2/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Update now/i })).toBeTruthy();
  });

  it("stays hidden when up to date (no debt, activation:'activated')", async () => {
    const management = makeManagement({ status: UP_TO_DATE_STATUS });
    renderBanner(makeHost(management));
    await new Promise((r) => setTimeout(r, 20));
    expect(queryHostUpdateBanner()).toBeNull();
  });

  it("never shows for a merely-detected update (latestVersion ahead but not staged/ready)", async () => {
    const management = makeManagement({
      status: {
        ...UP_TO_DATE_STATUS,
        latestVersion: "1.5.0",
        stagedVersion: null,
        updateReady: false,
      },
    });
    renderBanner(makeHost(management));
    await new Promise((r) => setTimeout(r, 20));
    expect(queryHostUpdateBanner()).toBeNull();
  });

  it.each(["pendingActivation", "activationUnknown"] as const)(
    "renders 'Restart host' identically for activation debt (%s)",
    async (activation) => {
      const management = makeManagement({
        status: { ...UP_TO_DATE_STATUS, activation },
      });
      renderBanner(makeHost(management));
      expect(
        await screen.findByRole("button", { name: /Restart host/i }),
      ).toBeTruthy();
    },
  );

  it("activation:'unavailable' suppresses debt UI (direct projection)", async () => {
    const management = makeManagement({
      status: { ...UP_TO_DATE_STATUS, activation: "unavailable" },
    });
    renderBanner(makeHost(management));
    await new Promise((r) => setTimeout(r, 20));
    expect(queryHostUpdateBanner()).toBeNull();
  });

  it("update-over-debt priority: updateReady + activation debt renders the update copy, and the click submits applyStaged (direct projection)", async () => {
    const applyStaged = vi.fn(() =>
      Promise.resolve<MutationOutcome<ApplyStagedOk>>({
        kind: "ok",
        value: { appliedVersion: "1.4.2", runningActivated: true },
      }),
    );
    const activateInstalled = vi.fn(() =>
      Promise.resolve<MutationOutcome<ActivateInstalledOk>>({
        kind: "ok",
        value: { activated: true },
      }),
    );
    const management = makeManagement({
      status: { ...READY_STATUS, activation: "pendingActivation" },
      applyStaged,
      activateInstalled,
    });
    renderBanner(makeHost(management));

    const button = await screen.findByRole("button", { name: /Update now/i });
    expect(screen.queryByRole("button", { name: /Restart host/i })).toBeNull();
    fireEvent.click(button);

    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledWith("manual", false);
    });
    expect(activateInstalled).not.toHaveBeenCalled();
  });

  it("invokes applyStaged when 'Update now' is clicked and shows success toast, clearing the snooze", async () => {
    const applyStaged = vi.fn(() =>
      Promise.resolve<MutationOutcome<ApplyStagedOk>>({
        kind: "ok",
        value: { appliedVersion: "1.4.2", runningActivated: true },
      }),
    );
    const management = makeManagement({
      status: READY_STATUS,
      applyStaged,
    });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    useHostUpdateBannerStore
      .getState()
      .snooze("1.4.2", Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS);
    fireEvent.click(button);
    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledWith("manual", false);
    });
    await waitFor(() => {
      const snoozes = useHostUpdateBannerStore.getState().snoozeUntilByVersion;
      expect(Object.hasOwn(snoozes, "1.4.2")).toBe(false);
    });
  });

  it("opens the Force/Defer dialog on a busy outcome, Force following continuation:'retry-with-force'", async () => {
    const applyStaged = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "busy" as const,
        continuation: "retry-with-force" as const,
        message: "Another Traycer process is applying an update.",
      })
      .mockResolvedValueOnce({
        kind: "ok" as const,
        value: { appliedVersion: "1.4.2", runningActivated: true },
      });
    const management = makeManagement({ status: READY_STATUS, applyStaged });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    fireEvent.click(button);

    const dialog = await screen.findByTestId("host-busy-force-defer-dialog");
    expect(dialog.textContent).toContain(
      "Another Traycer process is applying an update.",
    );
    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledWith("manual", true);
    });
  });

  it("Force follows continuation:'activate' by submitting activateInstalled, not re-running apply", async () => {
    const applyStaged = vi.fn(() =>
      Promise.resolve({
        kind: "busy" as const,
        continuation: "activate" as const,
        message: "Update already committed; activation is pending.",
      }),
    );
    const activateInstalled = vi.fn(() =>
      Promise.resolve<MutationOutcome<ActivateInstalledOk>>({
        kind: "ok",
        value: { activated: true },
      }),
    );
    const management = makeManagement({
      status: READY_STATUS,
      applyStaged,
      activateInstalled,
    });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    fireEvent.click(button);

    await screen.findByTestId("host-busy-force-defer-dialog");
    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(activateInstalled).toHaveBeenCalledWith(true);
    });
    expect(applyStaged).toHaveBeenCalledTimes(1);
  });

  it("Defer dismisses the busy dialog without re-submitting", async () => {
    const applyStaged = vi.fn(() =>
      Promise.resolve({
        kind: "busy" as const,
        continuation: "retry-with-force" as const,
        message: "Another Traycer process is applying an update.",
      }),
    );
    const management = makeManagement({ status: READY_STATUS, applyStaged });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    fireEvent.click(button);

    await screen.findByTestId("host-busy-force-defer-dialog");
    fireEvent.click(screen.getByTestId("host-busy-defer"));
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
    expect(applyStaged).toHaveBeenCalledTimes(1);
  });

  it("renders its own deferred-lock outcome inline, with Retry", async () => {
    const applyStaged = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "deferred" as const,
        message: "Another Traycer process is managing the host.",
      })
      .mockResolvedValueOnce({
        kind: "ok" as const,
        value: { appliedVersion: "1.4.2", runningActivated: true },
      });
    const management = makeManagement({ status: READY_STATUS, applyStaged });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    fireEvent.click(button);

    const deferred = await screen.findByTestId("host-update-banner-deferred");
    expect(deferred.textContent).toContain(
      "Another Traycer process is managing the host.",
    );

    fireEvent.click(screen.getByTestId("host-update-banner-retry"));
    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-update-banner-deferred")).toBeNull();
    });
  });

  it("hides when a pushed controller-status status clears updateReady", async () => {
    const statusBridge = createStatusBridge();
    const management = makeManagement({ status: READY_STATUS });
    const host = Object.assign(makeHost(management), {
      hostControllerStatus: statusBridge.bridge,
    });
    renderBannerWithStatusListener(host);
    expect(await findHostUpdateBanner()).toBeTruthy();

    act(() => {
      statusBridge.emit({
        ...UP_TO_DATE_STATUS,
        installedVersion: "1.4.2",
      });
    });

    await waitFor(() => {
      expect(queryHostUpdateBanner()).toBeNull();
    });
  });

  it("renders nothing when hostManagement is null (mobile/web)", () => {
    renderBanner(makeHost(null));

    expect(queryHostUpdateBanner()).toBeNull();
  });

  // Snooze flow - keyed to the persistent `useHostUpdateBannerStore`.
  // The store is reset in beforeEach so these tests cannot bleed into
  // each other.
  it("hides the banner after clicking the snooze (X) button", async () => {
    const management = makeManagement({ status: READY_STATUS });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
    const snoozeBtn = screen.getByRole("button", { name: /Remind me later/i });
    fireEvent.click(snoozeBtn);
    await waitFor(() => {
      expect(queryHostUpdateBanner()).toBeNull();
    });
    // Persisted store should now hold an entry for the snoozed version.
    const snoozes = useHostUpdateBannerStore.getState().snoozeUntilByVersion;
    expect(Object.hasOwn(snoozes, "1.4.2")).toBe(true);
    expect(snoozes["1.4.2"]).toBeGreaterThan(Date.now());
  });

  it("stays hidden when a non-expired snooze exists for the current stagedVersion", async () => {
    // Pre-seed the store with a snooze that has not yet expired.
    useHostUpdateBannerStore.setState({
      snoozeUntilByVersion: {
        "1.4.2": Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS,
      },
    });
    const management = makeManagement({ status: READY_STATUS });
    renderBanner(makeHost(management));
    await new Promise((r) => setTimeout(r, 20));
    expect(queryHostUpdateBanner()).toBeNull();
  });

  it("re-appears when the snooze entry has expired (snoozeUntil < now)", async () => {
    useHostUpdateBannerStore.setState({
      snoozeUntilByVersion: {
        // Snooze expired one hour ago.
        "1.4.2": Date.now() - 60 * 60 * 1000,
      },
    });
    const management = makeManagement({ status: READY_STATUS });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
  });

  it("re-arms when stagedVersion advances past the snoozed version (snooze is per-version)", async () => {
    // User snoozed v1.4.1; now the stage reports v1.4.2.
    useHostUpdateBannerStore.setState({
      snoozeUntilByVersion: {
        "1.4.1": Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS,
      },
    });
    const management = makeManagement({ status: READY_STATUS });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
  });
});
