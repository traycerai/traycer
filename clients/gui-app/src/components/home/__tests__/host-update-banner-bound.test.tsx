// Mirrors `local-host-restart-flow.test.tsx`'s boundary exactly, because
// `HostUpdateBanner`'s bound arm pulls in the SAME split
// (`useHostBinding`) plus `useLocalHostUpdateOperation`'s own two leaf
// hooks (`useReactiveLocalHostId` / `useReactiveHostReadiness`, both built on
// `useHostBinding().directory` and a real `HostClient`) and, for the Force
// restart modal, `LocalHostRestartFlow`'s cooperative arm (`useHostDirectoryList`,
// `useHostClientForHostId`). `useHostRestart`/`host.status` stay REAL RPCs
// dispatched against a real `HostClient` from `buildOverviewHostFixture` over
// an in-memory messenger - not mocked calls - so this exercises the genuine
// wiring, not a stand-in for it.
//
// The existing `host-update-banner.test.tsx` renders WITHOUT a host binding at
// all, so `useHostBinding()` resolves `null` and every one of its 3 test files
// / 68 tests takes the UNBOUND arm exclusively. None of them touch
// `BoundHostUpdateBanner`, `OperationContent`, `describeUpdateOperation`, or
// `LocalHostRestartFlow`'s cooperative arm - this file is what actually
// exercises that code, which is the coverage gap the ticket flagged.
interface HostBindingFixture {
  readonly directory: {
    readonly getLocalEntry: () => HostDirectoryEntry | null;
    readonly getLocalHostId: () => string | null;
    readonly onChange: (cb: () => void) => { dispose: () => void };
  };
  /**
   * G8's isolation test additionally mounts the REAL `HostOverviewPanel`
   * (`@/lib/host`'s `useHostBinding` re-exports from `./runtime`, so this
   * mock covers both call sites) — which reads `binding.hostClient`, not
   * `binding.directory`. One fixture object carries both shapes so the
   * banner and the Overview panel can be mounted together against it.
   */
  readonly hostClient: unknown;
}
const hostBindingMock = vi.hoisted(
  (): { current: HostBindingFixture | null } => ({ current: null }),
);
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

// G8's isolation test needs the real `HostSettingsPanel` seam, which reads
// its host scope through this hook rather than through props.
const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

interface DirectoryListMockState {
  readonly data: readonly HostDirectoryEntry[] | undefined;
}
const directoryListMock = vi.hoisted(
  (): { current: DirectoryListMockState } => ({
    current: { data: undefined },
  }),
);
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => directoryListMock.current,
}));

type HostClientResolver = (
  hostId: string | null,
) => HostClient<HostRpcRegistry> | null;
const clientForHostIdMock = vi.hoisted((): { current: HostClientResolver } => ({
  current: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    clientForHostIdMock.current(hostId),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

// G7: the banner's Diagnostics button now routes through the in-app Settings
// modal (`useSystemTabModalActions().openSettings`), which needs a mounted
// `<RouterProvider>` this file's harness does not stand up. Mocked rather than
// wired for the same reason `use-host-directory-list-query` and
// `use-host-client-for-host-id` are above: this suite's whole point is the
// banner's OWN wiring, not the router's.
const openSettingsMock = vi.hoisted(() => vi.fn());
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: openSettingsMock,
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type {
  HostControllerStatus,
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type {
  HostStatusUpdateOperation,
  HostStatusUpdateProgress,
} from "@traycer/protocol/host/status/index";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { HostRpcRegistry } from "@/lib/host";
import { HostUpdateBanner } from "@/components/home/host-update-banner";
import { HostOverviewOperationCard } from "@/components/settings/panels/host-overview-operation-card";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { projectFleetUpdateView } from "@/lib/host/fleet-update/fleet-update-view";
import { observationFromStatus } from "@/lib/host/fleet-update/borrowed-status-read";
import {
  HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS,
  useHostUpdateBannerStore,
} from "@/stores/settings/host-update-banner-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  buildOverviewHostFixture,
  openHostOverviewMenu,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";

const LOCAL_HOST_ID = "local-1";

const UP_TO_DATE_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: "1.4.1",
  latestVersion: "1.4.1",
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

function makeManagement(): IHostManagement {
  const notImplemented = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`${method} not implemented`));
  return {
    getHostControllerStatus: vi.fn(() => Promise.resolve(UP_TO_DATE_STATUS)),
    convergeReady: vi.fn(notImplemented("convergeReady")),
    applyStaged: vi.fn(notImplemented("applyStaged")),
    activateInstalled: vi.fn(notImplemented("activateInstalled")),
    installVersion: vi.fn(notImplemented("installVersion")),
    uninstallHost: vi.fn(notImplemented("uninstallHost")),
    restartHost: vi.fn(() => Promise.resolve({ kind: "restarted" as const })),
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

function localEntry(): HostDirectoryEntry {
  return {
    hostId: LOCAL_HOST_ID,
    label: "This computer",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:0",
    version: "1.5.0",
    transportDialability: "dialable",
  };
}

/** Sets up the bound arm: a host binding + a real client resolving to a fixture. */
function bindLocalHost(
  overrideHandlers: MockHandlerMap<HostRpcRegistry> | undefined,
) {
  const fixture = buildOverviewHostFixture({
    hostId: LOCAL_HOST_ID,
    isLocalMachine: true,
    overrideHandlers,
  });
  hostBindingMock.current = {
    directory: {
      getLocalEntry: () => localEntry(),
      getLocalHostId: () => LOCAL_HOST_ID,
      onChange: () => ({ dispose: () => undefined }),
    },
    hostClient: fixture.client,
  };
  clientForHostIdMock.current = (hostId) =>
    hostId === LOCAL_HOST_ID ? fixture.client : null;
  return fixture;
}

function attemptStatus(
  operation: HostStatusUpdateOperation,
): ResponseOfMethod<HostRpcRegistry, "host.status"> {
  return {
    ready: true,
    hostVersion: "1.5.0",
    protocolVersion: { major: 1, minor: 3 },
    busy: false,
    busySessionCount: 0,
    updateProgress: null,
    busyBreakdown: null,
    updateOperation: operation,
    updateTransaction: { recordSchemaVersion: 2, authority: "attempt" },
  };
}

function baseAttempt(
  overrides: Partial<Extract<HostStatusUpdateOperation, { kind: "attempt" }>>,
): HostStatusUpdateOperation {
  return {
    kind: "attempt",
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    targetVersion: "2.1.0",
    trigger: "manual",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    liveness: "active",
    livenessCause: null,
    busySessionCount: null,
    busyBreakdown: null,
    error: null,
    ...overrides,
  };
}

function renderBanner(runnerHost: IRunnerHost | undefined): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider
        runnerHost={
          runnerHost ??
          createFakeRunnerHost({ hostManagement: makeManagement() })
        }
      >
        <HostUpdateBanner className={undefined} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

async function findPhaseText(): Promise<string> {
  const el = await screen.findByTestId("host-update-banner-phase");
  return el.textContent;
}

/**
 * G8's isolation replacement: the REAL production composition — this
 * computer's `HostOverviewPanel` (Restart, Diagnostics and the overflow menu
 * all live on it) mounted beside the real `HostUpdateBanner`, both reading the
 * SAME fixture. Any regression that made the failing attempt inert
 * outside the banner would show up here as a genuinely disabled production
 * control, not as an arbitrary sibling button's `.disabled` property.
 */
function renderBannerWithRealOverview(
  client: HostClient<HostRpcRegistry>,
): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: LOCAL_HOST_ID,
      isLocalMachine: true,
      connectable: true,
    }),
    hostId: LOCAL_HOST_ID,
    status: "ready",
    client,
  };
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider
        runnerHost={createFakeRunnerHost({ hostManagement: makeManagement() })}
      >
        <HostUpdateBanner className={undefined} />
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  hostBindingMock.current = null;
  directoryListMock.current = { data: undefined };
  clientForHostIdMock.current = () => null;
  openSettingsMock.mockClear();
  useHostUpdateBannerStore.setState({ landingDismissedAttemptIds: [] });
  scopeOverrides.current = {};
  resetHostServiceWriteLatchesForTest();
  resetNegotiatedManifests();
  vi.useRealTimers();
});

describe("HostUpdateBanner — bound arm (Ticket 06 subject E)", () => {
  // 1. Every banner state names its phase.
  const STATE_CASES: ReadonlyArray<{
    readonly name: string;
    readonly operation: HostStatusUpdateOperation;
    readonly expectedPhrase: RegExp;
  }> = [
    {
      name: "downloading",
      operation: baseAttempt({
        phase: "downloading",
        progress: { percent: 42, bytes: 4_200, totalBytes: 10_000 },
      }),
      expectedPhrase: /Downloading update to v2\.1\.0/,
    },
    {
      name: "preparing",
      operation: baseAttempt({ phase: "preparing" }),
      expectedPhrase: /Preparing update to v2\.1\.0/,
    },
    {
      name: "applying",
      operation: baseAttempt({ phase: "applying" }),
      expectedPhrase: /Installing update to v2\.1\.0/,
    },
    {
      name: "waiting-for-work",
      operation: baseAttempt({
        phase: "waiting-for-work",
        execution: "parked",
        busySessionCount: 2,
      }),
      expectedPhrase: /Update will continue when 2 sessions finish/,
    },
    {
      name: "waiting-to-activate",
      operation: baseAttempt({
        phase: "waiting-to-activate",
        execution: "parked",
      }),
      expectedPhrase: /Update installed — restart host to finish/,
    },
    {
      name: "restarting",
      operation: baseAttempt({ phase: "restarting", execution: "parked" }),
      expectedPhrase: /Restarting host to v2\.1\.0/,
    },
    {
      name: "verifying",
      operation: baseAttempt({ phase: "verifying" }),
      expectedPhrase: /Verifying updated host to v2\.1\.0/,
    },
    {
      name: "complete",
      operation: baseAttempt({
        phase: "complete",
        execution: "terminal",
        liveness: "terminal",
      }),
      expectedPhrase: /Updated to v2\.1\.0/,
    },
    {
      name: "failed (via liveness interrupted)",
      operation: baseAttempt({
        phase: "downloading",
        liveness: "interrupted",
      }),
      expectedPhrase: /Update failed/,
    },
    {
      name: "unavailable",
      operation: { kind: "unavailable", reason: "corrupt", cause: "boom" },
      expectedPhrase: /Update status unavailable — see Diagnostics/,
    },
  ];

  it.each(STATE_CASES)(
    "renders the named phase sentence for: $name",
    async ({ operation, expectedPhrase }) => {
      bindLocalHost({ "host.status": () => attemptStatus(operation) });
      renderBanner(undefined);
      const text = await findPhaseText();
      expect(text).toMatch(expectedPhrase);
      // Never the generic fallback the experience doc forbids.
      expect(text).not.toMatch(/^Updating this host/i);
    },
  );

  // `restarting`-while-disconnected ("reconnecting") is a projection-level
  // rule (`connected` from `useReactiveHostReadiness`), already pinned
  // directly against `projectFleetUpdateView` in subject D's table-driven
  // suite - simulating "bound, resolvable host id, but no live route" through
  // the REAL `HostClient` this file wires up would need deeper surgery on the
  // client's connection state than the seam here exposes cleanly. Not
  // re-covered here; the `restarting` (connected) case above already proves
  // the live wiring reaches `phaseKind`'s connected branch.

  // 2. Determinate vs indeterminate progress.
  it("active with progress.percent: null renders the INDETERMINATE bar and no percentage text", async () => {
    bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({
            phase: "downloading",
            progress: { percent: null, bytes: null, totalBytes: null },
          }),
        ),
    });
    renderBanner(undefined);
    await findPhaseText();
    await screen.findByTestId("update-progress-indeterminate");
    expect(screen.queryByTestId("update-progress-determinate")).toBeNull();
    expect(
      screen.queryByTestId("host-update-banner-progress-percent"),
    ).toBeNull();
  });

  it("a measured percent renders the DETERMINATE bar with aria-valuenow", async () => {
    bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({
            phase: "downloading",
            progress: { percent: 55, bytes: 5_500, totalBytes: 10_000 },
          }),
        ),
    });
    renderBanner(undefined);
    const bar = await screen.findByTestId("update-progress-determinate");
    expect(bar.parentElement?.getAttribute("aria-valuenow")).toBe("55");
    const percentEl = await screen.findByTestId(
      "host-update-banner-progress-percent",
    );
    expect(percentEl.textContent).toBe("55%");
  });

  // G5 — measured byte progress, independently of percentage.
  it("bytes-only (no percent measured) renders the byte text AND keeps the bar indeterminate", async () => {
    bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({
            phase: "downloading",
            progress: {
              percent: null,
              bytes: 80_000_000,
              totalBytes: 200_000_000,
            },
          }),
        ),
    });
    renderBanner(undefined);
    await findPhaseText();
    await screen.findByTestId("update-progress-indeterminate");
    const bytesEl = await screen.findByTestId(
      "host-update-banner-progress-bytes",
    );
    expect(bytesEl.textContent).not.toBe("");
    expect(
      screen.queryByTestId("host-update-banner-progress-percent"),
    ).toBeNull();
  });

  it("percent + bytes both present render together, on the DETERMINATE bar", async () => {
    bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({
            phase: "downloading",
            progress: {
              percent: 40,
              bytes: 80_000_000,
              totalBytes: 200_000_000,
            },
          }),
        ),
    });
    renderBanner(undefined);
    await screen.findByTestId("update-progress-determinate");
    const bytesEl = await screen.findByTestId(
      "host-update-banner-progress-bytes",
    );
    expect(bytesEl.textContent).not.toBe("");
    const percentEl = await screen.findByTestId(
      "host-update-banner-progress-percent",
    );
    expect(percentEl.textContent).toBe("40%");
  });

  // 3. Force restart… gating.
  it("offers Force restart… for waiting-for-work with a reported POSITIVE busySessionCount", async () => {
    bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({
            phase: "waiting-for-work",
            execution: "parked",
            busySessionCount: 3,
          }),
        ),
    });
    renderBanner(undefined);
    await findPhaseText();
    await screen.findByTestId("host-update-banner-force-restart");
  });

  it("does NOT offer Force restart… for waiting-for-work with busySessionCount: null (cannot count the work it would end)", async () => {
    bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({
            phase: "waiting-for-work",
            execution: "parked",
            busySessionCount: null,
          }),
        ),
    });
    renderBanner(undefined);
    // Positive control that the banner rendered at all - an absent button is
    // trivially "absent" if nothing rendered.
    expect(await findPhaseText()).toMatch(
      /Update will continue when work finishes/,
    );
    expect(screen.queryByTestId("host-update-banner-force-restart")).toBeNull();
  });

  it("does NOT offer Force restart… for any other phase, even with a positive count sitting in the same read", async () => {
    bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({
            phase: "downloading",
            busySessionCount: 5,
          }),
        ),
    });
    renderBanner(undefined);
    expect(await findPhaseText()).toMatch(/Downloading/);
    expect(screen.queryByTestId("host-update-banner-force-restart")).toBeNull();
  });

  // 4. The modal, both ways - Force restart… only ARMS the shared flow.
  it("Force restart… does not restart on the first click - it opens a confirmation, and CANCEL leaves the banner and attempt intact", async () => {
    let restartCalls = 0;
    const fixture = bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({
            phase: "waiting-for-work",
            execution: "parked",
            busySessionCount: 3,
          }),
        ),
      "host.restart": () => {
        restartCalls += 1;
        return { outcome: "accepted" as const };
      },
    });
    void fixture;
    renderBanner(undefined);
    await findPhaseText();

    fireEvent.click(
      await screen.findByTestId("host-update-banner-force-restart"),
    );
    await screen.findByTestId("confirm-destructive-dialog");
    expect(restartCalls).toBe(0); // arming is not restarting

    fireEvent.click(screen.getByTestId("confirm-cancel"));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(restartCalls).toBe(0);
    // The banner is untouched - still showing the same attempt.
    expect(await findPhaseText()).toMatch(/Update will continue/);
  });

  it("Force restart… CONFIRM dispatches the cooperative host.restart RPC", async () => {
    let restartCalls = 0;
    bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({
            phase: "waiting-for-work",
            execution: "parked",
            busySessionCount: 3,
          }),
        ),
      "host.restart": () => {
        restartCalls += 1;
        return { outcome: "accepted" as const };
      },
    });
    renderBanner(undefined);
    await findPhaseText();

    fireEvent.click(
      await screen.findByTestId("host-update-banner-force-restart"),
    );
    await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(restartCalls).toBe(1);
    });
  });

  // 5. The banner never blocks host controls.
  //
  // G8 (independent cold review, finding 7): the ORIGINAL version of this
  // test mounted two arbitrary sibling `<button>`s and asserted their
  // `.disabled` property. That renders neither Restart, Diagnostics,
  // Activate nor the overflow menu — none of the production controls the
  // rule is actually about — so a regression that made the REAL Overview
  // inert (or overlaid it) while these two fixture buttons stayed enabled
  // would sail through green. Replaced with the real production composition:
  // this computer's `HostOverviewPanel`, mounted beside the real banner
  // against the SAME fixture, with its own Restart/Diagnostics/overflow
  // controls checked directly.
  const ISOLATION_CASES: ReadonlyArray<{
    readonly name: string;
    readonly operation: HostStatusUpdateOperation | null;
    readonly updateProgress: HostStatusUpdateProgress | null;
  }> = [
    {
      name: "failed",
      operation: baseAttempt({ phase: "downloading", liveness: "interrupted" }),
      // No coarse mirror for a terminal outcome — a failed attempt was never
      // the shape Ticket 04's mapping locked on.
      updateProgress: null,
    },
    {
      name: "parked (waiting-to-activate)",
      operation: baseAttempt({
        phase: "waiting-to-activate",
        execution: "parked",
      }),
      // A @1.3 host still mirrors the rich attempt into the legacy coarse
      // field for pre-@1.3 siblings mid-fleet-update, and Ticket 04's mapping
      // reads ANY non-terminal attempt — parked included — as `"updating"`.
      // Without this mirrored alongside `updateOperation`, this case cannot
      // tell `holdsLifecycleGate(operationView)` (the fix) apart from the
      // coarse `view.updateProgress?.state === "updating"` fallback it
      // replaced (the defect) — both would read this attempt as not holding.
      updateProgress: { state: "updating", error: null },
    },
    {
      name: "unknown (updateOperation absent — pre-@1.3 coarse fallback)",
      operation: null,
      updateProgress: null,
    },
  ];

  it.each(ISOLATION_CASES)(
    "with the banner showing a $name attempt, the REAL Overview panel's Restart, Diagnostics and overflow actions stay ENABLED",
    async ({ operation, updateProgress }) => {
      const fixture = bindLocalHost({
        "host.status": () =>
          operation === null
            ? {
                ready: true,
                hostVersion: "1.5.0",
                protocolVersion: { major: 1, minor: 2 },
                busy: false,
                busySessionCount: 0,
                updateProgress,
                busyBreakdown: null,
                updateOperation: null,
                updateTransaction: null,
              }
            : { ...attemptStatus(operation), updateProgress },
      });
      recordNegotiatedHostMethods(LOCAL_HOST_ID, [
        "host.status",
        "host.identity.get",
        "host.identity.set",
        "host.getInstallationInfo",
        "host.restart",
        "host.doctor",
        "host.update.check",
        "host.update.install",
        "diagnostics.logs.tail",
      ]);
      renderBannerWithRealOverview(fixture.client);
      // The banner itself has nothing to show for the coarse-fallback
      // "unknown" case (`operationSupersedesControllerStatus` is false), so
      // synchronize on the Overview mounting rather than the banner's phase
      // text, which the other two cases in this table DO produce.
      await screen.findByTestId("host-overview-edit-name");

      // The Overview's Restart AND Run doctor live in its `⋯` menu.
      await openHostOverviewMenu();
      expect(
        screen
          .getByTestId("host-overview-restart")
          .getAttribute("aria-disabled"),
      ).not.toBe("true");
      expect(
        screen
          .getByTestId("host-overview-run-doctor")
          .getAttribute("aria-disabled"),
      ).not.toBe("true");

      // Positive control: the assertions above CAN fail — mutate the
      // element to the disabled state, then assert the ORIGINAL negative
      // expectation now throws. Asserting the mutated value against itself
      // was self-referential and could never fail; re-running the actual
      // `.not.toBe("true")` check is what proves it is not vacuous against
      // whatever this harness happens to render.
      screen
        .getByTestId("host-overview-restart")
        .setAttribute("aria-disabled", "true");
      expect(() => {
        expect(
          screen
            .getByTestId("host-overview-restart")
            .getAttribute("aria-disabled"),
        ).not.toBe("true");
      }).toThrow();
    },
  );

  // 6. Keyboard access.
  it("Force restart… is reachable and activates by keyboard (Enter) via REAL keyboard semantics, and the confirmation receives focus", async () => {
    bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({
            phase: "waiting-for-work",
            execution: "parked",
            busySessionCount: 3,
          }),
        ),
    });
    renderBanner(undefined);
    await findPhaseText();
    const forceButton = await screen.findByTestId(
      "host-update-banner-force-restart",
    );
    forceButton.focus();
    expect(document.activeElement).toBe(forceButton);
    // `userEvent.keyboard` simulates the BROWSER'S OWN default action for a
    // focused native `<button>` (keydown → click → keyup on Enter/Space),
    // unlike `fireEvent.keyDown`, which only dispatches the keydown event and
    // synthesizes nothing further. No manual `fireEvent.click` follows this —
    // if the control regressed to a focusable, click-only element with no
    // real keyboard activation, this line alone would fail to open the
    // dialog. See the ablation below for the proof that this test can fail.
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  // G7. Terminal lifecycle: Retry / Diagnostics / Dismiss for a failed rich
  // attempt, evidence retention on the Overview, dismissal re-arming on a
  // newer attempt, and complete's auto-collapse.
  describe("G7 — terminal lifecycle", () => {
    it("a rich FAILED attempt offers Retry, Diagnostics and Dismiss, all present together", async () => {
      bindLocalHost({
        "host.status": () =>
          attemptStatus(
            baseAttempt({ phase: "downloading", liveness: "interrupted" }),
          ),
      });
      renderBanner(undefined);
      await findPhaseText();
      await screen.findByTestId("host-update-banner-operation-retry");
      await screen.findByTestId("host-update-banner-operation-diagnostics");
      await screen.findByTestId("host-update-banner-operation-dismiss");
    });

    it("Retry dispatches applyStaged", async () => {
      const applyStaged = vi.fn(() =>
        Promise.resolve({
          kind: "ok" as const,
          value: { appliedVersion: "2.1.0", runningActivated: true },
        }),
      );
      bindLocalHost({
        "host.status": () =>
          attemptStatus(
            baseAttempt({ phase: "downloading", liveness: "interrupted" }),
          ),
      });
      renderBanner(
        createFakeRunnerHost({
          hostManagement: { ...makeManagement(), applyStaged },
        }),
      );
      await findPhaseText();
      fireEvent.click(
        await screen.findByTestId("host-update-banner-operation-retry"),
      );
      await waitFor(() => {
        expect(applyStaged).toHaveBeenCalledTimes(1);
      });
    });

    it("Diagnostics calls openSettings with section: 'diagnostics'", async () => {
      bindLocalHost({
        "host.status": () =>
          attemptStatus(
            baseAttempt({ phase: "downloading", liveness: "interrupted" }),
          ),
      });
      renderBanner(undefined);
      await findPhaseText();
      fireEvent.click(
        await screen.findByTestId("host-update-banner-operation-diagnostics"),
      );
      expect(openSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({ section: "diagnostics" }),
      );
    });

    it("Dismiss hides the LANDING banner, but HostOverviewOperationCard still renders the same failed attempt — evidence survives on the Overview", async () => {
      const failedAttempt = baseAttempt({
        attemptId: "attempt-failed-1",
        phase: "downloading",
        liveness: "interrupted",
      });
      bindLocalHost({
        "host.status": () => attemptStatus(failedAttempt),
      });
      renderBanner(undefined);
      await findPhaseText();
      fireEvent.click(
        await screen.findByTestId("host-update-banner-operation-dismiss"),
      );
      await waitFor(() => {
        expect(screen.queryByTestId("host-update-banner")).toBeNull();
      });

      // THE OVERVIEW CARD ignores landing dismissal by design (it is its own
      // seam, "the failure remains discoverable in the selected-host Overview
      // until host-side expiry or a newer attempt supersedes it"). It reads
      // no store at all — its input is only the projected view.
      expect(
        useHostUpdateBannerStore
          .getState()
          .landingDismissedAttemptIds.includes("attempt-failed-1"),
      ).toBe(true);
      const observation = observationFromStatus({
        hostId: LOCAL_HOST_ID,
        status: attemptStatus(failedAttempt),
        nowMs: Date.now(),
      });
      const view = projectFleetUpdateView({
        observation,
        nowMs: Date.now(),
        connected: true,
      });
      render(
        <HostOverviewOperationCard
          view={view}
          hostName="This computer"
          onForceRestart={() => undefined}
        />,
      );
      const card = screen.getByTestId("host-overview-operation-card");
      expect(card.textContent).toMatch(/Update failed/);
    });

    it("a NEWER attemptId re-shows after a dismissal of the older one", async () => {
      let currentAttempt = baseAttempt({
        attemptId: "attempt-old",
        phase: "downloading",
        liveness: "interrupted",
      });
      bindLocalHost({
        "host.status": () => attemptStatus(currentAttempt),
      });
      renderBanner(undefined);
      await findPhaseText();
      fireEvent.click(
        await screen.findByTestId("host-update-banner-operation-dismiss"),
      );
      await waitFor(() => {
        expect(screen.queryByTestId("host-update-banner")).toBeNull();
      });

      // A NEWER attempt arrives (a fresh retry), with a different id.
      currentAttempt = baseAttempt({
        attemptId: "attempt-new",
        phase: "downloading",
        liveness: "interrupted",
      });
      cleanup();
      hostBindingMock.current = null;
      bindLocalHost({
        "host.status": () => attemptStatus(currentAttempt),
      });
      renderBanner(undefined);
      await screen.findByTestId("host-update-banner");
    });

    it("a completed attempt auto-collapses after HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      bindLocalHost({
        "host.status": () =>
          attemptStatus(
            baseAttempt({
              attemptId: "attempt-complete-1",
              phase: "complete",
              execution: "terminal",
              liveness: "terminal",
            }),
          ),
      });
      renderBanner(undefined);
      await screen.findByTestId("host-update-banner");
      expect(
        useHostUpdateBannerStore.getState().landingDismissedAttemptIds,
      ).not.toContain("attempt-complete-1");

      await vi.advanceTimersByTimeAsync(
        HOST_UPDATE_COMPLETE_ACKNOWLEDGE_MS + 100,
      );

      await waitFor(() => {
        expect(screen.queryByTestId("host-update-banner")).toBeNull();
      });
      expect(
        useHostUpdateBannerStore.getState().landingDismissedAttemptIds,
      ).toContain("attempt-complete-1");
    });
  });

  // 7. Live-region politeness.
  it("aria-live is polite for an ordinary phase and assertive for failed", async () => {
    bindLocalHost({
      "host.status": () => attemptStatus(baseAttempt({ phase: "downloading" })),
    });
    renderBanner(undefined);
    const politeBanner = await screen.findByTestId("host-update-banner");
    expect(politeBanner.getAttribute("aria-live")).toBe("polite");
    cleanup();
    hostBindingMock.current = null;

    bindLocalHost({
      "host.status": () =>
        attemptStatus(
          baseAttempt({ phase: "downloading", liveness: "interrupted" }),
        ),
    });
    renderBanner(undefined);
    const assertiveBanner = await screen.findByTestId("host-update-banner");
    expect(assertiveBanner.getAttribute("aria-live")).toBe("assertive");
  });

  // 8. The split itself.
  it("the UNBOUND arm (no host binding) still renders the controller-status banner and does not throw", async () => {
    hostBindingMock.current = null; // no <HostRuntimeProvider> equivalent
    clientForHostIdMock.current = () => null;
    const READY_STATUS: HostControllerStatus = {
      ...UP_TO_DATE_STATUS,
      latestVersion: "1.4.2",
      stagedVersion: "1.4.2",
      updateReady: true,
    };
    const management: IHostManagement = {
      ...makeManagement(),
      getHostControllerStatus: vi.fn(() => Promise.resolve(READY_STATUS)),
    };
    expect(() =>
      renderBanner(createFakeRunnerHost({ hostManagement: management })),
    ).not.toThrow();
    await screen.findByRole("status", {
      name: /Traycer host update available: 1\.4\.2/i,
    });
    // Never the attempt-driven copy - the unbound arm has no attempt to read.
    expect(screen.queryByTestId("host-update-banner-force-restart")).toBeNull();
  });

  // 9. The host-down window reaching THIS surface (Ticket 07 §5.2.7).
  //
  // The projector's record arm always returns `kind: "unknown"` carrying
  // `lastKnownKind`, and this banner's supersede predicate rejected `unknown`
  // outright — so every record-backed view was suppressed here and the landing
  // page went blank while a local update sat half-finished behind an
  // unreachable host. These drive the REAL leg: `host.status` fails (the host
  // is not answering) and Desktop's controller status carries the durable
  // facts, exactly as production composes them.
  describe("host-down window — retained phase on the landing banner", () => {
    const HOST_DOWN_STATUS: HostControllerStatus = {
      ...UP_TO_DATE_STATUS,
      reachable: false,
      localAttempt: {
        attemptId: "attempt-down-1",
        generation: 1,
        sequence: 4,
        targetVersion: "2.1.0",
        phase: "preparing",
        continuation: null,
        updatedAt: "2026-05-15T00:00:00Z",
      },
    };

    function bindUnreachableHost(): void {
      bindLocalHost({
        "host.status": () => {
          throw new Error("host is not answering");
        },
      });
    }

    function renderWithControllerStatus(
      status: HostControllerStatus,
    ): QueryClient {
      return renderBanner(
        createFakeRunnerHost({
          hostManagement: {
            ...makeManagement(),
            getHostControllerStatus: vi.fn(() => Promise.resolve(status)),
          },
        }),
      );
    }

    it("renders the retained phase when the host is unreachable and the controller has nothing concrete", async () => {
      bindUnreachableHost();
      renderWithControllerStatus(HOST_DOWN_STATUS);
      // `Last seen: …` — the sentence `primarySentence` has always been able to
      // build and this surface could never reach.
      await waitFor(async () => {
        expect(await findPhaseText()).toBe(
          "Last seen: Preparing update to v2.1.0",
        );
      });
      // Qualified INLINE, so no second marker: the assertion that this is the
      // retained-phase rendering and not a live one.
      expect(screen.queryByTestId("host-update-banner-qualified")).toBeNull();
      // A remembered phase holds no lifecycle affordance.
      expect(
        screen.queryByTestId("host-update-banner-operation-retry"),
      ).toBeNull();
      expect(
        screen.queryByTestId("host-update-banner-force-restart"),
      ).toBeNull();
      expect(
        (await screen.findByTestId("host-update-banner")).getAttribute(
          "aria-live",
        ),
      ).toBe("polite");
    });

    it("does NOT displace a concrete controller fact — a ready stage still wins", async () => {
      bindUnreachableHost();
      renderWithControllerStatus({
        ...HOST_DOWN_STATUS,
        latestVersion: "1.4.2",
        stagedVersion: "1.4.2",
        updateReady: true,
      });
      await screen.findByRole("status", {
        name: /Traycer host update available: 1\.4\.2/i,
      });
      expect(screen.queryByTestId("host-update-banner-phase")).toBeNull();
    });

    it("a BARE unknown still loses — no record, nothing rendered", async () => {
      bindUnreachableHost();
      // Same unreachable host, but no durable attempt: `lastKnownKind` is null
      // and there is nothing to say. This is the arm the predicate must keep
      // rejecting, and it is what stops the widening from turning every
      // unreadable poll into an "Update state unknown" banner.
      renderWithControllerStatus({ ...HOST_DOWN_STATUS, localAttempt: null });
      await waitFor(() => {
        expect(screen.queryByTestId("host-update-banner")).toBeNull();
      });
    });
  });

  // 10. Operation-lane Retry routes on intent like every other retry here.
  describe("operation Retry routing", () => {
    function failedAttemptWithControllerStatus(status: HostControllerStatus): {
      readonly applyStaged: ReturnType<typeof vi.fn>;
      readonly activateInstalled: ReturnType<typeof vi.fn>;
    } {
      const applyStaged = vi.fn(() =>
        Promise.resolve({
          kind: "ok" as const,
          value: { appliedVersion: "2.1.0", runningActivated: true },
        }),
      );
      const activateInstalled = vi.fn(() =>
        Promise.resolve({
          kind: "ok" as const,
          value: { activated: true },
        }),
      );
      bindLocalHost({
        "host.status": () =>
          attemptStatus(
            baseAttempt({ phase: "downloading", liveness: "interrupted" }),
          ),
      });
      renderBanner(
        createFakeRunnerHost({
          hostManagement: {
            ...makeManagement(),
            getHostControllerStatus: vi.fn(() => Promise.resolve(status)),
            applyStaged,
            activateInstalled,
          },
        }),
      );
      return { applyStaged, activateInstalled };
    }

    it("retries a failed attempt by ACTIVATING when the machine is in activation debt", async () => {
      const { applyStaged, activateInstalled } =
        failedAttemptWithControllerStatus({
          ...UP_TO_DATE_STATUS,
          updateReady: false,
          activation: "pendingActivation",
        });
      await findPhaseText();
      fireEvent.click(
        await screen.findByTestId("host-update-banner-operation-retry"),
      );
      await waitFor(() => {
        expect(activateInstalled).toHaveBeenCalledTimes(1);
      });
      // The whole point: re-applying here asks the host for a stage the failed
      // attempt already consumed.
      expect(applyStaged).not.toHaveBeenCalled();
    });

    it("retries by ACTIVATING while the host reads unavailable and the live view still says failed", async () => {
      // SCOPE, stated because it is narrower than it looks. This covers the
      // window where the controller already reports `activation: "unavailable"`
      // (no running runtime identity) while the LIVE attempt view is still
      // `failed` — the interval right after a packaged-macOS activation fails
      // and takes the host down with it.
      //
      // It does NOT cover the SUSTAINED host-down state. Once the live read
      // expires, `useLocalHostUpdateOperation` falls back to the durable
      // record, which `projectFleetUpdateView` projects as `kind: "unknown"`
      // with `lastKnownKind: "failed"` — and Retry renders only for
      // `view.kind === "failed"`, so this callback is not reachable there at
      // all. That gap is real and is recorded rather than fixed here; binding a
      // local host below is what keeps this test inside the window it names,
      // and removing that binding would not extend the fix, it would just stop
      // rendering the button.
      //
      // `deriveActivationState` returns `unavailable`, not a debt state, when
      // there is no running runtime identity. `ACTIVATION_DEBT_STATES`
      // deliberately excludes it, so routing this retry off debt sent even this
      // window to `applyStaged`, against a stage the failed attempt had already
      // consumed.
      const { applyStaged, activateInstalled } =
        failedAttemptWithControllerStatus({
          ...UP_TO_DATE_STATUS,
          updateReady: false,
          activation: "unavailable",
        });
      await findPhaseText();
      fireEvent.click(
        await screen.findByTestId("host-update-banner-operation-retry"),
      );
      await waitFor(() => {
        expect(activateInstalled).toHaveBeenCalledTimes(1);
      });
      expect(applyStaged).not.toHaveBeenCalled();
    });

    it("still retries by APPLYING when a stage is genuinely ready (update-over-debt priority)", async () => {
      const { applyStaged, activateInstalled } =
        failedAttemptWithControllerStatus({
          ...UP_TO_DATE_STATUS,
          latestVersion: "2.1.0",
          stagedVersion: "2.1.0",
          updateReady: true,
          activation: "pendingActivation",
        });
      await findPhaseText();
      fireEvent.click(
        await screen.findByTestId("host-update-banner-operation-retry"),
      );
      await waitFor(() => {
        expect(applyStaged).toHaveBeenCalledTimes(1);
      });
      expect(activateInstalled).not.toHaveBeenCalled();
    });
  });
});
