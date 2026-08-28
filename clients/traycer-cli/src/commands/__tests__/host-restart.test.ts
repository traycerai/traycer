import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAttemptRecordForEnvironment } from "./attempt-record-test-support";

// `host restart`'s command-level wiring (Host Update Layer Redesign Tech
// Plan, "Lifecycle lock coverage" + "host restart --if-idle"): the whole
// marker-reconcile -> stop -> finalize -> start sequence runs inside ONE
// `cli-lock` acquisition, and `--if-idle` gates immediately before it
// with a fresh busy probe. `restartWithPendingCliUpgradeFinalize` itself
// is already covered end-to-end (stub controller, real manifest I/O)
// by host-restart-finalize.test.ts - these tests only need to prove the
// NEW command-level wrapping (lock span, ordering, --if-idle gating),
// so the service controller is stubbed here too.

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  busyOverride: null as "busy" | null,
  busyCalls: [] as Array<string | undefined>,
  lockCalls: [] as Array<{ reason: string }>,
  stopForRestartForceValues: [] as boolean[],
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      install: async () => undefined,
      uninstall: async () => undefined,
      status: async () => ({
        state: "stopped" as const,
        version: null,
        listenUrl: null,
        pid: null,
      }),
      stop: async () => {
        mocks.controllerCalls.push("stop");
      },
      start: async () => {
        mocks.controllerCalls.push("start");
      },
      restart: async () => {
        mocks.controllerCalls.push("restart");
      },
      stopForRestart: async (
        _label: import("../../service").ServiceLabel,
        options: import("../../service").StopServiceOptions,
      ) => {
        mocks.controllerCalls.push("stopForRestart");
        mocks.stopForRestartForceValues.push(options.force);
        return { forcedRecycle: false };
      },
      relaunchAfterRestart: async () => {
        mocks.controllerCalls.push("relaunchAfterRestart");
      },
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    }),
  };
});

// The real `publishHostStartAdoption` waits (up to 30s) for a service-
// manager child to ack a spawn that never happens under a stubbed
// controller. This suite pins `host restart`'s command-level wiring, not
// the adoption handshake (that's `host-start-adoption.test.ts`), so
// replace it with an immediately-satisfied lease.
vi.mock("../../host/host-start-adoption", () => ({
  publishHostStartAdoption: async () => ({
    waitForSpawn: async () => undefined,
    cancel: async () => undefined,
  }),
}));

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async (environment: string | undefined) => {
    mocks.busyCalls.push(environment);
    if (mocks.busyOverride === "busy") {
      throw Object.assign(new Error("host is busy"), { code: "E_HOST_BUSY" });
    }
  },
}));

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      opts: { reason: string },
      fn: () => Promise<T>,
    ): Promise<T> => {
      mocks.lockCalls.push({ reason: opts.reason });
      return fn();
    },
  };
});

import type { CommandContext } from "../../runner/runner";

// `store/paths` binds its home root from `os.homedir()` at module load.
// Keep the environment mutation below, but redirect `homedir()` too.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

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

async function writeInstallRecordForAttestation(): Promise<void> {
  const { writeHostInstallRecord } =
    await import("../../manifest/host-install");
  await writeHostInstallRecord("production", {
    installId: "restart-attestation-install",
    version: "1.7.0",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: "1.7.0" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: join(workHome, "host", "traycer-host"),
    executableSha256: null,
  });
}

describe("buildHostRestartCommand", () => {
  beforeEach(() => {
    workHome = mkdtempSync(join(tmpdir(), "traycer-host-restart-cmd-test-"));
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    // `store/paths` captures `homedir()` once at module load - drop the
    // module cache so each test (and the dynamic import below) sees its
    // own tmp HOME, matching host-restart-finalize.test.ts's pattern.
    vi.resetModules();
    mocks.controllerCalls = [];
    mocks.busyOverride = null;
    mocks.busyCalls = [];
    mocks.lockCalls = [];
    mocks.stopForRestartForceValues = [];
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    if (ORIGINAL_USERPROFILE === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = ORIGINAL_USERPROFILE;
    }
    rmSync(workHome, { recursive: true, force: true });
  });

  it("wraps the whole restart in one cli-lock acquisition, without a busy probe by default", async () => {
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: false,
      deferIfParked: false,
    });
    await command(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "host-restart" }]);
    expect(mocks.busyCalls).toHaveLength(0);
    expect(mocks.controllerCalls).toEqual([
      "stopForRestart",
      "relaunchAfterRestart",
    ]);
  });

  it("plain restart proceeds unconditionally even when the host is busy", async () => {
    mocks.busyOverride = "busy";
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: false,
      deferIfParked: false,
    });
    const result = await command(fakeCtx());

    expect(mocks.busyCalls).toHaveLength(0);
    expect(mocks.controllerCalls).toEqual([
      "stopForRestart",
      "relaunchAfterRestart",
    ]);
    expect(result.data).toMatchObject({ restarted: true });
  });

  it("returns the install record it observed under cli-lock for Desktop's post-restart CAS", async () => {
    await writeInstallRecordForAttestation();
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: false,
      deferIfParked: false,
    });

    const result = await command(fakeCtx());

    expect(result.data).toMatchObject({
      runtimeVersion: null,
      runtimeWasNull: true,
      installGeneration: expect.stringContaining("restart-attestation-install"),
    });
  });

  it("--if-idle probes busy (inside the lock) before stop, and proceeds when idle", async () => {
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: true,
      force: false,
      deferIfParked: false,
    });
    await command(fakeCtx());

    expect(mocks.busyCalls).toEqual(["production"]);
    expect(mocks.controllerCalls).toEqual([
      "stopForRestart",
      "relaunchAfterRestart",
    ]);
  });

  it("--if-idle refuses with E_HOST_BUSY before stop is ever called, and never proceeds", async () => {
    mocks.busyOverride = "busy";
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: true,
      force: false,
      deferIfParked: false,
    });

    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_HOST_BUSY",
    });
    expect(mocks.controllerCalls).toEqual([]);
  });

  it("--if-idle and --force together throw E_INVALID_ARGUMENT before the lock is ever taken", async () => {
    // One flag widens the busy gate, the other removes it - a command
    // carrying both has no coherent intent, so this must be refused before
    // any lock/probe/stop side effect runs, not merely resolved in favour
    // of one flag over the other.
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: true,
      force: true,
      deferIfParked: false,
    });

    await expect(command(fakeCtx())).rejects.toMatchObject({
      code: "E_INVALID_ARGUMENT",
    });
    expect(mocks.lockCalls).toEqual([]);
    expect(mocks.busyCalls).toEqual([]);
    expect(mocks.controllerCalls).toEqual([]);
  });

  it("threads --force through to stopForRestart", async () => {
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: true,
      deferIfParked: false,
    });
    await command(fakeCtx());

    expect(mocks.stopForRestartForceValues).toEqual([true]);
    expect(mocks.controllerCalls).toEqual([
      "stopForRestart",
      "relaunchAfterRestart",
    ]);
  });

  it("without --force, stopForRestart still sees force: false", async () => {
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: false,
      deferIfParked: false,
    });
    await command(fakeCtx());

    expect(mocks.stopForRestartForceValues).toEqual([false]);
  });

  // `--defer-if-parked` (Desktop's force-restart path, round-2 revalidation
  // redesign): the classification and the action it authorizes happen under
  // ONE contender-lock acquisition, so these tests drive it via a REAL
  // attempt record on disk (read by the real, unmocked shared contender
  // layer) rather than a stubbed `recoveryAction` - a stub would only prove
  // the wiring reads a field, not that the field is derived from the record
  // this flag exists to protect.
  describe("--defer-if-parked", () => {
    it("a stop-only record + --defer-if-parked refuses WITHOUT ever stopping the service", async () => {
      await writeAttemptRecordForEnvironment("production", {
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: false,
        force: false,
        deferIfParked: true,
      });
      const result = await command(fakeCtx());

      // The load-bearing negative: the service was never touched.
      expect(mocks.controllerCalls).toEqual([]);
      // Paired positive, so this test cannot pass merely because the
      // command failed early and never reached the branch under test.
      expect(result.data).toMatchObject({
        restarted: false,
        deferredForParkedActivation: true,
      });
    });

    it("the same stop-only record WITHOUT --defer-if-parked keeps the old behavior: stops the service, restarted:false", async () => {
      await writeAttemptRecordForEnvironment("production", {
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: false,
        force: false,
        deferIfParked: false,
      });
      const result = await command(fakeCtx());

      expect(mocks.controllerCalls).toEqual(["stop"]);
      expect(result.data).toMatchObject({
        restarted: false,
        deferredForParkedActivation: false,
      });
    });

    it("a restart-current record (restarting/activate) still restarts even with --defer-if-parked set", async () => {
      await writeAttemptRecordForEnvironment("production", {
        phase: "restarting",
        execution: "active",
        continuation: "activate",
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: false,
        force: false,
        deferIfParked: true,
      });
      const result = await command(fakeCtx());

      // The actual restart happened - not merely "did not defer".
      expect(mocks.controllerCalls).toEqual([
        "stopForRestart",
        "relaunchAfterRestart",
      ]);
      expect(result.data).toMatchObject({
        restarted: true,
        deferredForParkedActivation: false,
      });
    });

    it("a restart-current record (verifying/activate) also still restarts with --defer-if-parked set", async () => {
      await writeAttemptRecordForEnvironment("production", {
        phase: "verifying",
        execution: "active",
        continuation: "activate",
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: false,
        force: false,
        deferIfParked: true,
      });
      const result = await command(fakeCtx());

      expect(mocks.controllerCalls).toEqual([
        "stopForRestart",
        "relaunchAfterRestart",
      ]);
      expect(result.data).toMatchObject({
        restarted: true,
        deferredForParkedActivation: false,
      });
    });
  });

  // Codex P2 (round 5): `reconcilePostFinalizeMarker` used to drop the
  // marker's `serviceStartError` on the floor while consuming the marker
  // - the one durable record of why the host was left stopped rather
  // than merely un-upgraded. `describeMarkerReconcile` is where that
  // value (if any) is supposed to surface in `host restart`'s human
  // output, so these two tests pin the human-output half of the fix
  // (the reconcile-outcome half is covered by
  // `upgrade/__tests__/finalize-helper.test.ts`).
  function writePriorSwapFailedMarker(opts: {
    readonly serviceStartError: string | null;
  }): { readonly liveBinaryPath: string; readonly stagedBinaryPath: string } {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    const cliDir = join(workHome, ".traycer", "cli");
    mkdirSync(cliDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(cliDir, "manifest.json"),
      JSON.stringify(
        {
          version: "1.4.0",
          installedAt: "2026-04-01T00:00:00Z",
          binaryPath: liveBinaryPath,
          source: "manual",
          pendingUpgrade: {
            version: "1.5.0",
            stagedBinaryPath,
            stagedAt: "2026-05-10T00:00:00Z",
            reason: "binary-locked",
          },
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(
      join(cliDir, "post-finalize.json"),
      JSON.stringify({
        status: "swap-failed",
        attemptedAt: "2026-05-11T00:00:00Z",
        livePath: liveBinaryPath,
        stagedBinaryPath,
        errorMessage: "MoveFileEx error 5: Access denied",
        serviceStartError: opts.serviceStartError,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    return { liveBinaryPath, stagedBinaryPath };
  }

  it("surfaces a prior helper's service-start failure in the human output when reconciling a swap-failed marker that carries one", async () => {
    writePriorSwapFailedMarker({
      serviceStartError: "schtasks /Run failed: service already stopped",
    });

    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: false,
      deferIfParked: false,
    });
    const result = await command(fakeCtx());

    expect(result.human).toContain(
      "could not restart the service (schtasks /Run failed: service already stopped)",
    );
  });

  it("does not mention a service-start failure when reconciling a swap-failed marker whose serviceStartError is null", async () => {
    writePriorSwapFailedMarker({ serviceStartError: null });

    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: false,
      deferIfParked: false,
    });
    const result = await command(fakeCtx());

    expect(result.human).toContain("prior helper swap failed");
    expect(result.human).not.toContain("could not restart the service");
  });
});
