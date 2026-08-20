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

import { useEffect, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
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

function releasedFloorHandshake(): void {
  recordNegotiatedHostMethods(HOST_ID, RELEASED_FLOOR_METHODS);
}

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

function ExternalHostRestartTrigger(props: {
  readonly mutationFn: () => Promise<HostRestartRequestResult>;
  readonly onReady: (mutate: () => void) => void;
}): null {
  const { mutate } = useMutation({
    mutationKey: runnerMutationKeys.hostRestart(),
    mutationFn: props.mutationFn,
  });
  const { onReady } = props;
  useEffect(() => {
    onReady(() => {
      mutate();
    });
  }, [mutate, onReady]);
  return null;
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
  readonly restartHost: (() => Promise<HostRestartRequestResult>) | undefined;
  readonly extra: ReactNode | undefined;
}): {
  readonly management: IHostManagement;
  readonly fixture: OverviewHostFixture;
  readonly queryClient: QueryClient;
} {
  const rpcCheckCalls = options.rpcCheckCalls;
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
          manifest: updateCheckManifest(RPC_CHECK_VERSION),
        };
      },
      "host.getInstallationInfo": () =>
        managedInstallationInfo(RPC_INSTALL_VERSION),
    },
  });
  const management = buildOverviewManagement({
    maintenanceUpdateCheck: vi.fn(() =>
      Promise.resolve({
        outcome: "ok" as const,
        manifest: updateCheckManifest(BRIDGE_CHECK_VERSION),
      }),
    ),
    installVersion: vi.fn((_version: string, _force: boolean) =>
      Promise.resolve(options.installOutcome),
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
    ...(options.restartHost === undefined
      ? {}
      : { restartHost: vi.fn(options.restartHost) }),
  });
  releasedFloorHandshake();
  localHostIdMock.current = HOST_ID;
  hostBindingMock.current = bindingWith(fixture.client);
  scopeOverrides.current = fallbackScope(fixture, management);
  renderOverview({
    management,
    queryClient,
    extra: options.extra,
  });
  return { management, fixture, queryClient };
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
      restartHost: undefined,
      extra: undefined,
    });

    expect(await screen.findByTestId("host-overview-updates")).toBeTruthy();
    expect(screen.queryByTestId("host-overview-updates-degraded")).toBeNull();

    expect(
      screen.queryByTestId("host-overview-installation-degraded"),
    ).toBeNull();
    await waitFor(() => {
      expect(management.maintenanceInstallationInfo).toHaveBeenCalled();
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

  it("Update now dispatches installVersion(version, false) and an ok outcome lands the accepted path", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHost: undefined,
      extra: undefined,
    });

    await screen.findByText(`v${BRIDGE_CHECK_VERSION} is available.`);
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));

    await waitFor(() => {
      expect(management.installVersion).toHaveBeenCalledWith(
        BRIDGE_CHECK_VERSION,
        false,
      );
    });
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
      restartHost: undefined,
      extra: undefined,
    });

    await screen.findByText(`v${BRIDGE_CHECK_VERSION} is available.`);
    const updateNow = await screen.findByRole("button", { name: "Update now" });
    fireEvent.click(updateNow);

    await waitFor(() => {
      expect(management.installVersion).toHaveBeenCalledWith(
        BRIDGE_CHECK_VERSION,
        false,
      );
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("host-overview-updates-degraded")).toBeNull();
    expect(screen.getByTestId("host-overview-updates")).toBeTruthy();
    const updateNowAfter = screen.getByRole("button", { name: "Update now" });
    expectButtonEnabled(updateNowAfter);
  });

  it("Run doctor puts SERVICE_STOPPED in the disproven-by-transport bucket", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHost: undefined,
      extra: undefined,
    });

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-run-doctor"));

    await waitFor(() => {
      expect(management.maintenanceDoctor).toHaveBeenCalled();
    });
    expect(await screen.findByText("Doctor: no issues detected.")).toBeTruthy();
    fireEvent.click(await screen.findByText(/this connection already answers/));
    expect(
      await screen.findByTestId("host-doctor-disproven-by-transport"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("host-doctor-disproven-SERVICE_STOPPED"),
    ).toBeTruthy();
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
      restartHost: async () => {
        await gate;
        return {
          kind: "declined" as const,
          message: "Another process holds the host lock.",
        };
      },
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
      expect(management.restartHost).toHaveBeenCalledTimes(1);
    });
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
      restartHost: undefined,
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
      restartHost: undefined,
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

  it("a host-restart doctor fix on a capability-false local host dispatches the bridge respawn, not host.restart", async () => {
    // Discriminator: if `rpcRestartSupported` is hardcoded true, the fix
    // button takes the RPC route and `fixture.restartCalls()` increments
    // instead of `management.restartHost`.
    const { management, fixture } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
      restartHost: () => Promise.resolve({ kind: "restarted" as const }),
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

    await waitFor(() => {
      expect(management.restartHost).toHaveBeenCalledTimes(1);
    });
    expect(fixture.restartCalls()).toBe(0);
  });
});
