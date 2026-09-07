// Drive the real hook over a real client and runner host. Mock only `useHostBinding` and `useHostClientForHostId`.
interface HostBindingFixture {
  readonly directory: {
    readonly getLocalHostId: () => string | null;
    readonly onChange: (cb: () => void) => { dispose: () => void };
  };
}
const hostBindingMock = vi.hoisted(
  (): { current: HostBindingFixture | null } => ({ current: null }),
);
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

const clientForHostIdMock = vi.hoisted(
  (): { current: (hostId: string | null) => unknown } => ({
    current: () => null,
  }),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    clientForHostIdMock.current(hostId),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostControllerStatus,
  IHostManagement,
  LocalAttemptFacts,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostRpcRegistry } from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { buildOverviewHostFixture } from "@/components/settings/panels/__tests__/host-overview-test-support";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { useLocalHostUpdateOperation } from "../use-local-host-update-operation";

const LOCAL_HOST_ID = "local-1";

function localAttempt(
  overrides: Partial<LocalAttemptFacts>,
): LocalAttemptFacts {
  return {
    attemptId: "attempt-preparing-1",
    generation: 1,
    sequence: 1,
    targetVersion: "2.5.0",
    phase: "preparing",
    continuation: null,
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

const CONTROLLER_STATUS_BASE: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: "1.4.1",
  latestVersion: "2.5.0",
  stagedVersion: null,
  installedRuntimeVersion: null,
  runningRuntimeVersion: null,
  updateReady: false,
  activation: "activated",
  reachable: false,
  localAttempt: null,
  removedByUser: false,
  checkedAt: "2026-08-27T00:00:00.000Z",
};

function notImplementedManagement(
  controllerStatus: HostControllerStatus,
): IHostManagement {
  const notImplemented = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`${method} not implemented`));
  return {
    getHostControllerStatus: vi.fn(() => Promise.resolve(controllerStatus)),
    convergeReady: vi.fn(notImplemented("convergeReady")),
    applyStaged: vi.fn(notImplemented("applyStaged")),
    activateInstalled: vi.fn(notImplemented("activateInstalled")),
    installVersion: vi.fn(notImplemented("installVersion")),
    uninstallHost: vi.fn(notImplemented("uninstallHost")),
    restartHost: vi.fn(notImplemented("restartHost")),
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
    runDoctorRepairQueued: vi.fn(() =>
      Promise.resolve({ kind: "applied" as const }),
    ),
    freePortAndRestartIfIdle: vi.fn(() =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "ok" as const, value: null },
      }),
    ),
    cliManifest: vi.fn(() => Promise.resolve(null)),
    maintenanceUpdateCheck: vi.fn(notImplemented("maintenanceUpdateCheck")),
    maintenanceDoctor: vi.fn(notImplemented("maintenanceDoctor")),
    maintenanceInstallationInfo: vi.fn(
      notImplemented("maintenanceInstallationInfo"),
    ),
    maintenanceInstallVersion: vi.fn(
      notImplemented("maintenanceInstallVersion"),
    ),
    restartHostIfIdle: vi.fn(notImplemented("restartHostIfIdle")),
    runDoctorRepairIfIdle: vi.fn(notImplemented("runDoctorRepairIfIdle")),
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

/** Binds the local host id and a real `HostClient` whose `host.status` handler always REJECTS - the live leg never resolves a fresh read, so `statusQuery.data` stays `undefined` forever. */
function bindUnreachableLocalHost(): HostClient<HostRpcRegistry> {
  const fixture = buildOverviewHostFixture({
    hostId: LOCAL_HOST_ID,
    isLocalMachine: true,
    overrideHandlers: {
      "host.status": () => {
        throw new Error("host unreachable — no live route in this fixture");
      },
    },
  });
  hostBindingMock.current = {
    directory: {
      getLocalHostId: () => LOCAL_HOST_ID,
      onChange: () => ({ dispose: () => undefined }),
    },
  };
  clientForHostIdMock.current = (hostId) =>
    hostId === LOCAL_HOST_ID ? fixture.client : null;
  return fixture.client;
}

function renderOperation(management: IHostManagement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return renderHook(() => useLocalHostUpdateOperation(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider
          runnerHost={createFakeRunnerHost({ hostManagement: management })}
        >
          {children}
        </RunnerHostProvider>
      </QueryClientProvider>
    ),
  });
}

afterEach(() => {
  hostBindingMock.current = null;
  clientForHostIdMock.current = () => null;
});

/** The instant the CONTROLLER query resolves, frozen so the record's observation time can be asserted EXACTLY rather than as `> 0`.
 * `setTimeout` stays real because `waitFor` schedules on it, and faking it would hang the poll rather than test it. */
const CONTROLLER_READ_AT_MS = 1_774_000_000_000;

describe("useLocalHostUpdateOperation — F1 host-down window (Ticket 07 §5.2.7)", () => {
  it("a non-terminal local attempt, with the host unreachable, projects a QUALIFIED unknown carrying the retained phase and attempt identity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CONTROLLER_READ_AT_MS);
    try {
      bindUnreachableLocalHost();
      const management = notImplementedManagement({
        ...CONTROLLER_STATUS_BASE,
        localAttempt: localAttempt({ phase: "preparing" }),
      });

      const { result } = renderOperation(management);

      await waitFor(() => {
        expect(result.current.view.lastKnownKind).toBe("preparing");
      });
      // `kind` MUST be `unknown`: every gate and cadence decision reads `kind`,
      // and a host we cannot reach must hold no gate and earn no active poll.
      expect(result.current.view.kind).toBe("unknown");
      expect(result.current.view.attemptId).toBe("attempt-preparing-1");
      expect(result.current.view.targetVersion).toBe("2.5.0");
      expect(result.current.hostId).toBe(LOCAL_HOST_ID);

      // Record observation time is the controller query's instant, never live `host.status` `dataUpdatedAt`. Assert the frozen instant, not merely `> 0`.
      expect(result.current.view.lastObservedAtMs).toBe(CONTROLLER_READ_AT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Ablation: forcing the local-attempt observation to null collapses the view to unknown. */
  it("positive control — with NO local attempt on the record, the same unreachable host projects a BARE unknown (no retained phase)", async () => {
    bindUnreachableLocalHost();
    const management = notImplementedManagement(CONTROLLER_STATUS_BASE);
    // `localAttempt: null` on the controller status - the base fixture carries
    // it explicitly. Proves the test above is discriminating on the attempt's
    // presence, not merely on the host being unreachable.
    const { result } = renderOperation(management);

    await waitFor(() => {
      expect(result.current.hostId).toBe(LOCAL_HOST_ID);
    });
    expect(result.current.view.kind).toBe("unknown");
    expect(result.current.view.lastKnownKind).toBeNull();
    expect(result.current.view.attemptId).toBeNull();
  });
});
