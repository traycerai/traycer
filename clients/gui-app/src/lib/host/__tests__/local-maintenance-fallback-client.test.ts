import { afterEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  IHostManagement,
  InstallVersionOk,
  MaintenanceDoctorProjection,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import {
  LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES,
  type HostDoctorIssue,
  type HostGetInstallationInfoResponse,
} from "@traycer/protocol/host/maintenance/index";
import {
  buildOverviewHostFixture,
  buildOverviewManagement,
  updateCheckManifest,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import {
  LOCAL_MAINTENANCE_FALLBACK_METHODS,
  buildMaintenanceFallbackServeMap,
  createLocalMaintenanceFallbackClient,
  localWsDoctorResponse,
  mapInstallVersionOutcome,
} from "@/lib/host/local-maintenance-fallback-client";

const LOCAL_HOST_ID = "host-local";
const OTHER_HOST_ID = "host-other";

afterEach(() => {
  resetNegotiatedManifests();
});

function doctorIssue(code: string): HostDoctorIssue {
  return {
    code,
    severity: "warning",
    title: code,
    message: code,
    fixAction: null,
    terminalCommand: null,
    details: null,
  };
}

function handshakeAbsent(hostId: string): void {
  recordNegotiatedHostMethods(hostId, ["host.status"]);
}

function handshakeAdvertisesMaintenance(hostId: string): void {
  recordNegotiatedHostMethods(hostId, [
    "host.status",
    ...LOCAL_MAINTENANCE_FALLBACK_METHODS,
  ]);
}

function expectHostRpcError(run: () => void, message: string): void {
  try {
    run();
    throw new Error("expected HostRpcError");
  } catch (error) {
    expect(error).toBeInstanceOf(HostRpcError);
    if (!(error instanceof HostRpcError)) {
      throw new Error("expected HostRpcError");
    }
    expect(error.message).toBe(message);
    expect(error.method).toBe("host.update.install");
    expect(error.code).toBe("RPC_ERROR");
  }
}

describe("LOCAL_MAINTENANCE_FALLBACK_METHODS", () => {
  it("is exactly the four intercepted maintenance methods", () => {
    expect([...LOCAL_MAINTENANCE_FALLBACK_METHODS]).toEqual([
      "host.update.check",
      "host.update.install",
      "host.doctor",
      "host.getInstallationInfo",
    ]);
  });
});

describe("mapInstallVersionOutcome", () => {
  it("maps ok to accepted", () => {
    const outcome: MutationOutcome<InstallVersionOk> = {
      kind: "ok",
      value: { installedVersion: "1.2.0", runningActivated: true },
    };
    expect(mapInstallVersionOutcome(outcome)).toEqual({ outcome: "accepted" });
  });

  it("throws HostRpcError for busy, carrying the lane message", () => {
    expectHostRpcError(
      () =>
        mapInstallVersionOutcome({
          kind: "busy",
          continuation: "retry-with-force",
          message: "Host is busy installing another version.",
        }),
      "Host is busy installing another version.",
    );
  });

  it("throws HostRpcError for deferred, carrying the lane message", () => {
    expectHostRpcError(
      () =>
        mapInstallVersionOutcome({
          kind: "deferred",
          message: "CLI lock is held; retry when idle.",
        }),
      "CLI lock is held; retry when idle.",
    );
  });

  it.each([
    {
      kind: "failed" as const,
      message: "install failed",
    },
    {
      kind: "stage-fingerprint-mismatch" as const,
      message: "staged tree does not match the pin",
    },
    {
      kind: "installed-not-converged" as const,
      message: "installed host did not come up",
    },
  ])("maps $kind to cli-failed", (outcome) => {
    expect(mapInstallVersionOutcome(outcome)).toEqual({
      outcome: "cli-failed",
    });
  });
});

describe("localWsDoctorResponse", () => {
  it("stamps the local-WS trivially-green set on the ok arm", () => {
    const issues = [
      doctorIssue("SERVICE_STOPPED"),
      doctorIssue("STALE_CONFIG"),
    ];
    const projection: MaintenanceDoctorProjection = {
      status: "ok",
      issues,
    };
    const response = localWsDoctorResponse(projection);
    expect(response).toEqual({
      status: "ok",
      issues,
      triviallyGreenIssueCodes: [
        ...LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES,
      ],
    });
  });

  it.each([
    { status: "cli-unavailable" as const },
    { status: "cli-failed" as const },
    { status: "invalid-output" as const },
  ])("passes through the $status failure arm", (projection) => {
    expect(localWsDoctorResponse(projection)).toEqual({
      status: projection.status,
    });
  });
});

describe("buildMaintenanceFallbackServeMap", () => {
  it("forwards includePreReleases verbatim on host.update.check", async () => {
    const maintenanceUpdateCheck = vi.fn(
      (_input: { readonly includePreReleases: boolean }) =>
        Promise.resolve({
          outcome: "ok" as const,
          manifest: updateCheckManifest("1.2.0"),
        }),
    );
    const management = buildOverviewManagement({ maintenanceUpdateCheck });
    const serve = buildMaintenanceFallbackServeMap(management);

    await serve["host.update.check"]({ includePreReleases: true });
    await serve["host.update.check"]({ includePreReleases: false });

    expect(maintenanceUpdateCheck.mock.calls).toEqual([
      [{ includePreReleases: true }],
      [{ includePreReleases: false }],
    ]);
  });

  it("returns the host.getInstallationInfo IPC answer verbatim", async () => {
    const info: HostGetInstallationInfoResponse = {
      status: "managed",
      installRecord: {
        installId: "inst-1",
        version: "1.1.11",
        runtimeVersion: "1.1.11",
        platform: "darwin",
        arch: "arm64",
        installedAt: "2026-08-10T00:00:00Z",
        source: { kind: "registry", value: "1.1.11" },
        archiveSha256: "b".repeat(64),
        signatureVerifiedAt: "2026-08-10T00:00:00Z",
        signatureKeyId: "key-1",
        sizeBytes: 2048,
        executablePath: "/tmp/traycer/1.1.11/host",
      },
      stagedRecord: null,
      cliManifest: {
        version: "1.4.0",
        installedAt: "2026-08-01T00:00:00Z",
        binaryPath: "/usr/local/bin/traycer",
        source: "desktop",
        pendingUpgrade: null,
      },
    };
    const maintenanceInstallationInfo = vi.fn(() => Promise.resolve(info));
    const management = buildOverviewManagement({
      maintenanceInstallationInfo,
    });
    const serve = buildMaintenanceFallbackServeMap(management);

    await expect(serve["host.getInstallationInfo"]()).resolves.toBe(info);
  });
});

describe("createLocalMaintenanceFallbackClient", () => {
  function decorate(
    hostId: string,
    management: IHostManagement,
    localHostId: string,
  ) {
    const rpcCalls: string[] = [];
    const fixture = buildOverviewHostFixture({
      hostId,
      isLocalMachine: true,
      overrideHandlers: {
        "host.update.check": () => {
          rpcCalls.push("host.update.check");
          return {
            outcome: "ok" as const,
            manifest: updateCheckManifest("1.2.0"),
          };
        },
        "host.update.install": () => {
          rpcCalls.push("host.update.install");
          return { outcome: "accepted" as const };
        },
        "host.doctor": () => {
          rpcCalls.push("host.doctor");
          return {
            status: "ok" as const,
            issues: [],
            triviallyGreenIssueCodes: [],
          };
        },
        "host.getInstallationInfo": () => {
          rpcCalls.push("host.getInstallationInfo");
          return { status: "unmanaged" as const };
        },
        "host.status": () => {
          rpcCalls.push("host.status");
          return {
            ready: true,
            hostVersion: "1.1.11",
            protocolVersion: { major: 1, minor: 1 },
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
          };
        },
      },
    });
    const client = createLocalMaintenanceFallbackClient({
      client: fixture.client,
      localHostId,
      management,
    });
    return { client, rpcCalls, fixture };
  }

  function servingManagement(): {
    readonly management: IHostManagement;
    readonly checkCalls: Array<{ readonly includePreReleases: boolean }>;
    readonly installCalls: Array<{
      readonly version: string;
      readonly force: boolean;
    }>;
    readonly doctorCalls: number;
    readonly installInfoCalls: number;
  } {
    const checkCalls: Array<{ readonly includePreReleases: boolean }> = [];
    const installCalls: Array<{
      readonly version: string;
      readonly force: boolean;
    }> = [];
    let doctorCalls = 0;
    let installInfoCalls = 0;
    const management = buildOverviewManagement({
      maintenanceUpdateCheck: (input) => {
        checkCalls.push(input);
        return Promise.resolve({
          outcome: "ok" as const,
          manifest: updateCheckManifest("1.2.0"),
        });
      },
      installVersion: (version, force) => {
        installCalls.push({ version, force });
        return Promise.resolve({
          kind: "ok" as const,
          value: { installedVersion: version, runningActivated: true },
        });
      },
      maintenanceDoctor: () => {
        doctorCalls += 1;
        return Promise.resolve({
          status: "ok" as const,
          issues: [doctorIssue("SERVICE_STOPPED")],
        });
      },
      maintenanceInstallationInfo: () => {
        installInfoCalls += 1;
        return Promise.resolve({ status: "unmanaged" as const });
      },
    });
    return {
      management,
      checkCalls,
      installCalls,
      get doctorCalls() {
        return doctorCalls;
      },
      get installInfoCalls() {
        return installInfoCalls;
      },
    };
  }

  it("delegates when no negotiated manifest has been recorded (null)", async () => {
    const served = servingManagement();
    const { client, rpcCalls } = decorate(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
    );

    await client.request("host.update.check", { includePreReleases: false });

    expect(rpcCalls).toEqual(["host.update.check"]);
    expect(served.checkCalls).toEqual([]);
  });

  it("delegates when the method is advertised (true)", async () => {
    handshakeAdvertisesMaintenance(LOCAL_HOST_ID);
    const served = servingManagement();
    const { client, rpcCalls } = decorate(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
    );

    await client.request("host.update.check", { includePreReleases: false });
    await client.request("host.doctor", {});
    await client.request("host.getInstallationInfo", {});
    await client.request("host.update.install", {
      version: "1.2.0",
      force: false,
    });

    expect(rpcCalls).toEqual([
      "host.update.check",
      "host.doctor",
      "host.getInstallationInfo",
      "host.update.install",
    ]);
    expect(served.checkCalls).toEqual([]);
    expect(served.doctorCalls).toBe(0);
    expect(served.installInfoCalls).toBe(0);
    expect(served.installCalls).toEqual([]);
  });

  it("serves via IHostManagement when the method is handshake-false", async () => {
    handshakeAbsent(LOCAL_HOST_ID);
    const served = servingManagement();
    const { client, rpcCalls } = decorate(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
    );

    await client.request("host.update.check", { includePreReleases: true });
    await client.request("host.doctor", {});
    await client.request("host.getInstallationInfo", {});
    const install = await client.request("host.update.install", {
      version: "1.2.0",
      force: false,
    });

    expect(rpcCalls).toEqual([]);
    expect(served.checkCalls).toEqual([{ includePreReleases: true }]);
    expect(served.doctorCalls).toBe(1);
    expect(served.installInfoCalls).toBe(1);
    expect(served.installCalls).toEqual([{ version: "1.2.0", force: false }]);
    expect(install).toEqual({ outcome: "accepted" });
  });

  it("delegates when the wrapped client's active host is not the local host, even on handshake-false", async () => {
    handshakeAbsent(LOCAL_HOST_ID);
    handshakeAbsent(OTHER_HOST_ID);
    const served = servingManagement();
    const { client, rpcCalls } = decorate(
      OTHER_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
    );

    await client.request("host.update.check", { includePreReleases: false });

    expect(client.getActiveHostId()).toBe(OTHER_HOST_ID);
    expect(rpcCalls).toEqual(["host.update.check"]);
    expect(served.checkCalls).toEqual([]);
  });

  it("routes request, requestWithSignal, and requestWithResponseTimeout through the fallback", async () => {
    handshakeAbsent(LOCAL_HOST_ID);
    const served = servingManagement();
    const { client, rpcCalls } = decorate(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
    );

    await client.request("host.update.check", { includePreReleases: false });
    await client.requestWithSignal("host.doctor", {}, undefined);
    await client.requestWithResponseTimeout(
      "host.getInstallationInfo",
      {},
      1_000,
    );

    expect(rpcCalls).toEqual([]);
    expect(served.checkCalls).toEqual([{ includePreReleases: false }]);
    expect(served.doctorCalls).toBe(1);
    expect(served.installInfoCalls).toBe(1);
  });

  it("always delegates a non-intercepted method such as host.status", async () => {
    handshakeAbsent(LOCAL_HOST_ID);
    const served = servingManagement();
    const { client, rpcCalls } = decorate(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
    );

    await client.request("host.status", {});
    await client.requestWithSignal("host.status", {}, undefined);
    await expect(
      client.requestWithResponseTimeout("host.status", {}, 1_000),
    ).rejects.toThrow(
      "Host method 'host.status' does not permit response timeout 1000",
    );

    expect(rpcCalls).toEqual(["host.status", "host.status"]);
    expect(served.checkCalls).toEqual([]);
  });

  it("falls through non-request members to the wrapped client", () => {
    const served = servingManagement();
    const { client, fixture } = decorate(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
    );

    expect(client.getActiveHostId()).toBe(LOCAL_HOST_ID);
    expect(client.getActiveHostId()).toBe(fixture.client.getActiveHostId());
    expect(client.getRequestContext()).toBe(fixture.client.getRequestContext());
    expect(client.getRequestContextUserId()).toBe(
      fixture.client.getRequestContextUserId(),
    );
    expect(client.getRegistry()).toBe(fixture.client.getRegistry());
  });
});
