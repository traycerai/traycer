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
  updateAttemptRecordPath,
  type HostUpdateAttemptRecord,
} from "@traycer-clients/shared/host-update";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import type { HostInstallRecord } from "@traycer/protocol/config/installation-records";

// A `host ensure` reaching provisionHost's START-ONLY branch
// (installed + registered + not running) while a nonterminal update-attempt
// record stands - either PARKED (`waiting-for-work` / `waiting-to-activate`)
// or INTERRUPTED (e.g. `restarting`, execution `active`, continuation
// `activate`, no live holder) - must not refuse forever. On head,
// `provisionHost`'s outer segment takes admission `legacy-update-shadow`
// (`provision.ts:343-350`), which YIELDS to ANY nonterminal record, so
// `host ensure` throws `E_HOST_UPDATE_ATTEMPT_ACTIVE` on every retry and the
// host never starts.
//
// This suite drives `provisionHost` end to end with the REAL outer
// update-attempt lock and the REAL shared contender, and writes a genuine
// attempt record to disk so the contention this bug is about is real, not
// mocked away.
//
// HOME is redirected to a private temp dir BEFORE anything reads it:
// `store/paths` binds `homedir()` at module load. Replacing only its
// `hostHomeDir` export is NOT isolation - `hostPidMetadataPath`,
// `hostStopIntentPath`, `bootstrapLogPath` and the rest call the module's own
// `hostHomeDir`, so a start that got past the contender would read (and could
// act on) this machine's REAL `~/.traycer/host`. The dir is made inside the
// `node:os` factory, so it exists before the first module that asks for
// `homedir()` is evaluated.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-provision-start-over-test-"),
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

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

import { provisionHost, type ProvisionHostOptions } from "../provision";
import { atServiceSpawnEdge } from "../../service/spawn-edge";
import {
  consumeHostStartAdoption,
  readHostStartAdoptionNonce,
} from "../host-start-adoption";
import { hostHomeDir, hostPidMetadataPathIn } from "../../store/paths";
import { noopLogger } from "../../logger";
import type { RuntimeContext } from "../../runner/runtime";
import { CLI_ERROR_CODES } from "../../runner/errors";
import type { HostStartOrigin } from "../lifecycle-origin";

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

/** The one host home every path helper resolves to, emptied per test. */
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
const SERVICE_LABEL = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production" as const,
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

// Mirrors `attempt-record-test-support.ts`'s `attemptRecord()` fixture - the
// same shape `host-restart.test.ts` drives the real shared contender with -
// copied here (rather than imported across `commands/__tests__` and
// `host/__tests__`) so this file's on-disk shape is self-contained.
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

// (B): a stale `pid.json` naming a DEFINITELY dead pid, surviving a reboot.
// Only the fields `readHostPidMetadata` requires; `publishedHostProcessGone`
// reads a dead/unassigned pid as gone, so this is "no live host" either way.
async function writeStalePidMetadata(hostHomeDirPath: string): Promise<void> {
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

interface FakeControllerCalls {
  install: number;
  start: number;
  status: number;
}

interface FakeControllerHandle {
  readonly controller: unknown;
  readonly calls: FakeControllerCalls;
  readonly publishedOrigin: { value: HostStartOrigin | null | "none" };
}

/** installed + registered + NOT running, whose `start` really reaches the
 * spawn edge and satisfies its own adoption proof (self-supervisor style),
 * so a published proof's `origin` can actually be observed from disk. */
function startCapableController(): FakeControllerHandle {
  const calls: FakeControllerCalls = { install: 0, start: 0, status: 0 };
  const publishedOrigin: { value: HostStartOrigin | null | "none" } = {
    value: "none",
  };
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
      install: async () => {
        calls.install += 1;
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
          publishedOrigin.value = consumed.grant.origin;
          await consumed.grant.acknowledgeSpawn();
        }
      },
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    },
    calls,
    publishedOrigin,
  };
}

interface RecordedInfoLog {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

function makeRuntime(infoLog: RecordedInfoLog[]): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: {
      ...noopLogger,
      info: (message, fields) => {
        infoLog.push({ message, fields: fields as Record<string, unknown> });
      },
    },
  };
}

function makeOpts(
  overrides: Partial<ProvisionHostOptions>,
  infoLog: RecordedInfoLog[],
): ProvisionHostOptions {
  return {
    runtime: makeRuntime(infoLog),
    resolveInstallSource: () => {
      throw new Error("install branch must not be reached in this suite");
    },
    satisfaction: { kind: "exact", version: INSTALLED_VERSION },
    recordVersionOverride: null,
    enableLinger: true,
    allowSelfInvocation: true,
    registerService: true,
    lockReason: "test-provision-start-over-update-attempt",
    onProgress: null,
    force: false,
    acceptStoreFormatLoss: false,
    yankLookup: {
      isVersionYanked: async () => {
        throw new Error("yank lookup must not be reached in this suite");
      },
    },
    holdExplicitDowngrade: false,
    adoption: undefined,
    lifecycleOrigin: "desktop",
    beforeMutate: null,
    supervisorRelaunchWait: null,
    ...overrides,
  };
}

type PidVariant = "teardown" | "reboot";

async function setUpPidVariant(
  hostHomeDirPath: string,
  variant: PidVariant,
): Promise<void> {
  if (variant === "reboot") {
    await writeStalePidMetadata(hostHomeDirPath);
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

describe("provisionHost - the start-only branch, over a standing update-attempt record", () => {
  for (const { recordCase, variant } of MATRIX) {
    it(`${recordCase.name} / ${variant}: resolves "started" through the same exemption host-start.ts uses, leaving install/register and the record untouched`, async () => {
      const hostHomeDirPath = await freshHome();
      const installRecord = sampleInstallRecord(INSTALLED_VERSION);
      mocks.readHostInstallRecordMock.mockResolvedValue(installRecord);
      mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
      const { controller, calls, publishedOrigin } = startCapableController();
      mocks.createServiceControllerMock.mockReturnValue(controller);
      await setUpPidVariant(hostHomeDirPath, variant);
      const installGeneration = encodeInstallGeneration(installRecord);
      const overrides = recordCase.overrides(installGeneration);
      await writeAttemptRecord(hostHomeDirPath, overrides);
      const written = attemptRecord(overrides);
      const beforeBytes = await readAttemptRecordBytes(hostHomeDirPath);
      const infoLog: RecordedInfoLog[] = [];

      const result = await provisionHost(makeOpts({}, infoLog));

      expect(result.action).toBe("started");
      expect(calls.start).toBe(1);
      expect(publishedOrigin.value).toBe("desktop");
      expect(calls.install).toBe(0);
      const afterBytes = await readAttemptRecordBytes(hostHomeDirPath);
      expect(afterBytes).toBe(beforeBytes);
      // The mechanism, not just the end state: the start ran under the
      // supervisor-relaunch admission BESIDE the standing record, and said
      // so - never silently.
      const beside = infoLog.filter(
        (entry) =>
          entry.message ===
          "Host provisioning is starting the installed host beside a standing update attempt",
      );
      expect(beside).toHaveLength(1);
      expect(beside[0]?.fields.attemptId).toBe(written.attemptId);
      expect(beside[0]?.fields.phase).toBe(written.phase);
    });
  }

  // Control: a `waiting-to-activate` whose claim generation does NOT match
  // the install record must stay refused - the exemption is the
  // disposition's own identity check, not a blanket bypass for any park.
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

    await expect(provisionHost(makeOpts({}, []))).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
      details: expect.objectContaining({ disposition: "yield" }),
    });

    expect(calls.start).toBe(0);
    expect(calls.install).toBe(0);
  });

  // Control: a `waiting-for-work` record admits a plain RELAUNCH, never an
  // INSTALL - a state that is not already start-only (nothing installed)
  // must stay refused rather than have the exemption smuggle an install
  // through it.
  it("control: not installed under a waiting-for-work record stays refused, with no install attempted", async () => {
    const hostHomeDirPath = await freshHome();
    mocks.readHostInstallRecordMock.mockResolvedValue(null);
    mocks.serviceLabelForMock.mockReturnValue(SERVICE_LABEL);
    const { controller, calls } = startCapableController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      targetVersion: "9.9.9",
    });

    await expect(
      provisionHost(
        makeOpts(
          {
            resolveInstallSource: () => {
              throw new Error(
                "install branch must not be reached: the exemption must not admit an install",
              );
            },
          },
          [],
        ),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
      details: expect.objectContaining({ disposition: "yield" }),
    });

    expect(calls.install).toBe(0);
    expect(calls.start).toBe(0);
  });
});
