import { createHash } from "node:crypto";
import {
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

// `buildCliUpgradeCommand`'s downgrade floor.
//
// The CLI release feed publishes STABLE builds only, so its `version` is not
// an upper bound: a machine on 1.5.2-rc.1 is ABOVE a feed serving 1.5.1.
// The command used to decide "is there anything to do?" by STRING EQUALITY
// against the feed's version, which answers "yes" there and installs 1.5.1
// over the prerelease - measured on a 1.5.2-rc.1 Linux box, where
// `cli upgrade --dry-run` targeted 1.5.1.
//
// These cases pin the ordering comparison that replaces it, including the
// two boundaries equality got right and must keep getting right (equal, and
// a genuinely newer feed), and the `--target` consent that is the way to
// install the published build anyway.
//
// Same seams as `cli-upgrade-target-version.test.ts`: `fetchCliVersions`
// and `downloadToFile` are mocked to stay off the network, while the
// manifest read/write, staging, rename and cli-lock all run for real
// against a tmp HOME.

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
const LIVE_BYTES = "original-live-bytes";
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

function writeManifest(version: string): void {
  const dir = join(workHome, ".traycer", "cli");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        version,
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: liveBinaryPath,
        source: "manual",
        pendingUpgrade: null,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function readManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(workHome, ".traycer", "cli", "manifest.json"), "utf8"),
  );
}

async function setFeedVersion(version: string): Promise<void> {
  const { currentCliPlatformKey } = await import("../../registry/cli-versions");
  const platformKey: HostPlatformKey = currentCliPlatformKey();
  mocks.versionsManifest = {
    schemaVersion: 1,
    generatedAt: "2026-05-01T00:00:00Z",
    latest: version,
    version,
    releaseNotesUrl: "https://example.test/release-notes",
    compatibilityEpoch: null,
    platforms: {
      [platformKey]: {
        available: true,
        unavailableReason: null,
        url: `https://example.test/cli/${version}/${platformKey}`,
        sizeBytes: mocks.downloadContent.length,
        sha256: createHash("sha256")
          .update(mocks.downloadContent)
          .digest("hex"),
        signatureUrl: `https://example.test/cli/${version}/${platformKey}.minisig`,
        signatureAlgorithm: "minisign",
        publicKeyId: "test-key",
      },
    },
  };
}

async function runUpgrade(args: {
  readonly dryRun: boolean;
  readonly targetVersion: string | null;
}): Promise<import("../../runner/runner").CommandResult> {
  const { buildCliUpgradeCommand } = await import("../cli-upgrade");
  return buildCliUpgradeCommand(args)(fakeCtx());
}

describe("buildCliUpgradeCommand downgrade floor", () => {
  beforeEach(() => {
    workHome = mkdtempSync(join(tmpdir(), "traycer-cli-upgrade-floor-test-"));
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    vi.resetModules();
    mocks.versionsManifest = null;
    mocks.downloadCalls = [];
    mocks.downloadContent = "staged-cli-bytes";

    liveBinaryPath = join(workHome, "bin", "traycer");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, LIVE_BYTES);
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

  // The field case, on the path a user actually runs: no `--target`, no
  // `--dry-run`. Falsification: drop the `wouldDowngradeCli` guard from
  // `cli-upgrade.ts` and this downloads and replaces the live binary with
  // 1.5.1 while reporting `replaced`.
  it("leaves an installed prerelease alone when the feed publishes an older stable, without downloading anything", async () => {
    writeManifest("1.5.2-rc.1");
    await setFeedVersion("1.5.1");

    const result = await runUpgrade({ dryRun: false, targetVersion: null });

    expect(result.data).toMatchObject({
      status: "installed-newer",
      currentVersion: "1.5.2-rc.1",
      targetVersion: "1.5.1",
    });
    expect(result.exitCode).toBe(0);
    expect(mocks.downloadCalls).toEqual([]);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(LIVE_BYTES);
    expect(readManifest()).toMatchObject({
      version: "1.5.2-rc.1",
      pendingUpgrade: null,
    });
    // Names both versions and the way to install the published one anyway,
    // so the sentence is actionable without re-reading `--help`.
    expect(result.human).toContain("1.5.2-rc.1");
    expect(result.human).toContain("1.5.1");
    expect(result.human).toContain("--target 1.5.1");
  });

  it("reports the same refusal under --dry-run", async () => {
    writeManifest("1.5.2-rc.1");
    await setFeedVersion("1.5.1");

    const dryRun = await runUpgrade({ dryRun: true, targetVersion: null });

    expect(dryRun.data).toMatchObject({
      status: "installed-newer",
      currentVersion: "1.5.2-rc.1",
      targetVersion: "1.5.1",
    });
    expect(dryRun.exitCode).toBe(0);
    expect(mocks.downloadCalls).toEqual([]);
  });

  // `--target` is the consent: the caller named the version, so installing
  // it is an explicit request rather than "bring me up to date".
  it("--target <older feed version> installs it, and says it went backwards", async () => {
    writeManifest("1.5.2-rc.1");
    await setFeedVersion("1.5.1");

    const result = await runUpgrade({ dryRun: false, targetVersion: "1.5.1" });

    expect(result.data).toMatchObject({
      status: "replaced",
      previousVersion: "1.5.2-rc.1",
      currentVersion: "1.5.1",
    });
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(mocks.downloadContent);
    expect(readManifest()).toMatchObject({ version: "1.5.1" });
    expect(result.human).toContain("downgraded cli 1.5.2-rc.1 → 1.5.1");
  });

  // The GA release of the installed prerelease. This is the boundary that
  // makes the comparison prerelease-aware rather than core-triplet-only:
  // 1.5.2-rc.1 and 1.5.2 share a core triplet, and the rc must lose.
  it("upgrades a prerelease to the stable release of the same version", async () => {
    writeManifest("1.5.2-rc.1");
    await setFeedVersion("1.5.2");

    const result = await runUpgrade({ dryRun: false, targetVersion: null });

    expect(result.data).toMatchObject({
      status: "replaced",
      previousVersion: "1.5.2-rc.1",
      currentVersion: "1.5.2",
    });
    expect(mocks.downloadCalls).toHaveLength(1);
    expect(readManifest()).toMatchObject({ version: "1.5.2" });
    expect(result.human).toContain("upgraded cli 1.5.2-rc.1 → 1.5.2");
  });

  it("keeps the already-current reading when the feed matches the installed version", async () => {
    writeManifest("1.5.1");
    await setFeedVersion("1.5.1");

    const result = await runUpgrade({ dryRun: false, targetVersion: null });

    expect(result.data).toMatchObject({
      status: "already-current",
      currentVersion: "1.5.1",
      targetVersion: "1.5.1",
    });
    expect(mocks.downloadCalls).toEqual([]);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(LIVE_BYTES);
  });

  // An installed version the comparator cannot parse - what `cli re-anchor
  // --installed-version` accepts, and what a locally-built CLI stamps. The
  // floor fails OPEN there: refusing on "can't tell" would leave such an
  // install with no self-upgrade route at all.
  it("upgrades from an unparseable installed version rather than refusing on an unprovable comparison", async () => {
    writeManifest("local-devbuild-1730000000");
    await setFeedVersion("1.5.1");

    const result = await runUpgrade({ dryRun: false, targetVersion: null });

    expect(result.data).toMatchObject({
      status: "replaced",
      previousVersion: "local-devbuild-1730000000",
      currentVersion: "1.5.1",
    });
    expect(mocks.downloadCalls).toHaveLength(1);
  });
});
