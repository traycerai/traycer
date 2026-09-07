import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";
import { cliLockPath } from "../../host/host-paths";
import type { CliInstallManifest } from "../cli-discovery";

// These tests pin the property that closes the class: the staged binary must survive its bundled source disappearing.

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: (): string => "/tmp/desktop-app",
  },
}));

vi.mock("../../../config", async (importActual) => {
  const actual = await importActual<typeof import("../../../config")>();
  return {
    ...actual,
    isDevBuild: false,
    config: { ...actual.config, environment: "production" },
  };
});

const manifestWriteObserved = vi.hoisted(() => ({
  lockPathToCheck: null as string | null,
  sawLockDuringManifestWrite: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const mockedWriteFile = async (
    path: PathLike,
    data: string,
    encoding: BufferEncoding,
  ): Promise<void> => {
    if (manifestWriteObserved.lockPathToCheck !== null) {
      manifestWriteObserved.sawLockDuringManifestWrite = existsSync(
        manifestWriteObserved.lockPathToCheck,
      );
    }
    await actual.writeFile(path, data, encoding);
  };
  const mocked = {
    ...actual,
    writeFile: mockedWriteFile,
  };
  return { ...mocked, default: mocked };
});

let work: string;
let homeDir: string;

const CLI_BINARY_NAME =
  process.platform === "win32" ? "traycer.exe" : "traycer";

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "traycer-install-bundled-cli-"));
  homeDir = join(work, "home");
  mkdirSync(homeDir, { recursive: true });
  sandboxHome(homeDir);
  vi.resetModules();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  vi.resetModules();
});

function stageBundled(content: string): string {
  const bundleCliDir = join(
    work,
    "Traycer.app",
    "Contents",
    "Resources",
    "cli",
  );
  mkdirSync(bundleCliDir, { recursive: true });
  const bundled = join(bundleCliDir, CLI_BINARY_NAME);
  writeFileSync(bundled, content);
  return bundled;
}

describe("installBundledCli stages a copy that outlives the bundle", () => {
  it("stages a regular executable file (never a symlink) and writes the manifest", async () => {
    const bundled = stageBundled("cli-bytes-v1");
    const { installBundledCli } = await import("../cli-discovery");

    const { path: stable } = await installBundledCli({
      bundledCliPath: bundled,
      version: "1.0.0",
      source: "desktop",
    });

    expect(lstatSync(stable).isSymbolicLink()).toBe(false);
    expect(readFileSync(stable, "utf8")).toBe("cli-bytes-v1");
    if (process.platform !== "win32") {
      expect(statSync(stable).mode & 0o111).not.toBe(0);
    }
    const manifest: { binaryPath: string; version: string } = JSON.parse(
      readFileSync(join(homeDir, ".traycer", "cli", "manifest.json"), "utf8"),
    );
    expect(manifest.binaryPath).toBe(stable);
    expect(manifest.version).toBe("1.0.0");
  });

  it("keeps working after the bundle is deleted - the exact class of field report 5", async () => {
    const bundled = stageBundled("cli-bytes-v1");
    const { installBundledCli } = await import("../cli-discovery");
    const { path: stable } = await installBundledCli({
      bundledCliPath: bundled,
      version: "1.0.0",
      source: "desktop",
    });

    rmSync(join(work, "Traycer.app"), { recursive: true, force: true });

    // `stat` FOLLOWS links: with the old symlink staging this is exactly
    // where ENOENT surfaced while lstat (and `ls`) kept succeeding.
    expect(statSync(stable).size).toBeGreaterThan(0);
    expect(readFileSync(stable, "utf8")).toBe("cli-bytes-v1");
  });

  it.runIf(process.platform !== "win32")(
    "replaces a legacy dangling symlink from the pre-copy era with a real copy",
    async () => {
      const bundled = stageBundled("cli-bytes-v2");
      const binDir = join(homeDir, ".traycer", "cli", "bin");
      mkdirSync(binDir, { recursive: true });
      const legacySlot = join(binDir, "traycer");
      symlinkSync(join(work, "removed-bundle-target"), legacySlot);

      const { installBundledCli } = await import("../cli-discovery");
      const { path: stable } = await installBundledCli({
        bundledCliPath: bundled,
        version: "2.0.0",
        source: "desktop",
      });

      expect(stable).toBe(legacySlot);
      expect(lstatSync(stable).isSymbolicLink()).toBe(false);
      expect(readFileSync(stable, "utf8")).toBe("cli-bytes-v2");
    },
  );
});

describe("installBundledCli hardens the slot home it shares with the CLI", () => {
  it.skipIf(process.platform === "win32")(
    "repairs an EXISTING 0755 slot home and bin directory to 0700",
    async () => {
      const slotHome = join(homeDir, ".traycer", "cli");
      const binDir = join(slotHome, "bin");
      // A pre-existing install, world-traversable - the state an older
      // Desktop or a bare umask-mode mkdir leaves behind, and the one a
      // create-only fix can never reach.
      mkdirSync(binDir, { recursive: true });
      chmodSync(slotHome, 0o755);
      chmodSync(binDir, 0o755);
      const bundled = stageBundled("cli-bytes-v1");
      const { installBundledCli } = await import("../cli-discovery");

      const { path: stable } = await installBundledCli({
        bundledCliPath: bundled,
        version: "1.0.0",
        source: "desktop",
      });

      // Derived from the published path rather than assumed, so this cannot
      // pass by hardening directories the publish does not actually use.
      expect(dirname(stable)).toBe(binDir);
      expect(dirname(dirname(stable))).toBe(slotHome);
      expect(statSync(slotHome).mode & 0o777).toBe(0o700);
      expect(statSync(binDir).mode & 0o777).toBe(0o700);
    },
  );
});

describe("installBundledCli takes the CLI lock", () => {
  afterEach(() => {
    manifestWriteObserved.lockPathToCheck = null;
    manifestWriteObserved.sawLockDuringManifestWrite = false;
  });

  it("holds the lock file while writing the manifest and releases it once the call resolves", async () => {
    const bundled = stageBundled("cli-bytes-lock-held");
    const lockPath = cliLockPath("production");
    manifestWriteObserved.lockPathToCheck = lockPath;
    const { installBundledCli } = await import("../cli-discovery");
    const { default: electronLogMock } = await import("electron-log");

    expect(existsSync(lockPath)).toBe(false);

    const { path: stable } = await installBundledCli({
      bundledCliPath: bundled,
      version: "1.0.0",
      source: "desktop",
    });

    // The lock file existed at the moment the manifest write ran (inside the
    // locked section) and is gone again once installBundledCli resolved -
    // acquired and released for exactly this call.
    expect(manifestWriteObserved.sawLockDuringManifestWrite).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(readFileSync(stable, "utf8")).toBe("cli-bytes-lock-held");
    // No contention on this call: the fast, uncontended path never logs the
    // best-effort fallback warning.
    expect(electronLogMock.warn).not.toHaveBeenCalled();
  });
});

describe("installBundledCli proceeds past lock contention", () => {
  // A plain EMPTY lock file would NOT work for this: an empty/corrupt lock is judged solely by age (`EMPTY_LOCK_GRACE_MS` = 5s) and would be broken well before the 15s deadline.
  function writeUnbreakableHolderLock(lockPath: string): void {
    mkdirSync(dirname(lockPath), { recursive: true });
    const metadata = {
      pid: process.pid,
      reason: "external-test-holder",
      startedAt: new Date().toISOString(),
      hostname: null,
      token: "external-test-token",
      processStartedAtMs: null,
      processStartIdentity: null,
    };
    writeFileSync(lockPath, JSON.stringify(metadata, null, 2), "utf8");
  }

  // Not covered here: the past-the-wait branch, where the holder never lets go and the publish is deferred.
  it("publishes once a briefly-held lock is released", async () => {
    const bundled = stageBundled("cli-bytes-contended");
    const lockPath = cliLockPath("production");
    writeUnbreakableHolderLock(lockPath);
    const { installBundledCli } = await import("../cli-discovery");
    const { default: electronLogMock } = await import("electron-log");

    let settled = false;
    const install = installBundledCli({
      bundledCliPath: bundled,
      version: "1.0.0",
      source: "desktop",
    });
    void install.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Without this the test would pass even if the holder were removed before the first acquisition attempt.
    // The assertion errs in the safe direction: while an unbreakable holder is in place the call cannot finish inside this window, because its wait is 15s.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(false);

    // Hand the lock over. The holder file is removed, not rewritten, so
    // acquisition succeeds through the ordinary O_CREAT|O_EXCL path rather
    // than through any break arbitration.
    rmSync(lockPath, { force: true });

    const { path: stable } = await install;

    expect(readFileSync(stable, "utf8")).toBe("cli-bytes-contended");
    const manifest: { binaryPath: string; version: string } = JSON.parse(
      readFileSync(join(homeDir, ".traycer", "cli", "manifest.json"), "utf8"),
    );
    expect(manifest.binaryPath).toBe(stable);
    expect(manifest.version).toBe("1.0.0");
    // Acquired rather than fell back: the lock was taken and released, and
    // the best-effort warning never fired.
    expect(existsSync(lockPath)).toBe(false);
    expect(electronLogMock.warn).not.toHaveBeenCalled();
  });
});

describe("writeCliManifestPendingUpgrade", () => {
  it("re-reads the manifest under the lock instead of trusting the caller's snapshot", async () => {
    const { writeCliManifestPendingUpgrade, cliManifestPath } =
      await import("../cli-discovery");
    const manifestPath = cliManifestPath();
    mkdirSync(dirname(manifestPath), { recursive: true });
    // The on-disk manifest (M1) - what another writer committed most
    // recently.
    const onDiskManifest: CliInstallManifest = {
      version: "2.0.0",
      installedAt: new Date(0).toISOString(),
      binaryPath: join(homeDir, "on-disk-binary"),
      source: "homebrew",
      pendingUpgrade: null,
    };
    writeFileSync(
      manifestPath,
      JSON.stringify(onDiskManifest, null, 2),
      "utf8",
    );
    // The caller's STALE snapshot (M0) - taken at reconcile start, seconds
    // and one failed publish ago, and deliberately different from M1 on
    // every field so the assertions below cannot pass by accident.
    const staleSnapshot: CliInstallManifest = {
      version: "1.0.0",
      installedAt: new Date(0).toISOString(),
      binaryPath: join(homeDir, "stale-caller-snapshot-binary"),
      source: "manual",
      pendingUpgrade: null,
    };
    const pending: NonNullable<CliInstallManifest["pendingUpgrade"]> = {
      version: "3.0.0",
      stagedBinaryPath: join(homeDir, "staged-binary"),
      stagedAt: new Date().toISOString(),
      reason: "binary-locked",
    };

    const result = await writeCliManifestPendingUpgrade(pending, staleSnapshot);

    expect(result).not.toBeNull();
    if (result !== null) {
      // Every field but `pendingUpgrade` carries M1's values, not M0's -
      // proof the re-read under the lock won, not the caller's snapshot.
      expect(result.version).toBe(onDiskManifest.version);
      expect(result.binaryPath).toBe(onDiskManifest.binaryPath);
      expect(result.source).toBe(onDiskManifest.source);
      expect(result.pendingUpgrade).toEqual(pending);
    }
    const persisted: CliInstallManifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    );
    expect(persisted.version).toBe(onDiskManifest.version);
    expect(persisted.binaryPath).toBe(onDiskManifest.binaryPath);
    expect(persisted.pendingUpgrade).toEqual(pending);
  });

  it("returns null and writes nothing while the CLI lock is held", async () => {
    const { writeCliManifestPendingUpgrade, cliManifestPath } =
      await import("../cli-discovery");
    const manifestPath = cliManifestPath();
    mkdirSync(dirname(manifestPath), { recursive: true });
    const onDiskManifest: CliInstallManifest = {
      version: "1.5.0",
      installedAt: new Date(0).toISOString(),
      binaryPath: join(homeDir, "locked-test-binary"),
      source: "desktop",
      pendingUpgrade: null,
    };
    writeFileSync(
      manifestPath,
      JSON.stringify(onDiskManifest, null, 2),
      "utf8",
    );
    const lockPath = cliLockPath("production");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          pid: process.pid,
          reason: "external-test-holder",
          startedAt: new Date().toISOString(),
          hostname: null,
          token: "external-test-token",
          processStartedAtMs: null,
          processStartIdentity: null,
        },
        null,
        2,
      ),
      "utf8",
    );
    const pending: NonNullable<CliInstallManifest["pendingUpgrade"]> = {
      version: "2.0.0",
      stagedBinaryPath: join(homeDir, "staged-binary"),
      stagedAt: new Date().toISOString(),
      reason: "binary-locked",
    };

    const result = await writeCliManifestPendingUpgrade(
      pending,
      onDiskManifest,
    );

    expect(result).toBeNull();
    const persisted: CliInstallManifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    );
    expect(persisted.pendingUpgrade).toBeNull();
    expect(persisted.version).toBe("1.5.0");
  }, 20_000);
});
