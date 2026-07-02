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
  HostAvailableSnapshot,
  HostInstallResult,
  HostInstalledRecord,
  HostOperationStatus,
  HostRegistryUpdateState,
  IHostManagement,
  IRunnerHost,
  LocalHostSnapshot,
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
    expect(dialog.textContent).toContain("in-progress chats");
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

  it("runs updateHost and shows the update banner when registry reports a newer version", async () => {
    const installResult = makeInstallResult("2.0.0");
    const updateHost = vi.fn(() => Promise.resolve(installResult));
    const registry: HostRegistryUpdateState = {
      checkedAt: "2026-05-15T00:00:00Z",
      latestVersion: "2.0.0",
      installedVersion: "1.4.2",
      updateAvailable: true,
      reachable: true,
      errorMessage: null,
    };
    const { management } = makeManagement({
      updateHost,
      registryCheck: vi.fn(() => Promise.resolve(registry)),
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
      expect(updateHost).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).toHaveBeenCalledWith("Updated host to v2.0.0");
  });

  it("surfaces the install progress banner when the shared operation status reports progress", async () => {
    // The panel no longer wires its own `onProgress` callback (Ticket:
    // host-update-race-conditions) - progress is read from the shared
    // `hostOperationStatus` query, which in production is pushed by
    // `HostOperationStatusListener`. Here we push it directly via
    // `queryClient.setQueryData`, the same mechanism the listener uses.
    let resolveInstall: (value: HostInstallResult) => void = () => undefined;
    const installHost = vi.fn(
      () =>
        new Promise<HostInstallResult>((resolve) => {
          resolveInstall = resolve;
        }),
    );
    // No installed record → status is "not-installed", so the Actions row
    // exposes "Install host" - the install entry point now that the
    // Advanced → Installation "Reinstall" button has been removed.
    const { management } = makeManagement({
      installHost,
      installedRecord: vi.fn(() => Promise.resolve(null)),
    });

    const queryClient = renderPanel(makeHost(management, null));

    const installButton = await waitForButton("Install host");
    fireEvent.click(installButton);

    await waitFor(() => {
      expect(installHost).toHaveBeenCalledTimes(1);
    });

    act(() => {
      queryClient.setQueryData<HostOperationStatus>(
        runnerQueryKeys.hostOperationStatus(management),
        {
          operationId: "op-1",
          kind: "install",
          stage: "download",
          percent: 42,
          bytes: 100,
          totalBytes: 240,
          message: "downloading",
          startedAt: "2026-05-15T00:00:00Z",
        },
      );
    });

    const banner = await screen.findByTestId("settings-host-progress");
    expect(banner.textContent).toContain("Installing host");
    expect(banner.textContent).toContain("download");
    expect(
      (await screen.findByTestId("settings-host-progress-percent")).textContent,
    ).toBe("42%");

    act(() => {
      queryClient.setQueryData<HostOperationStatus | null>(
        runnerQueryKeys.hostOperationStatus(management),
        null,
      );
    });
    resolveInstall(makeInstallResult("1.4.2"));
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

  it("disables advanced install when the registry asset is unavailable", async () => {
    const installHost = vi.fn(() =>
      Promise.resolve(makeInstallResult("1.4.2")),
    );
    const availableVersions = vi.fn(() =>
      Promise.resolve(makeUnavailableAvailableSnapshot()),
    );
    const { management } = makeManagement({
      installHost,
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
    expect(installHost).not.toHaveBeenCalled();
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
  readonly installHost: Mock | undefined;
  readonly updateHost: Mock | undefined;
  readonly uninstallHost: Mock | undefined;
  readonly restartHost: Mock | undefined;
  readonly registerService: Mock | undefined;
  readonly ensureHost: Mock | undefined;
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

function makeManagement(
  overrides: Partial<ManagementOverrides>,
): ManagementResult {
  const notImplemented =
    (method: string) =>
    (..._args: unknown[]): Promise<never> =>
      Promise.reject(new Error(`${method} not implemented in mock`));
  const management: IHostManagement = {
    installHost: overrides.installHost ?? vi.fn(notImplemented("installHost")),
    updateHost: overrides.updateHost ?? vi.fn(notImplemented("updateHost")),
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
    ensureHost: overrides.ensureHost ?? vi.fn(notImplemented("ensureHost")),
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
    getOperationStatus: vi.fn(() => Promise.resolve(null)),
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

function makeInstallResult(version: string): HostInstallResult {
  return {
    version,
    installedAt: "2026-05-15T00:00:00Z",
    executablePath: `/tmp/traycer/${version}/host`,
    source: { kind: "registry", value: version },
    archiveSha256: "abc",
    signatureKeyId: "key",
    sizeBytes: 1024,
    previousVersion: null,
    serviceLifecycle: {
      priorServiceState: "not-installed",
      stoppedBeforeSwap: false,
      postSwapAction: "none",
      postSwapError: null,
    },
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
