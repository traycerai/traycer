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
import { HOST_NOT_SERVICE_RUN_CODE } from "@traycer-clients/shared/platform/host-service-notices";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  hostOptionStatusWord,
} from "@/components/settings/host-scope/host-option-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";

/**
 * The "setting up" row state must come from the mutation lane's KIND, not
 * merely its presence (Y5 regression): `deregister` / `uninstallHost` /
 * `removeTraycer` are just as busy as `ensure` / `install` / etc., but they
 * take the local host DOWN, and crediting them with "setting up" tells the
 * person watching the row the opposite of what is actually happening.
 *
 * This exercises `useHostOptions` end to end (through a real `MockRunnerHost`
 * for the mutation-lane status query) rather than stubbing the derivation, so
 * a regression in the WIRING - not just the exclusion list - fails here too.
 *
 * `settingUp` starts `false` (query unresolved) for EVERY lane, `false` being
 * indistinguishable from "not settled yet" - so a test that only polls
 * `settingUp` for the false cases would pass on the very first render, before
 * the mocked `getHostControllerStatus()` promise ever resolves. Each case
 * therefore first proves the controller-status QUERY itself has settled
 * (read straight from the query cache by the same key the hook builds), and
 * only then reads `settingUp` off the hook's result.
 */

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
// `useHostOptions` (and, transitively, `useRunnerHostControllerStatusQuery`)
// resolve `@/providers/use-runner-host` at STATIC import time, so the mock
// factory has to be the hoisted `vi.mock` form - a per-test `vi.doMock` runs
// too late to affect an already-resolved binding. The box is what lets each
// test still swap in its own `MockRunnerHost`.
const runnerHostBox = vi.hoisted<{ current: MockRunnerHost | null }>(() => ({
  current: null,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => runnerHostBox.current,
  useRunnerHostOrNull: () => runnerHostBox.current,
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
  lastEnsureFailure: null,
  updateDeferral: null,
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

function makeHostManagement(status: HostControllerStatus): IHostManagement {
  const notImplemented = (name: string) => () =>
    Promise.reject(new Error(`${name} not implemented in this test`));
  return {
    getHostControllerStatus: () => Promise.resolve(status),
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
    freePortAndRestart: (input) =>
      Promise.resolve({ kind: "applied" as const, ...input }),
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
    restartHostServiceIfHostIdle: notImplemented(
      "restartHostServiceIfHostIdle",
    ),
    runDoctorRepairIfIdle: notImplemented("runDoctorRepairIfIdle"),
    getHostName: notImplemented("getHostName"),
    setHostName: notImplemented("setHostName"),
  };
}

function renderWithLane(kind: MutationKind | null) {
  return renderWithStatus(controllerStatusWithLane(kind));
}

function renderWithStatus(status: HostControllerStatus) {
  const hostManagement = makeHostManagement(status);
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

/** Proves the controller-status query has SETTLED (success or error), not
 * merely that its `queryFn` was invoked - `settingUp` starts `false` the
 * instant the query goes from unresolved to a real "no lane" answer, so this
 * is the one signal a false-expecting case can actually wait on. */
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

  // The Y5 regression: a TEARDOWN lane must not read as "setting up".
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

  // `refreshService` ("host service refresh") rewrites the service
  // definition only - the host is neither brought up nor taken down.
  it("does not read a refreshService lane as setting up", async () => {
    const { result, queryClient, hostManagement } =
      renderWithLane("refreshService");
    await waitForControllerStatusSettled(queryClient, hostManagement);
    expect(findLocalRow(result.current.hosts)?.settingUp).toBe(false);
  });

  it("reads no lane as not setting up", async () => {
    const { result, queryClient, hostManagement } = renderWithLane(null);
    await waitForControllerStatusSettled(queryClient, hostManagement);
    expect(findLocalRow(result.current.hosts)?.settingUp).toBe(false);
  });

  // A terminal-started host the app defers over frees the lane: the row must
  // go back to a plain word, not stay on "setting up" and not fall to
  // "offline" while the host-health snapshot still holds.
  it("reads the local row's word as setting up only while an ensure holds the lane", async () => {
    const busy = renderWithLane("ensure");
    await waitForControllerStatusSettled(busy.queryClient, busy.hostManagement);
    await waitFor(() => {
      expect(findLocalRow(busy.result.current.hosts)?.settingUp).toBe(true);
    });
    const busyRow = findLocalRow(busy.result.current.hosts);
    expect(busyRow).toBeDefined();
    if (busyRow === undefined) return;
    expect(
      hostOptionStatusWord(busyRow, AVAILABLE_HOST_ROW_SURFACE_STATE),
    ).toBe("setting up");
    busy.unmount();

    const idle = renderWithLane(null);
    await waitForControllerStatusSettled(idle.queryClient, idle.hostManagement);
    const idleRow = findLocalRow(idle.result.current.hosts);
    expect(idleRow).toBeDefined();
    if (idleRow === undefined) return;
    expect(idleRow.settingUp).toBe(false);
    const word = hostOptionStatusWord(
      idleRow,
      AVAILABLE_HOST_ROW_SURFACE_STATE,
    );
    expect(word).not.toBe("setting up");
    expect(word).not.toBe("offline");
  });

  describe("terminal-run note", () => {
    const NOTE = "This host was started from a terminal, so the app leaves it.";
    const refusedStatus: HostControllerStatus = {
      ...IDLE_CONTROLLER_STATUS,
      lastEnsureFailure: { message: NOTE, code: HOST_NOT_SERVICE_RUN_CODE },
    };

    it("carries the refusal's sentence on the local row once the lane is free, and the word is not setting up", async () => {
      const { result, queryClient, hostManagement } =
        renderWithStatus(refusedStatus);
      await waitForControllerStatusSettled(queryClient, hostManagement);
      const row = findLocalRow(result.current.hosts);
      expect(row?.terminalRunNote).toBe(NOTE);
      expect(row?.settingUp).toBe(false);
      if (row === undefined) return;
      expect(
        hostOptionStatusWord(row, AVAILABLE_HOST_ROW_SURFACE_STATE),
      ).not.toBe("setting up");
    });

    it("drops the note while a lane job runs", async () => {
      const { result, queryClient, hostManagement } = renderWithStatus({
        ...refusedStatus,
        mutation: {
          kind: "ensure",
          progress: null,
          startedAt: "2026-05-15T00:00:00Z",
        },
      });
      await waitForControllerStatusSettled(queryClient, hostManagement);
      await waitFor(() => {
        expect(findLocalRow(result.current.hosts)?.settingUp).toBe(true);
      });
      expect(findLocalRow(result.current.hosts)?.terminalRunNote).toBeNull();
    });

    it("shows no note for any other ensure failure", async () => {
      const { result, queryClient, hostManagement } = renderWithStatus({
        ...refusedStatus,
        lastEnsureFailure: { message: "Something else.", code: null },
      });
      await waitForControllerStatusSettled(queryClient, hostManagement);
      expect(findLocalRow(result.current.hosts)?.terminalRunNote).toBeNull();
    });
  });
});
