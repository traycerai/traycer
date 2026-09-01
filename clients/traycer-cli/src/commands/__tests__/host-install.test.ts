import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  resolveHostAuthMock: vi.fn(),
  runDeviceAuthFlowMock: vi.fn(),
  provisionInstalledHostCredentialMock: vi.fn(),
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

// The contender-aware command facade imports the commit edge from the
// concrete installer module, not through the package barrel above. Mock the
// same boundary there so this command-wiring suite cannot mutate the
// operator's real host install while still providing a genuine staged file
// for the pre-commit attestation path.
vi.mock("../../installer/install", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../installer/install")>();
  return {
    ...actual,
    commitHostInstallSource: async (
      ...callArgs: Parameters<typeof mocks.commitHostInstallSourceMock>
    ) => {
      mocks.callOrder.push("commit");
      return mocks.commitHostInstallSourceMock(...callArgs);
    },
  };
});

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

// The real `resolveHostAuth` reads `~/.traycer/cli/credentials` (via
// `createCliLogger` + `readCredentials`) - genuine filesystem I/O against
// the operator's actual home, same hazard as the `createServiceController`
// mock above. Must be mocked even for tests that never care about auth.
vi.mock("../../internal/host-auth", () => ({
  resolveHostAuth: async (
    ...callArgs: Parameters<typeof mocks.resolveHostAuthMock>
  ) => {
    mocks.callOrder.push("auth-resolve");
    return mocks.resolveHostAuthMock(...callArgs);
  },
}));

vi.mock("../../auth/login-flow", () => ({
  runDeviceAuthFlow: async (
    ...callArgs: Parameters<typeof mocks.runDeviceAuthFlowMock>
  ) => {
    mocks.callOrder.push("device-login");
    return mocks.runDeviceAuthFlowMock(...callArgs);
  },
}));

// The real module dials a WebSocket (`provisionInstalledHostCredential`
// opens a `/stream` session against the just-installed host) - mandatory to
// mock for the whole suite, not just the tests that assert on it.
vi.mock("../../host/credential-provisioning", () => ({
  provisionInstalledHostCredential: async (
    ...callArgs: Parameters<typeof mocks.provisionInstalledHostCredentialMock>
  ) => {
    mocks.callOrder.push("credential-provision");
    return mocks.provisionInstalledHostCredentialMock(...callArgs);
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
    executableSha256: null,
  };
}

const stagedFixtureRoots: string[] = [];

function sampleStaged(): StagedHostInstallSource {
  const fixtureRoot = mkdtempSync(
    join(tmpdir(), "traycer-host-install-stage-"),
  );
  stagedFixtureRoots.push(fixtureRoot);
  const stagingDir = join(fixtureRoot, "staging");
  const archivePath = join(fixtureRoot, "archive.tar.gz");
  const executablePath = join(stagingDir, "traycer-host");
  const executableBytes = "fixture host executable";
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(archivePath, "fixture verified archive");
  writeFileSync(executablePath, executableBytes);
  return {
    stagingDir,
    archivePath,
    archiveIsTemporary: true,
    executablePath,
    version: "2.0.0",
    runtimeVersion: null,
    source: { kind: "registry", value: "2.0.0" },
    archiveSha256: "b".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: Buffer.byteLength(executableBytes),
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
      swapLockRecovery: null,
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
    force: false,
    attemptAdoption: null,
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

// Sign-in pre-flight tests need to vary `nonInteractive`/`json` without
// touching every other test's plain `fakeCtx()` call site.
function fakeCtxWithRuntime(overrides: {
  nonInteractive: boolean;
  json: boolean;
}): CommandContext {
  const ctx = fakeCtx();
  return {
    ...ctx,
    runtime: {
      ...ctx.runtime,
      nonInteractive: overrides.nonInteractive,
      json: overrides.json,
    },
  };
}

// The sign-in pre-flight's prompt gate reads `process.stdout.isTTY` directly
// (not through `ctx`). Under vitest it is normally an absent property (no
// own descriptor), not `false` - captured once at module load, before any
// test touches it, so `afterEach` can restore the exact original shape.
const originalStdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY",
);

function setStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
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
    // Pin the prompt gate rather than depending on vitest leaving `isTTY`
    // absent: a TTY-attached local run would otherwise send the signed-out
    // tests down the prompt path and fail only on some machines. Tests that
    // want the prompt call `setStdoutIsTTY(true)` themselves.
    setStdoutIsTTY(false);
    // Every existing test predates the sign-in pre-flight and expects to run
    // as signed-in with zero prompt/warning noise - default to that so only
    // the tests that care about auth need to override it.
    mocks.resolveHostAuthMock.mockResolvedValue({
      token: "test-token",
      authnBaseUrl: "https://authn.test",
      userId: "user-1",
    });
    // Every signed-in, non-JSON, service-started install now also runs
    // post-install credential provisioning. Default to an outcome that adds
    // NO human suffix ({ kind: "active", minted: false }) so existing
    // human/data assertions on other fields stay green; only the tests below
    // that care about provisioning override this.
    mocks.provisionInstalledHostCredentialMock.mockResolvedValue({
      kind: "active",
      minted: false,
    });
  });

  afterEach(() => {
    // resetAllMocks (not clearAllMocks) so a mockResolvedValue/
    // mockRejectedValue configured in one test can't leak into the next -
    // matches host-update.test.ts's convention.
    vi.resetAllMocks();
    mocks.callOrder = [];
    for (const fixtureRoot of stagedFixtureRoots.splice(0)) {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
    // Unconditional: a test that never touched `isTTY` restores a no-op
    // descriptor identical to the original, so this can't leak either way.
    if (originalStdoutIsTTYDescriptor === undefined) {
      Reflect.deleteProperty(process.stdout, "isTTY");
    } else {
      Object.defineProperty(
        process.stdout,
        "isTTY",
        originalStdoutIsTTYDescriptor,
      );
    }
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
      "auth-resolve",
      "stage",
      "lock-enter",
      "commit",
      "lock-exit",
      // Post-install credential provisioning: signed in, service started,
      // not JSON - re-reads auth, then provisions.
      "auth-resolve",
      "credential-provision",
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
      swapLockRecovery: null,
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

  it("rejects --force combined with --if-idle before staging anything (mutually exclusive: one refuses on busy work, the other kills it)", async () => {
    await expect(
      buildHostInstallCommand(baseArgs({ force: true, ifIdle: true }))(
        fakeCtx(),
      ),
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

    // No `attemptAdoption` here, deliberately: `host install` mints its own
    // adoption for the children it spawns rather than forwarding one into the
    // service-install lifecycle. Production is right; the field was carried in
    // this assertion from an earlier shape of the call.
    expect(mocks.createServiceInstallLifecycleMock).toHaveBeenCalledWith({
      environment: "production",
      bootstrap: { enableLinger: false, allowSelfInvocation: true },
      force: false,
    });
  });

  it("forwards --force into the service install lifecycle so the pre-swap stop can skip the cooperative claim", async () => {
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const command = buildHostInstallCommand(baseArgs({ force: true }));
    await command(fakeCtx());

    expect(mocks.createServiceInstallLifecycleMock).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
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
      "auth-resolve",
      "stage",
      "lock-enter",
      "busy-probe",
      "commit",
      "lock-exit",
      // Post-install credential provisioning runs after the lock is
      // released.
      "auth-resolve",
      "credential-provision",
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
    // The third argument is the verify callback, whose signature has now
    // settled: the discard runs under the same execution segment as the commit
    // it is scrubbing after, so it re-verifies the capability at the actuator
    // rather than trusting the one captured at segment entry.
    expect(mocks.discardStagedHostInstallSourceMock).toHaveBeenCalledWith(
      "production",
      staged,
      expect.any(Function),
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

    // The third argument is the verify callback, whose signature has now
    // settled: the discard runs under the same execution segment as the commit
    // it is scrubbing after, so it re-verifies the capability at the actuator
    // rather than trusting the one captured at segment entry.
    expect(mocks.discardStagedHostInstallSourceMock).toHaveBeenCalledWith(
      "production",
      staged,
      expect.any(Function),
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

  it("signed in: skips the device-auth flow entirely and reports state=signed-in", async () => {
    // `resolveHostAuthMock` already resolves non-null via `beforeEach`'s
    // default - this test just asserts the consequences of that default.
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const ctx = fakeCtx();
    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(ctx);

    expect(mocks.runDeviceAuthFlowMock).not.toHaveBeenCalled();
    expect(ctx.output.humanRequired).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      authPreflight: { state: "signed-in", reason: null },
    });
  });

  it("signed out + interactive: runs the device-auth flow before staging and reports state=signed-in-inline", async () => {
    mocks.resolveHostAuthMock.mockResolvedValue(null);
    mocks.runDeviceAuthFlowMock.mockResolvedValue({
      token: "t",
      user: { id: "u1", email: "u@x.dev", name: "U" },
      authnBaseUrl: "https://authn.test",
    });
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });
    setStdoutIsTTY(true);

    const ctx = fakeCtx();
    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(ctx);

    // The device flow runs, and completes, BEFORE staging ever starts.
    // `resolveHostAuthMock` stays pinned to `null` for the whole test (it is
    // never re-armed after the inline sign-in), so the credential-
    // provisioning re-read also comes back null and skips the mint - only
    // the extra `auth-resolve` shows up, never `credential-provision`.
    expect(mocks.callOrder).toEqual([
      "auth-resolve",
      "device-login",
      "stage",
      "lock-enter",
      "commit",
      "lock-exit",
      "auth-resolve",
    ]);
    expect(result.data).toMatchObject({
      authPreflight: { state: "signed-in-inline", reason: null },
    });
    expect(ctx.output.humanRequired).toHaveBeenCalledWith(
      expect.stringContaining("Signed in as u@x.dev"),
    );
  });

  it("signed out + interactive: the inline sign-in's OWN credentials provision the started host", async () => {
    // The end-to-end shape of the whole feature, and the one combination the
    // test above cannot show: the real device flow persists credentials, so
    // the post-install re-read succeeds and provisioning runs on the token
    // the inline sign-in just wrote - not on the pre-flight's (absent) one.
    mocks.resolveHostAuthMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        token: "inline-token",
        authnBaseUrl: "https://authn.test",
        userId: "user-1",
      });
    mocks.runDeviceAuthFlowMock.mockResolvedValue({
      token: "inline-token",
      user: { id: "u1", email: "u@x.dev", name: "U" },
      authnBaseUrl: "https://authn.test",
    });
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });
    mocks.provisionInstalledHostCredentialMock.mockResolvedValue({
      kind: "active",
      minted: true,
    });
    setStdoutIsTTY(true);

    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(mocks.callOrder).toEqual([
      "auth-resolve",
      "device-login",
      "stage",
      "lock-enter",
      "commit",
      "lock-exit",
      "auth-resolve",
      "credential-provision",
    ]);
    expect(mocks.provisionInstalledHostCredentialMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ token: "inline-token" }),
      }),
    );
    expect(result.data).toMatchObject({
      authPreflight: { state: "signed-in-inline", reason: null },
      credentialProvision: { kind: "active", minted: true },
    });
    expect(result.human ?? "").toMatch(/host credential provisioned$/);
  });

  it("signed out + interactive, device flow declined: install still commits, reports sign-in-incomplete", async () => {
    mocks.resolveHostAuthMock.mockResolvedValue(null);
    mocks.runDeviceAuthFlowMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: "Sign-in was denied. Re-run `traycer login` to try again.",
        details: null,
        exitCode: 1,
      }),
    );
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });
    setStdoutIsTTY(true);

    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(fakeCtx());

    expect(mocks.commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      authPreflight: { state: "unauthenticated", reason: "sign-in-incomplete" },
    });
    expect(result.human).toContain("not signed in - the host is unprovisioned");
  });

  it("signed out + interactive, device flow fails: reports the same sign-in-incomplete reason, with the detail in the warning", async () => {
    mocks.resolveHostAuthMock.mockResolvedValue(null);
    mocks.runDeviceAuthFlowMock.mockRejectedValue(
      cliError({
        code: CLI_ERROR_CODES.AUTH_NETWORK,
        message:
          "Could not reach the authn service to start sign-in; check your network.",
        details: null,
        exitCode: 2,
      }),
    );
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });
    setStdoutIsTTY(true);

    const ctx = fakeCtx();
    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(ctx);

    expect(mocks.commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    // A network failure and a denial are NOT distinguished by `reason` - the
    // device flow raises `AUTH_REJECTED` for denial, expiry, invalid request
    // and token rejection alike, so any split there would be false precision.
    // The flow's own message is what carries the difference.
    expect(result.data).toMatchObject({
      authPreflight: { state: "unauthenticated", reason: "sign-in-incomplete" },
    });
    expect(ctx.output.humanRequired).toHaveBeenCalledWith(
      expect.stringContaining(
        "Could not reach the authn service to start sign-in",
      ),
    );
  });

  it("signed out + nonInteractive: never prompts (isTTY alone would allow it), reports noninteractive-cannot-prompt", async () => {
    mocks.resolveHostAuthMock.mockResolvedValue(null);
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });
    // isTTY true proves the gate is `nonInteractive`, not the TTY check.
    setStdoutIsTTY(true);

    const ctx = fakeCtxWithRuntime({ nonInteractive: true, json: false });
    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(ctx);

    expect(mocks.runDeviceAuthFlowMock).not.toHaveBeenCalled();
    expect(mocks.commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      authPreflight: {
        state: "unauthenticated",
        reason: "noninteractive-cannot-prompt",
      },
    });
    expect(ctx.output.humanRequired).toHaveBeenCalledWith(
      expect.stringContaining("not signed in"),
    );
  });

  it("signed out + json mode: never prompts, reports noninteractive-cannot-prompt", async () => {
    mocks.resolveHostAuthMock.mockResolvedValue(null);
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });
    // isTTY true proves the gate is `json`, not the TTY check.
    setStdoutIsTTY(true);

    const ctx = fakeCtxWithRuntime({ nonInteractive: false, json: true });
    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(ctx);

    expect(mocks.runDeviceAuthFlowMock).not.toHaveBeenCalled();
    expect(mocks.commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      authPreflight: {
        state: "unauthenticated",
        reason: "noninteractive-cannot-prompt",
      },
    });
    expect(ctx.output.humanRequired).toHaveBeenCalledWith(
      expect.stringContaining("not signed in"),
    );
  });

  it("signed out + stdout not a TTY: never prompts, reports noninteractive-cannot-prompt", async () => {
    mocks.resolveHostAuthMock.mockResolvedValue(null);
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });
    setStdoutIsTTY(false);

    const ctx = fakeCtx();
    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(ctx);

    expect(mocks.runDeviceAuthFlowMock).not.toHaveBeenCalled();
    expect(mocks.commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      authPreflight: {
        state: "unauthenticated",
        reason: "noninteractive-cannot-prompt",
      },
    });
    expect(ctx.output.humanRequired).toHaveBeenCalledWith(
      expect.stringContaining("not signed in"),
    );
  });

  it("credentials file unreadable at pre-flight: does not fail the install, continues unauthenticated", async () => {
    // `resolveHostAuth` only maps ENOENT to `null`; every other fs error
    // (EACCES on a foreign-owned credentials file, EISDIR, ...) rethrows.
    // `host install` never read credentials before the pre-flight existed, so
    // letting that escape would turn an unreadable file into a command that
    // refuses to install at all.
    const eacces = new Error(
      "EACCES: permission denied, open '/home/other/.traycer/cli/credentials'",
    );
    mocks.resolveHostAuthMock.mockRejectedValue(eacces);
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });
    setStdoutIsTTY(false);

    const ctx = fakeCtx();
    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(ctx);

    expect(mocks.commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({
      authPreflight: {
        state: "unauthenticated",
        reason: "noninteractive-cannot-prompt",
      },
    });
    expect(ctx.runtime.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read the stored credentials"),
      expect.objectContaining({ stage: "preflight" }),
    );
  });

  it("credentials file unreadable at the provisioning re-read: install still succeeds, but the loss surfaces as unauthorized", async () => {
    // The nastier half of the same hazard: this read happens AFTER the bytes
    // are swapped and the service started, so a throw here would report an
    // install that genuinely succeeded as a failure. The lost credentials are
    // no longer silently swallowed either - the pre-flight said signed-in, so
    // `maybeProvisionCredential` reports `unauthorized` rather than skipping
    // provisioning outright, and the human line names the remedy.
    mocks.resolveHostAuthMock
      .mockResolvedValueOnce({
        token: "test-token",
        authnBaseUrl: "https://authn.test",
        userId: "user-1",
      })
      .mockRejectedValueOnce(new Error("EIO: i/o error, read"));
    mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
    mocks.createServiceInstallLifecycleMock.mockReturnValue(
      sampleLifecycleHandle(),
    );
    mocks.commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const ctx = fakeCtx();
    const command = buildHostInstallCommand(baseArgs({}));
    const result = await command(ctx);

    expect(mocks.commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(mocks.provisionInstalledHostCredentialMock).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      authPreflight: { state: "signed-in", reason: null },
      credentialProvision: { kind: "unauthorized" },
    });
    expect(result.human ?? "").toContain("your sign-in is no longer valid");
    expect(result.exitCode).toBe(0);
    expect(ctx.runtime.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read the stored credentials"),
      expect.objectContaining({ stage: "provision" }),
    );
  });

  it("--no-service-register: skips the sign-in pre-flight entirely, reports state=not-checked", async () => {
    const bytesOnlyLifecycle = {
      beforeSwap: vi.fn(async () => {}),
      afterSwap: vi.fn(async () => {}),
      swapLockRecovery: null,
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

    expect(mocks.resolveHostAuthMock).not.toHaveBeenCalled();
    expect(mocks.runDeviceAuthFlowMock).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      authPreflight: { state: "not-checked", reason: "bytes-only" },
    });
  });

  describe("post-install credential provisioning", () => {
    it("signed-in install: provisions once, deadline-bounded, with the re-read auth, after the lock exits", async () => {
      mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
      mocks.createServiceInstallLifecycleMock.mockReturnValue(
        sampleLifecycleHandle(),
      );
      mocks.commitHostInstallSourceMock.mockResolvedValue({
        record: sampleRecord("2.0.0"),
        previous: null,
        installGeneration: "id:install-2.0.0",
      });
      mocks.provisionInstalledHostCredentialMock.mockResolvedValue({
        kind: "active",
        minted: false,
      });

      const command = buildHostInstallCommand(baseArgs({}));
      const result = await command(fakeCtx());

      expect(mocks.provisionInstalledHostCredentialMock).toHaveBeenCalledTimes(
        1,
      );
      expect(mocks.provisionInstalledHostCredentialMock).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: "production",
          deadlineMs: 30_000,
          auth: {
            token: "test-token",
            authnBaseUrl: "https://authn.test",
            userId: "user-1",
          },
        }),
      );
      expect(result.data).toMatchObject({
        credentialProvision: { kind: "active", minted: false },
      });
      expect(mocks.callOrder).toEqual([
        "auth-resolve",
        "stage",
        "lock-enter",
        "commit",
        "lock-exit",
        "auth-resolve",
        "credential-provision",
      ]);
    });

    it("{ kind: active, minted: true }: human ends with 'host credential provisioned'", async () => {
      mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
      mocks.createServiceInstallLifecycleMock.mockReturnValue(
        sampleLifecycleHandle(),
      );
      mocks.commitHostInstallSourceMock.mockResolvedValue({
        record: sampleRecord("2.0.0"),
        previous: null,
        installGeneration: "id:install-2.0.0",
      });
      mocks.provisionInstalledHostCredentialMock.mockResolvedValue({
        kind: "active",
        minted: true,
      });

      const command = buildHostInstallCommand(baseArgs({}));
      const result = await command(fakeCtx());

      expect(result.human ?? "").toMatch(/host credential provisioned$/);
      expect(result.exitCode).toBe(0);
    });

    it("{ kind: not-adopted }: human names the self-heal, exit code stays 0", async () => {
      mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
      mocks.createServiceInstallLifecycleMock.mockReturnValue(
        sampleLifecycleHandle(),
      );
      mocks.commitHostInstallSourceMock.mockResolvedValue({
        record: sampleRecord("2.0.0"),
        previous: null,
        installGeneration: "id:install-2.0.0",
      });
      mocks.provisionInstalledHostCredentialMock.mockResolvedValue({
        kind: "not-adopted",
      });

      const command = buildHostInstallCommand(baseArgs({}));
      const result = await command(fakeCtx());

      expect(result.data).toMatchObject({
        credentialProvision: { kind: "not-adopted" },
      });
      expect(result.human).toContain(
        "host credential not provisioned (the host did not adopt it in time)",
      );
      expect(result.exitCode).toBe(0);
    });

    it("json mode: STILL provisions - automation is the caller that most needs it", async () => {
      // `--json` is the documented automation mode, not a signal that some
      // GUI will connect and mint later. A headless provisioning script is
      // precisely the run with no other minting client coming, so gating on
      // output format denied the credential to the cohort that needed it.
      mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
      mocks.createServiceInstallLifecycleMock.mockReturnValue(
        sampleLifecycleHandle(),
      );
      mocks.commitHostInstallSourceMock.mockResolvedValue({
        record: sampleRecord("2.0.0"),
        previous: null,
        installGeneration: "id:install-2.0.0",
      });
      mocks.provisionInstalledHostCredentialMock.mockResolvedValue({
        kind: "active",
        minted: true,
      });

      const ctx = fakeCtxWithRuntime({ nonInteractive: false, json: true });
      const command = buildHostInstallCommand(baseArgs({}));
      const result = await command(ctx);

      expect(mocks.provisionInstalledHostCredentialMock).toHaveBeenCalledTimes(
        1,
      );
      expect(result.data).toMatchObject({
        credentialProvision: { kind: "active", minted: true },
      });
    });

    it("unauthenticated preflight (non-interactive, cannot prompt): never provisions a credential", async () => {
      mocks.resolveHostAuthMock.mockResolvedValue(null);
      mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
      mocks.createServiceInstallLifecycleMock.mockReturnValue(
        sampleLifecycleHandle(),
      );
      mocks.commitHostInstallSourceMock.mockResolvedValue({
        record: sampleRecord("2.0.0"),
        previous: null,
        installGeneration: "id:install-2.0.0",
      });

      const ctx = fakeCtxWithRuntime({ nonInteractive: true, json: false });
      const command = buildHostInstallCommand(baseArgs({}));
      const result = await command(ctx);

      expect(mocks.provisionInstalledHostCredentialMock).not.toHaveBeenCalled();
      expect(result.data).toMatchObject({ credentialProvision: null });
    });

    it("--no-service-register: never provisions a credential", async () => {
      const bytesOnlyLifecycle = {
        beforeSwap: vi.fn(async () => {}),
        afterSwap: vi.fn(async () => {}),
        swapLockRecovery: null,
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

      expect(mocks.provisionInstalledHostCredentialMock).not.toHaveBeenCalled();
      expect(result.data).toMatchObject({ credentialProvision: null });
    });

    it("post-swap error: never provisions a credential (nothing came up to dial)", async () => {
      mocks.stageHostInstallSourceMock.mockResolvedValue(sampleStaged());
      mocks.createServiceInstallLifecycleMock.mockReturnValue({
        state: {
          priorState: "running",
          stoppedBeforeSwap: true,
          postSwapAction: "start",
          postSwapError: "failed to start the host process",
        },
        lifecycle: {
          beforeSwap: async () => {},
          afterSwap: async () => {},
          swapLockRecovery: null,
        },
      });
      mocks.commitHostInstallSourceMock.mockResolvedValue({
        record: sampleRecord("2.0.0"),
        previous: null,
        installGeneration: "id:install-2.0.0",
      });

      const command = buildHostInstallCommand(baseArgs({}));
      const result = await command(fakeCtx());

      expect(mocks.provisionInstalledHostCredentialMock).not.toHaveBeenCalled();
      expect(result.data).toMatchObject({ credentialProvision: null });
    });

    it("resolveHostAuth going null between the preflight and the re-read: surfaces as unauthorized, not skipped", async () => {
      mocks.resolveHostAuthMock.mockResolvedValueOnce({
        token: "test-token",
        authnBaseUrl: "https://authn.test",
        userId: "user-1",
      });
      mocks.resolveHostAuthMock.mockResolvedValueOnce(null);
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
      const result = await command(fakeCtx());

      expect(mocks.resolveHostAuthMock).toHaveBeenCalledTimes(2);
      expect(mocks.provisionInstalledHostCredentialMock).not.toHaveBeenCalled();
      expect(result.data).toMatchObject({
        authPreflight: { state: "signed-in", reason: null },
        credentialProvision: { kind: "unauthorized" },
      });
      expect(result.human ?? "").toContain("your sign-in is no longer valid");
      expect(result.exitCode).toBe(0);
    });
  });
});
