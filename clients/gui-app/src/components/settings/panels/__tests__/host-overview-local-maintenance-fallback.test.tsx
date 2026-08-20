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

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  IHostManagement,
  IRunnerHost,
  MutationOutcome,
  InstallVersionOk,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { resetHostServiceWriteLatchesForTest } from "@/components/settings/panels/host-service-write-latch-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import {
  LOCAL_MAINTENANCE_FALLBACK_METHODS,
  createLocalMaintenanceFallbackClient,
} from "@/lib/host/local-maintenance-fallback-client";
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

const SERVICE_STOPPED: HostDoctorIssue = {
  code: "SERVICE_STOPPED",
  severity: "warning",
  title: "Host service is stopped",
  message: "The launch agent is not loaded.",
  fixAction: "host-service-register",
  terminalCommand: "traycer host service install",
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

function renderOverview(management: IHostManagement): void {
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <RunnerHostProvider runnerHost={makeRunnerHostWithManagement(management)}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

function mountFallbackOverview(options: {
  readonly installOutcome: MutationOutcome<InstallVersionOk>;
  readonly rpcCheckCalls: { count: number };
}): {
  readonly management: IHostManagement;
  readonly fixture: OverviewHostFixture;
} {
  const rpcCheckCalls = options.rpcCheckCalls;
  const fixture = buildOverviewHostFixture({
    hostId: HOST_ID,
    isLocalMachine: true,
    hostVersion: "1.1.11",
    effectiveName: HOST_NAME,
    overrideHandlers: {
      "host.update.check": () => {
        rpcCheckCalls.count += 1;
        return {
          outcome: "ok" as const,
          manifest: updateCheckManifest("1.2.0"),
        };
      },
    },
  });
  const management = buildOverviewManagement({
    maintenanceUpdateCheck: vi.fn(() =>
      Promise.resolve({
        outcome: "ok" as const,
        manifest: updateCheckManifest("1.2.0"),
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
      Promise.resolve({ status: "unmanaged" as const }),
    ),
  });
  releasedFloorHandshake();
  localHostIdMock.current = HOST_ID;
  hostBindingMock.current = bindingWith(fixture.client);
  scopeOverrides.current = fallbackScope(fixture, management);
  renderOverview(management);
  return { management, fixture };
}

describe("<HostSettingsPanel /> local-maintenance CLI fallback", () => {
  it("renders the intercepted four without degrade notices, and keeps service/rename degraded", async () => {
    mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
    });

    expect(await screen.findByTestId("host-overview-updates")).toBeTruthy();
    expect(screen.queryByTestId("host-overview-updates-degraded")).toBeNull();

    expect(
      screen.queryByTestId("host-overview-installation-degraded"),
    ).toBeNull();

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
    });

    await screen.findByText("v1.2.0 is available.");
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));

    await waitFor(() => {
      expect(management.installVersion).toHaveBeenCalledWith("1.2.0", false);
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        "Updating Local Host to v1.2.0",
      );
    });
  });

  it("a busy install outcome surfaces as the mutation error toast and does not retire the updates region", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "busy",
        continuation: "retry-with-force",
        message: "Host is busy installing another version.",
      },
      rpcCheckCalls: { count: 0 },
    });

    await screen.findByText("v1.2.0 is available.");
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));

    await waitFor(() => {
      expect(management.installVersion).toHaveBeenCalledWith("1.2.0", false);
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("host-overview-updates-degraded")).toBeNull();
    expect(screen.getByTestId("host-overview-updates")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy();
  });

  it("Run doctor puts SERVICE_STOPPED in the disproven-by-transport bucket", async () => {
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls: { count: 0 },
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

  it("Restart confirm dispatches management.restartHost, not host.restart, and declined is informational", async () => {
    const fixture = buildOverviewHostFixture({
      hostId: HOST_ID,
      isLocalMachine: true,
      hostVersion: "1.1.11",
      effectiveName: HOST_NAME,
    });
    const restartHost = vi.fn(() =>
      Promise.resolve({
        kind: "declined" as const,
        message: "Another process holds the host lock.",
      }),
    );
    const management = buildOverviewManagement({
      restartHost,
      maintenanceUpdateCheck: () =>
        Promise.resolve({
          outcome: "ok" as const,
          manifest: updateCheckManifest("1.2.0"),
        }),
      maintenanceDoctor: () =>
        Promise.resolve({ status: "ok" as const, issues: [] }),
      maintenanceInstallationInfo: () =>
        Promise.resolve({ status: "unmanaged" as const }),
    });
    releasedFloorHandshake();
    localHostIdMock.current = HOST_ID;
    hostBindingMock.current = bindingWith(fixture.client);
    scopeOverrides.current = fallbackScope(fixture, management);
    renderOverview(management);

    await openHostOverviewMenu();
    fireEvent.click(await screen.findByTestId("host-overview-restart"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart host" }),
    );

    await waitFor(() => {
      expect(restartHost).toHaveBeenCalledTimes(1);
    });
    expect(fixture.restartCalls()).toBe(0);
    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith("Host not restarted", {
        description: "Another process holds the host lock.",
      });
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("self-heals onto the RPC client after the negotiated manifest grows the maintenance family", async () => {
    const rpcCheckCalls = { count: 0 };
    const { management } = mountFallbackOverview({
      installOutcome: {
        kind: "ok",
        value: { installedVersion: "1.2.0", runningActivated: true },
      },
      rpcCheckCalls,
    });

    await screen.findByText("v1.2.0 is available.");
    expect(management.maintenanceUpdateCheck).toHaveBeenCalled();
    const fallbackChecks = vi.mocked(management.maintenanceUpdateCheck).mock
      .calls.length;
    expect(rpcCheckCalls.count).toBe(0);

    act(() => {
      healedHandshake();
    });

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));

    await waitFor(() => {
      expect(rpcCheckCalls.count).toBe(1);
    });
    expect(vi.mocked(management.maintenanceUpdateCheck).mock.calls.length).toBe(
      fallbackChecks,
    );
  });
});
