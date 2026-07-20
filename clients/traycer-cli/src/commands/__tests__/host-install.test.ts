import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `host install` (Host Update Layer Redesign Tech Plan, "Lock-scope
// restructure" + "--no-service-register" + "--if-idle"): stage/verify/
// extract into an owner-tokened temp OUTSIDE `cli-lock`
// (`stageHostInstallSource`), then commit (reconcile -> stop -> swap ->
// start -> re-reconcile, `commitHostInstallSource`) INSIDE the lock. This
// suite pins the command-layer wiring around that split - lock scope,
// flag plumbing, and the busy-abort/discard path - by mocking the
// installer boundary and the service lifecycle, mirroring host-update.
// test.ts's mock style. The genuine two-process lock-contention coverage
// lives in host-install-lock.test.ts.

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  stageHostInstallSourceMock: vi.fn(),
  commitHostInstallSourceMock: vi.fn(),
  discardStagedHostInstallSourceMock: vi.fn(),
  currentInstallPlatformMock: vi.fn(),
  createServiceInstallLifecycleMock: vi.fn(),
  createBytesOnlyInstallLifecycleMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  assertHostNotBusyMock: vi.fn(),
}));

vi.mock("../../installer", () => ({
  stageHostInstallSource: async (
    ...callArgs: Parameters<typeof mocks.stageHostInstallSourceMock>
  ) => {
    mocks.callOrder.push("stage");
    return mocks.stageHostInstallSourceMock(...callArgs);
  },
  commitHostInstallSource: async (
    ...callArgs: Parameters<typeof mocks.commitHostInstallSourceMock>
  ) => {
    mocks.callOrder.push("commit");
    return mocks.commitHostInstallSourceMock(...callArgs);
  },
  discardStagedHostInstallSource: async (
    ...callArgs: Parameters<typeof mocks.discardStagedHostInstallSourceMock>
  ) => {
    mocks.callOrder.push("discard");
    return mocks.discardStagedHostInstallSourceMock(...callArgs);
  },
  currentInstallPlatform: mocks.currentInstallPlatformMock,
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: mocks.createServiceInstallLifecycleMock,
  createBytesOnlyInstallLifecycle: mocks.createBytesOnlyInstallLifecycleMock,
}));

// `createServiceController`/`serviceLabelFor` must be mocked here too, not
// just `createServiceInstallLifecycle` - the bytes-only path
// (`--no-service-register`) now calls them directly, and the REAL
// `createServiceController()` builds a `createCliLogger` that does real
// filesystem I/O against the operator's actual `~/.traycer` home. Leaving
// this unmocked would run real disk writes from this suite. `formatService
// LifecycleWarning` is kept genuine (pure string formatting, no I/O).
vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: mocks.createServiceControllerMock,
    serviceLabelFor: mocks.serviceLabelForMock,
  };
});

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: (
    ...callArgs: Parameters<typeof mocks.assertHostNotBusyMock>
  ) => {
    mocks.callOrder.push("busy-probe");
    return mocks.assertHostNotBusyMock(...callArgs);
  },
}));

vi.mock("../../store/cli-lock", () => ({
  withCliLock: async (
    _opts: unknown,
    fn: (handle: {
      path: string;
      metadata: Record<string, unknown>;
      release: () => Promise<void>;
    }) => Promise<unknown>,
  ) => {
    mocks.callOrder.push("lock-enter");
    const result = await fn({
      path: "/tmp/.lock",
      metadata: {},
      release: async () => {},
    });
    mocks.callOrder.push("lock-exit");
    return result;
  },
}));

import { buildHostInstallCommand, type HostInstallArgs } from "../host-install";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { HostInstallRecord } from "../../manifest/host-install";
import type { StagedHostInstallSource } from "../../installer";
import type { ServiceInstallLifecycleHandle } from "../../service/install-lifecycle";

function sampleRecord(version: string): HostInstallRecord {
  return {
    installId: `install-${version}`,
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

function sampleStaged(): StagedHostInstallSource {
  return {
    stagingDir: "/tmp/staging-dir",
    archivePath: "/tmp/staging-dir/archive.tar.gz",
    archiveIsTemporary: true,
    executablePath: "/tmp/staging-dir/traycer-host",
    version: "2.0.0",
    runtimeVersion: null,
    source: { kind: "registry", value: "2.0.0" },
    archiveSha256: "b".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
  };
}

function sampleLifecycleHandle(): ServiceInstallLifecycleHandle {
  return {
    state: {
      priorState: "running",
      stoppedBeforeSwap: true,
      postSwapAction: "install",
      postSwapError: null,
    },
    lifecycle: {
      beforeSwap: async () => {},
      afterSwap: async () => {},
    },
  };
}

function baseArgs(overrides: Partial<HostInstallArgs>): HostInstallArgs {
  return {
    versionRequest: "2.0.0",
    fromPath: null,
    enableLinger: true,
    allowSelfInvocation: false,
    noServiceRegister: false,
    ifIdle: false,
    ...overrides,
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

describe("buildHostInstallCommand", () => {
  beforeEach(() => {
    // Default stand-ins so the bytes-only branch (which now calls these
    // directly) never falls through to the real, side-effecting
    // implementations. `resetAllMocks` in `afterEach` wipes these between
    // tests, so they're re-applied here rather than once at module load.
    mocks.createServiceControllerMock.mockReturnValue({
      install: vi.fn(),
      uninstall: vi.fn(),
      status: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      restart: vi.fn(),
    });
    mocks.serviceLabelForMock.mockReturnValue({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment: "production",
      devSlot: null,
    });
    mocks.currentInstallPlatformMock.mockReturnValue("darwin");
  });

  afterEach(() => {
    // resetAllMocks (not clearAllMocks) so a mockResolvedValue/
    // mockRejectedValue configured in one test can't leak into the next -
    // matches host-update.test.ts's convention.
    vi.resetAllMocks();
    mocks.callOrder = [];
  });

  it("stages entirely before the lock is ever acquired, and commits only inside it", async () => {
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: sampleRecord("1.0.0"),
      installGeneration: "id:install-2.0.0",
    });

    const command = buildHostInstallCommand(baseArgs({}));
    await command(fakeCtx());

    expect(mocks.callOrder).toEqual([
      "stage",
      "lock-enter",
      "commit",
      "lock-exit",
    ]);
  });

  it("--no-service-register skips the service lifecycle entirely: no stop, no register, no start (Finding 4)", async () => {
    // `createServiceInstallLifecycle`'s `bootstrap: null` still rewrites and
    // re-loads an EXISTING OS registration post-swap (see `service/install-
    // lifecycle.ts`'s `afterSwap`) - that is NOT the bytes-only contract
    // `--no-service-register` promises. The fix skips that lifecycle
    // entirely and uses the bytes-only builder instead.
    const bytesOnlyLifecycle = {
      beforeSwap: vi.fn(async () => {}),
      afterSwap: vi.fn(async () => {}),
    };
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createBytesOnlyInstallLifecycleMock.mockReturnValue(
      bytesOnlyLifecycle,
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const command = buildHostInstallCommand(
      baseArgs({ noServiceRegister: true }),
    );
    const result = await command(fakeCtx());

    // The stop/register/rewrite/start-capable lifecycle is never built at
    // all - not built-then-unused, never constructed.
    expect(mocks.createServiceInstallLifecycleMock).not.toHaveBeenCalled();
    expect(mocks.createBytesOnlyInstallLifecycleMock).toHaveBeenCalledTimes(1);
    // The bytes-only lifecycle - not a `createServiceInstallLifecycle`
    // handle's lifecycle - is what actually reaches the commit.
    expect(mocks.commitHostInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: bytesOnlyLifecycle }),
    );
    // `commitHostInstallSource` (which owns invoking the hooks) is mocked
    // here, so neither hook having fired proves nothing in the command
    // layer itself calls stop/register/start directly.
    expect(bytesOnlyLifecycle.beforeSwap).not.toHaveBeenCalled();
    expect(bytesOnlyLifecycle.afterSwap).not.toHaveBeenCalled();
    // No service action is reported - activation remains a separate step.
    expect(result.data).toMatchObject({ serviceLifecycle: null });
  });

  it("rejects --no-service-register on Windows before staging or touching a live host", async () => {
    mocks.currentInstallPlatformMock.mockReturnValue("win32");

    await expect(
      buildHostInstallCommand(baseArgs({ noServiceRegister: true }))(fakeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });

    expect(mocks.stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(mocks.commitHostInstallSourceMock).not.toHaveBeenCalled();
    expect(mocks.createServiceInstallLifecycleMock).not.toHaveBeenCalled();
    expect(mocks.createBytesOnlyInstallLifecycleMock).not.toHaveBeenCalled();
  });

  it("passes the enableLinger/allowSelfInvocation bootstrap payload when --no-service-register is NOT set", async () => {
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const command = buildHostInstallCommand(
      baseArgs({
        noServiceRegister: false,
        enableLinger: false,
        allowSelfInvocation: true,
      }),
    );
    await command(fakeCtx());

    expect(mocks.createServiceInstallLifecycleMock).toHaveBeenCalledWith({
      environment: "production",
      bootstrap: { enableLinger: false, allowSelfInvocation: true },
    });
  });

  it("plain install (no --if-idle) never probes busy", async () => {
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const command = buildHostInstallCommand(baseArgs({ ifIdle: false }));
    await command(fakeCtx());

    expect(mocks.assertHostNotBusyMock).not.toHaveBeenCalled();
  });

  it("--if-idle probes busy inside the lock, immediately before commit, and proceeds to commit when idle", async () => {
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.assertHostNotBusyMock.mockResolvedValue(undefined);
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const command = buildHostInstallCommand(baseArgs({ ifIdle: true }));
    await command(fakeCtx());

    expect(mocks.callOrder).toEqual([
      "stage",
      "lock-enter",
      "busy-probe",
      "commit",
      "lock-exit",
    ]);
  });

  it("--if-idle busy: discards the staged temp, never calls commitHostInstallSource, and rethrows E_HOST_BUSY", async () => {
    const staged = sampleStaged();
    mocks.stageHostInstallSourceMock.mockResolvedValue(staged);
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.assertHostNotBusyMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "The running host has work in progress",
        details: null,
        exitCode: 1,
      }),
    );

    const command = buildHostInstallCommand(baseArgs({ ifIdle: true }));
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });

    expect(mocks.commitHostInstallSourceMock).not.toHaveBeenCalled();
    expect(mocks.discardStagedHostInstallSourceMock).toHaveBeenCalledWith(
      "production",
      staged,
    );
  });

  it("on a cli-lock/commit failure, discards the staged temp and rethrows unchanged", async () => {
    const staged = sampleStaged();
    mocks.stageHostInstallSourceMock.mockResolvedValue(staged);
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
        message: "swap failed",
        details: null,
        exitCode: 1,
      }),
    );

    const command = buildHostInstallCommand(baseArgs({}));
    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INSTALL_FAILED,
    });

    expect(mocks.discardStagedHostInstallSourceMock).toHaveBeenCalledWith(
      "production",
      staged,
    );
  });

  it("on success, never discards the staged temp - commitHostInstallSource already owns that cleanup", async () => {
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const command = buildHostInstallCommand(baseArgs({}));
    await command(fakeCtx());

    expect(mocks.discardStagedHostInstallSourceMock).not.toHaveBeenCalled();
  });

  it("carries the attested installGeneration from commitHostInstallSource's result into the command's data payload", async () => {
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: { ...sampleRecord("2.0.0"), runtimeVersion: "2.0.0" },
      previous: sampleRecord("1.0.0"),
      installGeneration: "id:install-2.0.0:attested",
    });

    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(result.data).toMatchObject({
      installGeneration: "id:install-2.0.0:attested",
      version: "2.0.0",
      runtimeVersion: "2.0.0",
      previousVersion: "1.0.0",
    });
  });

  it("resolves a local-file source (--from) instead of a registry version request", async () => {
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const command = buildHostInstallCommand(
      baseArgs({ fromPath: "/tmp/local-host-build", versionRequest: "" }),
    );
    await command(fakeCtx());

    expect(mocks.stageHostInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "local-file", path: "/tmp/local-host-build" },
      }),
    );
  });
});
