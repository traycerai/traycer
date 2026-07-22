import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";

// Pins the `host ensure` state machine: a lock-free fast no-op when the
// host is already installed + registered + running, and the three
// mutating branches (full install, service-only register, start) keyed
// off the current install record + service status.

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  stageHostInstallSourceMock: vi.fn(),
  commitHostInstallSourceMock: vi.fn(),
  discardStagedHostInstallSourceMock: vi.fn(),
  currentInstallPlatformMock: vi.fn(),
  resolveBundledHostArchiveMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  resolveServiceCliInvocationMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  createServiceInstallLifecycleMock: vi.fn(),
  createBytesOnlyInstallLifecycleMock: vi.fn(),
  withCliLockMock: vi.fn(),
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

vi.mock("../../installer/bundled-host", () => ({
  resolveBundledHostArchive: mocks.resolveBundledHostArchiveMock,
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

vi.mock("../../service/cli-binary", () => ({
  resolveServiceCliInvocation: mocks.resolveServiceCliInvocationMock,
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: mocks.createServiceInstallLifecycleMock,
  createBytesOnlyInstallLifecycle: mocks.createBytesOnlyInstallLifecycleMock,
}));

vi.mock("../../store/cli-lock", () => ({
  withCliLock: mocks.withCliLockMock,
}));

vi.mock("../busy-check", () => ({
  assertHostNotBusy: mocks.assertHostNotBusyMock,
}));

const {
  stageHostInstallSourceMock,
  commitHostInstallSourceMock,
  discardStagedHostInstallSourceMock,
  resolveBundledHostArchiveMock,
  readHostInstallRecordMock,
  resolveServiceCliInvocationMock,
  createServiceControllerMock,
  serviceLabelForMock,
  createServiceInstallLifecycleMock,
  createBytesOnlyInstallLifecycleMock,
  withCliLockMock,
  assertHostNotBusyMock,
} = mocks;

import { ensureHost, type EnsureHostOptions } from "../ensure";
import { config } from "../../config";
import { cliError, CLI_ERROR_CODES } from "../../runner/errors";
import type { ServiceController } from "../../service";

function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
}

function makeOpts(overrides: Partial<EnsureHostOptions>): EnsureHostOptions {
  return {
    runtime: makeRuntime(),
    versionRequest: null,
    fromPath: null,
    enableLinger: true,
    allowSelfInvocation: true,
    noServiceRegister: false,
    force: false,
    onProgress: null,
    ...overrides,
  };
}

function makeController(
  state: "running" | "stopped" | "not-installed",
): ServiceController {
  let current = state;
  return {
    status: vi.fn(async () => ({
      state: current,
      version: null,
      listenUrl: null,
      pid: null,
    })),
    install: vi.fn(async () => {
      current = "running";
    }),
    start: vi.fn(async () => {
      current = "running";
    }),
    uninstall: vi.fn(async () => {
      current = "not-installed";
    }),
    stop: vi.fn(async () => {
      current = "stopped";
    }),
    restart: vi.fn(async () => {
      current = "running";
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callOrder = [];
  config.supportedHostVersion = null;
  serviceLabelForMock.mockImplementation(
    (environment: "production" | "dev") => ({
      id: environment === "dev" ? "ai.traycer.host.dev" : "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
  );
  resolveServiceCliInvocationMock.mockResolvedValue({
    command: "/usr/local/bin/traycer",
    args: [],
  });
  resolveBundledHostArchiveMock.mockResolvedValue(null);
  withCliLockMock.mockImplementation(
    async (_opts: unknown, fn: () => Promise<unknown>) => {
      mocks.callOrder.push("lock-enter");
      const result = await fn();
      mocks.callOrder.push("lock-exit");
      return result;
    },
  );
  createServiceInstallLifecycleMock.mockImplementation(() => ({
    state: {
      priorState: "not-installed",
      stoppedBeforeSwap: false,
      postSwapAction: "install",
      postSwapError: null,
    },
    lifecycle: { beforeSwap: vi.fn(), afterSwap: vi.fn() },
  }));
  createBytesOnlyInstallLifecycleMock.mockImplementation(() => ({
    beforeSwap: vi.fn(),
    afterSwap: vi.fn(),
  }));
  stageHostInstallSourceMock.mockResolvedValue({
    stagingDir: "/tmp/staged",
    version: "1.6.0",
  });
  commitHostInstallSourceMock.mockResolvedValue({
    record: {
      installId: "install-1.6.0",
      version: "1.6.0",
      runtimeVersion: null,
    },
    previous: null,
    installGeneration: "id:install-1.6.0",
  });
  assertHostNotBusyMock.mockResolvedValue(undefined);
  mocks.currentInstallPlatformMock.mockReturnValue("darwin");
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("ensureHost", () => {
  it("rejects --no-service-register on Windows before inspecting or stopping a live host", async () => {
    mocks.currentInstallPlatformMock.mockReturnValue("win32");

    await expect(
      ensureHost(makeOpts({ noServiceRegister: true })),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });

    expect(readHostInstallRecordMock).not.toHaveBeenCalled();
    expect(createServiceControllerMock).not.toHaveBeenCalled();
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
  });

  it("fast no-op when installed + registered + running (no lock, no install)", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("running");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("noop");
    expect(result.running).toBe(true);
    expect(result.installGeneration).toBeNull();
    expect(withCliLockMock).not.toHaveBeenCalled();
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    expect(controller.install).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("starts a registered-but-stopped host without reinstalling, and attests the current record's generation", async () => {
    readHostInstallRecordMock.mockResolvedValue({
      installId: "install-1.5.0",
      version: "1.5.0",
      runtimeVersion: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
    });
    const controller = makeController("stopped");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("started");
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    expect(controller.install).not.toHaveBeenCalled();
    expect(result.installGeneration).toBe("id:install-1.5.0");
    expect(result.serviceLifecycle).toEqual({
      priorServiceState: "stopped",
      stoppedBeforeSwap: false,
      postSwapAction: "start",
      postSwapError: null,
    });
  });

  it("escalate-once: install's own recovery run is accepted without a duplicate IgnoreNew start", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("stopped");
    let startCalls = 0;
    let recovered = false;
    controller.start = vi.fn(async () => {
      startCalls += 1;
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "schtasks /Run accepted but no spawn evidence",
        details: { lastRunResult: "0x1" },
        exitCode: 1,
      });
    });
    // Windows install recreates the task and issues its own verified `/Run`.
    // A second `/Run` would be suppressed by IgnoreNew and incorrectly fail.
    controller.install = vi.fn(async () => {
      recovered = true;
    });
    // Fast-path + locked recheck both need registered+stopped; only the
    // post-recovery status probe reports running.
    controller.status = vi.fn(async () => {
      if (!recovered) {
        return {
          state: "stopped" as const,
          version: null,
          listenUrl: null,
          pid: null,
        };
      }
      return {
        state: "running" as const,
        version: "1.5.0",
        listenUrl: "ws://127.0.0.1:7100/rpc",
        pid: 4242,
      };
    });
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("started");
    expect(result.running).toBe(true);
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.install).toHaveBeenCalledTimes(1);
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
  });

  it("escalate-once: failed install launch gets one verified retry, then reports its honest retry error", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("stopped");
    const startError = cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: "still no spawn evidence after rewrite",
      details: { lastRunResult: "0x41301" },
      exitCode: 1,
    });
    controller.start = vi.fn(async () => {
      throw startError;
    });
    controller.install = vi.fn(async () => {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "recreated task but initial /Run was rejected",
        details: null,
        exitCode: 1,
      });
    });
    controller.status = vi.fn(async () => ({
      state: "stopped" as const,
      version: null,
      listenUrl: null,
      pid: null,
    }));
    createServiceControllerMock.mockReturnValue(controller);

    await expect(ensureHost(makeOpts({}))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: "still no spawn evidence after rewrite",
    });
    expect(controller.start).toHaveBeenCalledTimes(2);
    expect(controller.install).toHaveBeenCalledTimes(1);
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed task-definition rewrite instead of retrying the stale task", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("stopped");
    controller.start = vi.fn(async () => {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "old task never published spawn evidence",
        details: null,
        exitCode: 1,
      });
    });
    controller.install = vi.fn(async () => {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: "schtasks /Create /F rejected the rewritten definition",
        details: null,
        exitCode: 1,
      });
    });
    createServiceControllerMock.mockReturnValue(controller);

    await expect(ensureHost(makeOpts({}))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: "schtasks /Create /F rejected the rewritten definition",
    });
    // Starting again here could succeed only because the stale task remains
    // registered, falsely reporting a repair that never rewrote anything.
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.install).toHaveBeenCalledTimes(1);
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
  });

  it("registers the service when installed but not registered (no download), and attests the current record's generation", async () => {
    readHostInstallRecordMock.mockResolvedValue({
      installId: "install-1.5.0",
      version: "1.5.0",
      runtimeVersion: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
    });
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("service-registered");
    expect(controller.install).toHaveBeenCalledTimes(1);
    expect(resolveServiceCliInvocationMock).toHaveBeenCalledTimes(1);
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    expect(result.installGeneration).toBe("id:install-1.5.0");
    expect(result.serviceLifecycle).toEqual({
      priorServiceState: "not-installed",
      stoppedBeforeSwap: false,
      postSwapAction: "install",
      postSwapError: null,
    });
  });

  it("installs from the registry (latest) when no host is installed, staging entirely before the lock is ever acquired", async () => {
    readHostInstallRecordMock.mockResolvedValue(null);
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("installed");
    expect(result.version).toBe("1.6.0");
    expect(result.installGeneration).toBe("id:install-1.6.0");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(stageHostInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "latest" },
      }),
    );
    expect(mocks.callOrder).toEqual([
      "stage",
      "lock-enter",
      "commit",
      "lock-exit",
    ]);
  });

  it("uses the configured supported host version for default registry installs", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue(null);
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("installed");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(stageHostInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "1.7.2" },
      }),
    );
  });

  it("reinstalls when the supported host version does not match the record", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.6.0" });
    const controller = makeController("running");
    createServiceControllerMock.mockReturnValue(controller);
    commitHostInstallSourceMock.mockResolvedValue({
      record: {
        installId: "install-1.7.2",
        version: "1.7.2",
        runtimeVersion: null,
      },
      previous: { installId: "install-1.6.0", version: "1.6.0" },
      installGeneration: "id:install-1.7.2",
    });

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("installed");
    expect(stageHostInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "1.7.2" },
      }),
    );
  });

  it("probes the busy check before reinstalling a running host (not forced)", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.6.0" });
    createServiceControllerMock.mockReturnValue(makeController("running"));

    const result = await ensureHost(makeOpts({}));

    expect(assertHostNotBusyMock).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("installed");
  });

  it("aborts the reinstall when the busy probe throws E_HOST_BUSY, discarding the already-staged temp without ever committing", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.6.0" });
    createServiceControllerMock.mockReturnValue(makeController("running"));
    assertHostNotBusyMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message: "busy",
        details: null,
        exitCode: 1,
      }),
    );

    await expect(ensureHost(makeOpts({}))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_BUSY,
    });
    // Staging (outside the lock) already ran by prediction before the busy
    // probe (inside the lock) ever gets a chance to throw.
    expect(stageHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    expect(discardStagedHostInstallSourceMock).toHaveBeenCalledTimes(1);
  });

  it("--force skips the busy probe and reinstalls a running host", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.6.0" });
    createServiceControllerMock.mockReturnValue(makeController("running"));

    const result = await ensureHost(makeOpts({ force: true }));

    expect(assertHostNotBusyMock).not.toHaveBeenCalled();
    expect(result.action).toBe("installed");
  });

  it("always consults the busy check when reinstalling (the check no-ops when no live host)", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.6.0" });
    createServiceControllerMock.mockReturnValue(makeController("stopped"));

    const result = await ensureHost(makeOpts({}));

    // The gate no longer keys on the service `running` flag; the busy-check
    // module itself returns for a dead/absent host (see busy-check.test.ts).
    // Here the mock no-ops, so the install proceeds.
    expect(assertHostNotBusyMock).toHaveBeenCalledTimes(1);
    expect(result.action).toBe("installed");
  });

  it("--force reinstalls even when the install record already matches (no satisfied no-op)", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.7.2" });
    createServiceControllerMock.mockReturnValue(makeController("running"));
    commitHostInstallSourceMock.mockResolvedValue({
      record: {
        installId: "install-1.7.2",
        version: "1.7.2",
        runtimeVersion: null,
      },
      previous: { installId: "install-1.7.2-prev", version: "1.7.2" },
      installGeneration: "id:install-1.7.2",
    });

    const result = await ensureHost(makeOpts({ force: true }));

    // Without force this is a no-op (installed + registered + running + version
    // matches); force must still reinstall + restart (D5).
    expect(result.action).toBe("installed");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(assertHostNotBusyMock).not.toHaveBeenCalled();
  });

  it("noServiceRegister installs bytes only - no service register/start, no lifecycle", async () => {
    readHostInstallRecordMock.mockResolvedValue(null);
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({ noServiceRegister: true }));

    expect(result.action).toBe("installed");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    // Host (desktop SMAppService) owns registration - the CLI must not
    // touch the OS service or build a registering lifecycle.
    expect(controller.install).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
    expect(createServiceInstallLifecycleMock).not.toHaveBeenCalled();
    // The bytes-only builder IS used - Windows still needs its `beforeSwap`
    // to release stray file handles before the rename.
    expect(createBytesOnlyInstallLifecycleMock).toHaveBeenCalledTimes(1);
    expect(result.serviceLifecycle).toBeNull();
  });

  it("noServiceRegister no-ops when bytes already installed (ignores service state)", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({ noServiceRegister: true }));

    expect(result.action).toBe("noop");
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    expect(controller.install).not.toHaveBeenCalled();
  });

  it("prefers the packaged host archive over the registry for latest", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue(null);
    resolveBundledHostArchiveMock.mockResolvedValue("/bundle/host.tar.gz");
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    await ensureHost(makeOpts({}));

    expect(stageHostInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "local-file", path: "/bundle/host.tar.gz" },
      }),
    );
  });

  it("keeps explicit latest as a live registry request even when a default version is configured", async () => {
    config.supportedHostVersion = "1.7.2";
    readHostInstallRecordMock.mockResolvedValue(null);
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);

    await ensureHost(makeOpts({ versionRequest: "latest" }));

    expect(stageHostInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "latest" },
      }),
    );
  });

  it("reinstalls when an explicit --release version does not match the record", async () => {
    readHostInstallRecordMock.mockResolvedValue({ version: "1.5.0" });
    const controller = makeController("running");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({ versionRequest: "1.6.0" }));

    expect(result.action).toBe("installed");
    expect(stageHostInstallSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "registry", versionRequest: "1.6.0" },
      }),
    );
  });

  it("a lost race (locked recheck finds the host already provisioned by another actor) discards the pre-staged temp and never commits", async () => {
    // Fast (lock-free) read predicts install is needed (not installed yet);
    // by the time the lock is acquired, a concurrent actor has already
    // installed - the locked recheck must win and the speculative stage
    // must be discarded rather than committed on top.
    readHostInstallRecordMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ version: "1.6.0" });
    const controller = makeController("running");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({}));

    expect(result.action).toBe("noop");
    expect(stageHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    expect(discardStagedHostInstallSourceMock).toHaveBeenCalledTimes(1);
  });
});
