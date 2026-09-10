import { describe, expect, it, vi } from "vitest";
import {
  doctorFixRoute,
  freePortConfirmWentStale,
  runFixAction,
} from "@/components/settings/panels/host-doctor-actions";
import type {
  HostDoctorIssue,
  IHostManagement,
  QueuedDoctorRepair,
  QueuedDoctorRepairResult,
} from "@traycer-clients/shared/platform/runner-host";

function makeIssue(fixAction: string): HostDoctorIssue {
  return {
    code: "TEST_ISSUE",
    severity: "error",
    title: "Test issue",
    message: "Test issue message",
    fixAction,
    terminalCommand: null,
    details: null,
  };
}

function makeManagementWithRunDoctorRepairQueued(
  runDoctorRepairQueued: (input: {
    readonly repair: QueuedDoctorRepair;
    readonly expectedHostId: string;
  }) => Promise<QueuedDoctorRepairResult>,
): IHostManagement {
  const notImplemented = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`${method} not implemented in mock`));
  return {
    getHostControllerStatus: vi.fn(notImplemented("getHostControllerStatus")),
    convergeReady: vi.fn(notImplemented("convergeReady")),
    applyStaged: vi.fn(notImplemented("applyStaged")),
    activateInstalled: vi.fn(notImplemented("activateInstalled")),
    installVersion: vi.fn(notImplemented("installVersion")),
    uninstallHost: vi.fn(notImplemented("uninstallHost")),
    restartHost: vi.fn(notImplemented("restartHost")),
    uninstallTraycer: vi.fn(notImplemented("uninstallTraycer")),
    getRemovalState: vi.fn(notImplemented("getRemovalState")),
    clearRemoval: vi.fn(notImplemented("clearRemoval")),
    getHostLogs: vi.fn(notImplemented("getHostLogs")),
    runDoctor: vi.fn(notImplemented("runDoctor")),
    availableVersions: vi.fn(notImplemented("availableVersions")),
    installedRecord: vi.fn(notImplemented("installedRecord")),
    registerService: vi.fn(notImplemented("registerService")),
    deregisterService: vi.fn(notImplemented("deregisterService")),
    registryCheck: vi.fn(notImplemented("registryCheck")),
    freePortAndRestart: vi.fn(notImplemented("freePortAndRestart")),
    runDoctorRepairQueued: vi.fn(runDoctorRepairQueued),
    freePortAndRestartIfIdle: vi.fn(notImplemented("freePortAndRestartIfIdle")),
    cliManifest: vi.fn(notImplemented("cliManifest")),
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
    getHostName: vi.fn(notImplemented("getHostName")),
    setHostName: vi.fn(notImplemented("setHostName")),
  };
}

describe("runFixAction", () => {
  it.each(["host-install", "host-install-latest"] as const)(
    "%s dispatches the version-seeking converge-latest repair",
    async (fixAction) => {
      const runDoctorRepairQueued = vi.fn(() =>
        Promise.resolve<QueuedDoctorRepairResult>({ kind: "applied" }),
      );
      const management = makeManagementWithRunDoctorRepairQueued(
        runDoctorRepairQueued,
      );

      const result = await runFixAction(
        management,
        makeIssue(fixAction),
        "local-host",
      );

      expect(runDoctorRepairQueued).toHaveBeenCalledWith({
        repair: "converge-latest",
        expectedHostId: "local-host",
      });
      expect(result).toEqual({ kind: "applied" });
    },
  );
});

describe("doctorFixRoute", () => {
  it.each([
    {
      fixAction: "host-restart",
      rpcRestartSupported: true,
      bridgeRestartRoute: false,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "rpc",
    },
    {
      fixAction: "host-start",
      rpcRestartSupported: true,
      bridgeRestartRoute: false,
      isLocalMachine: false,
      hasLocalBridge: false,
      expected: "rpc",
    },
    {
      fixAction: "host-restart",
      rpcRestartSupported: false,
      bridgeRestartRoute: true,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "local-bridge",
    },
    {
      fixAction: "host-start",
      rpcRestartSupported: false,
      bridgeRestartRoute: true,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "local-bridge",
    },
    {
      fixAction: "host-restart",
      rpcRestartSupported: false,
      bridgeRestartRoute: false,
      isLocalMachine: false,
      hasLocalBridge: true,
      expected: "copy-command",
    },
    {
      fixAction: "host-start",
      rpcRestartSupported: false,
      bridgeRestartRoute: false,
      isLocalMachine: false,
      hasLocalBridge: false,
      expected: "copy-command",
    },
    {
      fixAction: "host-restart",
      rpcRestartSupported: false,
      bridgeRestartRoute: false,
      isLocalMachine: true,
      hasLocalBridge: true,
      expected: "copy-command",
    },
  ] as const)(
    "$fixAction supported=$rpcRestartSupported route=$bridgeRestartRoute local=$isLocalMachine bridge=$hasLocalBridge → $expected",
    (row) => {
      expect(
        doctorFixRoute({
          fixAction: row.fixAction,
          isLocalMachine: row.isLocalMachine,
          hasLocalBridge: row.hasLocalBridge,
          rpcRestartSupported: row.rpcRestartSupported,
          bridgeRestartRoute: row.bridgeRestartRoute,
        }),
      ).toBe(row.expected);
    },
  );

  it("routes host-logs to rpc regardless of restart support, locality, or a bridge", () => {
    expect(
      doctorFixRoute({
        fixAction: "host-logs",
        isLocalMachine: true,
        hasLocalBridge: true,
        rpcRestartSupported: false,
        bridgeRestartRoute: true,
      }),
    ).toBe("rpc");
    expect(
      doctorFixRoute({
        fixAction: "host-logs",
        isLocalMachine: false,
        hasLocalBridge: false,
        rpcRestartSupported: true,
        bridgeRestartRoute: false,
      }),
    ).toBe("rpc");
  });
});

describe("freePortConfirmWentStale", () => {
  it.each([
    {
      name: "no dialog open",
      issue: null,
      lifecycleArmed: true,
      ownDispatchCode: null,
      expected: false,
    },
    {
      name: "open + gate idle",
      issue: { code: "PORT_CONFLICT" },
      lifecycleArmed: false,
      ownDispatchCode: null,
      expected: false,
    },
    {
      name: "open + gate armed + a different code dispatching",
      issue: { code: "PORT_CONFLICT" },
      lifecycleArmed: true,
      ownDispatchCode: "HOST_NOT_INSTALLED",
      expected: true,
    },
    {
      name: "open + gate armed + this code dispatching",
      issue: { code: "PORT_CONFLICT" },
      lifecycleArmed: true,
      ownDispatchCode: "PORT_CONFLICT",
      expected: false,
    },
  ] as const)("$name → $expected", (row) => {
    expect(
      freePortConfirmWentStale({
        issue: row.issue,
        lifecycleArmed: row.lifecycleArmed,
        ownDispatchCode: row.ownDispatchCode,
      }),
    ).toBe(row.expected);
  });
});
