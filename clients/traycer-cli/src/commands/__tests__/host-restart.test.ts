import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAttemptRecordForEnvironment } from "./attempt-record-test-support";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import type { HostInstallRecord } from "../../manifest/host-install";

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
  // Runs at the marker-reconciliation step - after the admission checks and
  // before the stop - so a test can publish a host in that window.
  afterAdmission: null as (() => Promise<void>) | null,
  // Runs once the stub's stop has completed, before the relaunch.
  afterStop: null as (() => Promise<void>) | null,
  // When set, the stub's relaunch issues a launch through the same edges a
  // platform controller does (spawn edge, authority check, the stop-target's
  // launch wrapper) and runs this inside the launching call.
  launchCall: null as (() => Promise<void>) | null,
  launches: 0,
  // Replaces the stub with a real platform controller over a recording runner.
  realController: null as import("../../service").ServiceController | null,
  // Answers a publication of the host-start adoption proof with the spawn
  // acknowledgement wait of that publication (counting from 1).
  spawnWaitFor: null as
    | ((publication: number) => Promise<() => Promise<void>>)
    | null,
  busyOverride: null as "busy" | null,
  busyCalls: [] as Array<string | undefined>,
  lockCalls: [] as Array<{ reason: string }>,
  stopForRestartForceValues: [] as boolean[],
  // When set, the stub's relaunch crosses the REAL service spawn edge, which
  // is what publishes the adoption proof - so the proof's origin becomes
  // observable in `publishedOrigins`. Off by default: every other case pins
  // command-level wiring and never publishes.
  crossSpawnEdge: false,
  publishedOrigins: [] as string[],
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () =>
      mocks.realController ?? {
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
          if (mocks.afterStop !== null) await mocks.afterStop();
          return { forcedRecycle: false };
        },
        relaunchAfterRestart: async () => {
          mocks.controllerCalls.push("relaunchAfterRestart");
          if (mocks.crossSpawnEdge) {
            const { atServiceSpawnEdge } =
              await import("../../service/spawn-edge");
            await atServiceSpawnEdge();
          }
          const launchCall = mocks.launchCall;
          if (launchCall !== null) {
            const { atServiceSpawnEdge } =
              await import("../../service/spawn-edge");
            const { verifyServiceMutationAuthority } =
              await import("../../service/mutation-authority");
            const { runAtStopTargetEdge } =
              await import("../../service/stop-target");
            await atServiceSpawnEdge();
            await verifyServiceMutationAuthority();
            await runAtStopTargetEdge(async () => {
              mocks.launches += 1;
              await launchCall();
            });
            // A later service call of the same command, against the host the
            // launch brought up.
            await verifyServiceMutationAuthority();
          }
        },
        hostStartAdoptionLabel: async (label: { id: string }) => label.id,
      },
  };
});

// The real `publishHostStartAdoption` waits (up to 30s) for a service-
// manager child to ack a spawn that never happens under a stubbed
// controller. This suite pins `host restart`'s command-level wiring, not
// the adoption handshake (that's `host-start-adoption.test.ts`), so
// replace it with an immediately-satisfied lease.
vi.mock("../../host/host-start-adoption", () => ({
  publishHostStartAdoption: async (
    _capability: unknown,
    _contenderOptions: unknown,
    _serviceLabel: string,
    origin: string,
  ) => {
    mocks.publishedOrigins.push(origin);
    return {
      waitForSpawn:
        mocks.spawnWaitFor === null
          ? async () => undefined
          : await mocks.spawnWaitFor(mocks.publishedOrigins.length),
      cancel: async () => undefined,
    };
  },
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

vi.mock("../../upgrade/finalize-helper", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../upgrade/finalize-helper")>();
  return {
    ...actual,
    reconcilePostFinalizeMarker: async (
      ...callArgs: Parameters<typeof actual.reconcilePostFinalizeMarker>
    ) => {
      if (mocks.afterAdmission !== null) await mocks.afterAdmission();
      return actual.reconcilePostFinalizeMarker(...callArgs);
    },
  };
});

import type { CommandContext, CommandFn } from "../../runner/runner";

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

// Returns the record it wrote so callers can compute the SAME
// `installGeneration` a matching park's claim would carry
// (`encodeInstallGeneration(record)`) - never a hand-rebuilt literal, for the
// exact reason `install-generation.ts` warns about: a per-site copy of the
// four fields is how the claim baseline and this fixture would drift apart
// silently.
async function writeInstallRecordForAttestation(): Promise<HostInstallRecord> {
  const { writeHostInstallRecord } =
    await import("../../manifest/host-install");
  const record: HostInstallRecord = {
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
  };
  await writeHostInstallRecord("production", record);
  return record;
}

describe("buildHostRestartCommand", () => {
  beforeEach(async () => {
    workHome = mkdtempSync(join(tmpdir(), "traycer-host-restart-cmd-test-"));
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    // `store/paths` captures `homedir()` once at module load - drop the
    // module cache so each test (and the dynamic import below) sees its
    // own tmp HOME, matching host-restart-finalize.test.ts's pattern.
    vi.resetModules();
    // HOME-safety guard: prove the redirect actually took before any test
    // can touch a real path under it.
    const { hostHomeDir } = await import("../../store/paths");
    expect(hostHomeDir("production").startsWith(workHome)).toBe(true);
    mocks.controllerCalls = [];
    mocks.afterAdmission = null;
    mocks.afterStop = null;
    mocks.busyOverride = null;
    mocks.busyCalls = [];
    mocks.lockCalls = [];
    mocks.stopForRestartForceValues = [];
    mocks.crossSpawnEdge = false;
    mocks.publishedOrigins = [];
    mocks.launchCall = null;
    mocks.launches = 0;
    mocks.realController = null;
    mocks.spawnWaitFor = null;
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
      expectedHost: null,
      lifecycleOrigin: "terminal",
    });
    await command(fakeCtx());

    expect(mocks.lockCalls).toEqual([{ reason: "host-restart" }]);
    expect(mocks.busyCalls).toHaveLength(0);
    expect(mocks.controllerCalls).toEqual([
      "stopForRestart",
      "relaunchAfterRestart",
    ]);
  });

  it("publishes the relaunch's adoption proof as `maintenance`, whoever asked for the restart", async () => {
    // Lifecycle modes: a restart brings back a run that already
    // existed, so its relaunch leg records `maintenance` in the proof the
    // supervisor consumes - never the caller's `--lifecycle-origin`.
    mocks.crossSpawnEdge = true;
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: false,
      deferIfParked: false,
      expectedHost: null,
      lifecycleOrigin: "terminal",
    });
    await command(fakeCtx());

    expect(mocks.controllerCalls).toEqual([
      "stopForRestart",
      "relaunchAfterRestart",
    ]);
    expect(mocks.publishedOrigins).toEqual(["maintenance"]);
  });

  it("plain restart proceeds unconditionally even when the host is busy", async () => {
    mocks.busyOverride = "busy";
    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({
      ifIdle: false,
      force: false,
      deferIfParked: false,
      expectedHost: null,
      lifecycleOrigin: "terminal",
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
      expectedHost: null,
      lifecycleOrigin: "terminal",
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
      expectedHost: null,
      lifecycleOrigin: "terminal",
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
      expectedHost: null,
      lifecycleOrigin: "terminal",
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
      expectedHost: null,
      lifecycleOrigin: "terminal",
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
      expectedHost: null,
      lifecycleOrigin: "terminal",
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
      expectedHost: null,
      lifecycleOrigin: "terminal",
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
        expectedHost: null,
        lifecycleOrigin: "terminal",
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

    it("a CLAIM-LESS park WITHOUT --defer-if-parked keeps the old stop-only behavior: stops the service, restarted:false, human names 'traycer host update'", async () => {
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
        expectedHost: null,
        lifecycleOrigin: "terminal",
      });
      const result = await command(fakeCtx());

      expect(mocks.controllerCalls).toEqual(["stop"]);
      expect(result.data).toMatchObject({
        restarted: false,
        deferredForParkedActivation: false,
      });
      // The 2026-09-27 staging outage: the old stop-only sentence gave the
      // reader no way back. The stopped-outcome human text must now name the
      // one command that recovers a parked record.
      expect(result.human).toContain("traycer host update");
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
        expectedHost: null,
        lifecycleOrigin: "terminal",
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
        expectedHost: null,
        lifecycleOrigin: "terminal",
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

  // `parkedActivationRelaunchable` (`host/parked-activation-relaunch.ts`):
  // a `waiting-to-activate` park whose claim names EXACTLY the bytes
  // installed right now is not a generic stop-only hazard - it is the
  // activation restart the park itself is waiting for, so a plain
  // `host restart` (no flags) must continue it rather than stop the host and
  // leave the machine down beside a park nothing then resumes.
  describe("a parked record whose claim matches the installed bytes", () => {
    it("restarts (stopForRestart + relaunchAfterRestart), restarted: true", async () => {
      const installed = await writeInstallRecordForAttestation();
      await writeAttemptRecordForEnvironment("production", {
        targetVersion: "1.7.0",
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
        claim: {
          installedVersion: "1.7.0",
          installGeneration: encodeInstallGeneration(installed),
          stageFingerprint: null,
          allowDowngrade: false,
          acceptStoreFormatLoss: false,
        },
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: false,
        force: false,
        deferIfParked: false,
        expectedHost: null,
        lifecycleOrigin: "terminal",
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

    it("--defer-if-parked still defers even over a MATCHING park: decided before the park is examined", async () => {
      const installed = await writeInstallRecordForAttestation();
      await writeAttemptRecordForEnvironment("production", {
        targetVersion: "1.7.0",
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
        claim: {
          installedVersion: "1.7.0",
          installGeneration: encodeInstallGeneration(installed),
          stageFingerprint: null,
          allowDowngrade: false,
          acceptStoreFormatLoss: false,
        },
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: false,
        force: false,
        deferIfParked: true,
        expectedHost: null,
        lifecycleOrigin: "terminal",
      });
      const result = await command(fakeCtx());

      // Desktop's force-restart caller runs its own activation once this
      // command reports `deferred` - a matching park must still defer rather
      // than be activated here behind its back, so this is UNCONDITIONAL on
      // `deferIfParked`, not merely "when it wouldn't have matched anyway".
      expect(mocks.controllerCalls).toEqual([]);
      expect(result.data).toMatchObject({
        restarted: false,
        deferredForParkedActivation: true,
      });
      // The install comparison runs for a DEFERRED record too (traycer#2208
      // review): a deferred park that still matches the install must not be
      // called stale - Desktop's own activation is what resumes it next.
      expect(result.human).toContain("run 'traycer host update' to resume it");
      expect(result.human).not.toContain("no longer matches");
    });

    it("--defer-if-parked over a MISMATCHING park: still defers, but the human text calls it stale, not resumable", async () => {
      const installed = await writeInstallRecordForAttestation();
      await writeAttemptRecordForEnvironment("production", {
        targetVersion: "1.7.0",
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
        claim: {
          // The claim names a DIFFERENT installed version than what is
          // actually on disk (still "1.7.0", from
          // `writeInstallRecordForAttestation`).
          installedVersion: "1.6.0",
          installGeneration: encodeInstallGeneration(installed),
          stageFingerprint: null,
          allowDowngrade: false,
          acceptStoreFormatLoss: false,
        },
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: false,
        force: false,
        deferIfParked: true,
        expectedHost: null,
        lifecycleOrigin: "terminal",
      });
      const result = await command(fakeCtx());

      // Still deferred - `--defer-if-parked` is decided BEFORE the match is
      // examined, so the service is never touched here either.
      expect(mocks.controllerCalls).toEqual([]);
      expect(result.data).toMatchObject({
        restarted: false,
        deferredForParkedActivation: true,
      });
      expect(result.human).toContain("installed host no longer matches");
    });

    it("a claim whose installedVersion disagrees with the installed bytes stays stop-only", async () => {
      const installed = await writeInstallRecordForAttestation();
      await writeAttemptRecordForEnvironment("production", {
        targetVersion: "1.7.0",
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
        claim: {
          // The claim names a DIFFERENT installed version than what is
          // actually on disk (still "1.7.0", from `writeInstallRecordForAttestation`).
          installedVersion: "1.6.0",
          installGeneration: encodeInstallGeneration(installed),
          stageFingerprint: null,
          allowDowngrade: false,
          acceptStoreFormatLoss: false,
        },
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: false,
        force: false,
        deferIfParked: false,
        expectedHost: null,
        lifecycleOrigin: "terminal",
      });
      const result = await command(fakeCtx());

      expect(mocks.controllerCalls).toEqual(["stop"]);
      expect(result.data).toMatchObject({
        restarted: false,
        deferredForParkedActivation: false,
      });
      // The guidance is about THIS record: a stale park is not brought back
      // by `host update` alone (it retires the record `install-changed` and
      // exits), so the sentence must not promise that (traycer#2208 review).
      expect(result.human).toContain("installed host no longer matches");
      expect(result.human).toContain("'traycer host ensure' to start the host");
      expect(result.human).not.toContain("also starts the host");
    });

    it("a claim whose installGeneration disagrees with the installed bytes stays stop-only", async () => {
      await writeInstallRecordForAttestation();
      await writeAttemptRecordForEnvironment("production", {
        targetVersion: "1.7.0",
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
        claim: {
          installedVersion: "1.7.0",
          // A generation that does not match the install record's own
          // `installId`-derived fingerprint - a different install instance
          // that happens to carry the same version string.
          installGeneration: "id:some-other-install",
          stageFingerprint: null,
          allowDowngrade: false,
          acceptStoreFormatLoss: false,
        },
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: false,
        force: false,
        deferIfParked: false,
        expectedHost: null,
        lifecycleOrigin: "terminal",
      });
      const result = await command(fakeCtx());

      expect(mocks.controllerCalls).toEqual(["stop"]);
      expect(result.data).toMatchObject({
        restarted: false,
        deferredForParkedActivation: false,
      });
    });

    it("a matching claim with NO install record on disk stays stop-only (unverifiable is refused, never admitted)", async () => {
      // Deliberately no `writeInstallRecordForAttestation()` call - there is
      // no install record at all, so `readHostInstallRecord` returns `null`
      // and the park cannot be verified against anything.
      await writeAttemptRecordForEnvironment("production", {
        targetVersion: "1.7.0",
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
        claim: {
          installedVersion: "1.7.0",
          installGeneration: "id:restart-attestation-install",
          stageFingerprint: null,
          allowDowngrade: false,
          acceptStoreFormatLoss: false,
        },
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: false,
        force: false,
        deferIfParked: false,
        expectedHost: null,
        lifecycleOrigin: "terminal",
      });
      const result = await command(fakeCtx());

      expect(mocks.controllerCalls).toEqual(["stop"]);
      expect(result.data).toMatchObject({
        restarted: false,
        deferredForParkedActivation: false,
      });
    });

    it.each([
      {
        phase: "applying" as const,
        execution: "active" as const,
        continuation: null,
      },
      {
        phase: "preparing" as const,
        execution: "active" as const,
        continuation: "activate" as const,
      },
    ])(
      "an ACTIVE record ($phase/$execution) stays stop-only regardless of a matching claim - never even reaches the parked exemption",
      async ({ phase, execution, continuation }) => {
        const installed = await writeInstallRecordForAttestation();
        await writeAttemptRecordForEnvironment("production", {
          targetVersion: "1.7.0",
          phase,
          execution,
          continuation,
          claim: {
            installedVersion: "1.7.0",
            installGeneration: encodeInstallGeneration(installed),
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        });
        const { buildHostRestartCommand } = await import("../host-restart");
        const command = buildHostRestartCommand({
          ifIdle: false,
          force: false,
          deferIfParked: false,
          expectedHost: null,
          lifecycleOrigin: "terminal",
        });
        const result = await command(fakeCtx());

        expect(mocks.controllerCalls).toEqual(["stop"]);
        expect(result.data).toMatchObject({
          restarted: false,
          deferredForParkedActivation: false,
        });
      },
    );
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
      expectedHost: null,
      lifecycleOrigin: "terminal",
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
      expectedHost: null,
      lifecycleOrigin: "terminal",
    });
    const result = await command(fakeCtx());

    expect(result.human).toContain("prior helper swap failed");
    expect(result.human).not.toContain("could not restart the service");
  });

  // Desktop's force restart of a host that stopped answering is bound to the
  // process the person confirmed (`--expect-host-pid`): pid.json is read
  // inside the lock, before the busy probe or any stop, and a different live
  // host published in its place refuses the restart.
  describe("a restart bound to one host process", () => {
    const EXPECTED_HOST = {
      pid: 4242,
      startIdentity: "linux:boot-a 4242",
    } as const;

    async function writePidMetadata(published: {
      readonly pid: number;
      readonly identity: string | null;
    }): Promise<void> {
      const { hostPidMetadataPath } = await import("../../store/paths");
      const path = hostPidMetadataPath("production");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          pid: published.pid,
          hostId: "host-b",
          version: "1.9.0",
          websocketUrl: `ws://127.0.0.1:${String(published.pid)}/rpc`,
          startedAt: "2026-09-01T00:00:00.000Z",
          processStartIdentity: published.identity,
        }),
        "utf8",
      );
    }

    async function buildBoundForceRestart(): Promise<CommandFn> {
      const { buildHostRestartCommand } = await import("../host-restart");
      return buildHostRestartCommand({
        ifIdle: false,
        force: true,
        deferIfParked: true,
        expectedHost: EXPECTED_HOST,
        lifecycleOrigin: "desktop",
      });
    }

    it("refuses E_HOST_RESTART_TARGET_CHANGED when pid.json names a different live host, stopping nothing", async () => {
      const { ownProcessStartIdentity } =
        await import("../../store/process-identity");
      await writePidMetadata({
        pid: process.pid,
        identity: ownProcessStartIdentity(),
      });

      const command = await buildBoundForceRestart();

      await expect(command(fakeCtx())).rejects.toMatchObject({
        code: "E_HOST_RESTART_TARGET_CHANGED",
        message: expect.stringContaining("so nothing was stopped"),
      });
      expect(mocks.controllerCalls).toEqual([]);
    });

    it("restarts when pid.json still names the confirmed host", async () => {
      await writePidMetadata({
        pid: EXPECTED_HOST.pid,
        identity: EXPECTED_HOST.startIdentity,
      });

      const command = await buildBoundForceRestart();
      await command(fakeCtx());

      expect(mocks.stopForRestartForceValues).toEqual([true]);
      expect(mocks.controllerCalls).toEqual([
        "stopForRestart",
        "relaunchAfterRestart",
      ]);
    });

    it("restarts when no host is published", async () => {
      const command = await buildBoundForceRestart();
      await command(fakeCtx());

      expect(mocks.controllerCalls).toEqual([
        "stopForRestart",
        "relaunchAfterRestart",
      ]);
    });

    it("refuses when pid.json cannot be read, stopping nothing", async () => {
      const { hostPidMetadataPath } = await import("../../store/paths");
      const path = hostPidMetadataPath("production");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{ not json", "utf8");

      const command = await buildBoundForceRestart();

      await expect(command(fakeCtx())).rejects.toMatchObject({
        code: "E_HOST_RESTART_TARGET_CHANGED",
      });
      expect(mocks.controllerCalls).toEqual([]);
    });

    // The admission check above runs once the command holds the lock, but a
    // host the supervisor admitted earlier can publish after it and before
    // the stop. The stop re-reads pid.json at each of its own edges.
    it("refuses a host published after the admission check and before the stop, stopping and relaunching nothing", async () => {
      const { ownProcessStartIdentity } =
        await import("../../store/process-identity");
      await writePidMetadata({
        pid: EXPECTED_HOST.pid,
        identity: EXPECTED_HOST.startIdentity,
      });
      mocks.afterAdmission = async () => {
        await writePidMetadata({
          pid: process.pid,
          identity: ownProcessStartIdentity(),
        });
      };

      const command = await buildBoundForceRestart();

      await expect(command(fakeCtx())).rejects.toMatchObject({
        code: "E_HOST_RESTART_TARGET_CHANGED",
        message: expect.stringContaining("so nothing was stopped"),
      });
      expect(mocks.controllerCalls).toEqual([]);
    });

    // The relaunch's `kickstart -k` / `systemctl restart` kills whatever the
    // label runs, so it is as destructive as the stop and is held to the
    // confirmed host up to its own launch.
    it("refuses a host published after the stop and before the relaunch's launch, issuing no launch, and says the stop had already run", async () => {
      const { ownProcessStartIdentity } =
        await import("../../store/process-identity");
      await writePidMetadata({
        pid: EXPECTED_HOST.pid,
        identity: EXPECTED_HOST.startIdentity,
      });
      mocks.launchCall = async () => undefined;
      mocks.afterStop = async () => {
        await writePidMetadata({
          pid: process.pid,
          identity: ownProcessStartIdentity(),
        });
      };

      const command = await buildBoundForceRestart();

      await expect(command(fakeCtx())).rejects.toMatchObject({
        code: "E_HOST_RESTART_TARGET_CHANGED",
        message: expect.stringContaining(
          "its stop had already run against the confirmed host",
        ),
      });
      expect(mocks.launches).toBe(0);
    });

    it("accepts the host the relaunch's own launch publishes, and holds nothing after it", async () => {
      const { ownProcessStartIdentity } =
        await import("../../store/process-identity");
      await writePidMetadata({
        pid: EXPECTED_HOST.pid,
        identity: EXPECTED_HOST.startIdentity,
      });
      // The supervisor the launch brings up publishes its host while the
      // launching call is still running; the stub then makes one more service
      // call of the same command.
      mocks.launchCall = async () => {
        await writePidMetadata({
          pid: process.pid,
          identity: ownProcessStartIdentity(),
        });
      };

      const command = await buildBoundForceRestart();
      const result = await command(fakeCtx());

      expect(result.data).toMatchObject({ restarted: true });
      expect(mocks.launches).toBe(1);
    });

    it("an --if-idle restart refuses a replaced host before its busy probe", async () => {
      const { ownProcessStartIdentity } =
        await import("../../store/process-identity");
      await writePidMetadata({
        pid: process.pid,
        identity: ownProcessStartIdentity(),
      });
      const { buildHostRestartCommand } = await import("../host-restart");
      const command = buildHostRestartCommand({
        ifIdle: true,
        force: false,
        deferIfParked: true,
        expectedHost: EXPECTED_HOST,
        lifecycleOrigin: "desktop",
      });

      await expect(command(fakeCtx())).rejects.toMatchObject({
        code: "E_HOST_RESTART_TARGET_CHANGED",
      });
      expect(mocks.busyCalls).toEqual([]);
      expect(mocks.controllerCalls).toEqual([]);
    });

    // The same command over a real platform controller and a recording
    // runner, so what is refused is the controller's own subprocess call.
    describe("through a platform controller", () => {
      const spawned: ChildProcess[] = [];

      afterEach(() => {
        for (const child of spawned.splice(0)) child.kill("SIGKILL");
      });

      async function startedChild(source: string): Promise<ChildProcess> {
        const script = join(workHome, `child-${String(spawned.length)}.js`);
        writeFileSync(script, source, "utf8");
        const child = spawn(process.execPath, [script], { stdio: "ignore" });
        spawned.push(child);
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", () => resolve());
          child.once("error", reject);
        });
        return child;
      }

      // A pid nothing holds any more: its record is "gone" without any
      // process-table fixture.
      async function exitedPid(): Promise<number> {
        const child = await startedChild("");
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        });
        if (child.pid === undefined) throw new Error("child had no pid");
        return child.pid;
      }

      async function publishThisProcess(): Promise<void> {
        const { ownProcessStartIdentity } =
          await import("../../store/process-identity");
        await writePidMetadata({
          pid: process.pid,
          identity: ownProcessStartIdentity(),
        });
      }

      async function buildBoundRestart(host: {
        readonly pid: number;
        readonly startIdentity: string;
      }): Promise<CommandFn> {
        const { buildHostRestartCommand } = await import("../host-restart");
        return buildHostRestartCommand({
          ifIdle: false,
          force: false,
          deferIfParked: true,
          expectedHost: host,
          lifecycleOrigin: "desktop",
        });
      }

      it("macOS: a stop that asks for a job recycle never reaches `kickstart -k` when a different host is published after it", async () => {
        const { createMacosController } =
          await import("../../service/platforms/macos");
        const pid = await exitedPid();
        const host = { pid, startIdentity: `linux:boot-a ${String(pid)}` };
        await writePidMetadata({ pid, identity: host.startIdentity });
        const calls: string[] = [];
        mocks.realController = createMacosController(async (command, args) => {
          calls.push([command, ...args].join(" "));
          // The job's SIGTERM lands and the host exits; a different one comes
          // up before the relaunch.
          if (args[0] === "kill") await publishThisProcess();
          return { stdout: "", stderr: "", exitCode: 0 };
        });

        const command = await buildBoundRestart(host);

        await expect(command(fakeCtx())).rejects.toMatchObject({
          code: "E_HOST_RESTART_TARGET_CHANGED",
          message: expect.stringContaining(
            "its stop had already run against the confirmed host",
          ),
        });
        expect(calls.some((call) => / kill /.test(call))).toBe(true);
        expect(calls.some((call) => call.includes("kickstart"))).toBe(false);
      });

      it("Linux: a forced-recycle stop never reaches `systemctl restart` when a different host is published after it", async () => {
        const { createLinuxController, setRestartStopGracesForTests } =
          await import("../../service/platforms/linux");
        const { readProcessStartIdentity } =
          await import("../../store/process-identity");
        // The host survives both signals, so the stop can only report a
        // recycle.
        const live = await startedChild("setInterval(() => undefined, 1000);");
        const pid = live.pid;
        if (pid === undefined) throw new Error("child had no pid");
        const startIdentity = readProcessStartIdentity(pid);
        if (startIdentity === null) throw new Error("no start identity");
        await writePidMetadata({ pid, identity: startIdentity });
        setRestartStopGracesForTests({ sigtermMs: 20, sigkillMs: 20 });
        try {
          const calls: string[] = [];
          mocks.realController = createLinuxController(
            async (command, args) => {
              calls.push([command, ...args].join(" "));
              if (args.includes("--signal=SIGKILL")) {
                await publishThisProcess();
              }
              return { stdout: "", stderr: "", exitCode: 0 };
            },
          );

          const command = await buildBoundRestart({ pid, startIdentity });

          await expect(command(fakeCtx())).rejects.toMatchObject({
            code: "E_HOST_RESTART_TARGET_CHANGED",
            message: expect.stringContaining(
              "its stop had already run against the confirmed host",
            ),
          });
          expect(calls.some((call) => call.includes("--signal=SIGKILL"))).toBe(
            true,
          );
          expect(
            calls.some((call) => /systemctl --user restart/.test(call)),
          ).toBe(false);
        } finally {
          setRestartStopGracesForTests(null);
        }
      });

      // A launch whose proof no supervisor acknowledged is retried on a read
      // that nothing runs. A host published after that read is not the first
      // launch's, so the retry is held to the confirmed host again.
      it("Linux: a retried launch is refused when a different host is published after the first launch went unacknowledged", async () => {
        const { createLinuxController } =
          await import("../../service/platforms/linux");
        const { serviceLabelFor, serviceManifestPath } =
          await import("../../service/label");
        const { SpawnAcknowledgementTimeoutError } =
          await import("@traycer-clients/shared/host-start-adoption/spawn-acknowledgement-error");
        const pid = await exitedPid();
        const host = { pid, startIdentity: `linux:boot-a ${String(pid)}` };
        await writePidMetadata({ pid, identity: host.startIdentity });
        // The service is registered, which is what a status read needs to see.
        const manifest = serviceManifestPath(serviceLabelFor("production"));
        mkdirSync(dirname(manifest), { recursive: true });
        writeFileSync(manifest, "[Unit]\n", "utf8");
        mocks.spawnWaitFor = async (publication) => {
          if (publication === 1) {
            return async () => {
              throw new SpawnAcknowledgementTimeoutError();
            };
          }
          // The second proof is published as the retry reaches its edge.
          await publishThisProcess();
          return async () => undefined;
        };
        const calls: string[] = [];
        mocks.realController = createLinuxController(async (command, args) => {
          calls.push([command, ...args].join(" "));
          return { stdout: "", stderr: "", exitCode: 0 };
        });

        const command = await buildBoundRestart(host);

        await expect(command(fakeCtx())).rejects.toMatchObject({
          code: "E_HOST_RESTART_TARGET_CHANGED",
        });
        expect(
          calls.filter((call) => /systemctl --user start/.test(call)),
        ).toHaveLength(1);
      });
    });
  });
});
