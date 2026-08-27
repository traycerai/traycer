import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliVersionsManifest } from "../../registry/cli-versions";
import type { HostPlatformKey } from "../../registry/types";

// `buildCliUpgradeCommand` used to fall back to staging in
// `mktemp(tmpdir())` when the install directory wasn't writable, then
// download a full binary before discovering publication couldn't
// possibly succeed (atomic publish means creating a file NEXT TO the
// live binary) - leaking a downloaded executable and a temp dir on
// every retry. The fix refuses immediately after resolving the asset,
// BEFORE any download, with `E_CLI_UPGRADE_REPLACE_FAILED`.
//
// `fetchCliVersions` and `downloadToFile` are mocked to avoid the
// network (and so the test can assert `downloadToFile` was never
// called); everything else runs against a real tmp HOME, matching
// `doctor/__tests__/pending-upgrade.test.ts`.

const mocks = vi.hoisted(() => ({
  versionsManifest: null as CliVersionsManifest | null,
  downloadCalls: [] as Array<{ url: string; destPath: string }>,
  downloadContent: "staged-cli-bytes",
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

// Root and Windows both ignore/behave differently under POSIX directory
// mode bits, so the unwritable-directory scenario is unreliable there -
// same guard `doctor/__tests__/pending-upgrade.test.ts` uses for its
// EACCES case.
const canTestUnwritableDir =
  process.platform !== "win32" &&
  !(typeof process.getuid === "function" && process.getuid() === 0);

describe("buildCliUpgradeCommand refuses an unwritable install dir before downloading (CLI-014 fix 2)", () => {
  beforeEach(() => {
    workHome = mkdtempSync(
      join(tmpdir(), "traycer-cli-upgrade-unwritable-test-"),
    );
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    vi.resetModules();
    mocks.versionsManifest = null;
    mocks.downloadCalls = [];
    mocks.downloadContent = "staged-cli-bytes";
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

  it.runIf(canTestUnwritableDir)(
    "refuses with E_CLI_UPGRADE_REPLACE_FAILED naming the install dir, downloads nothing, and leaves the live binary and manifest untouched",
    async () => {
      const installDir = join(workHome, "locked-bin");
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

      const platformKey = await currentPlatformKey();
      mocks.versionsManifest = await makeVersionsManifest(platformKey);

      // Strip write permission from the install dir so `directoryWritable`
      // reports false. Always re-grant in `finally` so cleanup (and the
      // afterEach `rmSync` in other tests sharing this tmp root) succeeds.
      chmodSync(installDir, 0o500);
      try {
        const { buildCliUpgradeCommand } = await import("../cli-upgrade");
        const { CLI_ERROR_CODES, CliError } =
          await import("../../runner/errors");

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
          expect(caught.message).toContain(installDir);
          expect(caught.details).toMatchObject({
            livePath: liveBinaryPath,
            installDir,
          });
        }

        expect(mocks.downloadCalls).toEqual([]);
      } finally {
        chmodSync(installDir, 0o755);
      }

      expect(readFileSync(liveBinaryPath, "utf8")).toBe("original-live-bytes");
      // No staged binary or leaked temp dir anywhere under the install
      // dir - the whole point of failing before the download.
      expect(readdirSync(installDir)).toEqual(["traycer"]);

      const manifest = readManifest();
      expect(manifest.version).toBe("1.4.0");
      expect(manifest.pendingUpgrade).toBeNull();
    },
  );

  it("positive control: a writable install dir still upgrades", async () => {
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

    const platformKey = await currentPlatformKey();
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
    expect(mocks.downloadCalls).toHaveLength(1);
    expect(existsSync(liveBinaryPath)).toBe(true);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(mocks.downloadContent);
  });
});
