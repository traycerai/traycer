import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// `host service install` registers and starts the host bytes `host install`
// already staged; it refuses before any registration when the environment's
// install record or the executable it names is absent. The suites that need
// the command to proceed write the real prerequisite: an `install.json` record
// and the executable file it points at, at the path the command itself reads
// (`hostInstallRecordPath`, resolved by the caller AFTER the HOME redirect).

const INSTALLED_HOST_VERSION = "1.0.0";

/** Writes `install.json` at `recordPath` plus the executable beside it. */
export function writeInstalledHostFixture(recordPath: string): string {
  const executablePath = join(dirname(recordPath), "traycer-host");
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(executablePath, 0o755);
  writeInstallRecordFixture(recordPath, executablePath);
  return executablePath;
}

/** Writes an `install.json` naming `executablePath`, which may not exist. */
export function writeInstallRecordFixture(
  recordPath: string,
  executablePath: string,
): void {
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(
    recordPath,
    `${JSON.stringify(
      {
        installId: null,
        version: INSTALLED_HOST_VERSION,
        runtimeVersion: null,
        platform: "darwin",
        arch: "arm64",
        installedAt: "2026-05-15T00:00:00.000Z",
        source: { kind: "registry", value: INSTALLED_HOST_VERSION },
        archiveSha256: "a".repeat(64),
        signatureVerifiedAt: "2026-05-15T00:00:00.000Z",
        signatureKeyId: "test-key",
        sizeBytes: 1234,
        executablePath,
        executableSha256: null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
