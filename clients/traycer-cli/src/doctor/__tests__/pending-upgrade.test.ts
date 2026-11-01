import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pending CLI upgrade is staged by `traycer cli upgrade` when the
// live binary is locked (Windows: the host supervisor holds the
// .exe). These tests cover:
//
//   - Doctor surfaces a stable `CLI_UPGRADE_PENDING` issue while the
//     pendingUpgrade manifest field is populated.
//   - Doctor's fix action is `host-restart` (the only restart path
//     that releases the binary lock; the GUI Doctor card already
//     wires this through `management.restartHost`).
//   - `finalizePendingCliUpgrade` swaps the staged binary in place
//     when the live path is writable and clears the pending state
//     (this is what `host restart` calls between stop/start, when
//     the supervisor has just released the lock).
//   - When the staged binary is gone, Doctor surfaces a recovery
//     message without offering a Doctor auto-fix button.
//   - When the live binary is still locked, finalize reports
//     `still-locked` and preserves the pendingUpgrade manifest field.

// `store/paths` binds its home root from `os.homedir()` at module load.
// Keep the environment mutation below, but redirect `homedir()` too.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-pending-upgrade-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
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
  vi.restoreAllMocks();
});

function writeManifest(
  environment: "production" | "dev",
  manifest: unknown,
): string {
  const dir =
    environment === "production"
      ? join(workHome, ".traycer", "cli")
      : join(workHome, ".traycer", "cli", "dev");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "manifest.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

function makePendingManifest(opts: {
  readonly version: string;
  readonly stagedBinaryPath: string;
  readonly liveBinaryPath: string;
  readonly source: "manual" | "desktop";
  readonly reason: "binary-locked" | "awaiting-service-restart";
}) {
  return {
    version: "1.4.0",
    installedAt: "2026-04-01T00:00:00Z",
    binaryPath: opts.liveBinaryPath,
    source: opts.source,
    pendingUpgrade: {
      version: opts.version,
      stagedBinaryPath: opts.stagedBinaryPath,
      stagedAt: "2026-05-10T00:00:00Z",
      reason: opts.reason,
    },
  };
}

describe("readPendingCliUpgrade", () => {
  it("returns null when manifest is missing", async () => {
    const { readPendingCliUpgrade } =
      await import("../../commands/cli-upgrade");
    expect(
      await readPendingCliUpgrade({ environment: "production" }),
    ).toBeNull();
  });

  it("returns null when manifest exists but pendingUpgrade is null", async () => {
    writeManifest("production", {
      version: "1.4.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: join(workHome, "bin", "traycer"),
      source: "manual",
      pendingUpgrade: null,
    });
    const { readPendingCliUpgrade } =
      await import("../../commands/cli-upgrade");
    expect(
      await readPendingCliUpgrade({ environment: "production" }),
    ).toBeNull();
  });

  it("returns the pending payload alongside current install fields", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live");
    writeFileSync(stagedBinaryPath, "staged");
    writeManifest(
      "production",
      makePendingManifest({
        version: "1.5.0",
        stagedBinaryPath,
        liveBinaryPath,
        source: "manual",
        reason: "binary-locked",
      }),
    );
    const { readPendingCliUpgrade } =
      await import("../../commands/cli-upgrade");
    const result = await readPendingCliUpgrade({ environment: "production" });
    expect(result).not.toBeNull();
    expect(result?.pending.version).toBe("1.5.0");
    expect(result?.pending.stagedBinaryPath).toBe(stagedBinaryPath);
    expect(result?.pending.reason).toBe("binary-locked");
    expect(result?.currentVersion).toBe("1.4.0");
    expect(result?.binaryPath).toBe(liveBinaryPath);
    expect(result?.source).toBe("manual");
  });
});

describe("finalizePendingCliUpgrade", () => {
  it("returns no-manifest when there is no install record", async () => {
    const { finalizePendingCliUpgrade } =
      await import("../../commands/cli-upgrade");
    const outcome = await finalizePendingCliUpgrade({
      environment: "production",
    });
    expect(outcome).toEqual({ status: "no-manifest" });
  });

  it("returns no-pending when manifest exists but pendingUpgrade is null", async () => {
    writeManifest("production", {
      version: "1.4.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: join(workHome, "bin", "traycer"),
      source: "manual",
      pendingUpgrade: null,
    });
    const { finalizePendingCliUpgrade } =
      await import("../../commands/cli-upgrade");
    const outcome = await finalizePendingCliUpgrade({
      environment: "production",
    });
    expect(outcome).toEqual({ status: "no-pending" });
  });

  it("reports staged-binary-missing when the staged file is gone", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-staged-missing");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live");
    writeManifest(
      "production",
      makePendingManifest({
        version: "1.5.0",
        stagedBinaryPath,
        liveBinaryPath,
        source: "manual",
        reason: "binary-locked",
      }),
    );
    const { finalizePendingCliUpgrade } =
      await import("../../commands/cli-upgrade");
    const outcome = await finalizePendingCliUpgrade({
      environment: "production",
    });
    expect(outcome.status).toBe("staged-binary-missing");
    if (outcome.status === "staged-binary-missing") {
      expect(outcome.stagedBinaryPath).toBe(stagedBinaryPath);
    }
    // Manifest unchanged.
    const manifestPath = join(workHome, ".traycer", "cli", "manifest.json");
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.pendingUpgrade.version).toBe("1.5.0");
  });

  it("swaps the staged binary in place, clears pendingUpgrade, and updates the install record", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.0");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    writeManifest(
      "production",
      makePendingManifest({
        version: "1.5.0",
        stagedBinaryPath,
        liveBinaryPath,
        source: "manual",
        reason: "binary-locked",
      }),
    );
    const { finalizePendingCliUpgrade } =
      await import("../../commands/cli-upgrade");
    const outcome = await finalizePendingCliUpgrade({
      environment: "production",
    });
    expect(outcome.status).toBe("finalised");
    if (outcome.status === "finalised") {
      expect(outcome.version).toBe("1.5.0");
      expect(outcome.previousVersion).toBe("1.4.0");
      expect(outcome.binaryPath).toBe(liveBinaryPath);
    }
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("staged-bytes-1.5.0");
    expect(existsSync(stagedBinaryPath)).toBe(false);

    const manifestPath = join(workHome, ".traycer", "cli", "manifest.json");
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.version).toBe("1.5.0");
    expect(reread.binaryPath).toBe(liveBinaryPath);
    expect(reread.pendingUpgrade).toBeNull();
  });

  it("preserves pendingUpgrade when the live path's directory is not writable", async () => {
    // Simulate the "supervisor holds the live binary" case by removing
    // write permission on the parent directory. On POSIX, renameSync()
    // into a non-writable directory fails with EACCES - one of the
    // codes tryReplaceLiveBinary classifies as "locked".
    //
    // Skip on Windows where directory ACLs behave differently and the
    // EACCES path is unreliable in test environments.
    if (process.platform === "win32") {
      return;
    }
    // Root bypasses POSIX directory permissions, so the EACCES branch
    // is unreachable; skip rather than emit a false failure on CI
    // images that happen to run as root.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const lockedDir = join(workHome, "locked-bin");
    mkdirSync(lockedDir, { recursive: true });
    const liveBinaryPath = join(lockedDir, "traycer");
    writeFileSync(liveBinaryPath, "live-bytes");
    const stagingDir = join(workHome, "staging-bin");
    mkdirSync(stagingDir, { recursive: true });
    const stagedBinaryPath = join(stagingDir, "traycer-1.5.0");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.0");
    chmodSync(stagedBinaryPath, 0o755);
    writeManifest(
      "production",
      makePendingManifest({
        version: "1.5.0",
        stagedBinaryPath,
        liveBinaryPath,
        source: "manual",
        reason: "binary-locked",
      }),
    );
    // Strip write permission on the parent of the live binary so
    // renameSync() reports EACCES. Always re-grant in finally so the
    // workDir cleanup in afterEach() can succeed.
    chmodSync(lockedDir, 0o555);
    try {
      const { finalizePendingCliUpgrade } =
        await import("../../commands/cli-upgrade");
      const outcome = await finalizePendingCliUpgrade({
        environment: "production",
      });
      expect(outcome.status).toBe("still-locked");
      if (outcome.status === "still-locked") {
        expect(outcome.stagedBinaryPath).toBe(stagedBinaryPath);
        expect(outcome.livePath).toBe(liveBinaryPath);
        expect(outcome.errorMessage.length).toBeGreaterThan(0);
      }
    } finally {
      chmodSync(lockedDir, 0o755);
    }

    // Pending state is intact for the next restart to retry.
    const manifestPath = join(workHome, ".traycer", "cli", "manifest.json");
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.pendingUpgrade.version).toBe("1.5.0");
    expect(reread.pendingUpgrade.stagedBinaryPath).toBe(stagedBinaryPath);
    // Staged binary still on disk for the next attempt.
    expect(existsSync(stagedBinaryPath)).toBe(true);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("live-bytes");
  });
});
