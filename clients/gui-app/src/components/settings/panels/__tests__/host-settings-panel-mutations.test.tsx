import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { toast } from "sonner";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import type {
  ApplyStagedOk,
  ConvergeReadyOk,
  HostAvailableSnapshot,
  HostControllerStatus,
  HostInstalledRecord,
  HostRegistryUpdateState,
  IHostManagement,
  InstallVersionOk,
  IRunnerHost,
  LocalHostSnapshot,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.message).mockClear();
});

describe("<HostSettingsPanel /> - mutation flows", () => {
  it("opens a confirmation dialog before restarting the host", async () => {
    const restartHost = vi.fn(() => Promise.resolve());
    const { management } = makeManagement({ restartHost });

    renderPanel(makeHost(management, makeLocalHostSnapshot()));

    const restartButton = await waitForButton("Restart");
    fireEvent.click(restartButton);

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("in-progress agents");
    expect(restartHost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(restartHost).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).toHaveBeenCalledWith("Host restart requested");
  });

  it("saves a custom host name from the Host settings page", async () => {
    const setHostName = vi.fn((input: { readonly customName: string | null }) =>
      Promise.resolve({
        systemName: "hardiks-macbook",
        customName: input.customName,
        effectiveName: input.customName ?? "hardiks-macbook",
      }),
    );
    const { management } = makeManagement({ setHostName });

    renderPanel(makeHost(management, makeLocalHostSnapshot()));

    const input = await screen.findByRole("textbox", {
      name: "Display Name",
    });
    await waitFor(() => {
      if (input.hasAttribute("disabled")) {
        throw new Error("Host name input still disabled");
      }
    });
    fireEvent.change(input, { target: { value: "  Studio   Mac  " } });
    fireEvent.click(await waitForButton("Save"));

    await waitFor(() => {
      expect(setHostName).toHaveBeenCalledWith({
        customName: "Studio Mac",
      });
    });
    expect(toast.success).toHaveBeenCalledWith("Host name updated");
  });

  it("runs applyStaged and shows a success toast once a stage is updateReady", async () => {
    const applyStaged = vi.fn(() =>
      Promise.resolve<MutationOutcome<ApplyStagedOk>>({
        kind: "ok",
        value: { appliedVersion: "2.0.0", runningActivated: true },
      }),
    );
    const status: HostControllerStatus = {
      download: null,
      mutation: null,
      installedVersion: "1.4.2",
      latestVersion: "2.0.0",
      stagedVersion: "2.0.0",
      installedRuntimeVersion: null,
      runningRuntimeVersion: null,
      updateReady: true,
      activation: "activated",
      reachable: true,
      removedByUser: false,
      checkedAt: "2026-05-15T00:00:00Z",
    };
    const { management } = makeManagement({
      applyStaged,
      status,
      // Provide an installedRecord so the panel's status derives as
      // "stopped" (not "not-installed") - the Updates row is hidden when
      // no host is installed, since "Up to date" next to "Not installed"
      // is internally contradictory.
      installedRecord: vi.fn(() =>
        Promise.resolve(makeInstalledRecord("1.4.2")),
      ),
    });

    renderPanel(makeHost(management, null));

    const updateButton = await waitForButton("Update");
    fireEvent.click(updateButton);

    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledWith("manual", false);
    });
    expect(toast.success).toHaveBeenCalledWith("Updated host to v2.0.0");
  });

  it("surfaces the install progress banner when the shared mutation lane reports progress", async () => {
    // The panel no longer wires its own `onProgress` callback (Host Update
    // Layer Redesign) - progress is read from the shared canonical
    // `HostControllerStatus` query, which in production is pushed by
    // `HostControllerStatusListener`. Here we push it directly via
    // `queryClient.setQueryData`, the same mechanism the listener uses.
    let resolveConverge: (
      value: MutationOutcome<ConvergeReadyOk>,
    ) => void = () => undefined;
    const convergeReady = vi.fn(
      () =>
        new Promise<MutationOutcome<ConvergeReadyOk>>((resolve) => {
          resolveConverge = resolve;
        }),
    );
    // No installed record → status is "not-installed", so the Actions row
    // exposes "Install host".
    const { management } = makeManagement({
      convergeReady,
      installedRecord: vi.fn(() => Promise.resolve(null)),
    });

    const queryClient = renderPanel(makeHost(management, null));

    const installButton = await waitForButton("Install host");
    fireEvent.click(installButton);

    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
    });

    act(() => {
      queryClient.setQueryData<HostControllerStatus>(
        runnerQueryKeys.hostControllerStatus(management),
        {
          download: null,
          mutation: {
            kind: "ensure",
            progress: {
              stage: "download",
              percent: 42,
              bytes: 100,
              totalBytes: 240,
              message: "downloading",
            },
            startedAt: "2026-05-15T00:00:00Z",
          },
          installedVersion: null,
          latestVersion: null,
          stagedVersion: null,
          installedRuntimeVersion: null,
          runningRuntimeVersion: null,
          updateReady: false,
          activation: "unavailable",
          reachable: false,
          removedByUser: false,
          checkedAt: "2026-05-15T00:00:00Z",
        },
      );
    });

    const banner = await screen.findByTestId("settings-host-progress");
    expect(banner.textContent).toContain("Setting up host");
    expect(banner.textContent).toContain("download");
    expect(
      (await screen.findByTestId("settings-host-progress-percent")).textContent,
    ).toBe("42%");

    act(() => {
      queryClient.setQueryData<HostControllerStatus>(
        runnerQueryKeys.hostControllerStatus(management),
        {
          download: null,
          mutation: null,
          installedVersion: "1.4.2",
          latestVersion: null,
          stagedVersion: null,
          installedRuntimeVersion: null,
          runningRuntimeVersion: null,
          updateReady: false,
          activation: "activated",
          reachable: true,
          removedByUser: false,
          checkedAt: "2026-05-15T00:00:00Z",
        },
      );
    });
    resolveConverge({
      kind: "ok",
      value: { running: true, version: "1.4.2" },
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Installed host v1.4.2");
    });
  });

  it("no longer exposes Reinstall or Uninstall in the Advanced section", async () => {
    const { management } = makeManagement({
      installedRecord: vi.fn(() =>
        Promise.resolve(makeInstalledRecord("1.4.2")),
      ),
    });

    renderPanel(makeHost(management, null));

    await openAdvancedDisclosure();
    // The OS service controls still live under Advanced...
    await waitForButton("Re-register");
    // ...but the Installation section (Reinstall / Uninstall) is gone.
    expect(screen.queryByRole("button", { name: /^Reinstall$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Uninstall$/ })).toBeNull();
  });

  it("passes the include prereleases filter when the Advanced version picker checkbox is selected", async () => {
    const availableVersions = vi.fn(
      (_input: { readonly includePreReleases: boolean }) =>
        Promise.resolve(makeAvailableSnapshot()),
    );
    const { management } = makeManagement({ availableVersions });

    renderPanel(makeHost(management, null));

    await waitFor(() => {
      expect(availableVersions).toHaveBeenCalledWith({
        includePreReleases: false,
      });
    });
    await openAdvancedDisclosure();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /include release candidates/i,
      }),
    );

    await waitFor(() => {
      expect(availableVersions).toHaveBeenCalledWith({
        includePreReleases: true,
      });
    });
  });

  it("disables advanced pin install when the registry asset is unavailable", async () => {
    const installVersion = vi.fn(() =>
      Promise.resolve<MutationOutcome<InstallVersionOk>>({
        kind: "ok",
        value: { installedVersion: "1.4.2", runningActivated: true },
      }),
    );
    const availableVersions = vi.fn(() =>
      Promise.resolve(makeUnavailableAvailableSnapshot()),
    );
    const { management } = makeManagement({
      installVersion,
      availableVersions,
      registryCheck: vi.fn(() =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: null,
          updateAvailable: false,
          reachable: true,
          errorMessage: null,
        }),
      ),
    });

    renderPanel(makeHost(management, null));

    await openAdvancedDisclosure();
    expect(
      await screen.findByText("Build unavailable for this platform."),
    ).toBeTruthy();
    const installButton = screen.getByRole("button", { name: "Install" });
    expect(installButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(installButton);
    expect(installVersion).not.toHaveBeenCalled();
  });

  it("uses the default advanced install reason for blank unavailable reasons", async () => {
    const availableVersions = vi.fn(() =>
      Promise.resolve(makeUnavailableAvailableSnapshotWithReason("   ")),
    );
    const { management } = makeManagement({
      availableVersions,
      registryCheck: vi.fn(() =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: null,
          updateAvailable: false,
          reachable: true,
          errorMessage: null,
        }),
      ),
    });

    renderPanel(makeHost(management, null));

    await openAdvancedDisclosure();
    expect(
      await screen.findByText("Unavailable on this platform."),
    ).toBeTruthy();
    const installButton = screen.getByRole("button", { name: "Install" });
    expect(installButton.hasAttribute("disabled")).toBe(true);
    expect(installButton.getAttribute("title")).toBe(
      "Unavailable on this platform.",
    );
  });
});

async function openAdvancedDisclosure(): Promise<void> {
  const trigger = await waitFor(() =>
    screen.getByRole("button", { name: "Advanced" }),
  );
  if (trigger.getAttribute("data-state") !== "open") {
    fireEvent.click(trigger);
  }
}

async function waitForButton(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const button = screen.getByRole("button", {
      name: new RegExp(`^${escapeRegex(name)}$`),
    });
    if (button.hasAttribute("disabled")) {
      throw new Error(`${name} button still disabled`);
    }
    return button;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ManagementOverrides {
  readonly status: HostControllerStatus | undefined;
  readonly convergeReady: Mock | undefined;
  readonly applyStaged: Mock | undefined;
  readonly activateInstalled: Mock | undefined;
  readonly installVersion: Mock | undefined;
  readonly uninstallHost: Mock | undefined;
  readonly restartHost: Mock | undefined;
  readonly registerService: Mock | undefined;
  readonly deregisterService: Mock | undefined;
  readonly registryCheck: Mock | undefined;
  readonly installedRecord: Mock | undefined;
  readonly availableVersions: Mock | undefined;
  readonly cliManifest: Mock | undefined;
  readonly getHostName: Mock | undefined;
  readonly setHostName: Mock | undefined;
}

interface ManagementResult {
  readonly management: IHostManagement;
}

const NOT_INSTALLED_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: null,
  latestVersion: null,
  stagedVersion: null,
  installedRuntimeVersion: null,
  runningRuntimeVersion: null,
  updateReady: false,
  activation: "unavailable",
  reachable: false,
  removedByUser: false,
  checkedAt: "2026-05-15T00:00:00Z",
};

function makeManagement(
  overrides: Partial<ManagementOverrides>,
): ManagementResult {
  const notImplemented =
    (method: string) =>
    (..._args: unknown[]): Promise<never> =>
      Promise.reject(new Error(`${method} not implemented in mock`));
  const status = overrides.status ?? NOT_INSTALLED_STATUS;
  const management: IHostManagement = {
    getHostControllerStatus: vi.fn(() => Promise.resolve(status)),
    convergeReady:
      overrides.convergeReady ?? vi.fn(notImplemented("convergeReady")),
    applyStaged: overrides.applyStaged ?? vi.fn(notImplemented("applyStaged")),
    activateInstalled:
      overrides.activateInstalled ?? vi.fn(notImplemented("activateInstalled")),
    installVersion:
      overrides.installVersion ?? vi.fn(notImplemented("installVersion")),
    uninstallHost:
      overrides.uninstallHost ?? vi.fn(notImplemented("uninstallHost")),
    restartHost: overrides.restartHost ?? vi.fn(() => Promise.resolve()),
    uninstallTraycer: vi.fn(notImplemented("uninstallTraycer")),
    getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    clearRemoval: vi.fn(() => Promise.resolve()),
    getHostLogs: vi.fn(() => Promise.resolve({ path: null, tail: "" })),
    runDoctor: vi.fn(() =>
      Promise.resolve({ issues: [], ranAt: "2026-05-15T00:00:00Z" }),
    ),
    availableVersions:
      overrides.availableVersions ??
      vi.fn(() => Promise.resolve(makeAvailableSnapshot())),
    installedRecord:
      overrides.installedRecord ?? vi.fn(() => Promise.resolve(null)),
    registerService:
      overrides.registerService ?? vi.fn(notImplemented("registerService")),
    deregisterService:
      overrides.deregisterService ?? vi.fn(() => Promise.resolve()),
    registryCheck:
      overrides.registryCheck ??
      vi.fn(() =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: null,
          latestVersion: null,
          installedVersion: null,
          updateAvailable: false,
          reachable: false,
          errorMessage: null,
        }),
      ),
    freePortAndRestart: vi.fn((input) => Promise.resolve(input)),
    cliManifest: overrides.cliManifest ?? vi.fn(() => Promise.resolve(null)),
    getHostName:
      overrides.getHostName ??
      vi.fn(() =>
        Promise.resolve({
          systemName: "hardiks-macbook",
          customName: null,
          effectiveName: "hardiks-macbook",
        }),
      ),
    setHostName:
      overrides.setHostName ??
      vi.fn((input: { readonly customName: string | null }) =>
        Promise.resolve({
          systemName: "hardiks-macbook",
          customName: input.customName,
          effectiveName: input.customName ?? "hardiks-macbook",
        }),
      ),
  };
  return { management };
}

function makeAvailableSnapshot(): HostAvailableSnapshot {
  return {
    generatedAt: "2026-05-15T00:00:00Z",
    latest: "1.4.2",
    platformKey: "darwin-arm64",
    manifestUrl: "",
    versions: [
      {
        version: "1.4.2",
        releasedAt: "2026-05-10T00:00:00Z",
        releaseNotesUrl: "",
        yanked: false,
        deprecationReason: null,
        platformAsset: {
          available: true,
          unavailableReason: null,
          url: "",
          sizeBytes: 1024,
          sha256: "",
          signatureUrl: "",
          publicKeyId: "",
        },
      },
    ],
  };
}

function makeUnavailableAvailableSnapshot(): HostAvailableSnapshot {
  return makeUnavailableAvailableSnapshotWithReason(
    "Build unavailable for this platform.",
  );
}

function makeUnavailableAvailableSnapshotWithReason(
  unavailableReason: string | null,
): HostAvailableSnapshot {
  const base = makeAvailableSnapshot();
  const entry = base.versions[0];
  return {
    ...base,
    versions: [
      {
        ...entry,
        platformAsset: {
          available: false,
          unavailableReason,
          url: "",
          sizeBytes: 1024,
          sha256: "",
          signatureUrl: "",
          publicKeyId: "",
        },
      },
    ],
  };
}

function makeInstalledRecord(version: string): HostInstalledRecord {
  return {
    version,
    installedAt: "2026-05-10T00:00:00Z",
    executablePath: `/tmp/traycer/${version}/host`,
    source: { kind: "registry", value: version },
    archiveSha256: "abc",
    signatureKeyId: "key",
    sizeBytes: 1024,
    signatureVerifiedAt: "2026-05-10T00:00:00Z",
    platform: "darwin",
    arch: "arm64",
  };
}

function makeHost(
  management: IHostManagement,
  localHost: LocalHostSnapshot | null,
): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost,
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

function makeLocalHostSnapshot(): LocalHostSnapshot {
  return {
    hostId: "test-host",
    websocketUrl: "ws://127.0.0.1:42123",
    version: "1.4.2",
    pid: 12345,
    systemHostName: "hardiks-macbook",
    displayName: "hardiks-macbook",
  };
}

function renderPanel(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}
