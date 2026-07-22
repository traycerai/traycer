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
  ApplyStagedOk,
  HostControllerStatus,
  HostInstalledRecord,
  IHostManagement,
  IRunnerHost,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";

// Ticket: renderer-surfaces-cutover (Host Update Layer Redesign). Reported
// bug (host-update-race-conditions): triggering an update from the
// landing-page banner left the Settings → Host "Update" button clickable,
// and clicking it there threw the CLI's "update locked" error while the
// banner still spun. Both surfaces now read one shared canonical
// `HostControllerStatus` query - primed via `getHostControllerStatus()` and
// pushed by `HostControllerStatusListener` in production. Here we push it
// directly via `queryClient.setQueryData`, exactly the mechanism the
// listener uses, to prove BOTH surfaces observe the SAME mutation-lane state
// regardless of which one triggered the mutation, and that a concurrent
// download-lane push does NOT disable either surface's button.

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

const READY_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: "1.4.2",
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

function makeManagement(overrides: {
  readonly applyStaged: () => Promise<MutationOutcome<ApplyStagedOk>>;
}): IHostManagement {
  const notImplemented =
    (method: string) =>
    (..._args: unknown[]): Promise<never> =>
      Promise.reject(new Error(`${method} not implemented in mock`));
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
    getHostControllerStatus: vi.fn(() => Promise.resolve(READY_STATUS)),
    convergeReady: vi.fn(notImplemented("convergeReady")),
    applyStaged: vi.fn(overrides.applyStaged),
    activateInstalled: vi.fn(notImplemented("activateInstalled")),
    installVersion: vi.fn(notImplemented("installVersion")),
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
    deregisterService: vi.fn(notImplemented("deregisterService")),
    registryCheck: vi.fn(() =>
      Promise.resolve({
        checkedAt: "2026-05-15T00:00:00Z",
        latestVersion: "1.5.0",
        installedVersion: "1.4.2",
        updateAvailable: true,
        reachable: true,
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

  it("disables Settings' Update button and shows the shared percent once the banner's apply is broadcast as in-progress", async () => {
    let resolveApply: (value: MutationOutcome<ApplyStagedOk>) => void = () =>
      undefined;
    const applyStaged = vi.fn(
      () =>
        new Promise<MutationOutcome<ApplyStagedOk>>((resolve) => {
          resolveApply = resolve;
        }),
    );
    const management = makeManagement({ applyStaged });
    const queryClient = renderBothSurfaces(makeHost(management));

    const bannerUpdateButton = await screen.findByRole("button", {
      name: /^Update now$/,
    });
    const settingsUpdateButton = await screen.findByTestId(
      "settings-host-update-action",
    );
    expect(settingsUpdateButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(bannerUpdateButton);
    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledTimes(1);
    });

    // Before the shared status push arrives, Settings' button is driven
    // purely by its OWN (never-triggered) mutation - it is NOT yet disabled.
    // This is the exact bug being fixed: without the shared broadcast, a
    // click here would race the banner's in-flight CLI subprocess.
    expect(settingsUpdateButton.hasAttribute("disabled")).toBe(false);

    // Simulate the main-process broadcast `HostControllerStatusListener`
    // pipes into this same query cache entry once the banner's apply
    // actually starts running on the CLI side.
    act(() => {
      queryClient.setQueryData<HostControllerStatus>(
        runnerQueryKeys.hostControllerStatus(management),
        {
          ...READY_STATUS,
          mutation: {
            kind: "apply",
            progress: {
              stage: "download",
              percent: 37,
              bytes: 37,
              totalBytes: 100,
              message: "downloading",
            },
            startedAt: "2026-05-15T00:00:00Z",
          },
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
      queryClient.setQueryData<HostControllerStatus>(
        runnerQueryKeys.hostControllerStatus(management),
        {
          ...READY_STATUS,
          installedVersion: "1.5.0",
          stagedVersion: null,
          updateReady: false,
          mutation: null,
        },
      );
    });
    resolveApply({
      kind: "ok",
      value: { appliedVersion: "1.5.0", runningActivated: true },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("settings-host-update-action")).toBeNull();
    });
  });

  it("a shared in-progress status from another surface disables the banner's Update button even though the banner never called applyStaged itself", async () => {
    const applyStaged = vi.fn(
      () => new Promise<MutationOutcome<ApplyStagedOk>>(() => undefined),
    );
    const management = makeManagement({ applyStaged });
    const queryClient = renderBothSurfaces(makeHost(management));

    const bannerUpdateButton = await screen.findByRole("button", {
      name: /^Update now$/,
    });
    expect(bannerUpdateButton.hasAttribute("disabled")).toBe(false);

    // Settings (or the background auto-update reconciler) started the
    // operation - the banner never touched its own mutation.
    act(() => {
      queryClient.setQueryData<HostControllerStatus>(
        runnerQueryKeys.hostControllerStatus(management),
        {
          ...READY_STATUS,
          mutation: {
            kind: "apply",
            progress: null,
            startedAt: "2026-05-15T00:00:00Z",
          },
        },
      );
    });

    await waitFor(() => {
      expect(bannerUpdateButton.hasAttribute("disabled")).toBe(true);
    });
    expect(applyStaged).not.toHaveBeenCalled();
  });

  it("a concurrent download-lane push does not disable either surface's action button", async () => {
    const applyStaged = vi.fn(
      () => new Promise<MutationOutcome<ApplyStagedOk>>(() => undefined),
    );
    const management = makeManagement({ applyStaged });
    const queryClient = renderBothSurfaces(makeHost(management));

    const bannerUpdateButton = await screen.findByRole("button", {
      name: /^Update now$/,
    });
    const settingsUpdateButton = await screen.findByTestId(
      "settings-host-update-action",
    );

    act(() => {
      queryClient.setQueryData<HostControllerStatus>(
        runnerQueryKeys.hostControllerStatus(management),
        {
          ...READY_STATUS,
          download: {
            version: "1.6.0",
            progress: { percent: 12, bytes: 12, totalBytes: 100 },
            lastError: null,
          },
        },
      );
    });

    // Give the pushed status a tick to propagate, then assert neither
    // surface's action disabled off it - the download lane must never gate
    // the mutation-lane buttons.
    await waitFor(() => {
      expect(management.getHostControllerStatus).toHaveBeenCalled();
    });
    expect(bannerUpdateButton.hasAttribute("disabled")).toBe(false);
    expect(settingsUpdateButton.hasAttribute("disabled")).toBe(false);
    expect(applyStaged).not.toHaveBeenCalled();
  });
});
