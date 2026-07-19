import { writeHostInstallRecordAt } from "../../../manifest/host-install";

// Worker process for the genuine two-process attested-generation CAS race
// test in `stamp-runtime.test.ts` (ticket-2 review round 1, Finding 5).
// Spawned as a real, separate OS process (via `bun run`) so "a terminal
// install lands between the command's returned attested generation and
// the stamp call" is exercised through actual cross-process filesystem
// writes - via `writeHostInstallRecordAt`, the SAME production write path
// `installer/install.ts`'s commit uses - not an in-process second write
// that a single-threaded test could trivially sequence either way without
// proving anything about the real race.
async function main(): Promise<void> {
  const installDir = process.env.WORKER_INSTALL_DIR;
  const installId = process.env.WORKER_INSTALL_ID;
  const version = process.env.WORKER_VERSION;
  const installedAt = process.env.WORKER_INSTALLED_AT;
  if (
    installDir === undefined ||
    installId === undefined ||
    version === undefined ||
    installedAt === undefined
  ) {
    throw new Error(
      "stamp-runtime-terminal-install-worker: WORKER_INSTALL_DIR, WORKER_INSTALL_ID, WORKER_VERSION, and WORKER_INSTALLED_AT are required",
    );
  }
  await writeHostInstallRecordAt(installDir, {
    installId,
    version,
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt,
    source: { kind: "registry", value: version },
    archiveSha256: "b".repeat(64),
    signatureVerifiedAt: installedAt,
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: `${installDir}/traycer-host`,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(
      `stamp-runtime-terminal-install-worker failed: ${String(err)}\n`,
    );
    process.exit(1);
  });
