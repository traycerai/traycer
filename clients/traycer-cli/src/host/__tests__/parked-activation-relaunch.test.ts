import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
