import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

// `placedFileFingerprint` wraps every read in `try {...} finally { await
// handle.close().catch(() => undefined); }`, so the descriptor is expected
// to close on every path out of the function - the early `!isFile()`
// return, the ordinary completed read, and the "identity changed between
// the two stats" rejection alike. This file pins that invariant directly by
// spying on the REAL handle's `close` (never a fake one) and counting calls,
// rather than inferring it from the observable evidence kind.
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

// Tracked outside the mock factory (which is hoisted above this file's own
// top-level bindings, hence `vi.hoisted`) so each test can read how many
// close spies were produced and, for the identity-drift case, install a
// hook that additionally spies on the SAME real handle's `stat`.
const closeTracking = vi.hoisted(() => ({
  spies: [] as MockInstance<FileHandle["close"]>[],
  onHandleOpened: null as ((handle: FileHandle) => void) | null,
}));

// `open` delegates to the real function, so every genuine filesystem read
// this file performs still happens for real; only the returned handle's
// `close` is spied on (wrapping the real method, never replacing it).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const spyingOpen = async (
    path: string,
    flags: number,
  ): Promise<FileHandle> => {
    const handle = await actual.open(path, flags);
    closeTracking.onHandleOpened?.(handle);
    closeTracking.spies.push(vi.spyOn(handle, "close"));
    return handle;
  };
  return { ...actual, open: vi.fn(spyingOpen) };
});

// Imports must come AFTER the vi.mock calls so the mocked modules are in
// place when `update-recovery-evidence` resolves them.
import * as paths from "../../store/paths";
import { writeHostInstallRecord } from "../../manifest/host-install";
import { readAttemptRecoveryEvidence } from "../update-recovery-evidence";

function installRecord(version: string, executablePath: string) {
  return {
    installId: "install-1",
    version,
    runtimeVersion: null,
    platform: "linux" as const,
    arch: "x64" as const,
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry" as const, value: version },
    archiveSha256: "a".repeat(64),
    // Irrelevant here: every case is decided before or without a digest
    // comparison mattering to the close count.
    executableSha256: null,
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath,
  };
}

beforeEach(() => {
  sandboxRoot = mkdtempSync(
    join(tmpdir(), "update-recovery-evidence-handle-close-test-"),
  );
  osHome.current = sandboxRoot;
  closeTracking.spies.length = 0;
  closeTracking.onHandleOpened = null;
});

afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
  closeTracking.onHandleOpened = null;
});

describe("placedFileFingerprint - the opened descriptor is closed on every path", () => {
  it("closes the handle exactly once when a directory sits at the path (fstat rejects .isFile())", async () => {
    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    const executablePath = join(installDir, "traycer-host");
    mkdirSync(executablePath);
    await writeHostInstallRecord(
      "production",
      installRecord("1.2.3", executablePath),
    );

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.installed).toEqual({ kind: "unreadable" });

    expect(closeTracking.spies).toHaveLength(1);
    expect(closeTracking.spies[0]).toHaveBeenCalledTimes(1);
  });

  it("closes the handle exactly once after a regular file is read to completion", async () => {
    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    const executablePath = join(installDir, "traycer-host");
    writeFileSync(executablePath, "binary-bytes");
    await writeHostInstallRecord(
      "production",
      installRecord("1.2.3", executablePath),
    );

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    // No recorded digest (see `installRecord` above), so this reads as
    // `unreadable` rather than `verified` - the read still completed, which
    // is the only thing this test cares about.
    expect(evidence.installed).toEqual({ kind: "unreadable" });

    expect(closeTracking.spies).toHaveLength(1);
    expect(closeTracking.spies[0]).toHaveBeenCalledTimes(1);
  });

  it("closes the handle exactly once when the stat identity changes between the two reads", async () => {
    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    const executablePath = join(installDir, "traycer-host");
    writeFileSync(executablePath, "binary-bytes");
    await writeHostInstallRecord(
      "production",
      installRecord("1.2.3", executablePath),
    );

    // A real concurrent replace-mid-read is not reliably reproducible in a
    // test; a mocked second `stat()` reporting a different inode stands in
    // for it, on the SAME real handle `open()` produced.
    closeTracking.onHandleOpened = (handle) => {
      let statCallCount = 0;
      const realStat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async () => {
        statCallCount += 1;
        const stats = await realStat();
        return statCallCount === 1 ? stats : { ...stats, ino: stats.ino + 1 };
      });
    };

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    // The identity mismatch between the two stats fails closed.
    expect(evidence.installed).toEqual({ kind: "unreadable" });

    expect(closeTracking.spies).toHaveLength(1);
    expect(closeTracking.spies[0]).toHaveBeenCalledTimes(1);
  });
});
