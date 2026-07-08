import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import type {
  CliInstallManifestSnapshot,
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

interface ManagementMock {
  readonly management: IHostManagement;
  readonly cliManifestMock: Mock;
}

function makeManagement(
  cliManifest: CliInstallManifestSnapshot | null,
): ManagementMock {
  const notImplemented =
    (method: string) =>
    (..._args: unknown[]): Promise<never> =>
      Promise.reject(new Error(`${method} not implemented in mock`));
  const cliManifestMock = vi.fn(() => Promise.resolve(cliManifest));
  const management: IHostManagement = {
    installHost: vi.fn(notImplemented("installHost")),
    updateHost: vi.fn(notImplemented("updateHost")),
    uninstallHost: vi.fn(notImplemented("uninstallHost")),
    restartHost: vi.fn(() => Promise.resolve()),
    uninstallTraycer: vi.fn(notImplemented("uninstallTraycer")),
    getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    clearRemoval: vi.fn(() => Promise.resolve()),
    getHostLogs: vi.fn(() => Promise.resolve({ path: null, tail: "" })),
    runDoctor: vi.fn(() =>
      Promise.resolve({ issues: [], ranAt: "2026-05-15T00:00:00Z" }),
    ),
    availableVersions: vi.fn(() =>
      Promise.resolve({
        generatedAt: "2026-05-15T00:00:00Z",
        latest: "1.4.2",
        platformKey: "darwin-arm64",
        manifestUrl: "",
        versions: [],
      }),
    ),
    installedRecord: vi.fn(() => Promise.resolve(null)),
    registerService: vi.fn(notImplemented("registerService")),
    ensureHost: vi.fn(notImplemented("ensureHost")),
    deregisterService: vi.fn(notImplemented("deregisterService")),
    getOperationStatus: vi.fn(() => Promise.resolve(null)),
    registryCheck: vi.fn(() =>
      Promise.resolve({
        checkedAt: null,
        latestVersion: null,
        installedVersion: null,
        updateAvailable: false,
        reachable: false,
        errorMessage: null,
      }),
    ),
    freePortAndRestart: vi.fn((input) => Promise.resolve(input)),
    cliManifest: cliManifestMock,
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
  return { management, cliManifestMock };
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

describe("<HostSettingsPanel /> - package-manager upgrade hint", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the hint with the source label and upgrade command when packageManagerUpgrade is present", async () => {
    const manifest: CliInstallManifestSnapshot = {
      version: "1.0.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: "/usr/local/Cellar/traycer/1.0.0/bin/traycer",
      source: "homebrew",
      pendingUpgrade: null,
      packageManagerUpgrade: {
        source: "homebrew",
        installedVersion: "1.0.0",
        bundledVersion: "1.4.2",
        upgradeCommand: "brew upgrade traycer",
        recordedAt: "2026-05-15T00:00:00Z",
      },
    };
    const { management } = makeManagement(manifest);
    const host = makeHost(management, null);

    renderPanel(host);

    const hint = await waitFor(() =>
      screen.findByTestId("settings-host-package-manager-upgrade-hint"),
    );
    expect(hint).not.toBeNull();
    expect(hint.textContent).toContain("Homebrew");
    expect(hint.textContent).toContain("1.0.0");
    expect(hint.textContent).toContain("1.4.2");
    const command = await screen.findByTestId(
      "settings-host-package-manager-upgrade-command",
    );
    expect(command.textContent).toBe("brew upgrade traycer");
  });

  it("renders npm package-manager upgrade hints", async () => {
    const manifest: CliInstallManifestSnapshot = {
      version: "1.0.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: "/usr/local/bin/traycer",
      source: "npm",
      pendingUpgrade: null,
      packageManagerUpgrade: {
        source: "npm",
        installedVersion: "1.0.0",
        bundledVersion: "1.4.2",
        upgradeCommand: "npm install -g @traycerai/cli@latest",
        recordedAt: "2026-05-15T00:00:00Z",
      },
    };
    const { management } = makeManagement(manifest);
    const host = makeHost(management, null);

    renderPanel(host);

    const hint = await waitFor(() =>
      screen.findByTestId("settings-host-package-manager-upgrade-hint"),
    );
    expect(hint.textContent).toContain("npm");
    const command = await screen.findByTestId(
      "settings-host-package-manager-upgrade-command",
    );
    expect(command.textContent).toBe("npm install -g @traycerai/cli@latest");
  });

  it("does not render the hint when packageManagerUpgrade is null", async () => {
    const manifest: CliInstallManifestSnapshot = {
      version: "1.4.2",
      installedAt: "2026-05-01T00:00:00Z",
      binaryPath: "/home/me/.traycer/cli/bin/traycer",
      source: "desktop",
      pendingUpgrade: null,
      packageManagerUpgrade: null,
    };
    const { management, cliManifestMock } = makeManagement(manifest);
    const host = makeHost(management, null);

    renderPanel(host);

    // Allow microtasks for the query to resolve.
    await waitFor(() => {
      expect(cliManifestMock.mock.calls.length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByTestId("settings-host-package-manager-upgrade-hint"),
    ).toBeNull();
  });
});
