import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import type {
  HostPendingRevisionState,
  IHostManagement,
  IRunnerHost,
  LocalHostSnapshot,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { DesktopHostPendingRevisionBridge } from "@/lib/windows/types";

// Ticket T4 (Settings Restart + apply-after-update, finding C - Pending
// surface): Settings renders the "restart pending" hint for a durable
// marker and a distinct non-durable warning when the marker write failed.
// These tests wire the same `get`/change-event bridge that preload exposes,
// rather than seeding React Query directly. That keeps the Settings surface
// covered across renderer reloads and the snapshot/event handoff.

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

function makeManagement(): IHostManagement {
  const notImplemented =
    (method: string) =>
    (..._args: unknown[]): Promise<never> =>
      Promise.reject(new Error(`${method} not implemented in mock`));
  return {
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
    getOperationStatus: vi.fn(() =>
      Promise.resolve({ revision: 0, status: null, lastEnsureOutcome: null }),
    ),
    registryCheck: vi.fn(() =>
      Promise.resolve({
        checkedAt: null,
        latestVersion: null,
        installedVersion: null,
        updateAvailable: false,
        reachable: false,
        errorMessage: null,
        includePreReleases: false,
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

function makeHost(
  management: IHostManagement,
  localHost: LocalHostSnapshot | null,
  pendingRevision: DesktopHostPendingRevisionBridge,
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
    hostPendingRevision: pendingRevision,
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

function renderPanel(host: IRunnerHost): void {
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
}

function createPendingRevisionBridge(
  get: () => Promise<HostPendingRevisionState>,
): {
  readonly bridge: DesktopHostPendingRevisionBridge;
  readonly emit: (state: HostPendingRevisionState) => void;
  readonly subscriberCount: () => number;
} {
  const handlers = new Set<(state: HostPendingRevisionState) => void>();
  return {
    bridge: {
      get,
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
    subscriberCount: () => handlers.size,
  };
}

describe("<HostSettingsPanel /> - pending LaunchAgent revision hint", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders no hint when there is no pending revision", async () => {
    const management = makeManagement();
    const pendingRevision = createPendingRevisionBridge(() =>
      Promise.resolve({
        pending: false,
        durable: false,
        cause: null,
        error: null,
      }),
    );
    renderPanel(
      makeHost(management, makeLocalHostSnapshot(), pendingRevision.bridge),
    );

    await waitFor(() => {
      expect(management.getOperationStatus).toHaveBeenCalled();
      expect(pendingRevision.subscriberCount()).toBe(1);
    });

    expect(
      screen.queryByRole("status", { name: /restart pending/i }),
    ).toBeNull();
    expect(screen.queryByRole("status", { name: /downloaded/i })).toBeNull();
  });

  it("renders the durable 'applies when idle' hint for a durable pending marker", async () => {
    const management = makeManagement();
    const pendingRevision = createPendingRevisionBridge(() =>
      Promise.resolve({
        pending: false,
        durable: false,
        cause: null,
        error: null,
      }),
    );
    renderPanel(
      makeHost(management, makeLocalHostSnapshot(), pendingRevision.bridge),
    );

    await waitFor(() => {
      expect(pendingRevision.subscriberCount()).toBe(1);
    });
    act(() => {
      pendingRevision.emit({
        pending: true,
        durable: true,
        cause: null,
        error: null,
      });
    });

    const hint = await screen.findByRole("status");
    expect(hint.textContent).toContain(
      "Restart pending — the updated host applies when the host is idle.",
    );
  });

  it("keeps the non-durable warning when its change event wins over a stale get snapshot", async () => {
    const management = makeManagement();
    let resolveSnapshot: (state: HostPendingRevisionState) => void = () =>
      undefined;
    const staleSnapshot = new Promise<HostPendingRevisionState>((resolve) => {
      resolveSnapshot = resolve;
    });
    const pendingRevision = createPendingRevisionBridge(() => staleSnapshot);
    renderPanel(
      makeHost(management, makeLocalHostSnapshot(), pendingRevision.bridge),
    );

    await waitFor(() => {
      expect(pendingRevision.subscriberCount()).toBe(1);
    });
    act(() => {
      pendingRevision.emit({
        pending: true,
        durable: false,
        cause: "update",
        error: "ENOSPC: no space left on device",
      });
    });
    act(() => {
      resolveSnapshot({
        pending: false,
        durable: false,
        cause: null,
        error: null,
      });
    });

    const hint = await screen.findByRole("status");
    expect(hint.textContent).toContain(
      "Downloaded — press Restart to apply. The pending update could not be saved for automatic retry.",
    );
    expect(hint.textContent).toContain("ENOSPC: no space left on device");
  });
});
