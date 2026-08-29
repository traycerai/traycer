// `useLocalHostUpdateOperation` is the LANDING BANNER's whole data source: it
// resolves this machine's host id, reads the LIVE `host.status` leg over a
// real client, reads the DURABLE-RECORD leg off `useRunnerHostControllerStatusQuery()`
// via `recordObservationFromLocalAttempt`, and combines the two through
// `preferLiveOverRecord` into one `FleetUpdateView` (Ticket 07 §5.2.7 — the
// host-down window).
//
// This is a PRODUCTION-WIRING witness, not a pure-module test: it drives the
// REAL hook, over a REAL `HostClient` (in-memory messenger, mirroring
// `host-update-banner-bound.test.tsx`'s harness) for the live leg, and a real
// `RunnerHostProvider` + `IHostManagement.getHostControllerStatus()` for the
// record leg. Only `useHostBinding` and `useHostClientForHostId` are mocked —
// the same two seams `host-update-banner-bound.test.tsx` mocks, and for the
// same reason: this suite is not about the directory/selection machinery
// behind them.
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

/**
 * Binds the local host id and a real `HostClient` whose `host.status`
 * handler always REJECTS — the live leg never resolves a fresh read, so
 * `statusQuery.data` stays `undefined` forever. This is what "the host is
 * unreachable / the wire read is stale or absent" looks like at this seam:
 * `preferLiveOverRecord` then has no fresh wire observation to prefer, and
 * the durable-record leg is what the projector falls through to.
 */
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

/**
 * The instant the CONTROLLER query resolves, frozen so the record's observation
 * time can be asserted EXACTLY rather than as `> 0`.
 *
 * Only `Date` is faked. `setTimeout` stays real because `waitFor` schedules on
 * it, and faking it would hang the poll rather than test it.
 */
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

      // R2 fix-round-2 pin: the record's observation time must be stamped by
      // the CONTROLLER query that actually read it, never by the live
      // `host.status` query. In this fixture `host.status` throws and never
      // succeeds, so its `dataUpdatedAt` is `0` — the previous source, which
      // reported a record freshly read from disk as observed at the Unix epoch.
      //
      // Asserted EXACTLY against the frozen controller-read instant rather than
      // as `> 0`: `> 0` would also pass if someone later routed this through
      // some other non-zero clock, and the property being pinned is WHICH read
      // this timestamp describes, not merely that it is non-empty.
      expect(result.current.view.lastObservedAtMs).toBe(CONTROLLER_READ_AT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ABLATION-RESISTANCE CHECK, actually run (not merely reasoned about):
   * verified by mocking `recordObservationFromLocalAttempt` to always return
   * `null` — the exact downstream effect of deleting the `localAttempt` read
   * in `useLocalHostUpdateOperation` (its own real implementation already
   * returns `null` whenever `facts === null`) — in a throwaway copy of the
   * test above. Chose a mocked leaf over editing the production hook file
   * directly: this worktree is shared with the agent doing the Ticket 07
   * production wiring, and it was mid-edit on this exact file during this
   * session, so a live on-disk ablation risked colliding with that work.
   * The throwaway file was deleted immediately after confirming the result;
   * it is not part of this suite.
   *
   * Result: RED, as expected. With the leg forced `null`, the live leg is
   * also unreachable (per this fixture), so `preferLiveOverRecord(null,
   * null, …)` returns `null` and the view collapses to
   * `UNKNOWN_FLEET_UPDATE_VIEW` — `lastKnownKind: null`, `attemptId: null`,
   * `targetVersion: null` — failing every assertion in the test above.
   */
  it("positive control — with NO local attempt on the record, the same unreachable host projects a BARE unknown (no retained phase)", async () => {
    bindUnreachableLocalHost();
    const management = notImplementedManagement(CONTROLLER_STATUS_BASE);
    // `localAttempt: null` on the controller status — the base fixture carries
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
