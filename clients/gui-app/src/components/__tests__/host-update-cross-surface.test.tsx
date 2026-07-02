import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostUpdateBanner } from "@/components/home/host-update-banner";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { useHostUpdateBannerStore } from "@/stores/settings/host-update-banner-store";
import type {
  HostInstallResult,
  HostInstalledRecord,
  HostOperationStatus,
  HostRegistryUpdateState,
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";

// Ticket: host-update-race-conditions. Reported bug: triggering an update
// from the landing-page banner left the Settings → Host "Update" button
// clickable, and clicking it there threw the CLI's "update locked" error
// while the banner still spun. Both surfaces now read one shared
// `hostOperationStatus` query - primed via `getOperationStatus()` and pushed
// by `HostOperationStatusListener` in production. Here we push it directly
// via `queryClient.setQueryData`, exactly the mechanism the listener uses,
// to prove BOTH surfaces observe the SAME state regardless of which one
// triggered the mutation.

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

function makeManagement(overrides: {
  readonly updateHost: () => Promise<HostInstallResult>;
}): IHostManagement {
  const notImplemented =
    (method: string) =>
    (..._args: unknown[]): Promise<never> =>
      Promise.reject(new Error(`${method} not implemented in mock`));
  const registryState: HostRegistryUpdateState = {
    checkedAt: "2026-05-15T00:00:00Z",
    latestVersion: "1.5.0",
    installedVersion: "1.4.2",
    updateAvailable: true,
    reachable: true,
    errorMessage: null,
  };
  const installedRecord: HostInstalledRecord = {
    version: "1.4.2",
    installedAt: "2026-05-10T00:00:00Z",
    executablePath: "/tmp/traycer/1.4.2/host",
    source: { kind: "registry", value: "1.4.2" },
    archiveSha256: "abc",
    signatureKeyId: "key",
    sizeBytes: 1024,
    signatureVerifiedAt: "2026-05-10T00:00:00Z",
    platform: "darwin",
    arch: "arm64",
  };
  return {
    installHost: vi.fn(notImplemented("installHost")),
    updateHost: vi.fn(overrides.updateHost),
    uninstallHost: vi.fn(notImplemented("uninstallHost")),
    restartHost: vi.fn(() => Promise.resolve()),
    uninstallTraycer: vi.fn(notImplemented("uninstallTraycer")),
    getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    clearRemoval: vi.fn(() => Promise.resolve()),
    getHostLogs: vi.fn(() => Promise.resolve({ path: null, tail: "" })),
    runDoctor: vi.fn(() => Promise.resolve({ issues: [], ranAt: "" })),
    availableVersions: vi.fn(() =>
      Promise.resolve({
        generatedAt: "2026-05-15T00:00:00Z",
        latest: "1.5.0",
        platformKey: "darwin-arm64",
        manifestUrl: "",
        versions: [],
      }),
    ),
    installedRecord: vi.fn(() => Promise.resolve(installedRecord)),
    registerService: vi.fn(notImplemented("registerService")),
    ensureHost: vi.fn(notImplemented("ensureHost")),
    deregisterService: vi.fn(notImplemented("deregisterService")),
    registryCheck: vi.fn(() => Promise.resolve(registryState)),
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

function makeHost(management: IHostManagement): IRunnerHost {
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
    hostManagement: management,
    hostTray: null,
  });
}

function renderBothSurfaces(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostUpdateBanner className={undefined} />
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("host update - shared state across the banner and Settings → Host", () => {
  afterEach(() => {
    cleanup();
    useHostUpdateBannerStore.setState({ snoozeUntilByVersion: {} });
  });

  it("disables Settings' Update button and shows the shared percent once the banner's update is broadcast as in-progress", async () => {
    let resolveUpdate: (value: HostInstallResult) => void = () => undefined;
    const updateHost = vi.fn(
      () =>
        new Promise<HostInstallResult>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const management = makeManagement({ updateHost });
    const queryClient = renderBothSurfaces(makeHost(management));

    const bannerInstallButton = await screen.findByRole("button", {
      name: /^Install$/,
    });
    const settingsUpdateButton = await screen.findByRole("button", {
      name: /^Update$/,
    });
    expect(settingsUpdateButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(bannerInstallButton);
    await waitFor(() => {
      expect(updateHost).toHaveBeenCalledTimes(1);
    });

    // Before the shared status push arrives, Settings' button is driven
    // purely by its OWN (never-triggered) mutation - it is NOT yet disabled.
    // This is the exact bug being fixed: without the shared broadcast, a
    // click here would race the banner's in-flight CLI subprocess.
    expect(settingsUpdateButton.hasAttribute("disabled")).toBe(false);

    // Simulate the main-process broadcast `HostOperationStatusListener`
    // pipes into this same query cache entry once the banner's update
    // actually starts running on the CLI side.
    act(() => {
      queryClient.setQueryData<HostOperationStatus>(
        runnerQueryKeys.hostOperationStatus(management),
        {
          operationId: "op-1",
          kind: "update",
          stage: "download",
          percent: 37,
          bytes: 37,
          totalBytes: 100,
          message: "downloading",
          startedAt: "2026-05-15T00:00:00Z",
        },
      );
    });

    await waitFor(() => {
      expect(settingsUpdateButton.hasAttribute("disabled")).toBe(true);
    });
    // Both surfaces render the same percent, driven by the same query.
    const percentReadouts = await screen.findAllByText("37%");
    expect(percentReadouts.length).toBeGreaterThanOrEqual(1);

    act(() => {
      queryClient.setQueryData<HostOperationStatus | null>(
        runnerQueryKeys.hostOperationStatus(management),
        null,
      );
    });
    resolveUpdate({
      version: "1.5.0",
      installedAt: "2026-05-15T00:00:00Z",
      executablePath: "/tmp/traycerd",
      source: { kind: "registry", value: "1.5.0" },
      archiveSha256: "deadbeef",
      signatureKeyId: "stub",
      sizeBytes: 1024,
      previousVersion: "1.4.2",
      serviceLifecycle: {
        priorServiceState: "running",
        stoppedBeforeSwap: true,
        postSwapAction: "restart",
        postSwapError: null,
      },
    });

    await waitFor(() => {
      expect(settingsUpdateButton.hasAttribute("disabled")).toBe(false);
    });
  });

  it("a shared in-progress status from another surface disables the banner's Install button even though the banner never called updateHost itself", async () => {
    const updateHost = vi.fn(
      () => new Promise<HostInstallResult>(() => undefined),
    );
    const management = makeManagement({ updateHost });
    const queryClient = renderBothSurfaces(makeHost(management));

    const bannerInstallButton = await screen.findByRole("button", {
      name: /^Install$/,
    });
    expect(bannerInstallButton.hasAttribute("disabled")).toBe(false);

    // Settings (or the background auto-update reconciler) started the
    // operation - the banner never touched its own mutation.
    act(() => {
      queryClient.setQueryData<HostOperationStatus>(
        runnerQueryKeys.hostOperationStatus(management),
        {
          operationId: "op-2",
          kind: "update",
          stage: null,
          percent: null,
          bytes: null,
          totalBytes: null,
          message: null,
          startedAt: "2026-05-15T00:00:00Z",
        },
      );
    });

    await waitFor(() => {
      expect(bannerInstallButton.hasAttribute("disabled")).toBe(true);
    });
    expect(updateHost).not.toHaveBeenCalled();
  });
});
