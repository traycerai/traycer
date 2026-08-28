import { createHash } from "node:crypto";
import type { PathLike } from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliVersionsManifest } from "../../registry/cli-versions";
import type { HostPlatformKey } from "../../registry/types";

// Cross-filesystem CLI binary publication (audit CLI-014): when `rename`
// refuses with EXDEV, the old fallback copied straight onto the live
// path and unlinked it outright on a digest mismatch - turning a corrupt
// CLI into no CLI. The fix (`publishAcrossFilesystems` in
// `commands/cli-upgrade.ts`) copies to a sibling temp file on the
// DESTINATION filesystem, verifies there, and publishes with the same
// atomic rename the same-volume path uses - so the live binary is never
// touched until the copy is already known-good.
//
// `node:fs/promises`'s `rename` is mocked to fail exactly once with
// EXDEV for a specific (src, dest) pair, forcing the EXDEV fallback
// without needing an actual second filesystem. `copyFile` is mocked to
// write corrupt bytes for the digest-mismatch case, standing in for
// "a short write or a hostile local actor" the module doc comment
// describes. Everything else goes through the real implementation
// against a tmp HOME, matching `doctor/__tests__/pending-upgrade.test.ts`.

const mocks = vi.hoisted(() => ({
  failRenameOnceFor: null as { src: string; dest: string } | null,
  corruptCopyDestSuffix: null as string | null,
  corruptContent: "corrupted-bytes-not-matching-sha256",
  versionsManifest: null as CliVersionsManifest | null,
  downloadContent: "staged-cli-bytes-1.5.0",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (src: PathLike, dest: PathLike): Promise<void> => {
      const target = mocks.failRenameOnceFor;
      if (target !== null && src === target.src && dest === target.dest) {
        mocks.failRenameOnceFor = null;
        const err = new Error(
          "EXDEV: cross-device link not permitted, rename",
        ) as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      return actual.rename(src, dest);
    },
    copyFile: async (
      src: PathLike,
      dest: PathLike,
      mode: number | undefined,
    ): Promise<void> => {
      if (
        mocks.corruptCopyDestSuffix !== null &&
        typeof dest === "string" &&
        dest.includes(mocks.corruptCopyDestSuffix)
      ) {
        await actual.writeFile(dest, mocks.corruptContent);
        return;
      }
      return actual.copyFile(src, dest, mode);
    },
  };
});

vi.mock("../../registry/cli-versions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../registry/cli-versions")>();
  return {
    ...actual,
    fetchCliVersions: async () => {
      if (mocks.versionsManifest === null) {
        throw new Error(
          "test bug: versionsManifest not set before fetchCliVersions()",
        );
      }
      return mocks.versionsManifest;
    },
  };
});

vi.mock("../../registry/fetch-resource", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../registry/fetch-resource")>();
  return {
    ...actual,
    downloadToFile: async (opts: {
      readonly destPath: string;
      readonly onProgress: (info: {
        downloadedBytes: number;
        totalBytes: number;
      }) => void;
    }) => {
      writeFileSync(opts.destPath, mocks.downloadContent);
      opts.onProgress({
        downloadedBytes: mocks.downloadContent.length,
        totalBytes: mocks.downloadContent.length,
      });
      return {
        downloadedBytes: mocks.downloadContent.length,
        sha256: createHash("sha256")
          .update(mocks.downloadContent)
          .digest("hex"),
      };
    },
  };
});

// `store/paths` binds its home root from `os.homedir()` at module load.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

import type { CommandContext } from "../../runner/runner";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

function writeManifest(manifest: unknown): string {
  const dir = join(workHome, ".traycer", "cli");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "manifest.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

function readManifest(): Record<string, unknown> {
  const path = join(workHome, ".traycer", "cli", "manifest.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

// The cross-device PUBLISH temp only - `.<live-basename>.traycer-upgrade-
// <pid>-<rand>.tmp`, cleaned up (successfully or via `safeUnlink`) by
// `publishAcrossFilesystems` either way. Deliberately narrower than "any
// name containing .traycer-upgrade-": `buildCliUpgradeCommand`'s staged
// DOWNLOAD file now also lives under that prefix
// (`.traycer-upgrade-<version>-<platform>.download<ext>`, see
// `resolveStagingPath`) and is left in place on purpose so a retry can
// reuse it - that is a deliberate design choice, not a leak, so it must
// not be conflated with the publish temp this helper exists to catch.
function leftoverPublishTempFiles(dir: string): string[] {
  return readdirSync(dir).filter(
    (name) => name.includes(".traycer-upgrade-") && name.endsWith(".tmp"),
  );
}

async function currentPlatformKey(): Promise<HostPlatformKey> {
  const { currentCliPlatformKey } = await import("../../registry/cli-versions");
  return currentCliPlatformKey();
}

function binaryExtension(): string {
  return process.platform === "win32" ? ".exe" : "";
}

describe("cross-filesystem CLI binary publication (CLI-014)", () => {
  beforeEach(() => {
    workHome = mkdtempSync(join(tmpdir(), "traycer-cli-upgrade-exdev-test-"));
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    vi.resetModules();
    mocks.failRenameOnceFor = null;
    mocks.corruptCopyDestSuffix = null;
    mocks.corruptContent = "corrupted-bytes-not-matching-sha256";
    mocks.versionsManifest = null;
    mocks.downloadContent = "staged-cli-bytes-1.5.0";
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

  it("happy path: publishes the new bytes atomically across a simulated EXDEV and leaves no .tmp behind", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "old-live-bytes");

    const stagingDir = join(workHome, "staging");
    mkdirSync(stagingDir, { recursive: true });
    const stagedBinaryPath = join(stagingDir, "traycer-1.5.0");
    writeFileSync(stagedBinaryPath, "staged-new-bytes-1.5.0");

    writeManifest({
      version: "1.4.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: liveBinaryPath,
      source: "manual",
      pendingUpgrade: {
        version: "1.5.0",
        stagedBinaryPath,
        stagedAt: "2026-05-10T00:00:00Z",
        reason: "binary-locked",
      },
    });

    mocks.failRenameOnceFor = { src: stagedBinaryPath, dest: liveBinaryPath };

    const { finalizePendingCliUpgrade } = await import("../cli-upgrade");
    const outcome = await finalizePendingCliUpgrade({
      environment: "production",
    });

    expect(outcome).toMatchObject({
      status: "finalised",
      previousVersion: "1.4.0",
      version: "1.5.0",
      binaryPath: liveBinaryPath,
    });
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("staged-new-bytes-1.5.0");
    expect(existsSync(stagedBinaryPath)).toBe(false);
    expect(leftoverPublishTempFiles(join(workHome, "bin"))).toEqual([]);

    const manifest = readManifest();
    expect(manifest.version).toBe("1.5.0");
    expect(manifest.pendingUpgrade).toBeNull();
  });

  it("deferred finalize path (no release digest in scope) still verifies against the staged file's own digest: a corrupted cross-device copy leaves the live binary untouched, the pending upgrade retained, and returns publish-failed rather than throwing", async () => {
    // `finalizePendingCliUpgrade` never has the release sha256 in scope
    // (the persisted `pendingUpgrade` record doesn't carry one), so it
    // calls `tryReplaceLiveBinary` with `expectedSha256: null`. Before
    // the digest fix, `publishAcrossFilesystems` skipped verification
    // entirely whenever `expectedSha256` was `null` - a corrupt
    // cross-device copy on THIS path would have published silently and
    // reported "finalised". The digest fix falls back to hashing the
    // staged file itself immediately before the copy, so this path is
    // verified too.
    //
    // Separately (Codex P1 #2, fixed after the above), the resulting
    // failure must not ESCAPE as an exception: `finalizePendingCliUpgrade`
    // is called by `restartWithPendingCliUpgradeFinalize` between
    // `stopForRestart` and `relaunchAfterRestart`, and a throw here used
    // to skip the relaunch entirely, leaving the host stopped because a
    // bolt-on CLI swap failed. It now catches the publication failure and
    // returns `{status:"publish-failed", ...}` instead - see
    // `host-restart-publish-failed.test.ts` for the restart-level
    // regression this enables fixing.
    const liveBinaryPath = join(workHome, "bin", "traycer");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "original-live-bytes");

    const stagingDir = join(workHome, "staging");
    mkdirSync(stagingDir, { recursive: true });
    const stagedBinaryPath = join(stagingDir, "traycer-1.5.0");
    writeFileSync(stagedBinaryPath, "staged-new-bytes-1.5.0");

    writeManifest({
      version: "1.4.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: liveBinaryPath,
      source: "manual",
      pendingUpgrade: {
        version: "1.5.0",
        stagedBinaryPath,
        stagedAt: "2026-05-10T00:00:00Z",
        reason: "binary-locked",
      },
    });

    mocks.failRenameOnceFor = { src: stagedBinaryPath, dest: liveBinaryPath };
    mocks.corruptCopyDestSuffix = ".traycer-upgrade-";

    const { finalizePendingCliUpgrade } = await import("../cli-upgrade");

    // Must resolve, not throw - that's the whole point of the fix.
    const outcome = await finalizePendingCliUpgrade({
      environment: "production",
    });

    expect(outcome).toMatchObject({
      status: "publish-failed",
      stagedBinaryPath,
      livePath: liveBinaryPath,
    });
    if (outcome.status === "publish-failed") {
      expect(outcome.errorMessage.length).toBeGreaterThan(0);
    }

    // The staged binary was never touched by the corrupt copy - only the
    // sibling publish temp was - so hashing it again would still match.
    // What matters is the LIVE binary: still the pre-upgrade bytes.
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("original-live-bytes");
    expect(leftoverPublishTempFiles(join(workHome, "bin"))).toEqual([]);

    // The pending upgrade is RETAINED, not cleared: the swap never
    // completed, and `pendingUpgrade` is the only record that a
    // finalized upgrade was ever requested.
    const manifest = readManifest();
    expect(manifest.version).toBe("1.4.0");
    expect(manifest.pendingUpgrade).toMatchObject({
      version: "1.5.0",
      stagedBinaryPath,
    });
  });

  it("digest mismatch on the cross-device copy leaves the live binary untouched, cleans up the .tmp, and throws E_CLI_UPGRADE_REPLACE_FAILED", async () => {
    const platformKey = await currentPlatformKey();
    const installDir = join(workHome, "bin");
    mkdirSync(installDir, { recursive: true });
    const liveBinaryPath = join(installDir, "traycer");
    writeFileSync(liveBinaryPath, "original-live-bytes");

    writeManifest({
      version: "1.4.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: liveBinaryPath,
      source: "manual",
      pendingUpgrade: null,
    });

    mocks.versionsManifest = {
      schemaVersion: 1,
      generatedAt: "2026-05-01T00:00:00Z",
      latest: "1.5.0",
      version: "1.5.0",
      releaseNotesUrl: "https://example.test/release-notes",
      compatibilityEpoch: null,
      platforms: {
        [platformKey]: {
          available: true,
          unavailableReason: null,
          url: `https://example.test/cli/1.5.0/${platformKey}`,
          sizeBytes: mocks.downloadContent.length,
          sha256: createHash("sha256")
            .update(mocks.downloadContent)
            .digest("hex"),
          signatureUrl: `https://example.test/cli/1.5.0/${platformKey}.minisig`,
          signatureAlgorithm: "minisign",
          publicKeyId: "test-key",
        },
      },
    };

    // Same naming `resolveStagingPath` uses for the staged download
    // (audit CLI-014 Codex fix: dotted, `.download`-suffixed, never the
    // live path), staged in the (writable) install dir since it's a
    // sibling of the live binary.
    const stagedBinaryPath = join(
      installDir,
      `.traycer-upgrade-1.5.0-${platformKey}.download${binaryExtension()}`,
    );
    mocks.failRenameOnceFor = { src: stagedBinaryPath, dest: liveBinaryPath };
    mocks.corruptCopyDestSuffix = ".traycer-upgrade-";

    const { buildCliUpgradeCommand } = await import("../cli-upgrade");
    const { CLI_ERROR_CODES, CliError } = await import("../../runner/errors");

    let caught: unknown = null;
    try {
      await buildCliUpgradeCommand({
        dryRun: false,
        targetVersion: null,
      })(fakeCtx());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe(CLI_ERROR_CODES.CLI_UPGRADE_REPLACE_FAILED);
      // `buildCliUpgradeCommand` has the release digest in scope (from
      // the resolved asset), unlike the deferred finalize path above.
      expect(caught.details).toMatchObject({ digestSource: "release" });
    }

    // The regression that mattered: the old EXDEV fallback unlinked the
    // live binary on a digest mismatch, turning a corrupt CLI into no CLI.
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("original-live-bytes");
    expect(leftoverPublishTempFiles(installDir)).toEqual([]);

    const manifest = readManifest();
    expect(manifest.version).toBe("1.4.0");
    expect(manifest.pendingUpgrade).toBeNull();
  });
});
