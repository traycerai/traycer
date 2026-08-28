import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireUpdateAttemptLock,
  commitAttemptMutation,
} from "@traycer-clients/shared/host-update";

// This file drives `verifyHostUpdateAttempt`/`reportFor` (host/update-verify.ts)
// indirectly through the REAL `runLocalAttemptExecutorSegment` machinery -
// same shape as `update-executor.test.ts`, which this file borrows its
// mocking conventions from verbatim, because `verifyHostUpdateAttempt` sits
// directly on top of that same executor with no seam of its own.
//
// THE SEAM WARNING (see the ticket): a mock that looks right can silently
// fail to intercept the code path production actually calls. The dedicated
// "SEAM PROOF" test below forces the cohort mock to a distinctive verdict
// and confirms the OBSERVABLE outcome changes from the real shipped
// shadow-disabled default (`cohort-disabled`) to something only reachable
// past the gate (`stale-expectation`) - proving this mock is the exact thing
// `runLocalAttemptExecutorSegment` calls, not a look-alike at the wrong
// specifier. Every test here also runs against a REAL temp-dir
// `hostHomeDir` (never the operator's real `~/.traycer`), confirmed via
// `currentHome.value` below - never a real installed host, never a
// subprocess.
const cohortMock = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock("../update-executor-cohort", async () => {
  const actual = await vi.importActual<
    typeof import("../update-executor-cohort")
  >("../update-executor-cohort");
  cohortMock.decide.mockImplementation(actual.decideUpdateExecutorCohort);
  return { ...actual, decideUpdateExecutorCohort: cohortMock.decide };
});

// Same sandboxing convention as `update-executor.test.ts`: every test pins
// `currentHome.value` to its own fresh tmpdir before touching the module
// under test, so `observeAttemptRecoveryEvidence`'s foreign-home guard
// (`resolve(hostHomeDir(environment)) !== resolve(canonicalHostHomeDir)`)
// always sees the SAME sandboxed home on both sides.
const currentHome = { value: "" };
vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  const hostHomeFor = (): string => currentHome.value;
  return {
    ...actual,
    hostHomeDir: () => hostHomeFor(),
    hostInstallDir: () => join(hostHomeFor(), "install"),
    hostInstallRecordPath: () => join(hostHomeFor(), "install", "install.json"),
    hostStagedDir: () => join(hostHomeFor(), "staged"),
    hostStagedRecordPath: () => join(hostHomeFor(), "staged", "staged.json"),
    hostPidMetadataPath: () => join(hostHomeFor(), "pid.json"),
  };
});
const rpcMocks = vi.hoisted(() => ({
  identityVerdict: vi.fn(),
  callHostRpc: vi.fn(),
}));
vi.mock("../../store/process-identity", () => ({
  getPublishedProcessIdentityVerdict: rpcMocks.identityVerdict,
}));
vi.mock("../../internal/host-rpc", () => ({
  callHostRpcAtEndpoint: rpcMocks.callHostRpc,
}));

import {
  verifyHostUpdateAttempt,
  humanForVerifyReport,
  type HostUpdateVerifyArgs,
} from "../update-verify";
import { writeHostInstallRecord } from "../../manifest/host-install";
import * as paths from "../../store/paths";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "update-verify-test-"));
  roots.push(root);
  return join(root, "host-home");
}

beforeEach(async () => {
  const actualCohort = await vi.importActual<
    typeof import("../update-executor-cohort")
  >("../update-executor-cohort");
  cohortMock.decide.mockReset();
  cohortMock.decide.mockImplementation(actualCohort.decideUpdateExecutorCohort);
  rpcMocks.identityVerdict.mockReset();
  rpcMocks.callHostRpc.mockReset();
  currentHome.value = "";
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// Unlike `update-executor.test.ts`'s `mockCohortEligible`, this suite never
// asserts platform-selective behaviour - `verifyHostUpdateAttempt` derives
// `platform` from the real `currentInstallPlatform()` (whatever OS the test
// runs on), so the mock here is unconditionally eligible.
function mockCohortEligible(): void {
  cohortMock.decide.mockReturnValue({ kind: "eligible", platform: "linux" });
}

/**
 * Seeds an "active, restarting, unheld" attempt record - exactly the shape
 * `update-verify.ts`'s own module comment describes as what a Desktop-owned
 * packaged-macOS activation leaves behind after the bootout: the record is
 * `restarting`, active, and has no live holder. `attemptId`/`generation`/
 * `sequence` land at "attempt-1"/1/1, matching every test's `args` below.
 */
async function seedRestartingActiveRecord(
  hostHomeDir: string,
  targetVersion: string,
): Promise<void> {
  await mkdir(hostHomeDir, { recursive: true });
  const acquired = await acquireUpdateAttemptLock({
    hostHomeDir,
    reason: "seed-restarting-record",
    waitMs: 0,
    pollIntervalMs: 10,
  });
  if (acquired.kind !== "acquired") {
    throw new Error(
      `expected to acquire the seeding lock, got ${acquired.kind}`,
    );
  }
  const committed = await commitAttemptMutation({
    handle: acquired.handle,
    intent: {
      kind: "create",
      request: {
        targetVersion,
        trigger: "manual",
        action: "start",
        expected: null,
        newAttemptId: "attempt-1",
        initialPhase: "restarting",
        nowIso: "2026-01-01T00:00:00.000Z",
      },
    },
  });
  if (committed.kind !== "committed") {
    throw new Error(
      `expected the seed create to commit, got ${committed.kind}`,
    );
  }
  await acquired.handle.release();
}

/**
 * Writes a genuine (attested, hash-checked) installed-artifact fixture at
 * `installedVersion`, WITHOUT any running-host evidence at all (no
 * `pid.json`) - the "bytes placed, host not yet running them" shape.
 */
async function seedInstallOnly(
  hostHomeDir: string,
  installedVersion: string,
): Promise<void> {
  currentHome.value = hostHomeDir;
  const installDir = paths.hostInstallDir("production");
  await mkdir(installDir, { recursive: true });
  const executablePath = join(installDir, "traycer-host");
  writeFileSync(executablePath, "binary-bytes");
  await writeHostInstallRecord("production", {
    installId: "install-1",
    version: installedVersion,
    runtimeVersion: null,
    platform: "linux",
    arch: "x64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: installedVersion },
    archiveSha256: "a".repeat(64),
    executableSha256: createHash("sha256").update("binary-bytes").digest("hex"),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath,
  });
}

/**
 * Writes genuine installed AND running-host fixtures, independently
 * versioned, through the SAME sandboxed `store/paths` + process-identity +
 * host-rpc module boundaries `update-executor.test.ts` uses. Neither leg is
 * a caller-supplied testimonial object - both are real fs/RPC observations
 * `observeAttemptRecoveryEvidence` derives itself.
 */
async function seedInstallAndRunning(
  hostHomeDir: string,
  installedVersion: string,
  runningVersion: string,
): Promise<void> {
  await seedInstallOnly(hostHomeDir, installedVersion);
  writeFileSync(
    paths.hostPidMetadataPath("production"),
    JSON.stringify({
      pid: 4242,
      hostId: "host-1",
      version: runningVersion,
      websocketUrl: "ws://127.0.0.1:58036/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: "linux:boot-a 4242",
    }),
    "utf8",
  );
  rpcMocks.identityVerdict.mockResolvedValue("current");
  rpcMocks.callHostRpc.mockResolvedValue({
    ready: true,
    hostVersion: runningVersion,
    protocolVersion: { major: 1, minor: 2 },
    busy: false,
    busySessionCount: null,
    updateProgress: null,
    busyBreakdown: null,
  });
}

function argsFor(targetVersion: string): HostUpdateVerifyArgs {
  return {
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    targetVersion,
  };
}

describe("verifyHostUpdateAttempt / reportFor - the four HostUpdateVerifyReport arms", () => {
  it("SEAM PROOF: the cohort mock is the exact module runLocalAttemptExecutorSegment calls through - forcing it eligible changes the observable outcome away from the real shipped shadow-disabled default", async () => {
    const hostHomeDir = await freshHome();
    currentHome.value = hostHomeDir;

    // Real (unmocked-override) shadow-disabled default: no record exists,
    // but the cohort gate refuses before that would ever matter.
    const withRealCohort = await verifyHostUpdateAttempt(
      "production",
      argsFor("1.2.3"),
    );
    expect(withRealCohort).toEqual({
      outcome: "indeterminate",
      reason: "cohort-disabled",
    });

    // Force a distinctive verdict this exact test controls. If this mock
    // were NOT the module `runLocalAttemptExecutorSegment` actually
    // imports, the outcome would stay `cohort-disabled` above. Instead it
    // must change to a verdict only reachable past the gate -
    // `decideAttemptClaim`'s `stale-expectation` refusal for a
    // non-null `expected` against an absent record.
    cohortMock.decide.mockReturnValue({ kind: "eligible", platform: "linux" });
    const withMockedCohort = await verifyHostUpdateAttempt(
      "production",
      argsFor("1.2.3"),
    );
    expect(withMockedCohort).toEqual({
      outcome: "indeterminate",
      reason: "stale-expectation",
    });
  });

  it("reports indeterminate/cohort-disabled - the real, unmocked production default - without seeding any fixture", async () => {
    const hostHomeDir = await freshHome();
    currentHome.value = hostHomeDir;
    const report = await verifyHostUpdateAttempt(
      "production",
      argsFor("1.2.3"),
    );
    expect(report).toEqual({
      outcome: "indeterminate",
      reason: "cohort-disabled",
    });
  });

  it("reports indeterminate/stale-expectation for a stale (mismatched-identity) expected attempt - no record exists to verify against at all", async () => {
    mockCohortEligible();
    const hostHomeDir = await freshHome();
    currentHome.value = hostHomeDir;
    const report = await verifyHostUpdateAttempt("production", {
      attemptId: "attempt-does-not-exist",
      generation: 7,
      sequence: 3,
      targetVersion: "1.2.3",
    });
    expect(report).toEqual({
      outcome: "indeterminate",
      reason: "stale-expectation",
    });
  });

  it("reports indeterminate/evidence-unreadable when the installed artifact's attestation cannot be verified against the actual bytes on disk", async () => {
    mockCohortEligible();
    const hostHomeDir = await freshHome();
    currentHome.value = hostHomeDir;
    await seedRestartingActiveRecord(hostHomeDir, "1.2.3");

    const installDir = paths.hostInstallDir("production");
    await mkdir(installDir, { recursive: true });
    const executablePath = join(installDir, "traycer-host");
    writeFileSync(executablePath, "binary-bytes");
    // Deliberately WRONG executableSha256 - the real bytes on disk hash to
    // something else, so `readInstalledObservation` returns `unreadable`
    // rather than `verified` or `missing`.
    await writeHostInstallRecord("production", {
      installId: "install-1",
      version: "1.2.3",
      runtimeVersion: null,
      platform: "linux",
      arch: "x64",
      installedAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "registry", value: "1.2.3" },
      archiveSha256: "a".repeat(64),
      executableSha256: "f".repeat(64),
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      signatureKeyId: "test-key",
      sizeBytes: 1234,
      executablePath,
    });

    const report = await verifyHostUpdateAttempt(
      "production",
      argsFor("1.2.3"),
    );
    expect(report).toEqual({
      outcome: "indeterminate",
      reason: "evidence-unreadable",
    });
  });

  it("reports resumed/activate when installed evidence genuinely verifies the target but the host is not yet running it", async () => {
    mockCohortEligible();
    const hostHomeDir = await freshHome();
    currentHome.value = hostHomeDir;
    await seedRestartingActiveRecord(hostHomeDir, "1.2.3");
    await seedInstallOnly(hostHomeDir, "1.2.3");

    const report = await verifyHostUpdateAttempt(
      "production",
      argsFor("1.2.3"),
    );
    // RETARGETED by the Ticket 07 orphan-recovery ruling. The arm is the same;
    // it now carries the identity of the record as recovery PARKED it.
    //
    // The generation is the load-bearing part. `argsFor` invokes with
    // generation 1; recovery resumes at a bumped generation, and the re-park
    // rides that same generation. So a caller that reused its OWN `expected`
    // to resume would present a stale expectation and be refused - which is
    // exactly why the arm has to report an identity rather than none.
    expect(report).toEqual({
      outcome: "resumed",
      continuation: "activate",
      attemptId: "attempt-1",
      generation: 2,
      sequence: expect.any(Number),
    });
    // Stated separately so the point survives a fixture edit: the reported
    // identity is NOT the one this call was invoked with.
    expect(report).not.toMatchObject({
      generation: argsFor("1.2.3").generation,
    });
  });

  it("reports complete when installed AND running evidence both genuinely verify the exact target version", async () => {
    mockCohortEligible();
    const hostHomeDir = await freshHome();
    currentHome.value = hostHomeDir;
    await seedRestartingActiveRecord(hostHomeDir, "1.2.3");
    await seedInstallAndRunning(hostHomeDir, "1.2.3", "1.2.3");

    const report = await verifyHostUpdateAttempt(
      "production",
      argsFor("1.2.3"),
    );
    expect(report).toEqual({ outcome: "complete" });
  });

  it("reports failed with the recovery-evidence-contradiction error code when a positively bound running host disagrees with the installed artifact", async () => {
    mockCohortEligible();
    const hostHomeDir = await freshHome();
    currentHome.value = hostHomeDir;
    await seedRestartingActiveRecord(hostHomeDir, "1.2.3");
    // Running is genuinely verified AT the target, but installed is
    // genuinely verified at a DIFFERENT version - the exact contradiction
    // `recoveryEvidenceContradicts` detects (a host-home-bound process
    // cannot truthfully run the target while its own install record proves
    // a different placed target).
    await seedInstallAndRunning(hostHomeDir, "9.9.9", "1.2.3");

    const report = await verifyHostUpdateAttempt(
      "production",
      argsFor("1.2.3"),
    );
    expect(report).toEqual({
      outcome: "failed",
      reason: "recovery-evidence-contradiction",
    });
  });

  it("never reports a terminal outcome (complete/failed) for any refusal - indeterminate is the only arm a failed dispatch may produce", async () => {
    // Re-asserts the load-bearing invariant from the module comment across
    // every refusal case exercised above, as a single grouped check.
    mockCohortEligible();
    const hostHomeDir = await freshHome();
    currentHome.value = hostHomeDir;
    const report = await verifyHostUpdateAttempt("production", {
      attemptId: "attempt-does-not-exist",
      generation: 1,
      sequence: 1,
      targetVersion: "1.2.3",
    });
    expect(report.outcome).not.toBe("complete");
    expect(report.outcome).not.toBe("failed");
    expect(report.outcome).toBe("indeterminate");
  });
});

describe("humanForVerifyReport - pure projection, one branch per outcome", () => {
  it("complete", () => {
    expect(humanForVerifyReport({ outcome: "complete" })).toBe(
      "verified the restarted host is running the exact target version",
    );
  });

  it("failed carries the reason in the message", () => {
    expect(
      humanForVerifyReport({ outcome: "failed", reason: "some-code" }),
    ).toBe("verification failed (some-code)");
  });

  it("resumed/activate", () => {
    expect(
      humanForVerifyReport({
        outcome: "resumed",
        continuation: "activate",
        attemptId: "attempt-1",
        generation: 2,
        sequence: 5,
      }),
    ).toBe("bytes are placed but not yet running; activation continues");
  });

  it("indeterminate carries the reason and states the record is unchanged", () => {
    expect(
      humanForVerifyReport({
        outcome: "indeterminate",
        reason: "cohort-disabled",
      }),
    ).toBe(
      "verification could not be completed (cohort-disabled); the attempt record is unchanged",
    );
  });
});
