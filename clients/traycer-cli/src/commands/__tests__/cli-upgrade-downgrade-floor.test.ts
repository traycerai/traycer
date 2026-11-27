import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliVersionsManifest } from "../../registry/cli-versions";
import type { HostPlatformKey } from "../../registry/types";
import type { ScheduledTaskXmlQuery } from "../../service/platforms/windows";
import {
  createFeedSigningKey,
  feedPayload,
  signFeedPayload,
  type FeedSigningKey,
} from "../../registry/__tests__/signed-feed-test-helpers";

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
// a genuinely newer feed), and all four readings of a feed below the
// installed version - which are `host update`'s, by design: same
// comparator, same `--allow-downgrade` consent needing an explicit version
// beside it, and an explicitly-requested-but-undelivered version raised as
// an error rather than reported as a no-op.
//
// Same seams as `cli-upgrade-target-version.test.ts`: `fetchCliVersions`
// and `downloadToFile` are mocked to stay off the network, while the
// manifest read/write, staging, rename and cli-lock all run for real
// against a tmp HOME.

const mocks = vi.hoisted(() => ({
  pinnedKey: null as string | null,
  versionsManifest: null as CliVersionsManifest | null,
  downloadCalls: [] as Array<{ url: string; destPath: string }>,
  downloadContent: "staged-cli-bytes" as string | Buffer,
  // When set, `rename` onto THIS path fails with EBUSY, which is what the
  // supervisor holding the live binary looks like to the publish step
  // (`isBinaryLockedCode`). An unwritable directory cannot stand in for it:
  // the command pre-flights writability and refuses with
  // E_CLI_UPGRADE_REPLACE_FAILED before any download, so that route never
  // reaches the staging path at all.
  renameLockedDest: null as string | null,
}));

vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      get hostTrustedPubkeys() {
        return mocks.pinnedKey === null
          ? actual.config.hostTrustedPubkeys
          : [mocks.pinnedKey];
      },
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: string) => {
      if (mocks.renameLockedDest !== null && to === mocks.renameLockedDest) {
        const err: NodeJS.ErrnoException = new Error(
          `EBUSY: resource busy or locked, rename -> '${to}'`,
        );
        err.code = "EBUSY";
        throw err;
      }
      return actual.rename(from, to);
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

function feedAsset(version: string, platformKey: HostPlatformKey) {
  return {
    available: true,
    unavailableReason: null,
    url: `https://example.test/cli/${version}/${platformKey}`,
    sizeBytes: mocks.downloadContent.length,
    sha256: createHash("sha256").update(mocks.downloadContent).digest("hex"),
    signatureUrl: `https://example.test/cli/${version}/${platformKey}.minisig`,
    signatureAlgorithm: "minisign" as const,
    publicKeyId: "test-key",
  };
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
    platforms: { [platformKey]: feedAsset(version, platformKey) },
  };
}

async function setWindowsFeedVersion(version: string): Promise<void> {
  await setFeedVersion(version);
  const manifest = mocks.versionsManifest;
  if (manifest === null) {
    throw new Error("test bug: versionsManifest was not set");
  }
  mocks.versionsManifest = {
    ...manifest,
    platforms: {
      ...manifest.platforms,
      "win32-x64": feedAsset(version, "win32-x64"),
    },
  };
}

function signedWindowsFeed(signingKey: FeedSigningKey): string {
  const versions = mocks.versionsManifest;
  if (versions === null) throw new Error("missing fixture feed");
  return signFeedPayload(
    JSON.stringify(
      feedPayload({
        feed: "cli",
        latest: versions.version,
        versions: [
          {
            version: versions.version,
            releaseNotesUrl: versions.releaseNotesUrl,
            platforms: versions.platforms,
          },
        ],
      }),
    ),
    signingKey,
  );
}

async function runUpgrade(args: {
  readonly dryRun: boolean;
  readonly targetVersion: string | null;
  readonly allowDowngrade: boolean;
}): Promise<import("../../runner/runner").CommandResult> {
  const { buildCliUpgradeCommand } = await import("../cli-upgrade");
  return buildCliUpgradeCommand(args)(fakeCtx());
}

async function withWindowsTaskDefinition<T>(
  mode: "absent" | "logon" | "boot" | "unavailable" | "hidden",
  action: (queryCalls: string[]) => Promise<T>,
): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  const windows = await import("../../service/platforms/windows");
  const { serviceLabelFor } = await import("../../service/label");
  const queryCalls: string[] = [];
  const label = serviceLabelFor("production");
  const result: ScheduledTaskXmlQuery =
    mode === "absent" || mode === "hidden"
      ? { kind: "absent" }
      : mode === "unavailable"
        ? { kind: "failed", reason: "Task Scheduler is unavailable" }
        : {
            kind: "xml",
            xml: windows.buildScheduledTaskXml(
              {
                label,
                cli: { command: "C:\\Traycer\\traycer.exe", args: [] },
                windowsBootRunLevel:
                  mode === "boot" ? "HighestAvailable" : null,
              },
              "S-1-5-21-1234-5678-9012-1001",
              true,
            ),
          };
  windows.setWindowsTaskUserSidReaderForTests(
    () => "S-1-5-21-1234-5678-9012-1001",
  );
  windows.setWindowsTaskHiddenProbeForTests(async () => mode === "hidden");
  windows.setWindowsDefinitionDepsForTests({
    queryTaskXml: async (taskName) => {
      queryCalls.push(taskName);
      return result;
    },
    predictCli: async () => {
      throw new Error("predictCli should not be called");
    },
    resolveCli: async () => {
      throw new Error("resolveCli should not be called");
    },
  });
  try {
    return await action(queryCalls);
  } finally {
    windows.setWindowsDefinitionDepsForTests(null);
    windows.setWindowsTaskHiddenProbeForTests(null);
    windows.setWindowsTaskUserSidReaderForTests(null);
    if (originalPlatform !== undefined) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  }
}

function windowsCliBytes(supportsBootTask: boolean): Buffer {
  const dosAndPeHeader = Buffer.alloc(68);
  dosAndPeHeader.write("MZ", 0, "ascii");
  dosAndPeHeader.writeUInt32LE(64, 0x3c);
  dosAndPeHeader.write("PE\0\0", 64, "binary");
  const source = Buffer.from('.option("--start-at-boot", "Example")');
  const marker = Buffer.from(
    "traycer:windows-unattended-service:1:ed362e23-7428-47cf-b857-ff24ea69d5d2\n",
  );
  return Buffer.concat([dosAndPeHeader, supportsBootTask ? marker : source]);
}

async function writeWellKnownSlot(bytes: Buffer): Promise<string> {
  const { wellKnownCliBinaryPath } = await import("../../store/well-known-cli");
  const slotPath = wellKnownCliBinaryPath("production");
  mkdirSync(dirname(slotPath), { recursive: true });
  writeFileSync(slotPath, bytes);
  return slotPath;
}

describe("buildCliUpgradeCommand downgrade floor", () => {
  beforeEach(() => {
    workHome = mkdtempSync(join(tmpdir(), "traycer-cli-upgrade-floor-test-"));
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    vi.resetModules();
    mocks.versionsManifest = null;
    mocks.pinnedKey = null;
    mocks.downloadCalls = [];
    mocks.downloadContent = "staged-cli-bytes";
    mocks.renameLockedDest = null;

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

    const result = await runUpgrade({
      dryRun: false,
      targetVersion: null,
      allowDowngrade: false,
    });

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
    // "Nothing changed" down to the install directory's contents: the
    // refusal happens before the writability probe and before staging, so
    // it leaves behind neither a `.traycer-upgrade-probe-*` nor the
    // `.traycer-upgrade-*.download` file that a FAILED upgrade keeps on
    // purpose for its retry.
    expect(readdirSync(join(workHome, "bin"))).toEqual(["traycer"]);
    // Names both versions and the whole way to install the published one
    // anyway, so the sentence is actionable without re-reading `--help`.
    expect(result.human).toContain("1.5.2-rc.1");
    expect(result.human).toContain("1.5.1");
    expect(result.human).toContain("--target 1.5.1 --allow-downgrade");
  });

  it("reports the same refusal under --dry-run", async () => {
    writeManifest("1.5.2-rc.1");
    await setFeedVersion("1.5.1");

    const dryRun = await runUpgrade({
      dryRun: true,
      targetVersion: null,
      allowDowngrade: false,
    });

    expect(dryRun.data).toMatchObject({
      status: "installed-newer",
      currentVersion: "1.5.2-rc.1",
      targetVersion: "1.5.1",
    });
    expect(dryRun.exitCode).toBe(0);
    expect(mocks.downloadCalls).toEqual([]);
  });

  // Consent is BOTH halves, the way `host update --release X
  // --allow-downgrade` is. The two cases below pin each half as
  // insufficient on its own.
  it("--target <older feed version> with --allow-downgrade installs it, and says it went backwards", async () => {
    writeManifest("1.5.2-rc.1");
    await setFeedVersion("1.5.1");

    const result = await runUpgrade({
      dryRun: false,
      targetVersion: "1.5.1",
      allowDowngrade: true,
    });

    expect(result.data).toMatchObject({
      status: "replaced",
      previousVersion: "1.5.2-rc.1",
      currentVersion: "1.5.1",
    });
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(mocks.downloadContent);
    expect(readManifest()).toMatchObject({ version: "1.5.1" });
    expect(result.human).toContain("downgraded cli 1.5.2-rc.1 → 1.5.1");
  });

  // The write half of the consent channel, and the regression that made it
  // necessary. A consented downgrade whose publish cannot happen now - the
  // live binary is held by the supervisor - is STAGED, and the publish runs in
  // a later process that sees only the manifest. If the record did not carry
  // the consent, the floor inside `finalizePendingCliUpgrade` would refuse it
  // on every restart, and Doctor's own card pointed at this exact command: the
  // guidance and the recovery would both be dead ends. Asserted on the
  // persisted bytes, because the persisted record is the only thing the
  // publisher gets.
  it("records downgrade consent on the pending upgrade when the live binary is locked", async () => {
    writeManifest("1.5.2-rc.1");
    await setFeedVersion("1.5.1");
    mocks.renameLockedDest = liveBinaryPath;

    const result = await runUpgrade({
      dryRun: false,
      targetVersion: "1.5.1",
      allowDowngrade: true,
    });

    expect(result.data).toMatchObject({
      status: "pending-upgrade",
      stagedVersion: "1.5.1",
      reason: "binary-locked",
    });
    expect(readManifest()).toMatchObject({
      version: "1.5.2-rc.1",
      pendingUpgrade: { version: "1.5.1", allowDowngrade: true },
    });
    // A deferral, not a publish: the live binary still holds its own bytes.
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(LIVE_BYTES);
  });

  // `--target` alone is NOT consent. It is an assertion that the feed still
  // serves a build, so a caller naming the feed's own version to check it
  // has not asked to be moved onto it - and an explicitly requested version
  // that is not delivered is an error, not a silent exit 0. Same code shape
  // as the host's `E_HOST_UPDATE_NOT_NEWER`, down to naming
  // `--allow-downgrade` as the way through.
  it("--target <older feed version> WITHOUT --allow-downgrade raises E_CLI_UPGRADE_NOT_NEWER and transfers nothing", async () => {
    writeManifest("1.5.2-rc.1");
    await setFeedVersion("1.5.1");

    const { CLI_ERROR_CODES, CliError } = await import("../../runner/errors");
    let caught: unknown = null;
    try {
      await runUpgrade({
        dryRun: false,
        targetVersion: "1.5.1",
        allowDowngrade: false,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe(CLI_ERROR_CODES.CLI_UPGRADE_NOT_NEWER);
      expect(caught.exitCode).toBe(1);
      expect(caught.details).toMatchObject({
        installedVersion: "1.5.2-rc.1",
        targetVersion: "1.5.1",
      });
      expect(caught.message).toContain("--allow-downgrade");
    }
    expect(mocks.downloadCalls).toEqual([]);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(LIVE_BYTES);
    expect(readManifest()).toMatchObject({ version: "1.5.2-rc.1" });
  });

  // `--allow-downgrade` alone is not consent either: an unqualified "bring
  // me up to date" must not go backwards just because the flag was on the
  // command line. The host refuses the same shape - a bare
  // `host update --allow-downgrade` resolving `latest` below the install is
  // still up to date.
  it("--allow-downgrade without --target still changes nothing", async () => {
    writeManifest("1.5.2-rc.1");
    await setFeedVersion("1.5.1");

    const result = await runUpgrade({
      dryRun: false,
      targetVersion: null,
      allowDowngrade: true,
    });

    expect(result.data).toMatchObject({
      status: "installed-newer",
      currentVersion: "1.5.2-rc.1",
      targetVersion: "1.5.1",
    });
    expect(result.exitCode).toBe(0);
    expect(mocks.downloadCalls).toEqual([]);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(LIVE_BYTES);
  });

  // An EARLIER rc of the release the machine is already on - the CLI-side
  // shape of the Windows venue's `host update --release 1.5.2-rc.1` over an
  // installed rc.2. This is the case that genuinely requires PRE-RELEASE
  // ordering: rc.1 and rc.2 share a core triplet, so a comparison that
  // stripped prerelease identifiers reads them as equal, declines to
  // refuse, and - because the two strings still differ, so the
  // already-current check does not fire either - downloads rc.1 and
  // installs it over rc.2. Measured: flattening `comparePreRelease` to
  // "equal" in the protocol comparator reds this case and no other here.
  it("leaves an installed rc alone when the feed publishes an EARLIER rc of the same release", async () => {
    writeManifest("1.5.2-rc.2");
    await setFeedVersion("1.5.2-rc.1");

    const result = await runUpgrade({
      dryRun: false,
      targetVersion: null,
      allowDowngrade: false,
    });

    expect(result.data).toMatchObject({
      status: "installed-newer",
      currentVersion: "1.5.2-rc.2",
      targetVersion: "1.5.2-rc.1",
    });
    expect(mocks.downloadCalls).toEqual([]);
    expect(readFileSync(liveBinaryPath, "utf8")).toBe(LIVE_BYTES);
    expect(readManifest()).toMatchObject({ version: "1.5.2-rc.2" });
  });

  // The GA release of the installed prerelease, which must NOT be refused:
  // the floor's job is to stop backwards moves, and an rc reaching its own
  // stable release is the forward move the whole command exists for.
  it("upgrades a prerelease to the stable release of the same version", async () => {
    writeManifest("1.5.2-rc.1");
    await setFeedVersion("1.5.2");

    const result = await runUpgrade({
      dryRun: false,
      targetVersion: null,
      allowDowngrade: false,
    });

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

    const result = await runUpgrade({
      dryRun: false,
      targetVersion: null,
      allowDowngrade: false,
    });

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

    const result = await runUpgrade({
      dryRun: false,
      targetVersion: null,
      allowDowngrade: false,
    });

    expect(result.data).toMatchObject({
      status: "replaced",
      previousVersion: "local-devbuild-1730000000",
      currentVersion: "1.5.1",
    });
    expect(mocks.downloadCalls).toHaveLength(1);
  });

  describe("Windows CLI downgrade task compatibility", () => {
    it.each(["unavailable", "hidden"] as const)(
      "retries a %s task definition before refusing to replace the live slot",
      async (mode) => {
        writeManifest("1.5.2-rc.1");
        mocks.downloadContent = windowsCliBytes(false);
        await setWindowsFeedVersion("1.5.1");

        await withWindowsTaskDefinition(mode, async (queryCalls) => {
          const slotBytes = Buffer.from("original-well-known-slot");
          const slotPath = await writeWellKnownSlot(slotBytes);
          const { CLI_ERROR_CODES } = await import("../../runner/errors");

          await expect(
            runUpgrade({
              dryRun: false,
              targetVersion: "1.5.1",
              allowDowngrade: true,
            }),
          ).rejects.toMatchObject({
            code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
            message: expect.stringContaining("Task Scheduler is available"),
            exitCode: 1,
          });

          expect(queryCalls).toHaveLength(2);
          expect(mocks.downloadCalls).toHaveLength(1);
          expect(readFileSync(liveBinaryPath, "utf8")).toBe(LIVE_BYTES);
          expect(readFileSync(slotPath)).toEqual(slotBytes);
          expect(readManifest()).toMatchObject({
            version: "1.5.2-rc.1",
            pendingUpgrade: null,
          });
        });
      },
    );

    it.each([false, true])(
      "reverifies staged signed evidence after the feed advances (tampered: %s)",
      async (tampered) => {
        const version = "1.5.1";
        const signingKey = createFeedSigningKey();
        mocks.pinnedKey = signingKey.publicKeyText;
        try {
          writeManifest("1.5.0");
          mocks.downloadContent = windowsCliBytes(true);
          const payload = mocks.downloadContent;
          await setWindowsFeedVersion(version);
          const versions = mocks.versionsManifest;
          if (versions === null) throw new Error("missing fixture feed");
          const envelope = signedWindowsFeed(signingKey);
          mocks.versionsManifest = { ...versions, signedEnvelope: envelope };
          mocks.renameLockedDest = liveBinaryPath;

          await withWindowsTaskDefinition("boot", async () => {
            const out = await runUpgrade({
              dryRun: false,
              targetVersion: null,
              allowDowngrade: false,
            });
            expect(out.data).toMatchObject({ status: "pending-upgrade" });
            const staged = mocks.downloadCalls[0]?.destPath;
            if (staged === undefined) throw new Error("missing staged binary");
            const receipt = `${staged}.release-evidence.json`;
            expect(readFileSync(receipt, "utf8")).toBe(envelope);
            mocks.renameLockedDest = null;
            await setWindowsFeedVersion("1.5.2");
            if (tampered)
              writeFileSync(receipt, envelope.replace("1.5.1", "1.5.9"));

            const { finalizePendingCliUpgrade } =
              await import("../cli-upgrade");
            await expect(
              finalizePendingCliUpgrade({ environment: "production" }),
            ).resolves.toMatchObject(
              tampered
                ? { status: "publish-failed" }
                : { status: "finalised", version },
            );
            expect(mocks.downloadCalls).toHaveLength(1);
            if (tampered) {
              expect(readFileSync(liveBinaryPath, "utf8")).toBe(LIVE_BYTES);
              expect(readManifest()).toMatchObject({
                pendingUpgrade: { version },
              });
            } else {
              expect(readFileSync(liveBinaryPath)).toEqual(payload);
              expect(readManifest()).toMatchObject({
                version,
                pendingUpgrade: null,
              });
            }
          });
        } finally {
          mocks.pinnedKey = null;
        }
      },
    );

    it("refuses a markerless release above the recorded version when the authenticated installed CLI is higher", async () => {
      const signingKey = createFeedSigningKey();
      mocks.pinnedKey = signingKey.publicKeyText;
      try {
        writeManifest("1.0.0");
        const installed = windowsCliBytes(true);
        writeFileSync(liveBinaryPath, installed);
        mocks.downloadContent = installed;
        await setWindowsFeedVersion("2.0.0");
        writeFileSync(
          `${liveBinaryPath}.release-evidence.json`,
          signedWindowsFeed(signingKey),
        );
        mocks.downloadContent = windowsCliBytes(false);
        await setWindowsFeedVersion("1.5.1");

        await withWindowsTaskDefinition("boot", async (reads) => {
          await expect(
            runUpgrade({
              dryRun: false,
              targetVersion: null,
              allowDowngrade: false,
            }),
          ).rejects.toMatchObject({
            code: "E_CLI_UPGRADE_BOOT_TASK_UNSUPPORTED",
          });
          expect(reads).toHaveLength(1);
          expect(readFileSync(liveBinaryPath)).toEqual(installed);
          expect(readManifest()).toMatchObject({
            version: "1.0.0",
            pendingUpgrade: null,
          });
        });
      } finally {
        mocks.pinnedKey = null;
      }
    });

    it.each(["absent", "logon"] as const)(
      "allows a downgrade when the registered task is %s",
      async (mode) => {
        writeManifest("1.5.2-rc.1");
        mocks.downloadContent = windowsCliBytes(false);
        await setWindowsFeedVersion("1.5.1");

        await withWindowsTaskDefinition(mode, async (queryCalls) => {
          const result = await runUpgrade({
            dryRun: false,
            targetVersion: "1.5.1",
            allowDowngrade: true,
          });

          expect(result.data).toMatchObject({
            status: "replaced",
            previousVersion: "1.5.2-rc.1",
            currentVersion: "1.5.1",
          });
          expect(queryCalls).toHaveLength(2);
          expect(readFileSync(liveBinaryPath)).toEqual(mocks.downloadContent);
        });
      },
    );

    it("refuses a boot task when the older candidate lacks the boot option", async () => {
      writeManifest("1.5.2-rc.1");
      mocks.downloadContent = windowsCliBytes(false);
      await setWindowsFeedVersion("1.5.1");

      await withWindowsTaskDefinition("boot", async (queryCalls) => {
        const { CLI_ERROR_CODES } = await import("../../runner/errors");

        await expect(
          runUpgrade({
            dryRun: false,
            targetVersion: "1.5.1",
            allowDowngrade: true,
          }),
        ).rejects.toMatchObject({
          code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
          message: expect.stringContaining("--start-at-boot"),
        });

        expect(queryCalls).toHaveLength(1);
        expect(readFileSync(liveBinaryPath, "utf8")).toBe(LIVE_BYTES);
      });
    });

    it("allows a boot-task downgrade when the feed-authenticated PE carries the capability marker", async () => {
      writeManifest("1.5.2-rc.1");
      mocks.downloadContent = windowsCliBytes(true);
      await setWindowsFeedVersion("1.5.1");

      await withWindowsTaskDefinition("boot", async (queryCalls) => {
        const result = await runUpgrade({
          dryRun: false,
          targetVersion: "1.5.1",
          allowDowngrade: true,
        });

        expect(result.data).toMatchObject({ status: "replaced" });
        expect(queryCalls).toHaveLength(2);
        expect(readFileSync(liveBinaryPath)).toEqual(mocks.downloadContent);
      });
    });
  });
});
