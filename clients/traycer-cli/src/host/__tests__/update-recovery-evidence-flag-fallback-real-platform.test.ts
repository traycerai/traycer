import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on every platform, including a real win32 CI runner - unlike the
// POSIX-only cases elsewhere in this suite, nothing here is skipped or
// mocked to a chosen platform. `fs.constants.O_NOFOLLOW` / `O_NONBLOCK` /
// `O_NOCTTY` may be `undefined` on some platforms (Windows among them), and
// `placedFileFingerprint` maps each to `0` when it is not a number. This
// file proves that fallback does not break the two ordinary readings - a
// real file that verifies, and a real missing path - on whichever platform
// actually runs it.
let sandboxRoot = "";

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  type Environment = "dev" | "production";
  const hostHomeFor = (environment: Environment | undefined): string => {
    const base = join(sandboxRoot, "host");
    return environment === "dev" ? join(base, "dev") : base;
  };
  const installDirFor = (environment: Environment): string =>
    join(hostHomeFor(environment), "install");
  return {
    ...actual,
    hostHomeDir: (environment: Environment | undefined) =>
      hostHomeFor(environment),
    hostInstallDir: (environment: Environment) => installDirFor(environment),
    hostInstallRecordPath: (environment: Environment) =>
      join(installDirFor(environment), "install.json"),
    hostStagedDir: (environment: Environment) =>
      join(hostHomeFor(environment), "staged"),
    hostStagedRecordPath: (environment: Environment) =>
      join(hostHomeFor(environment), "staged", "staged.json"),
    hostPidMetadataPath: (environment: Environment | undefined) =>
      join(hostHomeFor(environment), "pid.json"),
  };
});

import * as paths from "../../store/paths";
import { writeHostInstallRecord } from "../../manifest/host-install";
import { readAttemptRecoveryEvidence } from "../update-recovery-evidence";

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function installRecord(
  version: string,
  executablePath: string,
  executableSha256: string | null,
) {
  return {
    installId: "install-1",
    version,
    runtimeVersion: null,
    platform: "linux" as const,
    arch: "x64" as const,
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry" as const, value: version },
    archiveSha256: "a".repeat(64),
    executableSha256,
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath,
  };
}

beforeEach(() => {
  sandboxRoot = mkdtempSync(
    join(tmpdir(), "update-recovery-evidence-flag-fallback-test-"),
  );
  osHome.current = sandboxRoot;
});

afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("placedFileFingerprint on the real platform - the flag fallback must not break the ordinary readings", () => {
  it("verifies a real regular file with the correct recorded digest, on whichever platform runs this test", async () => {
    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    const executablePath = join(installDir, "traycer-host");
    writeFileSync(executablePath, "binary-bytes");
    await writeHostInstallRecord(
      "production",
      installRecord("1.2.3", executablePath, sha256Of("binary-bytes")),
    );

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    // A fingerprint, not "unreadable": whatever this platform's
    // O_NOFOLLOW/O_NONBLOCK/O_NOCTTY fallback resolves to, a genuine
    // matching file still verifies.
    expect(evidence.installed).toEqual({ kind: "verified", version: "1.2.3" });
  });

  it("reports a real missing path as missing - the observable shape of placedFileFingerprint's null - on whichever platform runs this test", async () => {
    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    const executablePath = join(installDir, "traycer-host");
    // Never written - a plain "no entry at all" path, no symlink involved.
    await writeHostInstallRecord(
      "production",
      installRecord("1.2.3", executablePath, sha256Of("binary-bytes")),
    );

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.installed).toEqual({ kind: "missing", version: "1.2.3" });
  });
});
