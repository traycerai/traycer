import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  HostControllerStatus,
  IHostManagement,
  MutationKind,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";

/** `settingUp` starts `false` (query unresolved) for every lane, `false` being indistinguishable from "not
 * settled yet". */

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mockLocalHostEntry.hostId,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [mockLocalHostEntry] }),
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({ data: { hosts: [] } }),
}));
vi.mock("@/hooks/host/use-remote-sessions-poll-readiness", () => ({
  useRemoteSessionsPollReadiness: () => () => false,
}));
vi.mock("@/hooks/host/use-host-lease", () => ({
  useHostLeases: () => [],
}));
vi.mock("@/hooks/host/use-selection-authority-attached", () => ({
  useSelectionAuthorityAttached: () => true,
}));
// `useHostOptions` (and, transitively, `useRunnerHostControllerStatusQuery`) resolve
// `@/providers/use-runner-host` at static import time.
const runnerHostBox = vi.hoisted<{ current: MockRunnerHost | null }>(() => ({
  current: null,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHostBox.current,
}));

const IDLE_CONTROLLER_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: "1.0.0",
  latestVersion: "1.0.0",
  stagedVersion: null,
  installedRuntimeVersion: null,
  runningRuntimeVersion: null,
  updateReady: false,
  activation: "activated",
  reachable: true,
  localAttempt: null,
  removedByUser: false,
  checkedAt: "2026-05-15T00:00:00Z",
};

function controllerStatusWithLane(
  kind: MutationKind | null,
): HostControllerStatus {
  if (kind === null) return IDLE_CONTROLLER_STATUS;
  return {
    ...IDLE_CONTROLLER_STATUS,
    mutation: { kind, progress: null, startedAt: "2026-05-15T00:00:00Z" },
  };
}

function makeHostManagement(kind: MutationKind | null): IHostManagement {
  const notImplemented = (name: string) => () =>
    Promise.reject(new Error(`${name} not implemented in this test`));
  return {
    getHostControllerStatus: () =>
      Promise.resolve(controllerStatusWithLane(kind)),
    convergeReady: notImplemented("convergeReady"),
    applyStaged: notImplemented("applyStaged"),
    activateInstalled: notImplemented("activateInstalled"),
    installVersion: notImplemented("installVersion"),
    uninstallHost: notImplemented("uninstallHost"),
    uninstallTraycer: notImplemented("uninstallTraycer"),
    getRemovalState: () => Promise.resolve({ removedByUser: false }),
    clearRemoval: () => Promise.resolve(),
    restartHost: notImplemented("restartHost"),
    getHostLogs: notImplemented("getHostLogs"),
    runDoctor: notImplemented("runDoctor"),
    availableVersions: notImplemented("availableVersions"),
    installedRecord: () => Promise.resolve(null),
    registerService: notImplemented("registerService"),
    deregisterService: notImplemented("deregisterService"),
    registryCheck: notImplemented("registryCheck"),
    freePortAndRestart: (input) => Promise.resolve(input),
    runDoctorRepairQueued: () => Promise.resolve({ kind: "applied" as const }),
    freePortAndRestartIfIdle: () =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "ok" as const, value: null },
      }),
    cliManifest: () => Promise.resolve(null),
    maintenanceUpdateCheck: notImplemented("maintenanceUpdateCheck"),
    maintenanceDoctor: notImplemented("maintenanceDoctor"),
    maintenanceInstallationInfo: notImplemented("maintenanceInstallationInfo"),
    maintenanceInstallVersion: notImplemented("maintenanceInstallVersion"),
    restartHostIfIdle: notImplemented("restartHostIfIdle"),
    runDoctorRepairIfIdle: notImplemented("runDoctorRepairIfIdle"),
    getHostName: notImplemented("getHostName"),
    setHostName: notImplemented("setHostName"),
  };
}

function renderWithLane(kind: MutationKind | null) {
  const hostManagement = makeHostManagement(kind);
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: {
      hostId: mockLocalHostEntry.hostId,
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "0.0.0-mock",
      pid: 1,
      systemHostName: "test-mac",
      displayName: "test-mac",
      availability: "available",
    },
    hosts: [mockLocalHostEntry],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement,
  });
  runnerHostBox.current = runnerHost;
  const queryClient = new QueryClient();
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  const rendered = renderHook(() => useHostOptions(), { wrapper });
  return { ...rendered, queryClient, hostManagement };
}

/** Proves the controller-status query has settled (success or error), not merely that its `queryFn` was
 * invoked. */
async function waitForControllerStatusSettled(
  queryClient: QueryClient,
  hostManagement: IHostManagement,
): Promise<void> {
  const queryKey = runnerQueryKeys.hostControllerStatus(hostManagement);
  await waitFor(() => {
    expect(queryClient.getQueryState(queryKey)?.status).toBe("success");
  });
}

function findLocalRow(
  hosts: readonly HostScopeOption[],
): HostScopeOption | undefined {
  return hosts.find((h) => h.hostId === mockLocalHostEntry.hostId);
}

afterEach(() => {
  cleanup();
  runnerHostBox.current = null;
});

describe("useHostOptions provisioning lane", () => {
  it("reads a settingUp lane (ensure) as setting up", async () => {
    const { result, queryClient, hostManagement } = renderWithLane("ensure");
    await waitForControllerStatusSettled(queryClient, hostManagement);
    await waitFor(() => {
      expect(findLocalRow(result.current.hosts)?.settingUp).toBe(true);
    });
  });

  // The Y5 regression: a teardown lane must not read as "setting up".
  it("does not read a removeTraycer lane as setting up", async () => {
    const { result, queryClient, hostManagement } =
      renderWithLane("removeTraycer");
    await waitForControllerStatusSettled(queryClient, hostManagement);
    expect(findLocalRow(result.current.hosts)?.settingUp).toBe(false);
  });

  it("does not read a deregister lane as setting up", async () => {
    const { result, queryClient, hostManagement } =
      renderWithLane("deregister");
    await waitForControllerStatusSettled(queryClient, hostManagement);
    expect(findLocalRow(result.current.hosts)?.settingUp).toBe(false);
  });

  it("reads no lane as not setting up", async () => {
    const { result, queryClient, hostManagement } = renderWithLane(null);
    await waitForControllerStatusSettled(queryClient, hostManagement);
    expect(findLocalRow(result.current.hosts)?.settingUp).toBe(false);
  });
});
