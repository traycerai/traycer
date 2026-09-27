import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import type { HostUpdateAttemptRecord } from "@traycer-clients/shared/host-update";
import type { HostInstallRecord } from "../../manifest/host-install";

// `parkedActivationRelaunchable` (`host/parked-activation-relaunch.ts`) is
// the shared predicate `host restart` and `host free-port-and-restart` both
// call before treating a `stop-only` record as continuable rather than a
// hazard to stop and leave alone. These are its own direct unit tests,
// against a real install record on disk (sandboxed HOME) rather than a
// stubbed reader - the claim under test includes that it reads the SAME
// record `readHostInstallRecord` would.

// `store/paths` binds its home root from `os.homedir()` at module load -
// mirrors `host-restart.test.ts`'s identical fixture.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

function attemptRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "1.7.0",
    phase: "waiting-to-activate",
    execution: "parked",
    continuation: "activate",
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

async function writeInstallRecord(): Promise<HostInstallRecord> {
  const { writeHostInstallRecord } =
    await import("../../manifest/host-install");
  const record: HostInstallRecord = {
    installId: "parked-relaunch-attestation-install",
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

describe("parkedActivationRelaunchable", () => {
  beforeEach(() => {
    workHome = mkdtempSync(
      join(tmpdir(), "traycer-parked-activation-relaunch-test-"),
    );
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    // `store/paths` captures `homedir()` once at module load - drop the
    // module cache so each test's dynamic import sees its own tmp HOME.
    vi.resetModules();
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

  it("false for a null record", async () => {
    const { parkedActivationRelaunchable } =
      await import("../parked-activation-relaunch");

    await expect(
      parkedActivationRelaunchable("production", null),
    ).resolves.toBe(false);
  });

  it("false for an ACTIVE record (not parked), even with a claim that would otherwise match", async () => {
    const installed = await writeInstallRecord();
    const { parkedActivationRelaunchable } =
      await import("../parked-activation-relaunch");

    await expect(
      parkedActivationRelaunchable(
        "production",
        attemptRecord({
          phase: "preparing",
          execution: "active",
          claim: {
            installedVersion: "1.7.0",
            installGeneration: encodeInstallGeneration(installed),
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      ),
    ).resolves.toBe(false);
  });

  it("false for a park with a matching claim but NO install record on disk", async () => {
    // Deliberately no `writeInstallRecord()` call.
    const { parkedActivationRelaunchable } =
      await import("../parked-activation-relaunch");

    await expect(
      parkedActivationRelaunchable(
        "production",
        attemptRecord({
          claim: {
            installedVersion: "1.7.0",
            installGeneration: "id:parked-relaunch-attestation-install",
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      ),
    ).resolves.toBe(false);
  });

  it("true for a park whose claim matches the installed bytes", async () => {
    const installed = await writeInstallRecord();
    const { parkedActivationRelaunchable } =
      await import("../parked-activation-relaunch");

    await expect(
      parkedActivationRelaunchable(
        "production",
        attemptRecord({
          claim: {
            installedVersion: "1.7.0",
            installGeneration: encodeInstallGeneration(installed),
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      ),
    ).resolves.toBe(true);
  });

  it("false for a park whose claim disagrees with the installed bytes", async () => {
    const installed = await writeInstallRecord();
    const { parkedActivationRelaunchable } =
      await import("../parked-activation-relaunch");

    await expect(
      parkedActivationRelaunchable(
        "production",
        attemptRecord({
          claim: {
            installedVersion: "1.6.0",
            installGeneration: encodeInstallGeneration(installed),
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      ),
    ).resolves.toBe(false);
  });

  it("false for a claim-less park", async () => {
    await writeInstallRecord();
    const { parkedActivationRelaunchable } =
      await import("../parked-activation-relaunch");

    await expect(
      parkedActivationRelaunchable("production", attemptRecord({})),
    ).resolves.toBe(false);
  });

  // `readHostInstallRecord` throws `HOST_INSTALL_RECORD_INVALID` for a
  // present-but-malformed `install.json`; `parkedActivationRelaunchable`
  // catches exactly that code and answers `null` rather than propagating, so
  // an observational caller (`host status`) does not die on it.
  it("null when the install record file is present but malformed JSON", async () => {
    // No `writeInstallRecord()` call - the file at
    // `hostInstallRecordPath("production")` does not exist yet on a fresh
    // temp HOME, so its parent directory is created explicitly before the
    // malformed bytes are written there.
    const { hostInstallRecordPath } = await import("../../store/paths");
    const path = hostInstallRecordPath("production");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json", "utf8");
    const { parkedActivationRelaunchable } =
      await import("../parked-activation-relaunch");

    await expect(
      parkedActivationRelaunchable(
        "production",
        attemptRecord({
          claim: {
            installedVersion: "1.7.0",
            installGeneration: "id:parked-relaunch-attestation-install",
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      ),
    ).resolves.toBeNull();
  });

  // A DIRECTORY at `hostInstallRecordPath("production")` makes `readFile`
  // throw a real errno (EISDIR), not the ENOENT the reader already maps to
  // "absent". `parkedActivationRelaunchable` must fold that into `null` the
  // same way it folds malformed JSON, so an observational caller does not
  // die on it (traycer#2208 review, Codex P2: only ENOENT was mapped to
  // absent and every other errno used to rethrow).
  it("null when the install record path exists but cannot be read as a file (errno, not ENOENT)", async () => {
    // No `writeInstallRecord()` call - create a directory at the install
    // record's own path instead of a file, so `readHostInstallRecord`'s
    // `readFile` throws EISDIR rather than reading JSON.
    const { hostInstallRecordPath } = await import("../../store/paths");
    const path = hostInstallRecordPath("production");
    mkdirSync(path, { recursive: true });
    const { parkedActivationRelaunchable } =
      await import("../parked-activation-relaunch");

    await expect(
      parkedActivationRelaunchable(
        "production",
        attemptRecord({
          claim: {
            installedVersion: "1.7.0",
            installGeneration: "id:parked-relaunch-attestation-install",
            stageFingerprint: null,
            allowDowngrade: false,
            acceptStoreFormatLoss: false,
          },
        }),
      ),
    ).resolves.toBeNull();
  });
});

// `describeNonterminalRecordRecovery` is the ONE writer of the "what now"
// sentence for `host restart`, `host free-port-and-restart` and `host status`.
// Its first shipped version promised one-step recovery for every park; for a
// park whose install has since changed, `host update` instead terminalizes it
// `failed {install-changed}` and exits without a restart (traycer#2208 review).
describe("describeNonterminalRecordRecovery", () => {
  const claim = {
    installedVersion: "1.7.0",
    installGeneration: "id:some-install",
    stageFingerprint: null,
    allowDowngrade: false,
    acceptStoreFormatLoss: false,
  };

  it("an ACTIVE record: wait, and `host update` recovers an interrupted one", async () => {
    const { describeNonterminalRecordRecovery } =
      await import("../parked-activation-relaunch");
    const sentence = describeNonterminalRecordRecovery(
      attemptRecord({ phase: "applying", execution: "active", claim }),
      false,
    );
    expect(sentence).toContain("is in progress (applying)");
    expect(sentence).toContain("wait for it to finish");
    expect(sentence).toContain("'traycer host update'");
    expect(sentence).not.toContain("traycer host ensure");
  });

  it("a park the install still matches: `host update` resumes it and starts the host", async () => {
    const { describeNonterminalRecordRecovery } =
      await import("../parked-activation-relaunch");
    const sentence = describeNonterminalRecordRecovery(
      attemptRecord({ claim }),
      true,
    );
    expect(sentence).toContain("run 'traycer host update' to resume it");
    expect(sentence).toContain("starts the host if none is running");
    expect(sentence).not.toContain("traycer host ensure");
  });

  it("a claim-less park resumes the same way - the resume compares nothing", async () => {
    const { describeNonterminalRecordRecovery } =
      await import("../parked-activation-relaunch");
    const sentence = describeNonterminalRecordRecovery(
      attemptRecord({}),
      false,
    );
    expect(sentence).toContain("run 'traycer host update' to resume it");
    expect(sentence).not.toContain("traycer host ensure");
  });

  it("a park the install no longer matches: `host update` retires it and exits, so `host ensure` is the start", async () => {
    const { describeNonterminalRecordRecovery } =
      await import("../parked-activation-relaunch");
    const sentence = describeNonterminalRecordRecovery(
      attemptRecord({ claim }),
      false,
    );
    expect(sentence).toContain("installed host no longer matches");
    expect(sentence).toContain("retire the stale record");
    expect(sentence).toContain("'traycer host ensure' to start the host");
    // The overpromise this replaces: never claim the resume brings it back.
    expect(sentence).not.toContain("also starts the host");
  });

  // `waiting-for-work` is the busy-before-apply checkpoint: no bytes are
  // placed, so the resume compares nothing and always proceeds, regardless
  // of whatever `parkMatchesInstall` the caller passes in - the predicate
  // answers `false` for this phase by design (it admits only a claimed
  // `waiting-to-activate` park), and that `false` must not read as "stale".
  it("a waiting-for-work park with a claim resumes the same way even when parkMatchesInstall is false", async () => {
    const { describeNonterminalRecordRecovery } =
      await import("../parked-activation-relaunch");
    const sentence = describeNonterminalRecordRecovery(
      attemptRecord({
        phase: "waiting-for-work",
        continuation: "resume-apply",
        claim,
      }),
      false,
    );
    expect(sentence).toContain("run 'traycer host update' to resume it");
    expect(sentence).toContain("starts the host if none is running");
    expect(sentence).not.toContain("traycer host ensure");
    expect(sentence).not.toContain("installed host no longer matches");
  });

  // `null`: the install record could not be read at all, so neither "still
  // matches" nor "no longer matches" is true - the record itself is the
  // thing to repair first, via `traycer host doctor`.
  it("a claimed waiting-to-activate park whose install record could not be read: names 'traycer host doctor'", async () => {
    const { describeNonterminalRecordRecovery } =
      await import("../parked-activation-relaunch");
    const sentence = describeNonterminalRecordRecovery(
      attemptRecord({ claim }),
      null,
    );
    expect(sentence).toContain("install record could not be read");
    expect(sentence).toContain("'traycer host doctor'");
    expect(sentence).not.toContain("installed host no longer matches");
    expect(sentence).not.toContain("also starts the host");
  });
});
