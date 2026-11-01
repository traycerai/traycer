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
  readonly installedVersion: string;
  readonly version: string;
  readonly stagedBinaryPath: string;
  readonly liveBinaryPath: string;
  readonly source: "manual" | "desktop";
  readonly reason: "binary-locked" | "awaiting-service-restart";
  readonly allowDowngrade: boolean;
}) {
  return {
    version: opts.installedVersion,
    installedAt: "2026-04-01T00:00:00Z",
    binaryPath: opts.liveBinaryPath,
    source: opts.source,
    pendingUpgrade: {
      version: opts.version,
      stagedBinaryPath: opts.stagedBinaryPath,
      stagedAt: "2026-05-10T00:00:00Z",
      reason: opts.reason,
      allowDowngrade: opts.allowDowngrade,
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
        installedVersion: "1.4.0",
        version: "1.5.0",
        stagedBinaryPath,
        liveBinaryPath,
        source: "manual",
        reason: "binary-locked",
        allowDowngrade: false,
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
        installedVersion: "1.4.0",
        version: "1.5.0",
        stagedBinaryPath,
        liveBinaryPath,
        source: "manual",
        reason: "binary-locked",
        allowDowngrade: false,
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

  // Everything about this record is finalisable - the staged file is on disk
  // and the live path is writable - and the swap is still refused, because
  // the staged version is BELOW the installed one. The population that holds
  // such a record is real: before `cli upgrade` carried a downgrade floor it
  // staged the feed's last stable over an installed prerelease whenever the
  // live binary was locked, and this function would then have published the
  // older build on the next `host restart`. The record is read from a file,
  // so the floor belongs on this side too, not only where it is written.
  it("declines to publish a staged version BELOW the installed one, leaving the live binary and the record alone", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.1");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes-1.5.2-rc.2");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.1");
    writeManifest(
      "production",
      makePendingManifest({
        installedVersion: "1.5.2-rc.2",
        version: "1.5.1",
        stagedBinaryPath,
        liveBinaryPath,
        source: "manual",
        reason: "binary-locked",
        allowDowngrade: false,
      }),
    );
    const { finalizePendingCliUpgrade } =
      await import("../../commands/cli-upgrade");
    const outcome = await finalizePendingCliUpgrade({
      environment: "production",
    });
    expect(outcome.status).toBe("installed-newer");
    if (outcome.status === "installed-newer") {
      expect(outcome.stagedVersion).toBe("1.5.1");
      expect(outcome.installedVersion).toBe("1.5.2-rc.2");
      expect(outcome.livePath).toBe(liveBinaryPath);
    }
    // Nothing was published: the live binary still holds its own bytes, and
    // the staged file is still where it was (not consumed by a rename).
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("live-bytes-1.5.2-rc.2");
    expect(existsSync(stagedBinaryPath)).toBe(true);

    // The record is retained - superseded, not false - so Doctor can still
    // report that someone asked for this version.
    const manifestPath = join(workHome, ".traycer", "cli", "manifest.json");
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.version).toBe("1.5.2-rc.2");
    expect(reread.pendingUpgrade.version).toBe("1.5.1");
  });

  // The other half of the floor, and the reason it reads consent at all. Same
  // two versions as the case above - 1.5.1 staged under 1.5.2-rc.2 - but the
  // person named that version with `--allow-downgrade`, and `cli upgrade`
  // recorded it because the live binary was locked and the publish had to wait
  // for a restart. Reading the ordering alone refused this too, which left
  // `cli upgrade --target X --allow-downgrade` unable to complete at all on a
  // locked binary while Doctor pointed at that very command.
  it("publishes a staged version below the installed one when the record carries downgrade consent", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.1");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes-1.5.2-rc.2");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.1");
    writeManifest(
      "production",
      makePendingManifest({
        installedVersion: "1.5.2-rc.2",
        version: "1.5.1",
        stagedBinaryPath,
        liveBinaryPath,
        source: "manual",
        reason: "binary-locked",
        allowDowngrade: true,
      }),
    );
    const { finalizePendingCliUpgrade } =
      await import("../../commands/cli-upgrade");
    const outcome = await finalizePendingCliUpgrade({
      environment: "production",
    });
    expect(outcome.status).toBe("finalised");
    if (outcome.status === "finalised") {
      expect(outcome.version).toBe("1.5.1");
      expect(outcome.previousVersion).toBe("1.5.2-rc.2");
    }
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("staged-bytes-1.5.1");

    const manifestPath = join(workHome, ".traycer", "cli", "manifest.json");
    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.version).toBe("1.5.1");
    expect(reread.pendingUpgrade).toBeNull();
  });

  // A record written before the consent field existed must read as
  // UNCONSENTED, which is the whole population the floor was restored for:
  // machines where a pre-floor `cli upgrade` staged the feed's older stable
  // over an installed prerelease. The schema defaults it, so the absent key
  // has to land on `false` rather than parse-fail or default permissive.
  it("treats a record with no consent field as unconsented and declines it", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    const stagedBinaryPath = join(workHome, "bin", "traycer-1.5.1");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "live-bytes-1.5.2-rc.2");
    writeFileSync(stagedBinaryPath, "staged-bytes-1.5.1");
    writeManifest("production", {
      version: "1.5.2-rc.2",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: liveBinaryPath,
      source: "manual",
      pendingUpgrade: {
        version: "1.5.1",
        stagedBinaryPath,
        stagedAt: "2026-05-10T00:00:00Z",
        reason: "binary-locked",
      },
    });
    const { finalizePendingCliUpgrade } =
      await import("../../commands/cli-upgrade");
    const outcome = await finalizePendingCliUpgrade({
      environment: "production",
    });
    expect(outcome.status).toBe("installed-newer");
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("live-bytes-1.5.2-rc.2");
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
        installedVersion: "1.4.0",
        version: "1.5.0",
        stagedBinaryPath,
        liveBinaryPath,
        source: "manual",
        reason: "binary-locked",
        allowDowngrade: false,
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
        installedVersion: "1.4.0",
        version: "1.5.0",
        stagedBinaryPath,
        liveBinaryPath,
        source: "manual",
        reason: "binary-locked",
        allowDowngrade: false,
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
