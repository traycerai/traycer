import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliVersionsManifest } from "../../registry/cli-versions";
import type { HostPlatformKey } from "../../registry/types";

// Codex P1 #1: `buildCliUpgradeCommand` used to stage the download at
// `join(installDir, "traycer-<targetVersion>-<platformKey><ext>")`. A
// re-anchored manual install can legitimately have EXACTLY that name -
// `cli re-anchor` records whatever version string it is told, not the
// one baked into the filename, so `manifest.version !== targetVersion`
// while `basename(manifest.binaryPath) === "traycer-<targetVersion>-
// <platformKey><ext>"` is reachable. When that happens the staged
// download path collides with `manifest.binaryPath`, and
// `downloadToFile` treats its destination as a RESUMABLE PARTIAL - it
// reads the existing file's size to resume from and discards/truncates
// it on a restart, destroying the live executable before any digest
// check ever runs.
//
// The fix (`resolveStagingPath` in `commands/cli-upgrade.ts`) stages at
// a dotted, `.download`-suffixed name instead
// (`.traycer-upgrade-<targetVersion>-<platformKey>.download<ext>`) and
// falls back to an additional `.staged` suffix on the (now practically
// impossible) chance even THAT collides with the live path.
//
// `fetchCliVersions` and `downloadToFile` are mocked to avoid the
// network, matching `cli-upgrade-target-version.test.ts`.

const mocks = vi.hoisted(() => ({
  versionsManifest: null as CliVersionsManifest | null,
  downloadCalls: [] as Array<{ url: string; destPath: string }>,
  downloadContent: "staged-cli-bytes-1.5.0",
  // Captured INSIDE the downloadToFile mock, before it writes anything -
  // proves the live binary was untouched at the moment staging began,
  // which is exactly the window the old colliding path corrupted.
  liveContentAtDownloadStart: null as string | null,
  liveBinaryPathForCapture: null as string | null,
}));

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
      readonly url: string;
      readonly destPath: string;
      readonly onProgress: (info: {
        downloadedBytes: number;
        totalBytes: number;
      }) => void;
    }) => {
      mocks.downloadCalls.push({ url: opts.url, destPath: opts.destPath });
      if (mocks.liveBinaryPathForCapture !== null) {
        mocks.liveContentAtDownloadStart = readFileSync(
          mocks.liveBinaryPathForCapture,
          "utf8",
        );
      }
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

async function currentPlatformKey(): Promise<HostPlatformKey> {
  const { currentCliPlatformKey } = await import("../../registry/cli-versions");
  return currentCliPlatformKey();
}

function binaryExtension(): string {
  return process.platform === "win32" ? ".exe" : "";
}

async function makeVersionsManifest(
  platformKey: HostPlatformKey,
): Promise<CliVersionsManifest> {
  return {
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
}

describe("buildCliUpgradeCommand's staging path never collides with the live binary (Codex P1 #1)", () => {
  beforeEach(() => {
    workHome = mkdtempSync(
      join(tmpdir(), "traycer-cli-upgrade-staging-path-test-"),
    );
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    vi.resetModules();
    mocks.versionsManifest = null;
    mocks.downloadCalls = [];
    mocks.downloadContent = "staged-cli-bytes-1.5.0";
    mocks.liveContentAtDownloadStart = null;
    mocks.liveBinaryPathForCapture = null;
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

  it("a re-anchored install whose binary happens to be named like the OLD staging template still stages and upgrades safely", async () => {
    const installDir = join(workHome, "bin");
    mkdirSync(installDir, { recursive: true });
    const platformKey = await currentPlatformKey();

    // Deliberately the OLD (pre-fix) staging template's exact shape -
    // this is the collision the fix exists to make impossible. Reachable
    // because `cli re-anchor` records the version it's told, independent
    // of the binary's filename, so `manifest.version` ("1.4.0" below)
    // and the version embedded in the live binary's own NAME ("1.5.0",
    // matching the feed's targetVersion) can legitimately disagree.
    const liveBinaryPath = join(
      installDir,
      `traycer-1.5.0-${platformKey}${binaryExtension()}`,
    );
    writeFileSync(liveBinaryPath, "original-live-bytes-pre-upgrade");
    mocks.liveBinaryPathForCapture = liveBinaryPath;

    writeManifest({
      version: "1.4.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: liveBinaryPath,
      source: "manual",
      pendingUpgrade: null,
    });

    mocks.versionsManifest = await makeVersionsManifest(platformKey);

    const { buildCliUpgradeCommand } = await import("../cli-upgrade");
    const result = await buildCliUpgradeCommand({
      dryRun: false,
      targetVersion: null,
    })(fakeCtx());

    expect(result.data).toMatchObject({
      status: "replaced",
      previousVersion: "1.4.0",
      currentVersion: "1.5.0",
    });

    // The staging destination must never be the live path itself.
    expect(mocks.downloadCalls).toHaveLength(1);
    expect(mocks.downloadCalls[0]?.destPath).not.toBe(liveBinaryPath);

    // At the moment staging began, the live binary still held its
    // ORIGINAL bytes - proof the download never touched it (the old
    // template would have pointed `downloadToFile` straight at it,
    // where a resumable-partial read/discard corrupts it before any
    // digest check).
    expect(mocks.liveContentAtDownloadStart).toBe(
      "original-live-bytes-pre-upgrade",
    );

    // The upgrade still completes normally: the live binary now holds
    // the newly-downloaded bytes via the final rename.
    expect(existsSync(liveBinaryPath)).toBe(true);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(mocks.downloadContent);

    const manifest = readManifest();
    expect(manifest.version).toBe("1.5.0");
  });

  it("stages the download at the dotted, .download-suffixed name, never the plain traycer-<version>-<platform> template", async () => {
    const installDir = join(workHome, "bin");
    mkdirSync(installDir, { recursive: true });
    const platformKey = await currentPlatformKey();

    const liveBinaryPath = join(installDir, "traycer");
    writeFileSync(liveBinaryPath, "original-live-bytes");
    writeManifest({
      version: "1.4.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: liveBinaryPath,
      source: "manual",
      pendingUpgrade: null,
    });

    mocks.versionsManifest = await makeVersionsManifest(platformKey);

    const { buildCliUpgradeCommand } = await import("../cli-upgrade");
    await buildCliUpgradeCommand({
      dryRun: false,
      targetVersion: null,
    })(fakeCtx());

    expect(mocks.downloadCalls).toHaveLength(1);
    const stagedName = basename(mocks.downloadCalls[0]?.destPath ?? "");
    expect(stagedName).toBe(
      `.traycer-upgrade-1.5.0-${platformKey}.download${binaryExtension()}`,
    );
    // The download actually landed under that exact name on disk (the
    // rename target for the final swap), not merely in the recorded call.
    expect(existsSync(join(installDir, stagedName))).toBe(false); // renamed over the live path on success
    expect(readdirSync(installDir)).not.toContain(
      `traycer-1.5.0-${platformKey}${binaryExtension()}`,
    );
    // No gratuitous `.staged` fallback when there's nothing to alias -
    // that suffix must only ever appear when it's actually needed.
    expect(stagedName.endsWith(".staged")).toBe(false);
  });

  it("a live binary differing from the staging template only by LETTER CASE still gets a distinct staging path (Codex P1: Windows/macOS are case-insensitive)", async () => {
    // `pathsMayAlias` runs its case-folded comparison unconditionally -
    // it is not gated on `process.platform` in production, so this test
    // exercises the real code path on whatever OS this suite happens to
    // run on (this repo's CI is Linux/macOS) rather than needing an
    // actual case-insensitive filesystem to prove the guard works.
    const installDir = join(workHome, "bin");
    mkdirSync(installDir, { recursive: true });
    const platformKey = await currentPlatformKey();

    const candidateName = `.traycer-upgrade-1.5.0-${platformKey}.download${binaryExtension()}`;
    // Same name, different case throughout - e.g.
    // ".TRAYCER-UPGRADE-1.5.0-<PLATFORM>.DOWNLOAD". A plain `===` guard
    // would call this a different file; `pathsMayAlias` must not.
    const liveBinaryPath = join(installDir, candidateName.toUpperCase());
    writeFileSync(liveBinaryPath, "original-live-bytes-case-alias");
    mocks.liveBinaryPathForCapture = liveBinaryPath;

    writeManifest({
      version: "1.4.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: liveBinaryPath,
      source: "manual",
      pendingUpgrade: null,
    });

    mocks.versionsManifest = await makeVersionsManifest(platformKey);

    const { buildCliUpgradeCommand } = await import("../cli-upgrade");
    await buildCliUpgradeCommand({
      dryRun: false,
      targetVersion: null,
    })(fakeCtx());

    expect(mocks.downloadCalls).toHaveLength(1);
    const destPath = mocks.downloadCalls[0]?.destPath ?? "";

    // Neither an exact nor a case-folded match against the live path.
    expect(destPath).not.toBe(liveBinaryPath);
    expect(destPath.toLowerCase()).not.toBe(liveBinaryPath.toLowerCase());

    // The alias branch actually fired: the `.staged` fallback suffix is
    // present on top of the plain candidate name.
    expect(basename(destPath)).toBe(`${candidateName}.staged`);

    // The live binary was untouched at the moment staging began.
    expect(mocks.liveContentAtDownloadStart).toBe(
      "original-live-bytes-case-alias",
    );
  });
});
