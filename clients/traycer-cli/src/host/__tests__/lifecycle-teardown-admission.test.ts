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

// The supervisor's Linked-mode lifecycle teardown
// (`createLifecycleTeardownPlatform().withLock`, `update-mutation.ts`
// ~591-610) takes its lock under admission `lifecycle-teardown-maintenance`.
// `lifecycleTeardownDisposition` (`clients/shared/host-update/contender.ts`
// ~1356) admits EVERY `waiting-to-activate` record unconditionally, with no
// claim/install check at all - unlike `supervisorRelaunchDisposition`
// (~1458-1487), which judges every later start against that record and
// REFUSES a `waiting-to-activate` whose claim is missing, whose claim
// generation disagrees with the installed one, or whose installed version
// disagrees with the claim or the target. So the teardown can stop a host
// that nothing can ever start again: it admits parks that the very next
// start (supervisor relaunch, or `host ensure`) would refuse.
//
// The review's ruling: the teardown should admit `waiting-to-activate` only where
// `supervisorRelaunchDisposition` would. This suite drives the REAL
// `createLifecycleTeardownPlatform().withLock("production", run)` against a
// real attempt record on disk, proving today's over-admission (b1-b4, RED)
// and pinning the shapes that are already correct on both sides of the fix
// (b5-b8, GREEN guards).
//
// HOME is redirected to a private temp dir BEFORE anything reads it -
// `withLock` reaches the real outer attempt lock and `hostHomeDir()`, same
// reasoning as `cli-finalize-upgrade-over-update-attempt.test.ts`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = mkdtempSync(
      join(actual.tmpdir(), "traycer-lifecycle-teardown-admission-test-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

const mocks = vi.hoisted(() => ({
  readHostInstallRecordMock: vi.fn(),
}));

// Same seam `cli-finalize-upgrade-over-update-attempt.test.ts` mocks: the
// CLI-side reader `readSupervisorRelaunchInstalledIdentity`
// (`update-contender.ts`) calls straight through to this, so a real install
// record never needs to be staged on disk in the exact bytes
// `readHostInstallRecord`'s own decoder expects.
vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

import { createLifecycleTeardownPlatform } from "../update-mutation";
import type { TeardownAttemptResult } from "../lifecycle-teardown";
import { CLI_ERROR_CODES, type CliError } from "../../runner/errors";
import { hostHomeDir } from "../../store/paths";

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(hostHomeDir("production"), { recursive: true, force: true });
});

const INSTALLED_VERSION = "2.0.0";

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

// Copied inline, same base shape as
// `cli-finalize-upgrade-over-update-attempt.test.ts`'s `attemptRecord`.
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

async function runTeardown(): Promise<{
  readonly ran: boolean;
  readonly error: CliError | null;
}> {
  let ran = false;
  const run = async (
    _verify: () => Promise<void>,
  ): Promise<TeardownAttemptResult> => {
    ran = true;
    return { kind: "complete" };
  };
  try {
    await createLifecycleTeardownPlatform().withLock("production", run);
    return { ran, error: null };
  } catch (cause) {
    return { ran, error: cause as CliError };
  }
}

describe("createLifecycleTeardownPlatform().withLock - admission over a standing update-attempt record", () => {
  it("(b1) waiting-to-activate with NO claim: refused, run never called", async () => {
    const hostHomeDirPath = hostHomeDir("production");
    const installRecord = sampleInstallRecord(INSTALLED_VERSION);
    mocks.readHostInstallRecordMock.mockResolvedValue(installRecord);
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "waiting-to-activate",
      execution: "parked",
      continuation: "activate",
      targetVersion: INSTALLED_VERSION,
      // No `claim` at all - the shape the real decoder accepts for a park
      // (`parseClaimBaseline` is not phase-gated), and the exact shape
      // `supervisorRelaunchDisposition` refuses ("A claim-less park is
      // REFUSED, deliberately").
    });

    const { ran, error } = await runTeardown();

    expect(ran).toBe(false);
    expect(error?.code).toBe(CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE);
  });

  it("(b2) waiting-to-activate, claim installGeneration mismatched: refused, run never called", async () => {
    const hostHomeDirPath = hostHomeDir("production");
    const installRecord = sampleInstallRecord(INSTALLED_VERSION);
    mocks.readHostInstallRecordMock.mockResolvedValue(installRecord);
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

    const { ran, error } = await runTeardown();

    expect(ran).toBe(false);
    expect(error?.code).toBe(CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE);
  });

  it("(b3) waiting-to-activate, claim matches the shape, install record ABSENT: refused, run never called", async () => {
    const hostHomeDirPath = hostHomeDir("production");
    mocks.readHostInstallRecordMock.mockResolvedValue(null);
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "waiting-to-activate",
      execution: "parked",
      continuation: "activate",
      targetVersion: INSTALLED_VERSION,
      claim: {
        installedVersion: INSTALLED_VERSION,
        installGeneration: encodeInstallGeneration(
          sampleInstallRecord(INSTALLED_VERSION),
        ),
        stageFingerprint: null,
        allowDowngrade: false,
        acceptStoreFormatLoss: false,
      },
    });

    const { ran, error } = await runTeardown();

    expect(ran).toBe(false);
    expect(error?.code).toBe(CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE);
  });

  it("(b4) waiting-to-activate, claim matches the install record, but installed version != target: refused, run never called", async () => {
    const hostHomeDirPath = hostHomeDir("production");
    const installRecord = sampleInstallRecord(INSTALLED_VERSION);
    mocks.readHostInstallRecordMock.mockResolvedValue(installRecord);
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "waiting-to-activate",
      execution: "parked",
      continuation: "activate",
      // The target this park is FOR is not the version actually installed -
      // the claim still names the installed identity faithfully, so only the
      // target/installed mismatch triggers the refusal.
      targetVersion: "9.9.9",
      claim: {
        installedVersion: INSTALLED_VERSION,
        installGeneration: encodeInstallGeneration(installRecord),
        stageFingerprint: null,
        allowDowngrade: false,
        acceptStoreFormatLoss: false,
      },
    });

    const { ran, error } = await runTeardown();

    expect(ran).toBe(false);
    expect(error?.code).toBe(CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE);
  });

  it("(b5) guard: waiting-to-activate, claim and install match, target == installed: run IS called", async () => {
    const hostHomeDirPath = hostHomeDir("production");
    const installRecord = sampleInstallRecord(INSTALLED_VERSION);
    mocks.readHostInstallRecordMock.mockResolvedValue(installRecord);
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "waiting-to-activate",
      execution: "parked",
      continuation: "activate",
      targetVersion: INSTALLED_VERSION,
      claim: {
        installedVersion: INSTALLED_VERSION,
        installGeneration: encodeInstallGeneration(installRecord),
        stageFingerprint: null,
        allowDowngrade: false,
        acceptStoreFormatLoss: false,
      },
    });

    const { ran, error } = await runTeardown();

    expect(error).toBeNull();
    expect(ran).toBe(true);
  });

  it("(b6) guard: waiting-for-work: run IS called", async () => {
    const hostHomeDirPath = hostHomeDir("production");
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord(INSTALLED_VERSION),
    );
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      targetVersion: "9.9.9",
    });

    const { ran, error } = await runTeardown();

    expect(error).toBeNull();
    expect(ran).toBe(true);
  });

  it("(b7) guard: downloading (a live, non-parked phase): refused, run never called", async () => {
    const hostHomeDirPath = hostHomeDir("production");
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord(INSTALLED_VERSION),
    );
    await writeAttemptRecord(hostHomeDirPath, {
      phase: "downloading",
      execution: "active",
      continuation: null,
      targetVersion: "9.9.9",
    });

    const { ran, error } = await runTeardown();

    expect(ran).toBe(false);
    expect(error?.code).toBe(CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE);
  });

  it("(b8) guard: no record at all: run IS called", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord(INSTALLED_VERSION),
    );

    const { ran, error } = await runTeardown();

    expect(error).toBeNull();
    expect(ran).toBe(true);
  });
});
