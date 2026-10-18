import { existsSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acquireUpdateAttemptLock,
  updateAttemptRecordPath,
  type HostUpdateAttemptRecord,
  type UpdateAttemptLockHandle,
} from "@traycer-clients/shared/host-update";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import type { HostInstallRecord } from "@traycer/protocol/config/installation-records";

// `cli finalize-upgrade`
// (`commands/cli-finalize-upgrade.ts`) - the hidden command the Windows (and
// POSIX) detached finalize-helper invokes after `host restart` has already
// STOPPED the service - ran under admission `service-maintenance`, which the
// shared contender's `dispositionFor` refuses unconditionally on ANY
// nonterminal attempt record. On Windows this command runs as the detached
// helper that completes a `host restart` (admitted under
// `recovery-maintenance`) that has already stopped the service, so a refusal
// here used to leave the host down.
//
// The review's ruling: the START-ONLY FALLBACK. The swap stays deferred exactly as
// before (no marker, `pendingUpgrade` kept, `finalizePendingCliUpgrade` never
// even called) - but when the refusal is specifically the standing-attempt
// one (`HOST_UPDATE_ATTEMPT_ACTIVE`, never a bare lock `CLI_LOCK_BUSY`), the
// command now falls back to JUST starting the host, admitted the way the
// service's own supervisor relaunch is (`withCliSupervisorRelaunchSegment`,
// admission `supervisor-relaunch-maintenance`) - the same exemption already
// given to `host ensure` and `host service start`. The overall outcome is still
// reported as `{ status: "lock-timeout" }` either way: only the SIDE EFFECT
// differs (the host gets started), never the swap's own deferred status.
//
// This suite drives `cliFinalizeUpgradeCommand` end to end with the REAL
// outer update-attempt lock and the REAL shared contender, and writes a
// genuine attempt record to disk. Pin the fallback's exact
// conditions and mechanism logging; still nothing about the swap/marker
// design beyond "it never runs when the fallback fires".
//
// HOME is redirected to a private temp dir BEFORE anything reads it, same
// reasoning as `service-start-over-update-attempt.test.ts`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-cli-finalize-upgrade-over-test-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

const mocks = vi.hoisted(() => ({
  readHostInstallRecordMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  finalizePendingCliUpgradeMock: vi.fn(),
}));

interface RecordedLog {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

// The command logs through `createCliLogger(environment)`, NOT `ctx.runtime`'s
// logger - a fresh logger built straight from the module, on every call. So
// the mock must record into a SHARED array across every logger instance the
// command creates in one run, not into a per-instance one `fakeCtx()` could
// own.
const logs = vi.hoisted(() => ({ entries: [] as RecordedLog[] }));
vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  return {
    ...actual,
    createCliLogger: () => ({
      debug: (message: string, fields: Record<string, unknown>) => {
        logs.entries.push({ level: "debug", message, fields });
      },
      info: (message: string, fields: Record<string, unknown>) => {
        logs.entries.push({ level: "info", message, fields });
      },
      warn: (message: string, fields: Record<string, unknown>) => {
        logs.entries.push({ level: "warn", message, fields });
      },
      error: (message: string, fields: Record<string, unknown>) => {
        logs.entries.push({ level: "error", message, fields });
      },
    }),
  };
});

function logsMatching(
  level: RecordedLog["level"],
  message: string,
): RecordedLog[] {
  return logs.entries.filter(
    (entry) => entry.level === level && entry.message === message,
  );
}

const DEFERRED_SWAP_MESSAGE =
  "Finalize-upgrade deferred its CLI swap and is starting the installed host beside a standing update attempt";
const LEFT_HOST_MESSAGE =
  "Finalize-upgrade left the host as it was: the standing update attempt does not admit its start";
const START_FAILED_MESSAGE = "Finalize-upgrade service start failed";
const STOP_ONLY_CONTINUATION_MESSAGE =
  "Finalize-upgrade left the host as it was: the standing update attempt's own continuation starts it";
const RESTART_COMPLETION_MESSAGE =
  "Finalize-upgrade deferred its CLI swap and is starting the installed host to complete the restart that stopped it";

// Not read by this command's own code today, but the coming fix is expected
// to mirror `service-start`'s `withCliSupervisorRelaunchSegment`, whose
// disposition check reads the install record to verify the claim generation
// (`update-contender.ts`'s `readSupervisorRelaunchInstalledIdentity`).
// Mocked here now so the main-matrix rows' generation matches once that
// lands, exactly as `service-start-over-update-attempt.test.ts` does.
vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: mocks.createServiceControllerMock,
    serviceLabelFor: mocks.serviceLabelForMock,
  };
});

// Staging a real pending upgrade (as `cli-finalize-upgrade.test.ts` /
// `cli-finalize-upgrade-lock.test.ts` do) is unrelated machinery this row
// does not need to exercise - only whether the service gets started beside
// a standing attempt record. Mocked to the simplest outcome that reaches
// `startServiceBestEffort` on every path (`no-pending`), which also means no
// post-finalize marker is ever written when the start itself succeeds (the
// marker write is conditional on `serviceStartError !== null`).
vi.mock("../cli-upgrade", () => ({
  finalizePendingCliUpgrade: mocks.finalizePendingCliUpgradeMock,
}));

import { cliFinalizeUpgradeCommand } from "../cli-finalize-upgrade";
import type { CommandContext, CommandResult } from "../../runner/runner";
import { atServiceSpawnEdge } from "../../service/spawn-edge";
import {
  consumeHostStartAdoption,
  readHostStartAdoptionNonce,
} from "../../host/host-start-adoption";
import {
  cliManifestPath,
  cliPostFinalizeMarkerPath,
  hostHomeDir,
} from "../../store/paths";
import type { ServiceLabel } from "../../service";
import { writeCliManifest } from "../../manifest/cli-manifest";
import type { CliInstallManifest } from "../../manifest/cli-manifest";

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

async function freshHome(): Promise<string> {
  const home = hostHomeDir("production");
  await rm(home, { recursive: true, force: true });
  return home;
}

afterEach(async () => {
  vi.clearAllMocks();
  logs.entries = [];
  await rm(hostHomeDir("production"), { recursive: true, force: true });
});

const INSTALLED_VERSION = "2.0.0";
const SERVICE_LABEL: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
  devSlot: null,
};

function sampleInstallRecord(version: string): HostInstallRecord {
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

// Same fixture as `service-start-over-update-attempt.test.ts` and
// `provision-start-over-update-attempt.test.ts` - copied inline so this
// file's on-disk shape is self-contained.
function attemptRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

// A genuine CLI install manifest carrying a `pendingUpgrade`, so "kept" can be
// asserted against real bytes on disk rather than inferred from
// `finalizePendingCliUpgradeMock` never being called. Nothing in this
// suite's code path under test (`startBesideUpdateAttempt` and its would-be
// third tier) touches this manifest at all - `../../manifest/cli-manifest`
// is not mocked - so a byte-for-byte comparison before/after is a real
// exercise of "nothing here writes it", not a fake.
function sampleCliManifestWithPendingUpgrade(): CliInstallManifest {
  return {
    version: "1.9.0",
    installedAt: "2026-01-01T00:00:00.000Z",
    binaryPath: "/tmp/traycer-cli",
    source: "manual",
    pendingUpgrade: {
      version: "2.1.0",
      stagedBinaryPath: "/tmp/traycer-cli.staged",
      stagedAt: "2026-01-01T00:00:00.000Z",
      reason: "awaiting-service-restart",
    },
  };
}

async function readCliManifestBytes(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(cliManifestPath("production"), "utf8");
}

async function writeAttemptRecord(
  hostHomeDirPath: string,
  overrides: Partial<HostUpdateAttemptRecord>,
): Promise<void> {
  await mkdir(hostHomeDirPath, { recursive: true });
  await writeFile(
    updateAttemptRecordPath(hostHomeDirPath),
    `${JSON.stringify(attemptRecord(overrides))}\n`,
    "utf8",
  );
}

async function readAttemptRecordBytes(
  hostHomeDirPath: string,
): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(updateAttemptRecordPath(hostHomeDirPath), "utf8");
}

interface FakeControllerCalls {
  start: number;
  status: number;
}

interface FakeControllerHandle {
  readonly controller: unknown;
  readonly calls: FakeControllerCalls;
}

/** Installed + registered + NOT running (status always "stopped"), whose
 * `start` really reaches the spawn edge and satisfies its own adoption proof
 * (self-supervisor style) - same shape as the sibling suite's `startCapableController`. */
function startCapableController(): FakeControllerHandle {
  const calls: FakeControllerCalls = { start: 0, status: 0 };
  return {
    controller: {
      status: async () => {
        calls.status += 1;
        return {
          state: "stopped" as const,
          version: INSTALLED_VERSION,
          listenUrl: null,
          pid: null,
        };
      },
      start: async () => {
        calls.start += 1;
        await atServiceSpawnEdge();
        const nonce = await readHostStartAdoptionNonce(
          "production",
          SERVICE_LABEL.id,
        );
        if (nonce === null) return;
        const consumed = await consumeHostStartAdoption(
          "production",
          SERVICE_LABEL.id,
          nonce,
        );
        if (consumed.kind === "grant") {
          await consumed.grant.acknowledgeSpawn();
        }
      },
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    },
    calls,
  };
}

/** A controller whose `start` rejects immediately - no spawn edge, no
 * adoption proof - for row 5: the fallback's own `startServiceBestEffort`
 * must record this, not throw it. */
function failingStartController(errorMessage: string): FakeControllerHandle {
  const calls: FakeControllerCalls = { start: 0, status: 0 };
  return {
    controller: {
      status: async () => {
        calls.status += 1;
        return {
          state: "stopped" as const,
          version: INSTALLED_VERSION,
          listenUrl: null,
          pid: null,
        };
      },
      start: async () => {
        calls.start += 1;
        throw new Error(errorMessage);
      },
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    },
    calls,
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

type PidVariant = "teardown" | "reboot";

async function setUpPidVariant(
  hostHomeDirPath: string,
  variant: PidVariant,
): Promise<void> {
  if (variant === "reboot") {
    const { hostPidMetadataPathIn } = await import("../../store/paths");
    await mkdir(hostHomeDirPath, { recursive: true });
    await writeFile(
      hostPidMetadataPathIn(hostHomeDirPath),
      JSON.stringify({
        pid: 999_999,
        hostId: "stale-host",
        version: INSTALLED_VERSION,
        websocketUrl: "ws://127.0.0.1:54999/rpc",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );
  }
  // "teardown": no pid.json at all - nothing to write.
}

interface RecordCase {
  readonly name: string;
  readonly overrides: (
    installGeneration: string,
  ) => Partial<HostUpdateAttemptRecord>;
}

const RECORD_CASES: readonly RecordCase[] = [
  {
    name: "waiting-for-work",
    overrides: () => ({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      targetVersion: "9.9.9",
    }),
  },
  {
    name: "matching waiting-to-activate",
    overrides: (installGeneration) => ({
      phase: "waiting-to-activate",
      execution: "parked",
      continuation: "activate",
      targetVersion: INSTALLED_VERSION,
      claim: {
        installedVersion: INSTALLED_VERSION,
        installGeneration,
        stageFingerprint: null,
        allowDowngrade: false,
        acceptStoreFormatLoss: false,
      },
    }),
  },
  {
    name: "interrupted (restarting / active / activate, no live holder)",
    overrides: (installGeneration) => ({
      phase: "restarting",
      execution: "active",
      continuation: "activate",
      targetVersion: INSTALLED_VERSION,
      claim: {
        installedVersion: INSTALLED_VERSION,
        installGeneration,
        stageFingerprint: null,
        allowDowngrade: false,
        acceptStoreFormatLoss: false,
      },
    }),
  },
];

const PID_VARIANTS: readonly PidVariant[] = ["teardown", "reboot"];

const MATRIX = RECORD_CASES.flatMap((recordCase) =>
  PID_VARIANTS.map((variant) => ({ recordCase, variant })),
);

describe("cliFinalizeUpgradeCommand - the finalize helper's start, over a standing update-attempt record", () => {
  for (const { recordCase, variant } of MATRIX) {
    it(`${recordCase.name} / ${variant}: starts the service beside the standing record, leaving it untouched`, async () => {
      const hostHomeDirPath = await freshHome();
      const installRecord = sampleInstallRecord(INSTALLED_VERSION);
      mocks.readHostInstallRecordMock.mockResolvedValue(installRecord);
      mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
      mocks.finalizePendingCliUpgradeMock.mockResolvedValue({
        status: "no-pending",
      });
      const { controller, calls } = startCapableController();
      mocks.createServiceControllerMock.mockReturnValue(controller);
      await setUpPidVariant(hostHomeDirPath, variant);
      const installGeneration = encodeInstallGeneration(installRecord);
      const overrides = recordCase.overrides(installGeneration);
      await writeAttemptRecord(hostHomeDirPath, overrides);
      const written = attemptRecord(overrides);
      const beforeBytes = await readAttemptRecordBytes(hostHomeDirPath);

      const result = await cliFinalizeUpgradeCommand(fakeCtx());

      // (1) The swap stays deferred: never even attempted, and outcome/exit
      // code report the deferral, not a fabricated success.
      expect(mocks.finalizePendingCliUpgradeMock).not.toHaveBeenCalled();
      expect(result.data).toEqual({ status: "lock-timeout" });
      expect(result.exitCode).toBe(0);
      expect(existsSync(cliPostFinalizeMarkerPath("production"))).toBe(false);
      // The fallback still does its one job: the host starts.
      expect(calls.start).toBe(1);
      const afterBytes = await readAttemptRecordBytes(hostHomeDirPath);
      expect(afterBytes).toBe(beforeBytes);

      // (2) Mechanism: the fallback said so, exactly once, naming the record
      // that admitted it.
      const deferred = logsMatching("info", DEFERRED_SWAP_MESSAGE);
      expect(deferred).toHaveLength(1);
      expect(deferred[0]?.fields.attemptId).toBe(written.attemptId);
      expect(deferred[0]?.fields.phase).toBe(written.phase);
    });
  }

  // Control: a `waiting-to-activate` whose claim generation does NOT match
  // the install record must stay refused - the FALLBACK's own
  // `supervisor-relaunch-maintenance` admission refuses it too (the review's "a
  // record supervisor-relaunch-maintenance itself REFUSES"), so it falls to
  // the third (recovery-maintenance) tier - whose `recoveryActionFor` reads
  // "stop-only" for `waiting-to-activate`, so it logs its own distinct
  // continuation line and returns without starting anything. This is `n3`:
  // its shape already matches the third-tier's "STOP-ONLY records" list, so it needed
  // no rewrite, only this log-line update once the fix's exact wording
  // landed.
  it("control: a waiting-to-activate record with a MISMATCHED claim generation never starts the service", async () => {
    const hostHomeDirPath = await freshHome();
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord(INSTALLED_VERSION),
    );
    mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
    mocks.finalizePendingCliUpgradeMock.mockResolvedValue({
      status: "no-pending",
    });
    const { controller, calls } = startCapableController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "waiting-to-activate",
      execution: "parked",
      continuation: "activate",
      targetVersion: INSTALLED_VERSION,
      claim: {
        installedVersion: INSTALLED_VERSION,
        installGeneration:
          "mismatched-generation-does-not-match-install-record",
        stageFingerprint: null,
        allowDowngrade: false,
        acceptStoreFormatLoss: false,
      },
    });

    const result = await cliFinalizeUpgradeCommand(fakeCtx());

    expect(calls.start).toBe(0);
    expect(result.data).toEqual({ status: "lock-timeout" });
    const stopOnly = logsMatching("info", STOP_ONLY_CONTINUATION_MESSAGE);
    expect(stopOnly).toHaveLength(1);
    expect(stopOnly[0]?.fields.phase).toBe("waiting-to-activate");
    expect(logsMatching("info", LEFT_HOST_MESSAGE)).toHaveLength(0);
    expect(logsMatching("info", DEFERRED_SWAP_MESSAGE)).toHaveLength(0);
  });

  // Control: the segment is live and held by ANOTHER holder. The FIRST
  // contender answers `CLI_LOCK_BUSY`, not `HOST_UPDATE_ATTEMPT_ACTIVE` - and
  // the command only invokes the fallback for the latter - so the fallback
  // must not run at all: neither log line fires, start is never called.
  it("control: a record whose segment is live and held never starts the service, and never runs the fallback", async () => {
    const hostHomeDirPath = await freshHome();
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord(INSTALLED_VERSION),
    );
    mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
    mocks.finalizePendingCliUpgradeMock.mockResolvedValue({
      status: "no-pending",
    });
    const { controller, calls } = startCapableController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      targetVersion: "9.9.9",
    });
    const heldOutcome = await acquireUpdateAttemptLock({
      hostHomeDir: hostHomeDirPath,
      reason: "control-live-holder",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(heldOutcome.kind).toBe("acquired");
    const held: UpdateAttemptLockHandle | null =
      heldOutcome.kind === "acquired" ? heldOutcome.handle : null;

    let result: CommandResult;
    try {
      result = await cliFinalizeUpgradeCommand(fakeCtx());
    } finally {
      await held?.release();
    }

    expect(calls.start).toBe(0);
    expect(result.data).toEqual({ status: "lock-timeout" });
    expect(logsMatching("info", DEFERRED_SWAP_MESSAGE)).toHaveLength(0);
    expect(logsMatching("info", LEFT_HOST_MESSAGE)).toHaveLength(0);
  });

  // Row 5: the fallback's own start can fail (a real OS-manager error). It
  // must be RECORDED, not thrown - the command still reports the deferral,
  // exit 0, and the standing record is untouched.
  it("a start failure is recorded, not thrown", async () => {
    const hostHomeDirPath = await freshHome();
    const installRecord = sampleInstallRecord(INSTALLED_VERSION);
    mocks.readHostInstallRecordMock.mockResolvedValue(installRecord);
    mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
    mocks.finalizePendingCliUpgradeMock.mockResolvedValue({
      status: "no-pending",
    });
    const { controller, calls } = failingStartController(
      "schtasks /Run failed",
    );
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      targetVersion: "9.9.9",
    });
    const beforeBytes = await readAttemptRecordBytes(hostHomeDirPath);

    const result = await cliFinalizeUpgradeCommand(fakeCtx());

    expect(result.data).toEqual({ status: "lock-timeout" });
    expect(result.exitCode).toBe(0);
    expect(calls.start).toBe(1);
    const failed = logsMatching("warn", START_FAILED_MESSAGE);
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.fields.errorMessage)).toContain(
      "schtasks /Run failed",
    );
    const afterBytes = await readAttemptRecordBytes(hostHomeDirPath);
    expect(afterBytes).toBe(beforeBytes);
  });
});

// When `supervisor-relaunch-maintenance` ALSO refuses, the
// fallback is expected to take a third tier, `recovery-maintenance`, and
// start the host ONLY when the contender context's `recoveryAction` reads
// "restart-current" - the exact verdict `host restart` stopped the host
// under (`commands/host-restart.ts:139`). That third tier does not exist
// yet, so every "s" row here is RED at current bytes: the fallback gives up
// after the second tier's refusal instead of trying a third.
//
// `recoveryActionFor` (`clients/shared/host-update/contender.ts`) answers
// "stop-only" for exactly three shapes - phase "applying"; phase
// "preparing" with continuation "activate"; phase "waiting-to-activate" -
// and "restart-current" for everything else. The "s" rows below are chosen
// so `supervisor-relaunch-maintenance` (tier 2) refuses THEM SPECIFICALLY
// (verified against `supervisorRelaunchOverActive` /
// `startsWhatThisRecordPlaced`), so the third tier is what decides the
// outcome, not the second one succeeding on its own:
//
//  - "downloading" / "preparing"+null / "preparing"+"resume-apply": tier 2
//    refuses because `startsWhatThisRecordPlaced` is false for all three
//    (only "restarting", "verifying", and "preparing"+"activate" pass it)
//    AND each is written NOW: a stale, unheld one is an interrupted updater,
//    which tier 2 admits on its own (`interruptedBeforePlacement`), and the
//    third tier would never be reached.
//  - "restarting" / "verifying" with installed != target: tier 2's
//    `startsWhatThisRecordPlaced` IS true for these phases, so the version
//    mismatch is what forces its refusal - matched, it would allow at tier
//    2 and never reach the third tier at all.
//
// None of these five need a `claim` - tier 2's active-phase arm
// (`supervisorRelaunchOverActive`) compares the INSTALLED identity against
// `targetVersion`, never against the record's own `claim`.
//
// The "n" rows are the mirror: `recoveryActionFor` answers "stop-only" for
// them, so even once the third tier exists it must not start the host.
// They are already refused by tier 2 for the same reasons as the "s" rows
// (`startsWhatThisRecordPlaced` false for "applying"; the version mismatch
// for "preparing"+"activate"), so at current bytes AND after the fix they
// stay exactly as refused as the file's `n3` control (the existing
// mismatched-claim `waiting-to-activate` row above) already is.
describe("cliFinalizeUpgradeCommand - the third (recovery-maintenance) tier adds to the fallback", () => {
  interface ThirdTierCase {
    readonly name: string;
    readonly overrides: Partial<HostUpdateAttemptRecord>;
    readonly phase: HostUpdateAttemptRecord["phase"];
    readonly expectStart: number;
  }

  const MISMATCHED_TARGET = "9.9.9";

  const THIRD_TIER_CASES: readonly ThirdTierCase[] = [
    {
      name: "(s1) downloading: recoveryAction is restart-current, so the third tier starts the host",
      phase: "downloading",
      overrides: {
        phase: "downloading",
        execution: "active",
        continuation: null,
        targetVersion: MISMATCHED_TARGET,
        updatedAt: new Date().toISOString(),
      },
      expectStart: 1,
    },
    {
      name: "(s2) preparing, continuation null: recoveryAction is restart-current, so the third tier starts the host",
      phase: "preparing",
      overrides: {
        phase: "preparing",
        execution: "active",
        continuation: null,
        targetVersion: MISMATCHED_TARGET,
        updatedAt: new Date().toISOString(),
      },
      expectStart: 1,
    },
    {
      name: "(s3) preparing, continuation resume-apply: recoveryAction is restart-current, so the third tier starts the host",
      phase: "preparing",
      overrides: {
        phase: "preparing",
        execution: "active",
        continuation: "resume-apply",
        targetVersion: MISMATCHED_TARGET,
        updatedAt: new Date().toISOString(),
      },
      expectStart: 1,
    },
    {
      name: "(s4) restarting, installed version != target: tier 2 refuses on the mismatch, so the third tier starts the host",
      phase: "restarting",
      overrides: {
        phase: "restarting",
        execution: "active",
        continuation: null,
        targetVersion: MISMATCHED_TARGET,
      },
      expectStart: 1,
    },
    {
      name: "(s5) verifying, installed version != target: tier 2 refuses on the mismatch, so the third tier starts the host",
      phase: "verifying",
      overrides: {
        phase: "verifying",
        execution: "active",
        continuation: null,
        targetVersion: MISMATCHED_TARGET,
      },
      expectStart: 1,
    },
    {
      name: "(n1) applying: recoveryAction is stop-only, so the host is never started",
      phase: "applying",
      overrides: {
        phase: "applying",
        execution: "active",
        continuation: null,
        targetVersion: MISMATCHED_TARGET,
      },
      expectStart: 0,
    },
    {
      name: "(n2) preparing, continuation activate, installed version != target: recoveryAction is stop-only, so the host is never started",
      phase: "preparing",
      overrides: {
        phase: "preparing",
        execution: "active",
        continuation: "activate",
        targetVersion: MISMATCHED_TARGET,
      },
      expectStart: 0,
    },
  ];

  for (const { name, overrides, phase, expectStart } of THIRD_TIER_CASES) {
    it(name, async () => {
      const hostHomeDirPath = await freshHome();
      const installRecord = sampleInstallRecord(INSTALLED_VERSION);
      mocks.readHostInstallRecordMock.mockResolvedValue(installRecord);
      mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
      mocks.finalizePendingCliUpgradeMock.mockResolvedValue({
        status: "no-pending",
      });
      const { controller, calls } = startCapableController();
      mocks.createServiceControllerMock.mockReturnValue(controller);
      await writeCliManifest(
        "production",
        sampleCliManifestWithPendingUpgrade(),
      );
      const manifestBeforeBytes = await readCliManifestBytes();
      await writeAttemptRecord(hostHomeDirPath, overrides);
      const beforeBytes = await readAttemptRecordBytes(hostHomeDirPath);

      const result = await cliFinalizeUpgradeCommand(fakeCtx());

      expect(calls.start).toBe(expectStart);
      const afterBytes = await readAttemptRecordBytes(hostHomeDirPath);
      expect(afterBytes).toBe(beforeBytes);
      expect(existsSync(cliPostFinalizeMarkerPath("production"))).toBe(false);
      const manifestAfterBytes = await readCliManifestBytes();
      expect(manifestAfterBytes).toBe(manifestBeforeBytes);
      expect(result.data).toEqual({ status: "lock-timeout" });

      if (expectStart === 1) {
        const restartCompletion = logsMatching(
          "info",
          RESTART_COMPLETION_MESSAGE,
        );
        expect(restartCompletion).toHaveLength(1);
        expect(restartCompletion[0]?.fields.phase).toBe(phase);
        expect(
          logsMatching("info", STOP_ONLY_CONTINUATION_MESSAGE),
        ).toHaveLength(0);
      } else {
        const stopOnly = logsMatching("info", STOP_ONLY_CONTINUATION_MESSAGE);
        expect(stopOnly).toHaveLength(1);
        expect(stopOnly[0]?.fields.phase).toBe(phase);
        expect(logsMatching("info", RESTART_COMPLETION_MESSAGE)).toHaveLength(
          0,
        );
      }
      expect(logsMatching("info", DEFERRED_SWAP_MESSAGE)).toHaveLength(0);
      expect(logsMatching("info", LEFT_HOST_MESSAGE)).toHaveLength(0);
    });
  }
});
