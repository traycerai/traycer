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
import { HostRegistryUpdateListener } from "@/components/layout/bridges/host-registry-update-listener";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  HOST_UPDATE_BANNER_SNOOZE_MS,
  useHostUpdateBannerStore,
} from "@/stores/settings/host-update-banner-store";
import type {
  HostInstallResult,
  HostRegistryUpdateState,
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { DesktopHostRegistryUpdatesBridge } from "@/lib/windows/types";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

interface Overrides {
  readonly registryCheck?: () => Promise<HostRegistryUpdateState>;
  readonly updateHost?: () => Promise<HostInstallResult>;
}

function makeManagement(overrides: Overrides): IHostManagement {
  const notImplemented = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`${method} not implemented`));
  return {
    installHost: vi.fn(notImplemented("installHost")),
    updateHost: vi.fn(overrides.updateHost ?? notImplemented("updateHost")),
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
    ensureHost: vi.fn(notImplemented("ensureHost")),
    deregisterService: vi.fn(notImplemented("deregisterService")),
    registryCheck:
      overrides.registryCheck ??
      vi.fn(() =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
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

function renderBannerWithRegistryListener(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostRegistryUpdateListener />
        <HostUpdateBanner className={undefined} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function createRegistryUpdatesBridge(): {
  readonly bridge: DesktopHostRegistryUpdatesBridge;
  readonly emit: (state: HostRegistryUpdateState) => void;
} {
  const handlers = new Set<(state: HostRegistryUpdateState) => void>();
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
    emit: (state) => {
      for (const handler of handlers) {
        handler(state);
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
    name: /Traycer host update available/i,
  });
}

describe("HostUpdateBanner (Flow 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset persistent zustand state so a snooze written by one test does
    // not leak into the next.
    useHostUpdateBannerStore.setState({ snoozeUntilByVersion: {} });
  });
  afterEach(() => {
    cleanup();
  });

  it("renders Install button when registryCheck reports an update available", async () => {
    const management = makeManagement({
      registryCheck: () =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: "1.4.1",
          updateAvailable: true,
          reachable: true,
          errorMessage: null,
        }),
    });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
    expect(screen.getByText(/1\.4\.2/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Install/i })).toBeTruthy();
  });

  it("stays hidden when no update is available", async () => {
    const management = makeManagement({
      registryCheck: () =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.1",
          installedVersion: "1.4.1",
          updateAvailable: false,
          reachable: true,
          errorMessage: null,
        }),
    });
    renderBanner(makeHost(management));
    await new Promise((r) => setTimeout(r, 20));
    expect(queryHostUpdateBanner()).toBeNull();
  });

  it("stays hidden when the registry probe was not reachable", async () => {
    const management = makeManagement({
      registryCheck: () =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: null,
          installedVersion: "1.4.1",
          updateAvailable: false,
          reachable: false,
          errorMessage: "offline",
        }),
    });
    renderBanner(makeHost(management));
    await new Promise((r) => setTimeout(r, 20));
    expect(queryHostUpdateBanner()).toBeNull();
  });

  it("invokes updateHost when Install is clicked and invalidates the registry cache", async () => {
    const updateHost = vi.fn(() =>
      Promise.resolve<HostInstallResult>({
        version: "1.4.2",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/tmp/traycerd",
        source: { kind: "registry", value: "1.4.2" },
        archiveSha256: "deadbeef",
        signatureKeyId: "stub",
        sizeBytes: 1024,
        previousVersion: "1.4.1",
        serviceLifecycle: {
          priorServiceState: "running",
          stoppedBeforeSwap: true,
          postSwapAction: "restart",
          postSwapError: null,
        },
      }),
    );
    const management = makeManagement({
      registryCheck: () =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: "1.4.1",
          updateAvailable: true,
          reachable: true,
          errorMessage: null,
        }),
      updateHost,
    });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Install/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(updateHost).toHaveBeenCalledTimes(1);
    });
  });

  it("hides when the desktop registry update event clears availability", async () => {
    const updates = createRegistryUpdatesBridge();
    const management = makeManagement({
      registryCheck: () =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: "1.4.1",
          updateAvailable: true,
          reachable: true,
          errorMessage: null,
        }),
    });
    const host = Object.assign(makeHost(management), {
      hostRegistryUpdates: updates.bridge,
    });
    renderBannerWithRegistryListener(host);
    expect(await findHostUpdateBanner()).toBeTruthy();

    act(() => {
      updates.emit({
        checkedAt: "2026-05-15T00:01:00Z",
        latestVersion: "1.4.2",
        installedVersion: "1.4.2",
        updateAvailable: false,
        reachable: true,
        errorMessage: null,
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
    const management = makeManagement({
      registryCheck: () =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: "1.4.1",
          updateAvailable: true,
          reachable: true,
          errorMessage: null,
        }),
    });
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

  it("stays hidden when a non-expired snooze exists for the current latestVersion", async () => {
    // Pre-seed the store with a snooze that has not yet expired.
    useHostUpdateBannerStore.setState({
      snoozeUntilByVersion: {
        "1.4.2": Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS,
      },
    });
    const management = makeManagement({
      registryCheck: () =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: "1.4.1",
          updateAvailable: true,
          reachable: true,
          errorMessage: null,
        }),
    });
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
    const management = makeManagement({
      registryCheck: () =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: "1.4.1",
          updateAvailable: true,
          reachable: true,
          errorMessage: null,
        }),
    });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
  });

  it("re-arms when latestVersion advances past the snoozed version (snooze is per-version)", async () => {
    // User snoozed v1.4.1; now the registry reports v1.4.2.
    useHostUpdateBannerStore.setState({
      snoozeUntilByVersion: {
        "1.4.1": Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS,
      },
    });
    const management = makeManagement({
      registryCheck: () =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: "1.4.0",
          updateAvailable: true,
          reachable: true,
          errorMessage: null,
        }),
    });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
  });

  it("clears the snooze for the installed version after a successful install via the Install button", async () => {
    // Start with no snooze so the banner renders. The Install onSuccess
    // calls clearSnooze(data.version); to prove the wiring works we
    // re-snooze v1.4.2 right before the click so the post-install
    // clearSnooze has something to remove.
    const updateHost = vi.fn(() =>
      Promise.resolve<HostInstallResult>({
        version: "1.4.2",
        installedAt: "2026-05-15T00:00:00Z",
        executablePath: "/tmp/traycerd",
        source: { kind: "registry", value: "1.4.2" },
        archiveSha256: "deadbeef",
        signatureKeyId: "stub",
        sizeBytes: 1024,
        previousVersion: "1.4.1",
        serviceLifecycle: {
          priorServiceState: "running",
          stoppedBeforeSwap: true,
          postSwapAction: "restart",
          postSwapError: null,
        },
      }),
    );
    const management = makeManagement({
      registryCheck: () =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: "1.4.1",
          updateAvailable: true,
          reachable: true,
          errorMessage: null,
        }),
      updateHost,
    });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Install/i });
    useHostUpdateBannerStore
      .getState()
      .snooze("1.4.2", Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS);
    expect(
      Object.hasOwn(
        useHostUpdateBannerStore.getState().snoozeUntilByVersion,
        "1.4.2",
      ),
    ).toBe(true);
    fireEvent.click(button);
    await waitFor(() => {
      expect(updateHost).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      const snoozes = useHostUpdateBannerStore.getState().snoozeUntilByVersion;
      expect(Object.hasOwn(snoozes, "1.4.2")).toBe(false);
    });
  });
});
