import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

// `host update --version <v> [--force]` is the exact invocation the host
// daemon spawns detached (fire-and-forget, not waited on) once it decides
// the host is idle (or the user forced past busy sessions). This suite
// pins:
//   - the version request is plumbed through to `installHost` verbatim
//     (not hardcoded to "latest"),
//   - the busy check is independently re-verified by THIS invocation and
//     only skipped by THIS invocation's own `--force`,
//   - the update-progress marker is written before anything is touched and
//     cleared/rewritten based on the post-swap health probe outcome,
//   - a failed health probe triggers a rollback (when a previous versioned
//     dir exists) and cycles the service lifecycle again, and
//   - a failed health probe with nothing to roll back to (first-ever
//     install) still fails loudly instead of swallowing the failure.

const mocks = vi.hoisted(() => ({
  assertHostNotBusyMock: vi.fn(),
  installHostMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  rollbackToVersionedDirMock: vi.fn(),
  probeHostHealthMock: vi.fn(),
  writeUpdateProgressMarkerMock: vi.fn(),
  deleteUpdateProgressMarkerMock: vi.fn(),
  createServiceInstallLifecycleMock: vi.fn(),
}));

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: mocks.assertHostNotBusyMock,
}));

vi.mock("../../installer", () => ({
  installHost: mocks.installHostMock,
  rollbackToVersionedDir: mocks.rollbackToVersionedDirMock,
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../../service/health-probe", () => ({
  probeHostHealth: mocks.probeHostHealthMock,
}));

vi.mock("../../host/update-progress-marker", () => ({
  writeUpdateProgressMarker: mocks.writeUpdateProgressMarkerMock,
  deleteUpdateProgressMarker: mocks.deleteUpdateProgressMarkerMock,
}));

vi.mock("../../store/cli-lock", () => ({
  withCliLock: (
    _opts: unknown,
    fn: (handle: {
      path: string;
      metadata: Record<string, unknown>;
      release: () => Promise<void>;
    }) => Promise<unknown>,
  ) =>
    fn({
      path: "/tmp/.lock",
      metadata: {},
      release: async () => {},
    }),
}));

interface LifecycleHandleStub {
  readonly lifecycle: {
    readonly beforeSwap: Mock;
    readonly afterSwap: Mock;
  };
  readonly state: {
    priorState: string;
    stoppedBeforeSwap: boolean;
    postSwapAction: string;
    postSwapError: string | null;
  };
}

function freshLifecycleHandle(): LifecycleHandleStub {
  return {
    lifecycle: {
      beforeSwap: vi.fn(async () => {}),
      afterSwap: vi.fn(async () => {}),
    },
    state: {
      priorState: "stopped",
      stoppedBeforeSwap: false,
      postSwapAction: "none",
      postSwapError: null,
    },
  };
}

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: mocks.createServiceInstallLifecycleMock,
}));

import { buildHostUpdateCommand } from "../host-update";
import { CLI_ERROR_CODES } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { HostInstallRecord } from "../../manifest/host-install";

function sampleRecord(version: string): HostInstallRecord {
  return {
    version,
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/tmp/traycer-host",
  };
}

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

describe("buildHostUpdateCommand busy-check gating", () => {
  afterEach(() => {
    // resetAllMocks (not clearAllMocks) so a mockResolvedValue/
    // mockRejectedValue configured in one test can't leak into the next.
    vi.resetAllMocks();
  });

  it("rejects with E_HOST_BUSY without --force, and never calls installHost", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockRejectedValue(
      Object.assign(new Error("busy"), { code: CLI_ERROR_CODES.HOST_BUSY }),
    );
    const command = buildHostUpdateCommand({
      versionRequest: "latest",
      force: false,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    expect(mocks.assertHostNotBusyMock).toHaveBeenCalledWith("production");
    expect(mocks.installHostMock).not.toHaveBeenCalled();
    // The marker must not be written before the busy gate passes.
    expect(mocks.writeUpdateProgressMarkerMock).not.toHaveBeenCalled();
  });

  it("skips the busy check and proceeds when --force is passed", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: sampleRecord("1.0.0"),
      previousVersionedDir: "/tmp/versions/1.0.0-abc",
    });
    mocks.createServiceInstallLifecycleMock.mockImplementation(
      freshLifecycleHandle,
    );
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: true,
      detail: "ok",
    });
    const command = buildHostUpdateCommand({
      versionRequest: "latest",
      force: true,
    });
    const result = await command(fakeCtx());
    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(mocks.installHostMock).toHaveBeenCalled();
    expect(result.data).toMatchObject({ version: "2.0.0" });
  });

  it("proceeds past the busy check when the host is idle", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("1.0.0"),
      previous: sampleRecord("1.0.0"),
      previousVersionedDir: null,
    });
    mocks.createServiceInstallLifecycleMock.mockImplementation(
      freshLifecycleHandle,
    );
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: true,
      detail: "ok",
    });
    const command = buildHostUpdateCommand({
      versionRequest: "latest",
      force: false,
    });
    const result = await command(fakeCtx());
    expect(mocks.assertHostNotBusyMock).toHaveBeenCalledWith("production");
    expect(mocks.installHostMock).toHaveBeenCalled();
    expect(result.human).toContain("no-op");
  });

  it("installs the exact release selected by Desktop", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("1.1.0-rc.2"),
      previous: sampleRecord("1.0.0"),
    });
    mocks.createServiceInstallLifecycleMock.mockImplementation(
      freshLifecycleHandle,
    );
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: true,
      detail: "ok",
    });

    const command = buildHostUpdateCommand({
      versionRequest: "1.1.0-rc.2",
      force: false,
    });
    await command(fakeCtx());

    expect(mocks.installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: "registry",
          versionRequest: "1.1.0-rc.2",
        },
      }),
    );
  });
});

// Final Host admission hardening: `host update --release` refuses a lower
// target and treats equal as an explicit no-op without install/lifecycle.
// Direct `host install` remains the deliberate operator downgrade surface
// and is intentionally not covered here.
describe("buildHostUpdateCommand --release lower/equal guards", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("rejects a lower --release target without calling installHost or busy-check", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.6.0"));
    const command = buildHostUpdateCommand({
      versionRequest: "1.5.0",
      force: false,
    });

    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      message: expect.stringMatching(
        /refusing to downgrade 1\.6\.0 to 1\.5\.0/i,
      ),
    });
    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(mocks.installHostMock).not.toHaveBeenCalled();
  });

  it("returns an explicit no-op for equal --release without installHost or busy-check", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.6.0"));
    const command = buildHostUpdateCommand({
      versionRequest: "1.6.0",
      force: false,
    });

    const result = await command(fakeCtx());
    expect(result.exitCode).toBe(0);
    expect(result.human).toContain("host already at 1.6.0 (no-op)");
    expect(result.data).toMatchObject({
      version: "1.6.0",
      previousVersion: "1.6.0",
    });
    expect(result.data).not.toHaveProperty("serviceLifecycle");
    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(mocks.installHostMock).not.toHaveBeenCalled();
  });

  it("still installs when --release is newer than the installed host", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.5.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("1.6.0"),
      previous: sampleRecord("1.5.0"),
    });
    mocks.createServiceInstallLifecycleMock.mockImplementation(
      freshLifecycleHandle,
    );
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: true,
      detail: "ok",
    });
    const command = buildHostUpdateCommand({
      versionRequest: "1.6.0",
      force: false,
    });

    const result = await command(fakeCtx());
    expect(mocks.installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: "registry",
          versionRequest: "1.6.0",
        },
      }),
    );
    expect(result.data).toMatchObject({ version: "1.6.0" });
  });
});

describe("buildHostUpdateCommand version plumbing", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("passes the requested version through to installHost instead of hardcoding 'latest'", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("1.4.2"),
      previous: sampleRecord("1.0.0"),
      previousVersionedDir: "/tmp/versions/1.0.0-abc",
    });
    mocks.createServiceInstallLifecycleMock.mockImplementation(
      freshLifecycleHandle,
    );
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: true,
      detail: "ok",
    });
    const command = buildHostUpdateCommand({
      versionRequest: "1.4.2",
      force: false,
    });
    await command(fakeCtx());
    expect(mocks.installHostMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "1.4.2" },
      }),
    );
  });
});

describe("buildHostUpdateCommand progress marker + health probe", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("writes an 'updating' marker before installHost runs, and clears it on a healthy probe", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    const callOrder: string[] = [];
    mocks.writeUpdateProgressMarkerMock.mockImplementation(
      async (_env, progress) => {
        callOrder.push(`write:${progress.state}`);
      },
    );
    mocks.installHostMock.mockImplementation(async () => {
      callOrder.push("installHost");
      return {
        record: sampleRecord("2.0.0"),
        previous: sampleRecord("1.0.0"),
        previousVersionedDir: "/tmp/versions/1.0.0-abc",
      };
    });
    mocks.createServiceInstallLifecycleMock.mockImplementation(
      freshLifecycleHandle,
    );
    mocks.probeHostHealthMock.mockImplementation(async () => {
      callOrder.push("probe");
      return { healthy: true, detail: "ok" };
    });
    mocks.deleteUpdateProgressMarkerMock.mockImplementation(async () => {
      callOrder.push("delete");
    });

    const command = buildHostUpdateCommand({
      versionRequest: "2.0.0",
      force: false,
    });
    const result = await command(fakeCtx());

    expect(callOrder).toEqual([
      "write:updating",
      "installHost",
      "probe",
      "delete",
    ]);
    expect(mocks.rollbackToVersionedDirMock).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      version: "2.0.0",
      healthCheck: { healthy: true },
    });
  });

  it("rolls back to the previous versioned dir and cycles the service when the health probe fails", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: sampleRecord("1.0.0"),
      previousVersionedDir: "/tmp/versions/1.0.0-abc",
    });
    const handles: LifecycleHandleStub[] = [];
    mocks.createServiceInstallLifecycleMock.mockImplementation(() => {
      const handle = freshLifecycleHandle();
      handles.push(handle);
      return handle;
    });
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: false,
      detail: "host process (pid 123) is not alive",
    });

    const command = buildHostUpdateCommand({
      versionRequest: "2.0.0",
      force: false,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    expect(mocks.rollbackToVersionedDirMock).toHaveBeenCalledWith(
      "production",
      "/tmp/versions/1.0.0-abc",
    );
    // A second lifecycle handle was created for the rollback cycle, and its
    // beforeSwap/afterSwap were both invoked to stop the failed process and
    // restart on the reverted binary.
    expect(handles).toHaveLength(2);
    expect(handles[1].lifecycle.beforeSwap).toHaveBeenCalledTimes(1);
    expect(handles[1].lifecycle.afterSwap).toHaveBeenCalledTimes(1);
    // The marker is rewritten as failed with the probe's detail, not cleared.
    expect(mocks.deleteUpdateProgressMarkerMock).not.toHaveBeenCalled();
    const failedWrite = mocks.writeUpdateProgressMarkerMock.mock.calls.find(
      ([, progress]) => progress.state === "failed",
    );
    expect(failedWrite).toBeDefined();
    expect(failedWrite?.[1]).toMatchObject({
      state: "failed",
      error: "host process (pid 123) is not alive",
      targetVersion: "2.0.0",
    });
  });

  it("skips the rollback swap (but still marks failed) when there is nothing to roll back to", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.installHostMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: sampleRecord("1.0.0"),
      previousVersionedDir: null,
    });
    mocks.createServiceInstallLifecycleMock.mockImplementation(
      freshLifecycleHandle,
    );
    mocks.probeHostHealthMock.mockResolvedValue({
      healthy: false,
      detail: "host loopback port 4100 did not accept a TCP connection",
    });

    const command = buildHostUpdateCommand({
      versionRequest: "2.0.0",
      force: false,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_HEALTH_CHECK_FAILED,
    });

    expect(mocks.rollbackToVersionedDirMock).not.toHaveBeenCalled();
    // Only the main handle was created - no rollback cycle to run.
    expect(mocks.createServiceInstallLifecycleMock).toHaveBeenCalledTimes(1);
    const failedWrite = mocks.writeUpdateProgressMarkerMock.mock.calls.find(
      ([, progress]) => progress.state === "failed",
    );
    expect(failedWrite).toBeDefined();
  });

  it("writes a failed marker and never probes when installHost itself throws", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.0.0"));
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.installHostMock.mockRejectedValue(
      Object.assign(new Error("signature verification failed"), {
        code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
      }),
    );
    mocks.createServiceInstallLifecycleMock.mockImplementation(
      freshLifecycleHandle,
    );

    const command = buildHostUpdateCommand({
      versionRequest: "2.0.0",
      force: false,
    });
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_VERIFY_FAILED,
    });

    expect(mocks.probeHostHealthMock).not.toHaveBeenCalled();
    expect(mocks.rollbackToVersionedDirMock).not.toHaveBeenCalled();
    const failedWrite = mocks.writeUpdateProgressMarkerMock.mock.calls.find(
      ([, progress]) => progress.state === "failed",
    );
    expect(failedWrite).toBeDefined();
    expect(failedWrite?.[1].error).toContain("signature verification failed");
  });
});
