import { rmSync } from "node:fs";
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

// `traycer host service start`
// (`commands/service-start.ts:125-133`) takes its segment under admission
// `service-maintenance`. The shared contender's `dispositionFor`
// (`clients/shared/host-update/contender.ts:1252-1271`) REFUSES that
// admission on ANY nonterminal attempt record - unlike
// `supervisor-relaunch-maintenance` and `lifecycle-teardown-maintenance`,
// nothing upgrades it for a parked/interrupted record whose own next act is
// exactly this command's start. So in exactly the same states - a parked
// `waiting-for-work`, a MATCHING `waiting-to-activate`, or an interrupted
// `restarting`/`active`/`activate` record with no live holder, host down
// after a teardown - the terminal's explicit `host service start` refuses
// with `E_HOST_UPDATE_ATTEMPT_ACTIVE` for as long as the record stands. That same remedy
// fixed `host ensure`'s equivalent branch by starting it under the
// supervisor-relaunch admission (`withCliSupervisorRelaunchSegment`); `host
// service start` still refuses.
//
// This suite drives `buildServiceStartCommand` end to end with the REAL
// outer update-attempt lock and the REAL shared contender, and writes a
// genuine attempt record to disk so the contention this bug is about is
// real, not mocked away.
//
// HOME is redirected to a private temp dir BEFORE anything reads it (in
// addition to `vitest.setup.ts`'s file-wide isolation): `store/paths` binds
// `homedir()` at module load, and replacing only its `hostHomeDir` export is
// NOT isolation - other path helpers call the module's own `hostHomeDir`, so
// a start that got past the contender would read (and could act on) this
// machine's REAL `~/.traycer/host`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-service-start-over-test-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

const mocks = vi.hoisted(() => ({
  readHostInstallRecordMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
}));

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

import { buildServiceStartCommand } from "../service-start";
import type { CommandContext } from "../../runner/runner";
import { atServiceSpawnEdge } from "../../service/spawn-edge";
import {
  consumeHostStartAdoption,
  readHostStartAdoptionNonce,
} from "../../host/host-start-adoption";
import { hostHomeDir } from "../../store/paths";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { ServiceLabel } from "../../service";

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

// Mirrors `attempt-record-test-support.ts`'s `attemptRecord()` fixture, and
// the inline copy in `provision-start-over-update-attempt.test.ts` -
// copied here (rather than imported across `host/__tests__` and
// `commands/__tests__`) so this file's on-disk shape is self-contained.
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
 * (self-supervisor style) - the same shape as the sibling suite's `startCapableController`
 * in `provision-start-over-update-attempt.test.ts`. */
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

interface RecordedInfoLog {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

function fakeCtx(infoLog: RecordedInfoLog[]): CommandContext {
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
        info: (message, fields) => {
          infoLog.push({ message, fields: fields as Record<string, unknown> });
        },
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

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
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
  // The updater died between its pre-swap stop and `applying` (RCA
  // forced-host-update-stuck-restart, 2026-10-09): the record is
  // pre-placement, unheld, and has not been written for longer than
  // `RECOMMENDED_ATTEMPT_STALENESS_MS`, so it is interrupted and the start
  // brings up the INSTALLED bytes beside it.
  {
    name: "interrupted (preparing / active / resume-apply, stale, no live holder)",
    overrides: () => ({
      phase: "preparing",
      execution: "active",
      continuation: "resume-apply",
      targetVersion: "9.9.9",
      updatedAt: minutesAgo(3),
    }),
  },
  {
    name: "interrupted (preparing / active / null, stale, no live holder)",
    overrides: () => ({
      phase: "preparing",
      execution: "active",
      continuation: null,
      targetVersion: "9.9.9",
      updatedAt: minutesAgo(3),
    }),
  },
  {
    name: "interrupted (downloading / active, stale, no live holder)",
    overrides: () => ({
      phase: "downloading",
      execution: "active",
      continuation: null,
      targetVersion: "9.9.9",
      updatedAt: minutesAgo(3),
    }),
  },
];

const PID_VARIANTS: readonly PidVariant[] = ["teardown", "reboot"];

const MATRIX = RECORD_CASES.flatMap((recordCase) =>
  PID_VARIANTS.map((variant) => ({ recordCase, variant })),
);

describe("buildServiceStartCommand - the explicit start, over a standing update-attempt record", () => {
  for (const { recordCase, variant } of MATRIX) {
    it(`${recordCase.name} / ${variant}: succeeds through the same supervisor-relaunch exemption host ensure uses, leaving the record untouched`, async () => {
      const hostHomeDirPath = await freshHome();
      const installRecord = sampleInstallRecord(INSTALLED_VERSION);
      mocks.readHostInstallRecordMock.mockResolvedValue(installRecord);
      mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
      const { controller, calls } = startCapableController();
      mocks.createServiceControllerMock.mockReturnValue(controller);
      await setUpPidVariant(hostHomeDirPath, variant);
      const installGeneration = encodeInstallGeneration(installRecord);
      const overrides = recordCase.overrides(installGeneration);
      await writeAttemptRecord(hostHomeDirPath, overrides);
      const written = attemptRecord(overrides);
      const beforeBytes = await readAttemptRecordBytes(hostHomeDirPath);
      const infoLog: RecordedInfoLog[] = [];

      const result = await buildServiceStartCommand({
        lifecycleOrigin: "terminal",
      })(fakeCtx(infoLog));

      expect(result.exitCode).toBe(0);
      expect(calls.start).toBe(1);
      const afterBytes = await readAttemptRecordBytes(hostHomeDirPath);
      expect(afterBytes).toBe(beforeBytes);
      // The mechanism, not just the end state: the start ran under the
      // supervisor-relaunch admission BESIDE the standing record, and said
      // so - never silently.
      const beside = infoLog.filter(
        (entry) =>
          entry.message ===
          "Service start command is starting the service beside a standing update attempt",
      );
      expect(beside).toHaveLength(1);
      expect(beside[0]?.fields.attemptId).toBe(written.attemptId);
      expect(beside[0]?.fields.phase).toBe(written.phase);
    });
  }

  // Control: a `waiting-to-activate` whose claim generation does NOT match
  // the install record must stay refused - the exemption is the
  // disposition's own identity check, not a blanket bypass for any park.
  // Refused today for an unrelated reason (`service-maintenance` refuses
  // every nonterminal record outright), and must stay refused once the fix
  // adopts the supervisor-relaunch admission, for the real reason this time.
  it("control: a waiting-to-activate record with a MISMATCHED claim generation stays refused, and start is never called", async () => {
    const hostHomeDirPath = await freshHome();
    const installRecord = sampleInstallRecord(INSTALLED_VERSION);
    mocks.readHostInstallRecordMock.mockResolvedValue(installRecord);
    mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
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

    const infoLog: RecordedInfoLog[] = [];
    let err: unknown;
    try {
      await buildServiceStartCommand({ lifecycleOrigin: "terminal" })(
        fakeCtx(infoLog),
      );
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(
      CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
    );
    expect(calls.start).toBe(0);
    expect(
      infoLog.some(
        (entry) =>
          entry.message ===
          "Service start command is starting the service beside a standing update attempt",
      ),
    ).toBe(false);
  });

  // Control: the segment is live and held by ANOTHER holder (this same
  // process, holding the canonical attempt lock outside this command's own
  // acquisition, is indistinguishable from a live foreign holder for this
  // purpose - the shared lock layer refuses re-entrant acquisition either
  // way). The command must stay busy or refused, never proceed.
  it("control: a record whose segment is live and held stays busy, and start is never called", async () => {
    const hostHomeDirPath = await freshHome();
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord(INSTALLED_VERSION),
    );
    mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
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

    const infoLog: RecordedInfoLog[] = [];
    let err: unknown;
    try {
      await buildServiceStartCommand({ lifecycleOrigin: "terminal" })(
        fakeCtx(infoLog),
      );
    } catch (caught) {
      err = caught;
    } finally {
      await held?.release();
    }

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.CLI_LOCK_BUSY);
    expect(calls.start).toBe(0);
    expect(
      infoLog.some(
        (entry) =>
          entry.message ===
          "Service start command is starting the service beside a standing update attempt",
      ),
    ).toBe(false);
  });
  // Controls for the interrupted admission: each keeps today's answer.
  async function startExpectingRefusal(
    overrides: Partial<HostUpdateAttemptRecord>,
  ): Promise<{ readonly err: unknown; readonly starts: number }> {
    const hostHomeDirPath = await freshHome();
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord(INSTALLED_VERSION),
    );
    mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
    const { controller, calls } = startCapableController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeAttemptRecord(hostHomeDirPath, overrides);
    let err: unknown;
    try {
      await buildServiceStartCommand({ lifecycleOrigin: "terminal" })(
        fakeCtx([]),
      );
    } catch (caught) {
      err = caught;
    }
    return { err, starts: calls.start };
  }

  it("control: a preparing / active record written 30 s ago stays refused - an updater between writes may still be alive", async () => {
    const { err, starts } = await startExpectingRefusal({
      phase: "preparing",
      execution: "active",
      continuation: "resume-apply",
      targetVersion: "9.9.9",
      updatedAt: new Date(Date.now() - 30_000).toISOString(),
    });

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(
      CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
    );
    expect(starts).toBe(0);
  });

  it("control: a stale applying / active record stays refused - byte placement keeps today's answer at any age", async () => {
    const { err, starts } = await startExpectingRefusal({
      phase: "applying",
      execution: "active",
      continuation: null,
      targetVersion: "9.9.9",
      updatedAt: minutesAgo(3),
    });

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(
      CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
    );
    expect(starts).toBe(0);
  });

  it("control: a stale preparing / active record whose attempt lock is HELD stays busy, and start is never called", async () => {
    const hostHomeDirPath = await freshHome();
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord(INSTALLED_VERSION),
    );
    mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
    const { controller, calls } = startCapableController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "preparing",
      execution: "active",
      continuation: "resume-apply",
      targetVersion: "9.9.9",
      updatedAt: minutesAgo(3),
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

    let err: unknown;
    try {
      await buildServiceStartCommand({ lifecycleOrigin: "terminal" })(
        fakeCtx([]),
      );
    } catch (caught) {
      err = caught;
    } finally {
      await held?.release();
    }

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(CLI_ERROR_CODES.CLI_LOCK_BUSY);
    expect(calls.start).toBe(0);
  });
});
