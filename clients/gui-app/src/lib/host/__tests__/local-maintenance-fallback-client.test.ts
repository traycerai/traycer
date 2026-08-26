import { afterEach, describe, expect, it, vi } from "vitest";
import { HostRequestControlFlowError } from "@traycer-clients/shared/host-client/host-request-coordinator";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  IHostManagement,
  InstallVersionOk,
  MaintenanceDoctorProjection,
  MaintenanceInstallDispatch,
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

  it("throws HostRpcError for the PRE-commit busy (retry-with-force), carrying the lane message", () => {
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

  it("throws for the POST-commit busy (continuation: activate) too, carrying the actionable message", () => {
    // Priced decision (see mapInstallVersionOutcome's doc): `accepted` here
    // would show a false "Updating…" toast, discard this actionable message,
    // and arm the accepted latch - which a pre-1.2.0 host can never release
    // early (no `host.status.updateProgress`, no self-restart), locking the
    // very controls the message asks the user to reach for. The refusal
    // renders the message and leaves the page live for that restart.
    expectHostRpcError(
      () =>
        mapInstallVersionOutcome({
          kind: "busy",
          continuation: "activate",
          message:
            "The update was installed, but the host has work in progress; restart it to finish.",
        }),
      "The update was installed, but the host has work in progress; restart it to finish.",
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
  it("does NOT borrow the local-WS trivially-green exemption", () => {
    // The exemption holds only when the response IS the liveness evidence -
    // the host answering over loopback. This lane's report comes from the
    // bundled CLI over IPC and completes with the host down, so honouring it
    // would hide the three codes that describe a host that stopped serving
    // behind a green Doctor card.
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
      triviallyGreenIssueCodes: [],
    });
    // Stated as an equality against the real set, so a future re-introduction
    // of the exemption has to argue with this test rather than slip past it.
    expect(LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES).toContain(
      "SERVICE_STOPPED",
    );
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
  it("reports a NON-update lane block as a refusal, never already-updating", async () => {
    // `already-updating` arms the caller's accepted-update latch to wait on
    // `host.status.updateProgress`, which a service registration never
    // publishes - so mislabelling it both lies and hangs the surface.
    const maintenanceInstallVersion = vi.fn(() =>
      Promise.resolve({
        kind: "lane-busy" as const,
        updateInFlight: false,
        message: "The host is registering its service.",
      } satisfies MaintenanceInstallDispatch),
    );
    const management = buildOverviewManagement({ maintenanceInstallVersion });
    const serve = buildMaintenanceFallbackServeMap(management, LOCAL_HOST_ID);
    await expect(
      serve["host.update.install"]({ version: "1.2.0", force: false }),
    ).rejects.toThrow("The host is registering its service.");
  });

  it("maps lane-busy to already-updating without consulting getHostControllerStatus or installVersion", async () => {
    // Discriminator: the old two-step read `getHostControllerStatus` then
    // called `installVersion`. Reintroducing that read makes this red.
    const maintenanceInstallVersion = vi.fn(
      (input: {
        readonly version: string;
        readonly force: boolean;
        readonly expectedHostId: string;
      }) => {
        expect(input).toEqual({
          version: "1.2.0",
          force: false,
          expectedHostId: LOCAL_HOST_ID,
        });
        return Promise.resolve({
          kind: "lane-busy" as const,
          updateInFlight: true,
          message: "An update is already installing.",
        } satisfies MaintenanceInstallDispatch);
      },
    );
    const management = buildOverviewManagement({
      maintenanceInstallVersion,
    });
    const serve = buildMaintenanceFallbackServeMap(management, LOCAL_HOST_ID);

    await expect(
      serve["host.update.install"]({ version: "1.2.0", force: false }),
    ).resolves.toEqual({ outcome: "already-updating" });
    expect(maintenanceInstallVersion).toHaveBeenCalledTimes(1);
    expect(management.getHostControllerStatus).not.toHaveBeenCalled();
    expect(management.installVersion).not.toHaveBeenCalled();
  });

  it("maps a dispatched ok through mapInstallVersionOutcome without a status read", async () => {
    const maintenanceInstallVersion = vi.fn(
      (input: { readonly version: string; readonly force: boolean }) =>
        Promise.resolve({
          kind: "dispatched" as const,
          outcome: {
            kind: "ok" as const,
            value: { installedVersion: input.version, runningActivated: true },
          },
        } satisfies MaintenanceInstallDispatch),
    );
    const management = buildOverviewManagement({
      maintenanceInstallVersion,
    });
    const serve = buildMaintenanceFallbackServeMap(management, LOCAL_HOST_ID);

    await expect(
      serve["host.update.install"]({ version: "1.2.0", force: true }),
    ).resolves.toEqual({ outcome: "accepted" });
    expect(maintenanceInstallVersion).toHaveBeenCalledWith({
      version: "1.2.0",
      force: true,
      expectedHostId: LOCAL_HOST_ID,
    });
    expect(management.getHostControllerStatus).not.toHaveBeenCalled();
    expect(management.installVersion).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: "busy" as const,
      continuation: "retry-with-force" as const,
      message: "Host is busy installing another version.",
    },
    {
      kind: "deferred" as const,
      message: "CLI lock is held; retry when idle.",
    },
  ])(
    "maps a dispatched $kind through mapInstallVersionOutcome as a thrown HostRpcError",
    async (outcome) => {
      const management = buildOverviewManagement({
        maintenanceInstallVersion: () =>
          Promise.resolve({
            kind: "dispatched" as const,
            outcome,
          }),
      });
      const serve = buildMaintenanceFallbackServeMap(management, LOCAL_HOST_ID);
      await expect(
        serve["host.update.install"]({ version: "1.2.0", force: false }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(HostRpcError);
        if (!(error instanceof HostRpcError)) return false;
        expect(error.message).toBe(outcome.message);
        expect(error.method).toBe("host.update.install");
        return true;
      });
      expect(management.getHostControllerStatus).not.toHaveBeenCalled();
      expect(management.installVersion).not.toHaveBeenCalled();
    },
  );

  it("rejects a dispatched POST-commit busy (continuation: activate) with the restart-to-finish message", async () => {
    // The error path ON PURPOSE: it releases the accepted latch, which is
    // what leaves the restart controls live for the action this message
    // names - `accepted` would lock them for the full 60s timer instead,
    // since a pre-1.2.0 host never publishes the progress frame that
    // releases the latch early.
    const management = buildOverviewManagement({
      maintenanceInstallVersion: () =>
        Promise.resolve({
          kind: "dispatched" as const,
          outcome: {
            kind: "busy" as const,
            continuation: "activate" as const,
            message:
              "The update was installed, but the host has work in progress; restart it to finish.",
          },
        }),
    });
    const serve = buildMaintenanceFallbackServeMap(management, LOCAL_HOST_ID);
    await expect(
      serve["host.update.install"]({ version: "1.2.0", force: false }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(HostRpcError);
      if (!(error instanceof HostRpcError)) return false;
      expect(error.message).toBe(
        "The update was installed, but the host has work in progress; restart it to finish.",
      );
      return true;
    });
  });

  it("maps a dispatched failed through mapInstallVersionOutcome to cli-failed", async () => {
    const management = buildOverviewManagement({
      maintenanceInstallVersion: () =>
        Promise.resolve({
          kind: "dispatched" as const,
          outcome: {
            kind: "failed" as const,
            message: "install failed",
          },
        }),
    });
    const serve = buildMaintenanceFallbackServeMap(management, LOCAL_HOST_ID);
    await expect(
      serve["host.update.install"]({ version: "1.2.0", force: false }),
    ).resolves.toEqual({ outcome: "cli-failed" });
    expect(management.getHostControllerStatus).not.toHaveBeenCalled();
    expect(management.installVersion).not.toHaveBeenCalled();
  });

  it("forwards includePreReleases verbatim on host.update.check", async () => {
    const maintenanceUpdateCheck = vi.fn(
      (_input: {
        readonly includePreReleases: boolean | undefined;
        readonly expectedHostId: string;
      }) =>
        Promise.resolve({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("1.2.0"),
        }),
    );
    const management = buildOverviewManagement({ maintenanceUpdateCheck });
    const serve = buildMaintenanceFallbackServeMap(management, LOCAL_HOST_ID);

    await serve["host.update.check"]({ includePreReleases: true });
    await serve["host.update.check"]({ includePreReleases: false });

    expect(maintenanceUpdateCheck.mock.calls).toEqual([
      [{ includePreReleases: true, expectedHostId: LOCAL_HOST_ID }],
      [{ includePreReleases: false, expectedHostId: LOCAL_HOST_ID }],
    ]);
  });

  it("sends the construction-time expectedHostId on every one of the four calls, not a later id", async () => {
    // Discriminator: omitting expectedHostId, or re-reading some live id at
    // dispatch, makes this red. The decorator freezes the id it was built
    // for; main is the one that compares it against the live local host.
    const captured = "host-captured";
    const maintenanceUpdateCheck = vi.fn(() =>
      Promise.resolve({
        outcome: "ok" as const,
        effectiveIncludePreReleases: false,
        includePreReleasesSource: "stable-default" as const,
        manifest: updateCheckManifest("1.2.0"),
      }),
    );
    const maintenanceDoctor = vi.fn(() =>
      Promise.resolve({ status: "ok" as const, issues: [] }),
    );
    const maintenanceInstallationInfo = vi.fn(() =>
      Promise.resolve({ status: "unmanaged" as const }),
    );
    const maintenanceInstallVersion = vi.fn(() =>
      Promise.resolve({
        kind: "lane-busy" as const,
        updateInFlight: true,
        message: "An update is already installing.",
      } satisfies MaintenanceInstallDispatch),
    );
    const management = buildOverviewManagement({
      maintenanceUpdateCheck,
      maintenanceDoctor,
      maintenanceInstallationInfo,
      maintenanceInstallVersion,
    });
    const serve = buildMaintenanceFallbackServeMap(management, captured);

    await serve["host.update.check"]({ includePreReleases: false });
    await serve["host.doctor"]();
    await serve["host.getInstallationInfo"]();
    await serve["host.update.install"]({ version: "1.2.0", force: true });

    expect(maintenanceUpdateCheck).toHaveBeenCalledWith({
      includePreReleases: false,
      expectedHostId: captured,
    });
    expect(maintenanceDoctor).toHaveBeenCalledWith({
      expectedHostId: captured,
    });
    expect(maintenanceInstallationInfo).toHaveBeenCalledWith({
      expectedHostId: captured,
    });
    expect(maintenanceInstallVersion).toHaveBeenCalledWith({
      version: "1.2.0",
      force: true,
      expectedHostId: captured,
    });
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
    const serve = buildMaintenanceFallbackServeMap(management, LOCAL_HOST_ID);

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
            effectiveIncludePreReleases: false,
            includePreReleasesSource: "stable-default" as const,
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
            busyBreakdown: null,
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

  function decorateThrowing(
    hostId: string,
    management: IHostManagement,
    localHostId: string,
    beforeThrow: (method: string) => void,
  ) {
    const rpcCalls: string[] = [];
    const fixture = buildOverviewHostFixture({
      hostId,
      isLocalMachine: true,
      overrideHandlers: {
        "host.update.check": () => {
          rpcCalls.push("host.update.check");
          beforeThrow("host.update.check");
          throw new Error("refused host.update.check");
        },
        "host.update.install": () => {
          rpcCalls.push("host.update.install");
          beforeThrow("host.update.install");
          throw new Error("refused host.update.install");
        },
        "host.doctor": () => {
          rpcCalls.push("host.doctor");
          beforeThrow("host.doctor");
          throw new Error("refused host.doctor");
        },
        "host.getInstallationInfo": () => {
          rpcCalls.push("host.getInstallationInfo");
          beforeThrow("host.getInstallationInfo");
          throw new Error("refused host.getInstallationInfo");
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
    readonly checkCalls: Array<{
      readonly includePreReleases: boolean | undefined;
      readonly expectedHostId: string;
    }>;
    readonly installCalls: Array<{
      readonly version: string;
      readonly force: boolean;
      readonly expectedHostId: string;
    }>;
    readonly doctorCalls: Array<{ readonly expectedHostId: string }>;
    readonly installInfoCalls: Array<{ readonly expectedHostId: string }>;
  } {
    const checkCalls: Array<{
      readonly includePreReleases: boolean | undefined;
      readonly expectedHostId: string;
    }> = [];
    const installCalls: Array<{
      readonly version: string;
      readonly force: boolean;
      readonly expectedHostId: string;
    }> = [];
    const doctorCalls: Array<{ readonly expectedHostId: string }> = [];
    const installInfoCalls: Array<{ readonly expectedHostId: string }> = [];
    const management = buildOverviewManagement({
      maintenanceUpdateCheck: (input) => {
        checkCalls.push(input);
        return Promise.resolve({
          outcome: "ok" as const,
          effectiveIncludePreReleases: false,
          includePreReleasesSource: "stable-default" as const,
          manifest: updateCheckManifest("1.2.0"),
        });
      },
      maintenanceInstallVersion: (input) => {
        installCalls.push(input);
        return Promise.resolve({
          kind: "dispatched" as const,
          outcome: {
            kind: "ok" as const,
            value: {
              installedVersion: input.version,
              runningActivated: true,
            },
          },
        });
      },
      maintenanceDoctor: (input) => {
        doctorCalls.push(input);
        return Promise.resolve({
          status: "ok" as const,
          issues: [doctorIssue("SERVICE_STOPPED")],
        });
      },
      maintenanceInstallationInfo: (input) => {
        installInfoCalls.push(input);
        return Promise.resolve({ status: "unmanaged" as const });
      },
    });
    return {
      management,
      checkCalls,
      installCalls,
      doctorCalls,
      installInfoCalls,
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
    expect(served.doctorCalls).toEqual([]);
    expect(served.installInfoCalls).toEqual([]);
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
    expect(served.checkCalls).toEqual([
      { includePreReleases: true, expectedHostId: LOCAL_HOST_ID },
    ]);
    expect(served.doctorCalls).toEqual([{ expectedHostId: LOCAL_HOST_ID }]);
    expect(served.installInfoCalls).toEqual([
      { expectedHostId: LOCAL_HOST_ID },
    ]);
    expect(served.installCalls).toEqual([
      { version: "1.2.0", force: false, expectedHostId: LOCAL_HOST_ID },
    ]);
    expect(install).toEqual({ outcome: "accepted" });
    expect(served.management.installVersion).not.toHaveBeenCalled();
    expect(served.management.getHostControllerStatus).not.toHaveBeenCalled();
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
    expect(served.checkCalls).toEqual([
      { includePreReleases: false, expectedHostId: LOCAL_HOST_ID },
    ]);
    expect(served.doctorCalls).toEqual([{ expectedHostId: LOCAL_HOST_ID }]);
    expect(served.installInfoCalls).toEqual([
      { expectedHostId: LOCAL_HOST_ID },
    ]);
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

  it("re-serves over the bridge when a delegated request's own handshake reveals the method absent", async () => {
    // Discriminator: if the catch arm is removed, the RPC refusal escapes
    // and the bridge is never called. Recording the absent family INSIDE
    // the rejecting fake is the cold-renderer race — `shouldServe` read
    // `null` at dispatch, then this call's handshake flipped it to false.
    const served = servingManagement();
    const { client, rpcCalls } = decorateThrowing(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
      () => {
        handshakeAbsent(LOCAL_HOST_ID);
      },
    );

    const answer = await client.request("host.update.check", {
      includePreReleases: false,
    });

    expect(answer).toEqual({
      outcome: "ok",
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default" as const,
      manifest: updateCheckManifest("1.2.0"),
    });
    expect(rpcCalls).toEqual(["host.update.check"]);
    expect(served.checkCalls).toEqual([
      { includePreReleases: false, expectedHostId: LOCAL_HOST_ID },
    ]);
  });

  it("re-serves a live-signal requestWithSignal after the same null→false flip", async () => {
    const served = servingManagement();
    const { client, rpcCalls } = decorateThrowing(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
      () => {
        handshakeAbsent(LOCAL_HOST_ID);
      },
    );
    const signal = new AbortController().signal;

    const answer = await client.requestWithSignal("host.doctor", {}, signal);

    expect(answer).toEqual({
      status: "ok",
      issues: [doctorIssue("SERVICE_STOPPED")],
      triviallyGreenIssueCodes: [],
    });
    expect(rpcCalls).toEqual(["host.doctor"]);
    expect(served.doctorCalls).toEqual([{ expectedHostId: LOCAL_HOST_ID }]);
  });

  it("re-serves requestWithResponseTimeout when the delegated call rejects and the handshake flips mid-flight", async () => {
    // This fixture's HostClient rejects `requestWithResponseTimeout` at the
    // scheduling-policy gate (no join timeout), which is still a delegated
    // rejection. Flip the registry between dispatch and settlement so the
    // catch arm can see handshake-false.
    const served = servingManagement();
    const { client, rpcCalls } = decorateThrowing(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
      () => {
        throw new Error("handler must not run; timeout policy rejects first");
      },
    );

    const pending = client.requestWithResponseTimeout(
      "host.getInstallationInfo",
      {},
      1_000,
    );
    handshakeAbsent(LOCAL_HOST_ID);
    const answer = await pending;

    expect(answer).toEqual({ status: "unmanaged" });
    expect(rpcCalls).toEqual([]);
    expect(served.installInfoCalls).toEqual([
      { expectedHostId: LOCAL_HOST_ID },
    ]);
  });

  it("propagates a genuine transport failure when the host already advertises the method", async () => {
    handshakeAdvertisesMaintenance(LOCAL_HOST_ID);
    const served = servingManagement();
    const { client, rpcCalls } = decorateThrowing(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
      () => undefined,
    );

    await expect(
      client.request("host.update.check", { includePreReleases: false }),
    ).rejects.toThrow("refused host.update.check");
    expect(rpcCalls).toEqual(["host.update.check"]);
    expect(served.checkCalls).toEqual([]);
  });

  it("does not re-serve an already-aborted requestWithSignal even if the handshake flips to absent", async () => {
    // Discriminator: without the abort guard, the catch would see
    // handshake-false and call the bridge, resurrecting work the caller
    // cancelled. The coordinator rejects an already-aborted waiter before
    // the mock handler runs, so the flip is recorded after dispatch.
    const served = servingManagement();
    const { client, rpcCalls } = decorateThrowing(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
      () => {
        throw new Error("handler must not run for an already-aborted waiter");
      },
    );
    const signal = AbortSignal.abort();

    const pending = client.requestWithSignal(
      "host.update.check",
      { includePreReleases: false },
      signal,
    );
    handshakeAbsent(LOCAL_HOST_ID);

    await expect(pending).rejects.toThrow("Host request waiter cancelled");
    expect(rpcCalls).toEqual([]);
    expect(served.checkCalls).toEqual([]);
  });

  it("does not call the wrapped client at all when shouldServe is already true", async () => {
    // Discriminator: routing through delegateThenServeIfAbsent first would
    // invoke the throwing RPC fake (rpcCalls non-empty) even if the catch
    // then served the bridge.
    handshakeAbsent(LOCAL_HOST_ID);
    const served = servingManagement();
    const { client, rpcCalls } = decorateThrowing(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
      () => undefined,
    );

    const answer = await client.request("host.update.check", {
      includePreReleases: true,
    });

    expect(answer).toEqual({
      outcome: "ok",
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default" as const,
      manifest: updateCheckManifest("1.2.0"),
    });
    expect(rpcCalls).toEqual([]);
    expect(served.checkCalls).toEqual([
      { includePreReleases: true, expectedHostId: LOCAL_HOST_ID },
    ]);
  });

  it("an already-aborted signal on the direct-serve path never starts the CLI", async () => {
    // Discriminator: round 8's serveRespectingSignal must reject with the
    // transport cancellation shape before calling management. Red against
    // 45e3cb7a^ which ignored the signal on the served branch.
    handshakeAbsent(LOCAL_HOST_ID);
    const served = servingManagement();
    const { client, rpcCalls } = decorate(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
    );
    const signal = AbortSignal.abort();

    await expect(
      client.requestWithSignal(
        "host.update.check",
        { includePreReleases: false },
        signal,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(HostRequestControlFlowError);
      if (!(error instanceof HostRequestControlFlowError)) return false;
      expect(error.reason).toBe("waiter-cancelled");
      return true;
    });
    expect(rpcCalls).toEqual([]);
    expect(served.checkCalls).toEqual([]);
  });

  it("aborting a served request mid-flight rejects the waiter even if the CLI never settles", async () => {
    handshakeAbsent(LOCAL_HOST_ID);
    const started: { current: (() => void) | null } = { current: null };
    const startedPromise = new Promise<void>((resolve) => {
      started.current = resolve;
    });
    const never = new Promise<never>(() => undefined);
    const management = buildOverviewManagement({
      maintenanceUpdateCheck: () => {
        if (started.current === null) {
          throw new Error("started latch was not armed");
        }
        started.current();
        return never;
      },
    });
    const { client } = decorate(LOCAL_HOST_ID, management, LOCAL_HOST_ID);
    const controller = new AbortController();

    const pending = client.requestWithSignal(
      "host.update.check",
      { includePreReleases: false },
      controller.signal,
    );
    await startedPromise;
    controller.abort();

    await expect(pending).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(HostRequestControlFlowError);
      if (!(error instanceof HostRequestControlFlowError)) return false;
      expect(error.reason).toBe("waiter-cancelled");
      return true;
    });
  });

  it("a served request that resolves before abort still resolves, and a later abort is ignored", async () => {
    handshakeAbsent(LOCAL_HOST_ID);
    const served = servingManagement();
    const { client } = decorate(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
    );
    const controller = new AbortController();

    const answer = await client.requestWithSignal(
      "host.update.check",
      { includePreReleases: false },
      controller.signal,
    );
    expect(answer).toEqual({
      outcome: "ok",
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default" as const,
      manifest: updateCheckManifest("1.2.0"),
    });
    controller.abort();
    expect(served.checkCalls).toEqual([
      { includePreReleases: false, expectedHostId: LOCAL_HOST_ID },
    ]);
  });

  it("request and requestWithResponseTimeout still serve without a signal", async () => {
    handshakeAbsent(LOCAL_HOST_ID);
    const served = servingManagement();
    const { client, rpcCalls } = decorate(
      LOCAL_HOST_ID,
      served.management,
      LOCAL_HOST_ID,
    );

    await expect(
      client.request("host.update.check", { includePreReleases: false }),
    ).resolves.toEqual({
      outcome: "ok",
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default" as const,
      manifest: updateCheckManifest("1.2.0"),
    });
    await expect(
      client.requestWithResponseTimeout("host.doctor", {}, 1_000),
    ).resolves.toMatchObject({ status: "ok" });
    expect(rpcCalls).toEqual([]);
    expect(served.checkCalls).toEqual([
      { includePreReleases: false, expectedHostId: LOCAL_HOST_ID },
    ]);
    expect(served.doctorCalls).toEqual([{ expectedHostId: LOCAL_HOST_ID }]);
  });
});
