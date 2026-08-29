import { createHash } from "node:crypto";
import {
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
import type { CliVersionsManifest } from "../../registry/cli-versions";
import type { HostPlatformKey } from "../../registry/types";

// `buildCliUpgradeCommand`'s target-version contract (audit CLI-013):
// the rolling release feed publishes exactly one build's platform
// assets, so the version stamped into the manifest must always be the
// feed's own `version` (never `latest`, never the caller's `--target`
// string). `--target` is downgraded from a selector to a GUARD that
// asserts the caller's expectation against the feed and refuses with
// E_CLI_UPGRADE_TARGET_UNAVAILABLE when they disagree.
//
// `fetchCliVersions` and `downloadToFile` are mocked to avoid the
// network; everything else (manifest read/write, staging, rename,
// well-known-slot refresh, cli-lock) runs against a real tmp HOME the
// same way `doctor/__tests__/pending-upgrade.test.ts` does.

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
let liveBinaryPath: string;

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

async function makeVersionsManifest(opts: {
  readonly latest: string;
  readonly version: string;
  readonly platformKey: HostPlatformKey;
}): Promise<CliVersionsManifest> {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-01T00:00:00Z",
    latest: opts.latest,
    version: opts.version,
    releaseNotesUrl: "https://example.test/release-notes",
    compatibilityEpoch: null,
    platforms: {
      [opts.platformKey]: {
        available: true,
        unavailableReason: null,
        url: `https://example.test/cli/${opts.version}/${opts.platformKey}`,
        sizeBytes: mocks.downloadContent.length,
        sha256: createHash("sha256")
          .update(mocks.downloadContent)
          .digest("hex"),
        signatureUrl: `https://example.test/cli/${opts.version}/${opts.platformKey}.minisig`,
        signatureAlgorithm: "minisign",
        publicKeyId: "test-key",
      },
    },
  };
}

describe("buildCliUpgradeCommand target-version contract (CLI-013)", () => {
  beforeEach(() => {
    workHome = mkdtempSync(join(tmpdir(), "traycer-cli-upgrade-target-test-"));
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    vi.resetModules();
    mocks.versionsManifest = null;
    mocks.downloadCalls = [];
    mocks.downloadContent = "staged-cli-bytes";

    liveBinaryPath = join(workHome, "bin", "traycer");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "original-live-bytes");
    writeManifest({
      version: "1.4.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath: liveBinaryPath,
      source: "manual",
      pendingUpgrade: null,
    });
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

  it("with no --target, stamps the feed's `version` (not `latest`) into the manifest and downloads that platform's asset", async () => {
    const platformKey = await currentPlatformKey();
    mocks.versionsManifest = await makeVersionsManifest({
      latest: "9.9.9",
      version: "1.5.0",
      platformKey,
    });

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
    expect(mocks.downloadCalls[0]?.url).toContain("1.5.0");
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(mocks.downloadContent);

    const manifest = readManifest();
    expect(manifest.version).toBe("1.5.0");
    expect(manifest.version).not.toBe("9.9.9");
  });

  it("--target <not-the-feed-version> throws E_CLI_UPGRADE_TARGET_UNAVAILABLE before any download/stage/manifest write happens", async () => {
    const platformKey = await currentPlatformKey();
    mocks.versionsManifest = await makeVersionsManifest({
      latest: "1.5.0",
      version: "1.5.0",
      platformKey,
    });

    const { buildCliUpgradeCommand } = await import("../cli-upgrade");
    const { CLI_ERROR_CODES, CliError } = await import("../../runner/errors");

    let caught: unknown = null;
    try {
      await buildCliUpgradeCommand({
        dryRun: false,
        targetVersion: "2.0.0",
      })(fakeCtx());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe(CLI_ERROR_CODES.CLI_UPGRADE_TARGET_UNAVAILABLE);
    }

    expect(mocks.downloadCalls).toHaveLength(0);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("original-live-bytes");
    const manifest = readManifest();
    expect(manifest.version).toBe("1.4.0");
    expect(manifest.pendingUpgrade).toBeNull();
  });

  it("--target <feed-version> is accepted", async () => {
    const platformKey = await currentPlatformKey();
    mocks.versionsManifest = await makeVersionsManifest({
      latest: "1.5.0",
      version: "1.5.0",
      platformKey,
    });

    const { buildCliUpgradeCommand } = await import("../cli-upgrade");
    const result = await buildCliUpgradeCommand({
      dryRun: true,
      targetVersion: "1.5.0",
    })(fakeCtx());

    expect(result.data).toMatchObject({
      status: "dry-run",
      currentVersion: "1.4.0",
      targetVersion: "1.5.0",
    });
  });

  it("--target v<feed-version> (leading v) is accepted", async () => {
    const platformKey = await currentPlatformKey();
    mocks.versionsManifest = await makeVersionsManifest({
      latest: "1.5.0",
      version: "1.5.0",
      platformKey,
    });

    const { buildCliUpgradeCommand } = await import("../cli-upgrade");
    const result = await buildCliUpgradeCommand({
      dryRun: true,
      targetVersion: "v1.5.0",
    })(fakeCtx());

    expect(result.data).toMatchObject({
      status: "dry-run",
      currentVersion: "1.4.0",
      targetVersion: "1.5.0",
    });
  });

  it("dry-run reports downloadSha256 alongside the resolved version", async () => {
    const platformKey = await currentPlatformKey();
    mocks.versionsManifest = await makeVersionsManifest({
      latest: "1.5.0",
      version: "1.5.0",
      platformKey,
    });
    const expectedSha256 = createHash("sha256")
      .update(mocks.downloadContent)
      .digest("hex");

    const { buildCliUpgradeCommand } = await import("../cli-upgrade");
    const result = await buildCliUpgradeCommand({
      dryRun: true,
      targetVersion: null,
    })(fakeCtx());

    expect(result.data).toMatchObject({
      status: "dry-run",
      targetVersion: "1.5.0",
      downloadSha256: expectedSha256,
    });
    expect(existsSync(liveBinaryPath)).toBe(true);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("original-live-bytes");
  });
});
