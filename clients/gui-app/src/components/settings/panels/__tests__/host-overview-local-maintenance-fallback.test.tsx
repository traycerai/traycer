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

interface HostBindingMock {
  readonly hostClient: unknown;
  readonly directory: {
    readonly getLocalEntry: () => { readonly hostId: string } | null;
  };
}
const hostBindingMock = vi.hoisted((): { current: HostBindingMock | null } => ({
  current: null,
}));
const localHostIdMock = vi.hoisted((): { current: string | null } => ({
  current: null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  DoctorRepairDispatch,
  DoctorRepairIntent,
  HostRestartRequestResult,
  IHostManagement,
  IRunnerHost,
  MutationOutcome,
  InstallVersionOk,
} from "@traycer-clients/shared/platform/runner-host";
import type {
  HostDoctorIssue,
  HostGetInstallationInfoResponse,
} from "@traycer/protocol/host/maintenance/index";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  LOCAL_MAINTENANCE_FALLBACK_METHODS,
  createLocalMaintenanceFallbackClient,
} from "@/lib/host/local-maintenance-fallback-client";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import {
  ExternalHostRestartTrigger,
  buildOverviewHostFixture,
  buildOverviewManagement,
  openHostOverviewAdvanced,
  openHostOverviewMenu,
  updateCheckManifest,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

afterEach(() => {
  resetHostServiceWriteLatchesForTest();
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  localHostIdMock.current = null;
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.message).mockClear();
});

const HOST_ID = "host-local";
const HOST_NAME = "Local Host";
const RELEASED_FLOOR_METHODS = ["host.status"] as const;
const RPC_INSTALL_VERSION = "rpc-1.0.0";
const BRIDGE_INSTALL_VERSION = "bridge-9.9.9";
const BRIDGE_CHECK_VERSION = "1.2.0";
const RPC_CHECK_VERSION = "1.3.0";

const SERVICE_STOPPED: HostDoctorIssue = {
  code: "SERVICE_STOPPED",
  severity: "warning",
  title: "Host service is stopped",
  message: "The launch agent is not loaded.",
  fixAction: "host-service-register",
  terminalCommand: "traycer host service install",
  details: null,
};

const CLI_UPGRADE_PENDING: HostDoctorIssue = {
  code: "CLI_UPGRADE_PENDING",
  severity: "warning",
  title: "CLI upgrade pending (2.0.0)",
  message: "Restart the host service to finalise the swap.",
  fixAction: "host-restart",
  terminalCommand: "traycer host restart --channel prod",
  details: null,
};

const RECENT_CRASH_MARKERS: HostDoctorIssue = {
  code: "RECENT_CRASH_MARKERS",
  severity: "warning",
  title: "Recent crash markers",
  message: "The host log contains recent crash markers.",
  fixAction: "host-logs",
  terminalCommand: null,
  details: null,
};

const LANE_BUSY_INSTALL_MESSAGE =
  "Traycer is installing an update on this host. Restart it once that finishes.";

const HOST_CHANGED_MESSAGE =
  "This computer's host changed while that was open. Reopen Settings and try again.";

const HOST_NOT_INSTALLED: HostDoctorIssue = {
  code: "HOST_NOT_INSTALLED",
  severity: "error",
  title: "Host not installed",
  message: "No host is installed.",
  fixAction: "host-install-latest",
  terminalCommand: "traycer host install latest",
  details: null,
};

const SERVICE_MISSING: HostDoctorIssue = {
  code: "LAUNCH_AGENT_MISSING",
  severity: "error",
  title: "Launch agent missing",
  message: "The background service is not installed.",
  fixAction: "service-install",
  terminalCommand: "traycer host service install",
  details: null,
};

const HOST_PROCESS_DOWN: HostDoctorIssue = {
  code: "HOST_PROCESS_DOWN",
  severity: "error",
  title: "Host is down",
  message: "The host process is not running.",
  fixAction: "host-start",
  terminalCommand: "traycer host start",
  details: null,
};

const PORT_HELD: HostDoctorIssue = {
  code: "PORT_HELD_BY_FOREIGN",
  severity: "error",
  title: "Port is held",
  message: "Another process holds the host port.",
  fixAction: "host-free-port-and-restart",
  terminalCommand: null,
  details: {
    port: 7420,
    conflictingPid: 99,
    conflictingProcess: "other",
  },
};

const UNKNOWN_FIX: HostDoctorIssue = {
  code: "UNKNOWN_DOCTOR_CODE",
  severity: "warning",
  title: "Unknown",
  message: "An unrecognized repair.",
  fixAction: "not-a-real-action",
  terminalCommand: null,
  details: null,
};

function healedHandshake(): void {
  recordNegotiatedHostMethods(HOST_ID, [
    ...RELEASED_FLOOR_METHODS,
    ...LOCAL_MAINTENANCE_FALLBACK_METHODS,
    "host.restart",
    "host.identity.get",
    "host.identity.set",
    "host.service.status",
    "host.service.register",
    "host.service.deregister",
  ]);
}

function managedInstallationInfo(
  version: string,
): HostGetInstallationInfoResponse {
  return {
    status: "managed",
    installRecord: {
      installId: `id-${version}`,
      version,
      runtimeVersion: version,
      platform: "darwin",
      arch: "arm64",
      installedAt: "2026-08-10T00:00:00Z",
      source: { kind: "registry", value: version },
      archiveSha256: "b".repeat(64),
      signatureVerifiedAt: "2026-08-10T00:00:00Z",
      signatureKeyId: "key-1",
      sizeBytes: 2048,
      executablePath: `/tmp/traycer/${version}/host`,
    },
    stagedRecord: null,
    cliManifest: null,
  };
}

function bindingWith(hostClient: unknown): HostBindingMock {
  return {
    hostClient,
    directory: {
      getLocalEntry: () =>
        localHostIdMock.current === null
          ? null
          : { hostId: localHostIdMock.current },
    },
  };
}

function makeRunnerHostWithManagement(
  management: IHostManagement | null,
): IRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    hostManagement: management,
  });
}

function fallbackScope(
  fixture: OverviewHostFixture,
  management: IHostManagement,
): Record<string, unknown> {
  const client = createLocalMaintenanceFallbackClient({
    client: fixture.client,
    localHostId: HOST_ID,
    management,
  });
  return {
    host: hostScopeOptionFixture({
      hostId: HOST_ID,
      name: HOST_NAME,
      isLocalMachine: true,
      connectable: true,
      platform: "darwin-arm64",
      version: "1.1.11",
    }),
    hostId: HOST_ID,
    hostLabel: HOST_NAME,
    status: "ready",
    client,
    localMaintenanceFallback: true,
  };
}

function renderOverview(input: {
  readonly management: IHostManagement;
  readonly queryClient: QueryClient;
  readonly extra: ReactNode | undefined;
}): void {
  render(
    <QueryClientProvider client={input.queryClient}>
      <RunnerHostProvider
        runnerHost={makeRunnerHostWithManagement(input.management)}
      >
        {input.extra ?? null}
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function mountFallbackOverview(options: {
  readonly installOutcome: MutationOutcome<InstallVersionOk>;
  readonly rpcCheckCalls: { count: number };
  readonly restartHostIfIdle:
    | ((input: {
        readonly expectedHostId: string;
      }) => Promise<HostRestartRequestResult>)
    | undefined;
  readonly extraHandshakeMethods: readonly string[] | undefined;
  readonly extra: ReactNode | undefined;
}): {
  readonly management: IHostManagement;
  readonly fixture: OverviewHostFixture;
  readonly queryClient: QueryClient;
  readonly rpcLogCalls: { count: number };
} {
  const rpcCheckCalls = options.rpcCheckCalls;
  const rpcLogCalls = { count: 0 };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const fixture = buildOverviewHostFixture({
    hostId: HOST_ID,
    isLocalMachine: true,
    hostVersion: "1.1.11",
    effectiveName: HOST_NAME,
    invalidator: createHostQueryInvalidator(queryClient),
    overrideHandlers: {
      "host.update.check": () => {
        rpcCheckCalls.count += 1;
        return {
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest(RPC_CHECK_VERSION),
        };
      },
      "host.getInstallationInfo": () =>
        managedInstallationInfo(RPC_INSTALL_VERSION),
      "diagnostics.logs.tail": () => {
        rpcLogCalls.count += 1;
        return {
          status: "available" as const,
          target: "host" as const,
          path: "/tmp/host.log",
          lines: ["rpc-log-line"],
          truncated: false,
        };
      },
    },
  });
  const management = buildOverviewManagement({
    maintenanceUpdateCheck: vi.fn(() =>
      Promise.resolve({
        outcome: "ok" as const,
        effectiveIncludePreReleases: false,
        includePreReleasesSource: "stable-default" as const,
        manifest: updateCheckManifest(BRIDGE_CHECK_VERSION),
      }),
    ),
    maintenanceInstallVersion: vi.fn(
      (_input: {
        readonly version: string;
        readonly force: boolean;
        readonly expectedHostId: string;
      }) =>
        Promise.resolve({
          kind: "dispatched" as const,
          outcome: options.installOutcome,
        }),
    ),
    maintenanceDoctor: vi.fn(() =>
      Promise.resolve({
        status: "ok" as const,
        issues: [SERVICE_STOPPED],
      }),
    ),
    maintenanceInstallationInfo: vi.fn(() =>
      Promise.resolve(managedInstallationInfo(BRIDGE_INSTALL_VERSION)),
    ),
    runDoctorRepairIfIdle: vi.fn(
      (_input: {
        readonly repair: DoctorRepairIntent;
        readonly expectedHostId: string;
      }) =>
        Promise.resolve({
          kind: "dispatched" as const,
          outcome: { kind: "ok" as const, value: null },
        } satisfies DoctorRepairDispatch),
    ),
    ...(options.restartHostIfIdle === undefined
      ? {}
      : { restartHostIfIdle: vi.fn(options.restartHostIfIdle) }),
  });
  recordNegotiatedHostMethods(HOST_ID, [
    ...RELEASED_FLOOR_METHODS,
    ...(options.extraHandshakeMethods ?? []),
  ]);
  localHostIdMock.current = HOST_ID;
  hostBindingMock.current = bindingWith(fixture.client);
  scopeOverrides.current = fallbackScope(fixture, management);
  renderOverview({
    management,
    queryClient,
    extra: options.extra,
  });
  return { management, fixture, queryClient, rpcLogCalls };
}

function expectButtonEnabled(button: HTMLElement): void {
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected an HTMLButtonElement");
  }
  expect(button.disabled).toBe(false);
}

describe("<HostSettingsPanel /> local-maintenance CLI fallback", () => {
  it("renders the intercepted four without degrade notices, and keeps service/rename degraded", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });

    expect(await screen.findByTestId("host-overview-updates")).toBeTruthy();
    expect(screen.queryByTestId("host-overview-updates-degraded")).toBeNull();

    expect(
      screen.queryByTestId("host-overview-installation-degraded"),
    ).toBeNull();
    await waitFor(() => {
      expect(management.maintenanceInstallationInfo).toHaveBeenCalledWith({
        expectedHostId: HOST_ID,
      });
    });
    fireEvent.click(await screen.findByText("Installation details"));
    const installVersion = await screen.findByTestId(
      "settings-host-install-version",
    );
    expect(installVersion.textContent).toContain(`v${BRIDGE_INSTALL_VERSION}`);
    expect(installVersion.textContent).not.toContain(RPC_INSTALL_VERSION);

    const pencil = await screen.findByTestId("host-overview-edit-name");
    expect(pencil.getAttribute("data-degraded")).toBe("unsupported");

    await openHostOverviewAdvanced();
    expect(
      await screen.findByTestId("host-overview-service-degraded"),
    ).toBeTruthy();

    await openHostOverviewMenu();
    const doctor = await screen.findByTestId("host-overview-run-doctor");
    expect(doctor.getAttribute("data-degraded")).toBeNull();
    expect(doctor.getAttribute("aria-disabled")).not.toBe("true");

    const restart = screen.getByTestId("host-overview-restart");
    expect(restart.getAttribute("data-degraded")).toBeNull();
    expect(restart.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("Update now dispatches maintenanceInstallVersion({version, force:false}) and an ok outcome lands the accepted path", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });

    await screen.findByText(`v${BRIDGE_CHECK_VERSION} is available.`);
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));

    await waitFor(() => {
      expect(management.maintenanceInstallVersion).toHaveBeenCalledWith({
        version: BRIDGE_CHECK_VERSION,
        force: false,
        expectedHostId: HOST_ID,
      });
    });
    expect(management.installVersion).not.toHaveBeenCalled();
    expect(management.getHostControllerStatus).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        `Updating Local Host to v${BRIDGE_CHECK_VERSION}`,
      );
    });
  });

  it("a busy install outcome surfaces as the mutation error toast, does not retire the region, and re-enables Update now", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "busy",
        continuation: "retry-with-force",
        message: "Host is busy installing another version.",
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });

    await screen.findByText(`v${BRIDGE_CHECK_VERSION} is available.`);
    const updateNow = await screen.findByRole("button", { name: "Update now" });
    fireEvent.click(updateNow);

    await waitFor(() => {
      expect(management.maintenanceInstallVersion).toHaveBeenCalledWith({
        version: BRIDGE_CHECK_VERSION,
        force: false,
        expectedHostId: HOST_ID,
      });
    });
    expect(management.installVersion).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("host-overview-updates-degraded")).toBeNull();
    expect(screen.getByTestId("host-overview-updates")).toBeTruthy();
    const updateNowAfter = screen.getByRole("button", { name: "Update now" });
    expectButtonEnabled(updateNowAfter);
  });

  it("Run doctor leaves SERVICE_STOPPED ACTIONABLE on this lane", async () => {
    // Inverted deliberately. The disproven-by-transport bucket exists because
    // a host answering over loopback proves its own listener is live - but
    // this lane's report comes from the bundled CLI over IPC and completes
    // with the host down, so it has no such proof to offer. Bucketing
    // SERVICE_STOPPED as disproven here hides a real outage behind a green
    // card, which is the one direction that actually costs the user.
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));

    await waitFor(() => {
      expect(management.maintenanceDoctor).toHaveBeenCalledWith({
        expectedHostId: HOST_ID,
      });
    });
    // Reported, not swallowed: the issue renders in the actionable list and
    // no disproven bucket is offered at all, because this projection sends an
    // empty trivially-green set.
    expect(
      await screen.findByTestId("host-doctor-issue-SERVICE_STOPPED"),
    ).toBeTruthy();
    expect(screen.queryByText("Doctor: no issues detected.")).toBeNull();
    expect(
      screen.queryByTestId("host-doctor-disproven-by-transport"),
    ).toBeNull();
  });

  it("own Restart confirm stays open and pending until the deferred respawn settles, then closes", async () => {
    let releaseRestart: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    const { management, fixture } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: async () => {
        await gate;
        return {
          kind: "declined" as const,
          message: "Another process holds the host lock.",
        };
      },
      extraHandshakeMethods: undefined,
      extra: undefined,
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog).toBeTruthy();
    await waitFor(() => {
      expect(management.restartHostIfIdle).toHaveBeenCalledWith({
        expectedHostId: HOST_ID,
      });
    });
    expect(management.restartHost).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("confirm-action");
    if (!(confirm instanceof HTMLButtonElement)) {
      throw new Error("expected confirm button");
    }
    expect(confirm.disabled).toBe(true);
    expect(fixture.restartCalls()).toBe(0);

    await act(async () => {
      releaseRestart?.();
      await gate;
    });

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(toast.info).toHaveBeenCalledWith("Host not restarted", {
      description: "Another process holds the host lock.",
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("an external same-key hostRestart closes an open idle confirm without treating it as this dialog's dispatch", async () => {
    let releaseExternal: (() => void) | null = null;
    const externalGate = new Promise<void>((resolve) => {
      releaseExternal = resolve;
    });
    const mutateRef: { current: (() => void) | null } = { current: null };
    const { fixture } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: (
        <ExternalHostRestartTrigger
          onReady={(mutate) => {
            mutateRef.current = mutate;
          }}
          mutationFn={async () => {
            await externalGate;
            return { kind: "restarted" as const };
          }}
        />
      ),
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    await screen.findByTestId("confirm-destructive-dialog");
    const confirm = screen.getByTestId("confirm-action");
    if (!(confirm instanceof HTMLButtonElement)) {
      throw new Error("expected confirm button");
    }
    expect(confirm.disabled).toBe(false);
    expect(fixture.restartCalls()).toBe(0);

    act(() => {
      if (mutateRef.current === null) {
        throw new Error("external restart trigger was not armed");
      }
      mutateRef.current();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(fixture.restartCalls()).toBe(0);

    await act(async () => {
      releaseExternal?.();
      await externalGate;
    });
  });

  it("self-heals onto the RPC client after the negotiated manifest flips and availability recovers, without a click", async () => {
    const rpcCheckCalls = { count: 0 };
    const { management, fixture } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls,
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });

    await screen.findByText(`v${BRIDGE_CHECK_VERSION} is available.`);
    expect(management.maintenanceUpdateCheck).toHaveBeenCalled();
    const fallbackChecks = vi.mocked(management.maintenanceUpdateCheck).mock
      .calls.length;
    expect(rpcCheckCalls.count).toBe(0);

    act(() => {
      healedHandshake();
      fixture.client.notifyHostAvailabilityRecovered(HOST_ID);
    });

    await waitFor(() => {
      expect(rpcCheckCalls.count).toBe(1);
    });
    expect(
      await screen.findByText(`v${RPC_CHECK_VERSION} is available.`),
    ).toBeTruthy();
    expect(vi.mocked(management.maintenanceUpdateCheck).mock.calls.length).toBe(
      fallbackChecks,
    );
  });

  it("a host-restart doctor fix on a capability-false local host opens the page confirm, then dispatches on confirm", async () => {
    // Discriminator: the P1 was a one-click `forceRestart.mutate()` from
    // the Doctor sheet — skipping the same RestartHostConfirmDialog the
    // header uses. Click must open the dialog; confirm then fires the
    // page's forceRestart once. `onLocalFix` would land on `hostRunDoctor`.
    const { management, fixture, queryClient } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: () => Promise.resolve({ kind: "restarted" as const }),
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [CLI_UPGRADE_PENDING],
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    const doctorMutationsBefore = queryClient
      .getMutationCache()
      .getAll()
      .filter(
        (mutation) =>
          JSON.stringify(mutation.options.mutationKey) ===
          JSON.stringify(runnerMutationKeys.hostRunDoctor()),
      ).length;
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-CLI_UPGRADE_PENDING"),
    );

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("Restarting will stop");
    expect(management.restartHostIfIdle).not.toHaveBeenCalled();
    expect(management.restartHost).not.toHaveBeenCalled();
    expect(fixture.restartCalls()).toBe(0);

    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(management.restartHostIfIdle).toHaveBeenCalledWith({
        expectedHostId: HOST_ID,
      });
    });
    expect(management.restartHostIfIdle).toHaveBeenCalledTimes(1);
    expect(management.restartHost).not.toHaveBeenCalled();
    expect(fixture.restartCalls()).toBe(0);
    const doctorMutationsAfter = queryClient
      .getMutationCache()
      .getAll()
      .filter(
        (mutation) =>
          JSON.stringify(mutation.options.mutationKey) ===
          JSON.stringify(runnerMutationKeys.hostRunDoctor()),
      ).length;
    expect(doctorMutationsAfter).toBe(doctorMutationsBefore);
    const restartMutations = queryClient
      .getMutationCache()
      .getAll()
      .filter(
        (mutation) =>
          JSON.stringify(mutation.options.mutationKey) ===
          JSON.stringify(runnerMutationKeys.hostRestart()),
      );
    expect(restartMutations.length).toBeGreaterThan(0);
  });

  it("a host-restart doctor fix is disabled while a same-key hostRestart is in flight, and a click does not dispatch", async () => {
    // Discriminator: if `DoctorFixControl` still reads `localFixPending` on
    // the local-bridge restart route, the button stays enabled (and the
    // click is only a silent no-op). `bridgeRestartPending` owning that
    // route's pending state disables it.
    let releaseExternal: (() => void) | null = null;
    const externalGate = new Promise<void>((resolve) => {
      releaseExternal = resolve;
    });
    const mutateRef: { current: (() => void) | null } = { current: null };
    const { management, queryClient } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: () => Promise.resolve({ kind: "restarted" as const }),
      extraHandshakeMethods: undefined,
      extra: (
        <ExternalHostRestartTrigger
          onReady={(mutate) => {
            mutateRef.current = mutate;
          }}
          mutationFn={async () => {
            await externalGate;
            return { kind: "restarted" as const };
          }}
        />
      ),
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [CLI_UPGRADE_PENDING],
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    const idleFix = await screen.findByTestId(
      "host-doctor-fix-CLI_UPGRADE_PENDING",
    );
    expectButtonEnabled(idleFix);

    act(() => {
      if (mutateRef.current === null) {
        throw new Error("external restart trigger was not armed");
      }
      mutateRef.current();
    });
    await waitFor(() => {
      expect(
        queryClient.isMutating({
          mutationKey: runnerMutationKeys.hostRestart(),
        }),
      ).toBeGreaterThan(0);
    });

    const gatedFix = screen.getByTestId("host-doctor-fix-CLI_UPGRADE_PENDING");
    if (!(gatedFix instanceof HTMLButtonElement)) {
      throw new Error("expected fix button");
    }
    expect(gatedFix.disabled).toBe(true);
    fireEvent.click(gatedFix);
    expect(management.restartHostIfIdle).not.toHaveBeenCalled();
    expect(management.restartHost).not.toHaveBeenCalled();

    await act(async () => {
      releaseExternal?.();
      await externalGate;
    });
    await waitFor(() => {
      expectButtonEnabled(
        screen.getByTestId("host-doctor-fix-CLI_UPGRADE_PENDING"),
      );
    });
  });

  it("a watched Restart confirm refused by a busy lane closes with an informational toast, not an error", async () => {
    const { management, fixture } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: () =>
        Promise.resolve({
          kind: "declined" as const,
          message: LANE_BUSY_INSTALL_MESSAGE,
        }),
      extraHandshakeMethods: undefined,
      extra: undefined,
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );

    await waitFor(() => {
      expect(management.restartHostIfIdle).toHaveBeenCalledWith({
        expectedHostId: HOST_ID,
      });
    });
    expect(management.restartHost).not.toHaveBeenCalled();
    expect(fixture.restartCalls()).toBe(0);
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    expect(toast.info).toHaveBeenCalledWith("Host not restarted", {
      description: LANE_BUSY_INSTALL_MESSAGE,
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a watched Restart confirm on an idle lane still respawns", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: () => Promise.resolve({ kind: "restarted" as const }),
      extraHandshakeMethods: undefined,
      extra: undefined,
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );

    await waitFor(() => {
      expect(management.restartHostIfIdle).toHaveBeenCalledWith({
        expectedHostId: HOST_ID,
      });
    });
    expect(management.restartHost).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Host restart requested");
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("Show logs on a capability-false local host reads the bridge log, not diagnostics.logs.tail", async () => {
    const { management, rpcLogCalls } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [RECENT_CRASH_MARKERS],
    });
    vi.mocked(management.getHostLogs).mockResolvedValue({
      path: "/tmp/host.log",
      tail: "bridge-line-1\nbridge-line-2",
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-RECENT_CRASH_MARKERS"),
    );

    await waitFor(() => {
      // Carries the identity fence: this read projects THIS machine's log
      // under a scope frozen on HOST_ID, so a replaced local host must be
      // refused rather than answered with its successor's log.
      expect(management.getHostLogs).toHaveBeenCalledWith({
        tailLines: 200,
        expectedHostId: HOST_ID,
      });
    });
    expect(rpcLogCalls.count).toBe(0);
    const tail = await screen.findByTestId("host-doctor-log-tail");
    expect(tail.textContent).toContain("bridge-line-1");
    expect(tail.textContent).toContain("bridge-line-2");
    expect(tail.textContent).not.toContain("rpc-log-line");
  });

  it("Show logs uses diagnostics.logs.tail when the host advertises it, and does not call getHostLogs", async () => {
    const { management, rpcLogCalls } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: ["diagnostics.logs.tail"],
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [RECENT_CRASH_MARKERS],
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-RECENT_CRASH_MARKERS"),
    );

    await waitFor(() => {
      expect(rpcLogCalls.count).toBe(1);
    });
    expect(management.getHostLogs).not.toHaveBeenCalled();
    const tail = await screen.findByTestId("host-doctor-log-tail");
    expect(tail.textContent).toContain("rpc-log-line");
    expect(tail.textContent).not.toContain("bridge-line-1");
    expect(management.runDoctorRepairIfIdle).not.toHaveBeenCalled();
  });

  it("Install host (HOST_NOT_INSTALLED) dispatches runDoctorRepairIfIdle converge-ready with the captured local id", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [HOST_NOT_INSTALLED],
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-HOST_NOT_INSTALLED"),
    );

    await waitFor(() => {
      expect(management.runDoctorRepairIfIdle).toHaveBeenCalledWith({
        repair: "converge-ready",
        expectedHostId: HOST_ID,
      });
    });
    expect(management.convergeReady).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Fix applied");
  });

  it("Register service dispatches runDoctorRepairIfIdle register-service, not the queueing registerService", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [SERVICE_MISSING],
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-LAUNCH_AGENT_MISSING"),
    );

    await waitFor(() => {
      expect(management.runDoctorRepairIfIdle).toHaveBeenCalledWith({
        repair: "register-service",
        expectedHostId: HOST_ID,
      });
    });
    expect(management.registerService).not.toHaveBeenCalled();
  });

  it("a lane-busy doctor repair is informational, not an error, and does not converge", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [HOST_NOT_INSTALLED],
    });
    vi.mocked(management.runDoctorRepairIfIdle).mockResolvedValue({
      kind: "lane-busy",
      message: LANE_BUSY_INSTALL_MESSAGE,
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-HOST_NOT_INSTALLED"),
    );

    await waitFor(() => {
      // NOT "Host not restarted": the click was Install host, and reporting a
      // refused install as a refused restart names an action nobody asked for.
      expect(toast.info).toHaveBeenCalledWith("Install host didn't run", {
        description: LANE_BUSY_INSTALL_MESSAGE,
      });
    });
    expect(toast.success).not.toHaveBeenCalledWith("Fix applied");
    expect(toast.error).not.toHaveBeenCalled();
    expect(management.convergeReady).not.toHaveBeenCalled();
  });

  it("a host-changed doctor repair is informational and does not converge", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [HOST_NOT_INSTALLED],
    });
    vi.mocked(management.runDoctorRepairIfIdle).mockResolvedValue({
      kind: "host-changed",
      message: HOST_CHANGED_MESSAGE,
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-HOST_NOT_INSTALLED"),
    );

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith("Install host didn't run", {
        description: HOST_CHANGED_MESSAGE,
      });
    });
    expect(toast.success).not.toHaveBeenCalledWith("Fix applied");
    expect(management.convergeReady).not.toHaveBeenCalled();
  });

  it("a lane-busy Register service repair names the clicked action, not a refused restart", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [SERVICE_MISSING],
    });
    vi.mocked(management.runDoctorRepairIfIdle).mockResolvedValue({
      kind: "lane-busy",
      message: LANE_BUSY_INSTALL_MESSAGE,
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-LAUNCH_AGENT_MISSING"),
    );

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith("Register service didn't run", {
        description: LANE_BUSY_INSTALL_MESSAGE,
      });
    });
    expect(toast.info).not.toHaveBeenCalledWith(
      "Host not restarted",
      expect.anything(),
    );
    expect(toast.success).not.toHaveBeenCalledWith("Fix applied");
    expect(toast.error).not.toHaveBeenCalled();
    expect(management.convergeReady).not.toHaveBeenCalled();
  });

  it("a declined doctor restart still reports Host not restarted", async () => {
    // The split must not over-rotate: a genuine restart decline keeps the
    // restart wording, it does not become "Restart host didn't run".
    const { management, fixture } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: () =>
        Promise.resolve({
          kind: "declined" as const,
          message: LANE_BUSY_INSTALL_MESSAGE,
        }),
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [CLI_UPGRADE_PENDING],
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-CLI_UPGRADE_PENDING"),
    );
    fireEvent.click(await screen.findByTestId("confirm-action"));

    await waitFor(() => {
      expect(management.restartHostIfIdle).toHaveBeenCalledWith({
        expectedHostId: HOST_ID,
      });
    });
    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith("Host not restarted", {
        description: LANE_BUSY_INSTALL_MESSAGE,
      });
    });
    expect(toast.info).not.toHaveBeenCalledWith(
      "Restart host didn't run",
      expect.anything(),
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(fixture.restartCalls()).toBe(0);
  });

  it("a dispatched non-ok doctor repair surfaces as a thrown Fix failed error", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [HOST_NOT_INSTALLED],
    });
    vi.mocked(management.runDoctorRepairIfIdle).mockResolvedValue({
      kind: "dispatched",
      outcome: { kind: "failed", message: "converge failed" },
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-HOST_NOT_INSTALLED"),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(toast.success).not.toHaveBeenCalledWith("Fix applied");
    expect(management.convergeReady).not.toHaveBeenCalled();
  });

  it("host-start on a capability-false local host still uses the page restart, not runDoctorRepairIfIdle", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: () => Promise.resolve({ kind: "restarted" as const }),
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [HOST_PROCESS_DOWN],
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-HOST_PROCESS_DOWN"),
    );

    expect(
      await screen.findByTestId("confirm-destructive-dialog"),
    ).toBeTruthy();
    expect(management.restartHostIfIdle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-action"));
    await waitFor(() => {
      expect(management.restartHostIfIdle).toHaveBeenCalledWith({
        expectedHostId: HOST_ID,
      });
    });
    expect(management.runDoctorRepairIfIdle).not.toHaveBeenCalled();
  });

  it("host-free-port-and-restart on the watched sheet dispatches freePortAndRestartIfIdle, not the queueing freePortAndRestart", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [PORT_HELD],
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-PORT_HELD_BY_FOREIGN"),
    );
    fireEvent.click(await screen.findByTestId("confirm-action"));

    await waitFor(() => {
      expect(management.freePortAndRestartIfIdle).toHaveBeenCalledWith({
        port: 7420,
        pid: 99,
        processName: "other",
        expectedHostId: HOST_ID,
      });
    });
    expect(management.freePortAndRestart).not.toHaveBeenCalled();
    expect(management.runDoctorRepairIfIdle).not.toHaveBeenCalled();
  });

  it("a lane-busy Free port + restart names the clicked action and never takes the queueing route", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [PORT_HELD],
    });
    vi.mocked(management.freePortAndRestartIfIdle).mockResolvedValue({
      kind: "lane-busy",
      message: LANE_BUSY_INSTALL_MESSAGE,
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-PORT_HELD_BY_FOREIGN"),
    );
    fireEvent.click(await screen.findByTestId("confirm-action"));

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        "Free port + restart didn't run",
        {
          description: LANE_BUSY_INSTALL_MESSAGE,
        },
      );
    });
    expect(management.freePortAndRestart).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalledWith("Fix applied");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("an unknown fix action does not take the refusing doctor-repair path", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: undefined,
      extraHandshakeMethods: undefined,
      extra: undefined,
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [UNKNOWN_FIX],
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    fireEvent.click(
      await screen.findByTestId("host-doctor-fix-UNKNOWN_DOCTOR_CODE"),
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(management.runDoctorRepairIfIdle).not.toHaveBeenCalled();
  });

  it("an HOST_NOT_INSTALLED fix is disabled while a same-key hostRestart is in flight, and a click does not dispatch", async () => {
    // Discriminator: round 4 only gated the restart pair. Widening to EVERY
    // bridge-routed repair disables Install host while the page's lifecycle
    // gate is armed. Red against 8816fab7^ if DoctorFixControl still uses
    // isBridgeRestart.
    let releaseExternal: (() => void) | null = null;
    const externalGate = new Promise<void>((resolve) => {
      releaseExternal = resolve;
    });
    const mutateRef: { current: (() => void) | null } = { current: null };
    const { management, queryClient } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHostIfIdle: () => Promise.resolve({ kind: "restarted" as const }),
      extraHandshakeMethods: undefined,
      extra: (
        <ExternalHostRestartTrigger
          onReady={(mutate) => {
            mutateRef.current = mutate;
          }}
          mutationFn={async () => {
            await externalGate;
            return { kind: "restarted" as const };
          }}
        />
      ),
    });
    vi.mocked(management.maintenanceDoctor).mockResolvedValue({
      status: "ok",
      issues: [HOST_NOT_INSTALLED],
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));
    const idleFix = await screen.findByTestId(
      "host-doctor-fix-HOST_NOT_INSTALLED",
    );
    expectButtonEnabled(idleFix);

    act(() => {
      if (mutateRef.current === null) {
        throw new Error("external restart trigger was not armed");
      }
      mutateRef.current();
    });
    await waitFor(() => {
      expect(
        queryClient.isMutating({
          mutationKey: runnerMutationKeys.hostRestart(),
        }),
      ).toBeGreaterThan(0);
    });

    const gatedFix = screen.getByTestId("host-doctor-fix-HOST_NOT_INSTALLED");
    if (!(gatedFix instanceof HTMLButtonElement)) {
      throw new Error("expected fix button");
    }
    expect(gatedFix.disabled).toBe(true);
    fireEvent.click(gatedFix);
    expect(management.runDoctorRepairIfIdle).not.toHaveBeenCalled();
    expect(management.convergeReady).not.toHaveBeenCalled();

    await act(async () => {
      releaseExternal?.();
      await externalGate;
    });
    await waitFor(() => {
      expectButtonEnabled(
        screen.getByTestId("host-doctor-fix-HOST_NOT_INSTALLED"),
      );
    });
  });
});
