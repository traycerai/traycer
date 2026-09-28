import { rmSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import { reportServiceInstallKeptDisabled } from "../../service/registration-repair";
import { SERVICE_TASK_NOT_OWNED_MESSAGE } from "../../service/platforms/windows-task-gate";
import { SERVICE_KEPT_DISABLED_WARNING } from "../../service/registration-owner";

// Pins the `host ensure` state machine: a lock-free fast no-op when the
// host is already installed + registered + running, and the three
// mutating branches (full install, service-only register, start) keyed
// off the current install record + service status.

// HOME is redirected to a private temp dir BEFORE anything reads it:
// `ensureHost` runs the REAL `provisionHost`, whose update-attempt segment
// takes its lock and reads its attempt record under `hostHomeDir()`, and
// `store/paths` binds `homedir()` at module load. Without this every row
// took (and read) this machine's REAL `~/.traycer/host` lock. The dir is made
// inside the `node:os` factory, so it exists before the first module that
// asks for `homedir()` is evaluated.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-ensure-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

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
  gateStoreFormatFloorMock: vi.fn(),
  isVersionYankedMock: vi.fn(),
  publishHostStartAdoptionMock: vi.fn(),
  readServiceRegistrationDisabledMock: vi.fn(),
}));

vi.mock("../../installer", () => ({
  // The two swap barriers this command observes: none. Inlined rather than
  // re-exported from the real module so this factory keeps the installer out
  // of the module graph entirely, which is what it exists for.
  NO_INSTALL_PHASE_HOOKS: {
    beforeSwapCommit: async () => {},
    afterSwap: async () => {},
  },
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

// `commitHostInstallSourceWithAttempt` (update-mutation.ts) imports
// `commitHostInstallSource` straight from `../../installer/install`, not
// the barrel above - that direct import bypasses the barrel mock, so the
// REAL committer (and the real attempt-lock machinery it drives) would
// otherwise run against this process's actual host home. Mirror the same
// fake here.
vi.mock("../../installer/install", () => ({
  commitHostInstallSource: async (
    ...callArgs: Parameters<typeof mocks.commitHostInstallSourceMock>
  ) => {
    mocks.callOrder.push("commit");
    return mocks.commitHostInstallSourceMock(...callArgs);
  },
}));

vi.mock("../../installer/bundled-host", () => ({
  resolveBundledHostArchive: mocks.resolveBundledHostArchiveMock,
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

// `ensureHost` calls the real `provisionHost`, which calls
// `gateStoreFormatFloor` - unmocked, that resolves `hostHomeDir` from
// `os.homedir()` at module load and walks it for real. This suite pins the
// ensure state machine, not the floor's own semantics (that is
// `store-format-floor.test.ts`, against an explicit temp `hostHome`), so the
// gate is mocked here.
vi.mock("../store-format-floor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store-format-floor")>();
  return {
    ...actual,
    gateStoreFormatFloor: (
      ...callArgs: Parameters<typeof mocks.gateStoreFormatFloorMock>
    ) => mocks.gateStoreFormatFloorMock(...callArgs),
  };
});

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

// Real exports (the message constant, the error builder) plus a `vi.fn`
// for the read, defaulted to "not-disabled" in `beforeEach` below so every
// OTHER row in this file - none of which cares about this gate - keeps
// exercising `runStart`'s escalation exactly as before this mock existed.
vi.mock("../../service/registration-disabled", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../service/registration-disabled")
    >();
  return {
    ...actual,
    readServiceRegistrationDisabled: (
      ...callArgs: Parameters<typeof mocks.readServiceRegistrationDisabledMock>
    ) => mocks.readServiceRegistrationDisabledMock(...callArgs),
  };
});

// The real `publishHostStartAdoption` waits (up to 30s) for a service-
// manager child to ack a spawn that never happens under a stubbed
// controller. This suite pins `ensureHost`'s orchestration, not the
// adoption handshake (that's `host-start-adoption.test.ts`), so replace it
// with an immediately-satisfied lease.
vi.mock("../host-start-adoption", () => ({
  publishHostStartAdoption: (
    ...callArgs: Parameters<typeof mocks.publishHostStartAdoptionMock>
  ) => {
    mocks.publishHostStartAdoptionMock(...callArgs);
    return Promise.resolve({
      waitForSpawn: async () => undefined,
      cancel: async () => undefined,
    });
  },
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
  isVersionYankedMock,
  publishHostStartAdoptionMock,
  readServiceRegistrationDisabledMock,
} = mocks;

import { ensureHost, type EnsureHostOptions } from "../ensure";
import { config } from "../../config";
import { cliError, CLI_ERROR_CODES } from "../../runner/errors";
import type { ServiceController } from "../../service";
import { hostHomeDir } from "../../store/paths";
import { atServiceSpawnEdge } from "../../service/spawn-edge";

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

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
    acceptStoreFormatLoss: false,
    // Through the seam, never the real lookup: the "regression: installed
    // 1.2.0, pin 1.3.0-rc.4, --keep-installed" case below is the one path
    // that asks whether the installed version is yanked, and the real
    // lookup's manifest fetch runs under a 10 s watchdog - twice vitest's
    // default - so a runner with no egress would time the test out.
    yankLookup: { isVersionYanked: mocks.isVersionYankedMock },
    keepInstalled: false,
    onProgress: null,
    adoption: undefined,
    lifecycleOrigin: "terminal",
    beforeMutate: null,
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
    stopForRestart: vi.fn(async () => {
      current = "stopped";
      return { forcedRecycle: false };
    }),
    relaunchAfterRestart: vi.fn(async () => {
      current = "running";
    }),
    restart: vi.fn(async () => {
      current = "running";
    }),
    hostStartAdoptionLabel: vi.fn(async (serviceLabel) => serviceLabel.id),
    // `host ensure` never reaches the externally-managed repair path (its
    // stub states are all CLI-managed), so a plain no-op is faithful here.
    retireCompetingRegistration: vi.fn(async () => ({
      kind: "not-applicable" as const,
    })),
    takeoverDesktopRegistration: vi.fn(async () => ({
      kind: "not-applicable" as const,
    })),
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
  isVersionYankedMock.mockResolvedValue(false);
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
      postSwapWarning: null,
    },
    lifecycle: {
      beforeSwap: vi.fn(),
      beforeSwapCommit: vi.fn(),
      afterSwap: vi.fn(),
      swapLockRecovery: null,
    },
  }));
  createBytesOnlyInstallLifecycleMock.mockImplementation(() => ({
    beforeSwap: vi.fn(),
    beforeSwapCommit: vi.fn(),
    afterSwap: vi.fn(),
    swapLockRecovery: null,
  }));
  stageHostInstallSourceMock.mockResolvedValue({
    stagingDir: "/tmp/staged",
    version: "1.6.0",
    // The staged source's own provenance. This fixture carried only the two
    // fields the suite asserted on; the real `StagedHostInstallSource` always
    // has it, and the install branch's "replacing a different installed
    // version" line reads it (Q7).
    source: { kind: "registry", value: "1.6.0" },
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
  mocks.gateStoreFormatFloorMock.mockResolvedValue({
    clearedVersion: null,
    publishedStoreFormats: null,
    acceptStoreFormatLoss: false,
    site: "host ensure",
  });
  readServiceRegistrationDisabledMock.mockResolvedValue({
    kind: "not-disabled",
  });
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

  // Every existing fixture in this file passes `lifecycleOrigin:
  // "terminal"` (the default in `makeOpts`), so nothing here pins that the
  // desktop's own origin actually reaches the published host-start adoption
  // proof. `host ensure` is desktop's post-auth provisioning call, so a
  // caller passing `lifecycleOrigin: "desktop"` is the routine case, not an
  // edge one.
  it("threads lifecycleOrigin: desktop through to the published host-start adoption proof", async () => {
    readHostInstallRecordMock.mockResolvedValue({
      installId: "install-1.5.0",
      version: "1.5.0",
      runtimeVersion: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
    });
    const controller = makeController("stopped");
    // `makeController`'s plain `start` never reaches `atServiceSpawnEdge()`
    // (same convention as every other fixture in this file, and in
    // `provision-supervisor-relaunch.test.ts`), so the armed publish hook
    // never fires and the mocked `publishHostStartAdoption` is never called.
    // This case is specifically about what reaches that publish call, so its
    // `start` must reach the real spawn edge - wrapping (not replacing) the
    // original keeps the same closure's mutable `current` state in sync.
    const originalStart = controller.start;
    controller.start = vi.fn(async (label) => {
      await atServiceSpawnEdge();
      return originalStart(label);
    });
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({ lifecycleOrigin: "desktop" }));

    expect(result.action).toBe("started");
    expect(publishHostStartAdoptionMock).toHaveBeenCalledTimes(1);
    expect(publishHostStartAdoptionMock.mock.calls[0]?.[3]).toBe("desktop");
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

  // Q7 wiring. The core's own rows (`provision.test.ts`, "own-build-minimum
  // satisfaction") prove what that policy DOES with a newer install; this is
  // the half they cannot see - that an own-build source still asks for it.
  // Reverting this mapping to `exact` reinstates the revert with every core
  // row still green, which is exactly how the churn survived review the first
  // time. Asserted on the target-computed line, before any install decision,
  // so no yank lookup is reached and the pin costs one log read.
  it.each([
    ["the packaged archive", { fromPath: null }],
    // The Windows desktop passes its bundled archive as `--from`, so the two
    // platforms would otherwise disagree about whether a user's newer host
    // survives a convergence.
    ["an explicit --from", { fromPath: "/elsewhere/host.tar.gz" }],
  ])(
    "asks for `own-build-minimum` for %s, never `exact`",
    async (_label, overrides) => {
      config.supportedHostVersion = "1.7.2";
      readHostInstallRecordMock.mockResolvedValue(null);
      resolveBundledHostArchiveMock.mockResolvedValue("/bundle/host.tar.gz");
      createServiceControllerMock.mockReturnValue(
        makeController("not-installed"),
      );
      const debug = vi.fn();

      await ensureHost(
        makeOpts({
          ...overrides,
          runtime: { ...makeRuntime(), logger: { ...noopLogger, debug } },
        }),
      );

      expect(debug).toHaveBeenCalledWith(
        "Host ensure provisioning target computed",
        expect.objectContaining({
          sourceKind: "local-file",
          satisfactionKind: "own-build-minimum",
          satisfactionVersion: config.version,
        }),
      );
    },
  );

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

  // Ticket 1/2 regression: the exact downgrade-revert RCA shape - a viable
  // OLDER install must not be reinstalled to the build's preferred pin just
  // because `--keep-installed` is threaded all the way through `ensureHost`.
  it("regression: installed 1.2.0, pin 1.3.0-rc.4, --keep-installed - no-op, no reinstall", async () => {
    config.supportedHostVersion = "1.3.0-rc.4";
    readHostInstallRecordMock.mockResolvedValue({ version: "1.2.0" });
    const controller = makeController("running");
    createServiceControllerMock.mockReturnValue(controller);

    const result = await ensureHost(makeOpts({ keepInstalled: true }));

    expect(result.action).toBe("noop");
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    expect(controller.install).not.toHaveBeenCalled();
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

  // `readProvisionState` (provision.ts ~:1682-1696) reads a
  // `controller.status` REJECTION as "not registered" - the same shape
  // `statusService` (windows.ts) confuses "access denied" and "timeout" with
  // "no such task" as well. Reading a failed probe as unregistered sends
  // `ensureHost` down the service-register branch even for a host that is
  // fully installed and registered - `installHostServiceWithAttempt` ->
  // `controller.install`, which on Windows is `/Create /F` over the EXISTING
  // task: it drops the user's disabled/customised settings for a task that
  // was never actually missing.
  describe("a status probe failure must not be read as 'not registered'", () => {
    function accessDeniedStatusError(): Promise<never> {
      return import("../../service/process-runner").then(
        ({ ProcessRunError }) => {
          throw new ProcessRunError(
            "schtasks /Query /TN ai.traycer.host exited with code 1: ERROR: Access is denied.",
            "schtasks",
            ["/Query", "/TN", "ai.traycer.host"],
            1,
            "",
            "ERROR: Access is denied.\r\n",
          );
        },
      );
    }

    function timeoutStatusError(): Promise<never> {
      return import("../../service/process-runner").then(
        ({ ProcessTimeoutError }) => {
          throw new ProcessTimeoutError(
            "schtasks /Query /TN ai.traycer.host timed out after 15000ms (killed via SIGTERM)",
            "schtasks",
            ["/Query", "/TN", "ai.traycer.host"],
            -1,
            "",
            "",
            15_000,
          );
        },
      );
    }

    function spyLogger(): {
      readonly logger: RuntimeContext["logger"];
      readonly info: Mock;
    } {
      const info = vi.fn();
      return {
        logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
        info,
      };
    }

    it("(i) install record at the requested version + an access-denied status rejection: starts the registered service instead of re-registering it", async () => {
      readHostInstallRecordMock.mockResolvedValue({
        installId: "install-1.5.0",
        version: "1.5.0",
        runtimeVersion: null,
        installedAt: "2026-01-01T00:00:00.000Z",
        archiveSha256: "a".repeat(64),
      });
      const controller = makeController("stopped");
      controller.status = vi.fn(accessDeniedStatusError);
      createServiceControllerMock.mockReturnValue(controller);
      const { logger, info } = spyLogger();

      const result = await ensureHost(
        makeOpts({ runtime: { ...makeRuntime(), logger } }),
      );

      expect(controller.start).toHaveBeenCalledTimes(1);
      expect(controller.install).not.toHaveBeenCalled();
      expect(result.action).toBe("started");
      // `info` also carries unrelated lines this flow logs regardless (e.g.
      // "Host provisioning started" at the top of `provisionHost`), so count
      // THIS message specifically rather than every `info` call.
      const statusUnreadableLines = info.mock.calls.filter(
        (call) =>
          call[0] ===
          "Host provisioning could not read the service status; starting the registered service instead of re-registering it",
      );
      expect(statusUnreadableLines).toHaveLength(1);
    });

    it("(ii) the same, with a timeout-shaped status rejection: starts the registered service instead of re-registering it", async () => {
      readHostInstallRecordMock.mockResolvedValue({
        installId: "install-1.5.0",
        version: "1.5.0",
        runtimeVersion: null,
        installedAt: "2026-01-01T00:00:00.000Z",
        archiveSha256: "a".repeat(64),
      });
      const controller = makeController("stopped");
      controller.status = vi.fn(timeoutStatusError);
      createServiceControllerMock.mockReturnValue(controller);
      const { logger, info } = spyLogger();

      const result = await ensureHost(
        makeOpts({ runtime: { ...makeRuntime(), logger } }),
      );

      expect(controller.start).toHaveBeenCalledTimes(1);
      expect(controller.install).not.toHaveBeenCalled();
      expect(result.action).toBe("started");
      const statusUnreadableLines = info.mock.calls.filter(
        (call) =>
          call[0] ===
          "Host provisioning could not read the service status; starting the registered service instead of re-registering it",
      );
      expect(statusUnreadableLines).toHaveLength(1);
    });

    it("(iii) control: a genuinely missing task (status resolves 'not-installed') DOES register the service - same fixture as the pinned 'registers the service when installed but not registered' row above", async () => {
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
    });

    it("(iv) evidence path: the probe rejects AND the start itself fails - the escalation re-registers on THAT evidence, exactly once, after the failed start", async () => {
      readHostInstallRecordMock.mockResolvedValue({
        installId: "install-1.5.0",
        version: "1.5.0",
        runtimeVersion: null,
        installedAt: "2026-01-01T00:00:00.000Z",
        archiveSha256: "a".repeat(64),
      });
      const controller = makeController("stopped");
      controller.status = vi.fn(accessDeniedStatusError);
      controller.start = vi.fn(async () => {
        throw new Error("start failed: the registered task could not be run");
      });
      createServiceControllerMock.mockReturnValue(controller);

      const result = await ensureHost(makeOpts({}));

      expect(controller.start).toHaveBeenCalledTimes(1);
      expect(controller.install).toHaveBeenCalledTimes(1);
      const startOrder = vi.mocked(controller.start).mock
        .invocationCallOrder[0];
      const installOrder = vi.mocked(controller.install).mock
        .invocationCallOrder[0];
      if (startOrder === undefined || installOrder === undefined) {
        throw new Error("unreachable: both mocks must have been called");
      }
      expect(startOrder).toBeLessThan(installOrder);
      // `runStart`'s escalation retries `start` again only when the REWRITE
      // itself failed with SERVICE_CONTROL_FAILED (Windows' `/Run` launch
      // verification). This fixture's `install` succeeds cleanly - the fake
      // controller's own registration IS the recovery launch, per
      // `runStart`'s comment - so no second `start` call follows it.
      expect(controller.start).toHaveBeenCalledTimes(1);
      expect(result.action).toBe("started");
    });
  });

  describe("a user-disabled Scheduled Task must not be silently re-registered", () => {
    function stoppedControllerWithFailingStart(): ServiceController {
      const controller = makeController("stopped");
      controller.status = vi.fn(async () => ({
        state: "stopped" as const,
        version: null,
        listenUrl: null,
        pid: null,
      }));
      // The exact shape `runTaskAndVerifyStart` (windows.ts) throws when
      // `/Run` fails - the trigger `runStart`'s `catch (firstError)` reads
      // `readServiceRegistrationDisabled` over, mocked separately per row.
      controller.start = vi.fn(async () => {
        throw cliError({
          code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
          message:
            "schtasks /Run failed for ai.traycer.host: schtasks /Run /TN ai.traycer.host exited with code 1: ERROR: The attempted operation is not supported for a task that is disabled.",
          details: {
            task: "ai.traycer.host",
            cause:
              "schtasks /Run /TN ai.traycer.host exited with code 1: ERROR: The attempted operation is not supported for a task that is disabled.",
            registrationCommitted: true,
          },
          exitCode: 1,
        });
      });
      return controller;
    }

    it("(p1) disabled: rejects with E_SERVICE_REGISTRATION_DISABLED and never calls install", async () => {
      readHostInstallRecordMock.mockResolvedValue({
        installId: "install-1.5.0",
        version: "1.5.0",
        runtimeVersion: null,
        installedAt: "2026-01-01T00:00:00.000Z",
        archiveSha256: "a".repeat(64),
      });
      const controller = stoppedControllerWithFailingStart();
      createServiceControllerMock.mockReturnValue(controller);
      readServiceRegistrationDisabledMock.mockResolvedValue({
        kind: "disabled",
      });

      await expect(ensureHost(makeOpts({}))).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_REGISTRATION_DISABLED,
        message:
          "the Traycer Host task is disabled in Task Scheduler; enable it or run `traycer host service install`",
      });
      expect(controller.start).toHaveBeenCalledTimes(1);
      expect(controller.install).not.toHaveBeenCalled();
      expect(readServiceRegistrationDisabledMock).toHaveBeenCalledWith(
        {
          id: "ai.traycer.host",
          displayName: "Traycer Host",
          environment: "production",
          devSlot: null,
        },
        process.platform,
      );
    });

    it("(p2) unknown: the escalation runs as before (install is still called once)", async () => {
      readHostInstallRecordMock.mockResolvedValue({
        installId: "install-1.5.0",
        version: "1.5.0",
        runtimeVersion: null,
        installedAt: "2026-01-01T00:00:00.000Z",
        archiveSha256: "a".repeat(64),
      });
      const controller = stoppedControllerWithFailingStart();
      createServiceControllerMock.mockReturnValue(controller);
      readServiceRegistrationDisabledMock.mockResolvedValue({
        kind: "unknown",
        reason: "schtasks /Query could not run (ETIMEDOUT)",
      });

      const result = await ensureHost(makeOpts({}));

      expect(controller.install).toHaveBeenCalledTimes(1);
      expect(result.action).toBe("started");
    });

    it("(p3) not-disabled: the escalation runs as before (install is still called once)", async () => {
      readHostInstallRecordMock.mockResolvedValue({
        installId: "install-1.5.0",
        version: "1.5.0",
        runtimeVersion: null,
        installedAt: "2026-01-01T00:00:00.000Z",
        archiveSha256: "a".repeat(64),
      });
      const controller = stoppedControllerWithFailingStart();
      createServiceControllerMock.mockReturnValue(controller);
      readServiceRegistrationDisabledMock.mockResolvedValue({
        kind: "not-disabled",
      });

      const result = await ensureHost(makeOpts({}));

      expect(controller.install).toHaveBeenCalledTimes(1);
      expect(result.action).toBe("started");
    });
  });
});

describe("ensureHost over a service registration that is another user's, or kept disabled", () => {
  const installedRecord = {
    installId: "install-1.5.0",
    version: "1.5.0",
    runtimeVersion: null,
    installedAt: "2026-01-01T00:00:00.000Z",
    archiveSha256: "a".repeat(64),
  };

  function notOwnedError() {
    return cliError({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      message: SERVICE_TASK_NOT_OWNED_MESSAGE,
      details: { task: "\\Traycer\\Host", verb: "run", reason: "other-owner" },
      exitCode: 1,
    });
  }

  // `ensure` promises a RUNNING host. A task another user owns is never
  // started for this account, and the rewrite the escalation would try is the
  // `/Create /F` takeover the ownership gate exists to stop: so the refusal is
  // final on the first read - no re-registration, no retry, no second start.
  it("a start refused as another user's task ends the run there: E_SERVICE_TASK_NOT_OWNED, install never called, the disabled switch never read", async () => {
    readHostInstallRecordMock.mockResolvedValue(installedRecord);
    const controller = makeController("stopped");
    controller.start = vi.fn(async () => {
      throw notOwnedError();
    });
    createServiceControllerMock.mockReturnValue(controller);

    await expect(ensureHost(makeOpts({}))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      message: SERVICE_TASK_NOT_OWNED_MESSAGE,
    });
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.install).not.toHaveBeenCalled();
    expect(readServiceRegistrationDisabledMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
  });

  it("a re-registration refused as another user's task surfaces the same code and is not retried", async () => {
    readHostInstallRecordMock.mockResolvedValue(installedRecord);
    const controller = makeController("not-installed");
    controller.install = vi.fn(async () => {
      throw notOwnedError();
    });
    createServiceControllerMock.mockReturnValue(controller);

    await expect(ensureHost(makeOpts({}))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
    });
    expect(controller.install).toHaveBeenCalledTimes(1);
    expect(controller.start).not.toHaveBeenCalled();
  });

  // The escalation's rewrite of a task whose owner disabled it carries the
  // switch over and starts nothing. The read that gated the rewrite could not
  // tell (`unknown`), so the rewrite's own read is what says so: the outcome
  // is the same typed refusal a start over a disabled task always gave.
  it("a rewrite that kept a disabled task disabled fails E_SERVICE_REGISTRATION_DISABLED, without a retried start", async () => {
    readHostInstallRecordMock.mockResolvedValue(installedRecord);
    const controller = makeController("stopped");
    controller.start = vi.fn(async () => {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "schtasks /Run failed",
        details: null,
        exitCode: 1,
      });
    });
    controller.install = vi.fn(async () => {
      reportServiceInstallKeptDisabled();
    });
    createServiceControllerMock.mockReturnValue(controller);
    readServiceRegistrationDisabledMock.mockResolvedValue({
      kind: "unknown",
      reason: "schtasks /Query could not run",
    });

    await expect(ensureHost(makeOpts({}))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_REGISTRATION_DISABLED,
    });
    expect(controller.install).toHaveBeenCalledTimes(1);
    expect(controller.start).toHaveBeenCalledTimes(1);
  });

  it("control: a rewrite that did not keep it disabled recovers as before", async () => {
    readHostInstallRecordMock.mockResolvedValue(installedRecord);
    const controller = makeController("stopped");
    controller.start = vi.fn(async () => {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: "schtasks /Run failed",
        details: null,
        exitCode: 1,
      });
    });
    createServiceControllerMock.mockReturnValue(controller);
    readServiceRegistrationDisabledMock.mockResolvedValue({
      kind: "not-disabled",
    });

    const result = await ensureHost(makeOpts({}));
    expect(result.action).toBe("started");
    expect(controller.install).toHaveBeenCalledTimes(1);
  });

  // The install branch (no host installed): the bytes go in, but ensure
  // promises a running host, and a registration that is refused or kept
  // disabled starts none - so it FAILS with the typed code (`host install`
  // reports the same facts as a warning beside its success).
  for (const [name, warning, code] of [
    [
      "another user's task",
      {
        code: "E_SERVICE_TASK_NOT_OWNED",
        message: SERVICE_TASK_NOT_OWNED_MESSAGE,
        details: { reason: "other-owner" },
      },
      CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
    ],
    [
      "a task kept disabled",
      SERVICE_KEPT_DISABLED_WARNING,
      CLI_ERROR_CODES.SERVICE_REGISTRATION_DISABLED,
    ],
  ] as const) {
    it(`the install branch over ${name}: the bytes are committed and ensure fails ${code}`, async () => {
      readHostInstallRecordMock.mockResolvedValue(null);
      const controller = makeController("not-installed");
      createServiceControllerMock.mockReturnValue(controller);
      createServiceInstallLifecycleMock.mockImplementation(() => ({
        state: {
          priorState: "not-installed",
          stoppedBeforeSwap: false,
          postSwapAction: "install",
          postSwapError: null,
          postSwapWarning: warning,
        },
        lifecycle: {
          beforeSwap: vi.fn(),
          beforeSwapCommit: vi.fn(),
          afterSwap: vi.fn(),
          swapLockRecovery: null,
        },
      }));

      await expect(ensureHost(makeOpts({}))).rejects.toMatchObject({ code });
      expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    });
  }

  // T08 ruling 13: the ensure failure carries the warning's reason, so a
  // reader of the code alone can still tell an unconfirmed owner from another
  // user's task, and its message is the unconfirmed copy verbatim.
  it("the install branch over a task whose owner could not be confirmed: E_SERVICE_TASK_NOT_OWNED with details.reason unconfirmed and the unconfirmed copy", async () => {
    const UNCONFIRMED =
      "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone. Try again, or run `traycer host doctor`.";
    readHostInstallRecordMock.mockResolvedValue(null);
    const controller = makeController("not-installed");
    createServiceControllerMock.mockReturnValue(controller);
    createServiceInstallLifecycleMock.mockImplementation(() => ({
      state: {
        priorState: "not-installed",
        stoppedBeforeSwap: false,
        postSwapAction: "install",
        postSwapError: null,
        postSwapWarning: {
          code: "E_SERVICE_TASK_NOT_OWNED",
          message: UNCONFIRMED,
          details: { reason: "unconfirmed" },
        },
      },
      lifecycle: {
        beforeSwap: vi.fn(),
        beforeSwapCommit: vi.fn(),
        afterSwap: vi.fn(),
        swapLockRecovery: null,
      },
    }));

    await expect(ensureHost(makeOpts({}))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_TASK_NOT_OWNED,
      message: UNCONFIRMED,
      details: { reason: "unconfirmed" },
    });
  });
});
