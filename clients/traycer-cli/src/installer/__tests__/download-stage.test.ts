import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform as osPlatform } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Environment = "dev" | "production";

let sandboxRoot = "";

function hostHomeFor(environment: Environment): string {
  return join(sandboxRoot, "host", environment);
}
function installDirFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install");
}
function stagingRootFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install-staging");
}
function stagedDirFor(environment: Environment): string {
  return join(hostHomeFor(environment), "staged");
}
function cliHomeFor(): string {
  return join(sandboxRoot, "cli");
}

// `store/paths` computes `TRAYCER_HOME` from `os.homedir()` once at module
// load - any export this mock leaves un-overridden would otherwise resolve
// against the REAL production `~/.traycer`, not this sandbox. Redirect the
// `os` boundary itself so `vi.importActual`'s fresh module evaluation picks
// up the sandbox (falling back to the real tmpdir, never the real home,
// before the first `beforeEach` has set `sandboxRoot`).
// `vi.mock` factories are hoisted above this file's own top-level `let
// sandboxRoot` - a direct reference hits a TDZ `ReferenceError`, so the
// live value has to live in `vi.hoisted` instead.
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
  return {
    ...actual,
    hostHomeDir: (environment: Environment) => hostHomeFor(environment),
    hostInstallDir: (environment: Environment) => installDirFor(environment),
    hostInstallRecordPath: (environment: Environment) =>
      join(installDirFor(environment), "install.json"),
    hostStagingRoot: (environment: Environment) => stagingRootFor(environment),
    hostStagedDir: (environment: Environment) => stagedDirFor(environment),
    ensureHostHomeDir: async (environment: Environment) => {
      mkdirSync(hostHomeFor(environment), { recursive: true });
    },
    ensureHostInstallDir: async (environment: Environment) => {
      mkdirSync(installDirFor(environment), { recursive: true });
    },
    ensureHostStagingRoot: async (environment: Environment) => {
      mkdirSync(stagingRootFor(environment), { recursive: true });
    },
    ensureHostHomeDirForStaged: async (environment: Environment) => {
      mkdirSync(hostHomeFor(environment), { recursive: true });
    },
    cliLockPath: () => join(cliHomeFor(), ".lock"),
    ensureCliInstallHomeDir: async () => {
      mkdirSync(cliHomeFor(), { recursive: true });
    },
  };
});

import { currentInstallArch, currentInstallPlatform } from "../install";
import {
  writeHostInstallRecord,
  type HostInstallRecord,
} from "../../manifest/host-install";
import {
  readHostStagedRecord,
  writeHostStagedRecordAt,
  HOST_STAGED_RECORD_SCHEMA_VERSION,
  type HostStagedRecord,
} from "../../manifest/host-staged";
import { currentHostPlatformKey } from "../../registry";
import type {
  HostPlatformAsset,
  HostVersionEntry,
  HostVersionsManifest,
  RegistryClient,
} from "../../registry";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import { acquireCliLock } from "../../store/cli-lock";
import {
  decideHostDownloadPromotion,
  downloadAndStageHost,
  resolveUpdatePlan,
} from "../download-stage";
import {
  updateAttemptRecordPath,
  type HostUpdateAttemptIdentity,
  type HostUpdateAttemptRecord,
} from "@traycer-clients/shared/host-update";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";
import {
  expectReached,
  expectStillGated,
} from "../../__tests__/support/barrier-gate";

const ENV: Environment = "production";
let archiveTmpDir = "";
// Path the fake registry client handed back on its most recent download,
// so a test can assert the caller released that exact slot.
let lastFakeArchivePath = "";

function executableBasename(): string {
  return osPlatform() === "win32" ? "traycer-host.exe" : "traycer-host";
}

interface FakeVersionSpec {
  readonly version: string;
  readonly yanked: boolean;
}

interface FakeClientOptions {
  readonly latest: string;
  readonly versions: readonly FakeVersionSpec[];
  readonly downloadGate: Promise<void> | null;
  readonly onDownloadStart: (() => void) | null;
}

function buildManifest(opts: FakeClientOptions): HostVersionsManifest {
  const platformKey = currentHostPlatformKey();
  const versions: HostVersionEntry[] = opts.versions.map((v) => {
    const asset: HostPlatformAsset = {
      available: true,
      unavailableReason: null,
      url: `https://example.com/${v.version}/${executableBasename()}`,
      sizeBytes: Buffer.byteLength("fake host binary"),
      sha256: "unused-in-fake",
      signatureUrl: `https://example.com/${v.version}/${executableBasename()}.minisig`,
      signatureAlgorithm: "minisign",
      publicKeyId: "fake-key-id",
    };
    return {
      version: v.version,
      releasedAt: new Date().toISOString(),
      releaseNotesUrl: "",
      yanked: v.yanked,
      deprecationReason: v.yanked ? "test-yanked" : null,
      requiredCliVersion: null,
      minimumEpoch: null,
      platforms: { [platformKey]: asset },
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    latest: opts.latest,
    versions,
  };
}

// A hand-rolled `RegistryClient` double - bypasses the real minisign trust
// chain entirely (already covered by `registry/__tests__/{client,
// minisign}.test.ts`). These tests exercise `download-stage.ts`'s OWN
// logic: short-circuits, promote policy, reconcile integration, and lock
// timing around the transfer.
function fakeRegistryClient(opts: FakeClientOptions): RegistryClient {
  const manifest = buildManifest(opts);
  return {
    async fetchManifest() {
      return manifest;
    },
    async resolveAsset(versionRequest, platformKey) {
      const resolvedVersion =
        versionRequest === "latest" ? manifest.latest : versionRequest;
      const entry = manifest.versions.find(
        (v) => v.version === resolvedVersion,
      );
      if (entry === undefined) {
        throw new CliError({
          code: CLI_ERROR_CODES.REGISTRY_VERSION_NOT_FOUND,
          message: `fake registry: version '${resolvedVersion}' not found`,
          details: null,
          exitCode: 1,
        });
      }
      if (entry.yanked) {
        throw new CliError({
          code: CLI_ERROR_CODES.REGISTRY_VERSION_NOT_FOUND,
          message: `fake registry: version '${resolvedVersion}' is yanked`,
          details: null,
          exitCode: 1,
        });
      }
      const asset = entry.platforms[platformKey];
      if (asset === undefined) {
        throw new CliError({
          code: CLI_ERROR_CODES.REGISTRY_VERSION_NOT_FOUND,
          message: `fake registry: no asset for ${platformKey}`,
          details: null,
          exitCode: 1,
        });
      }
      return { entry, asset };
    },
    async downloadAndVerify(entry, asset, onProgress) {
      if (opts.onDownloadStart !== null) opts.onDownloadStart();
      onProgress({
        downloadedBytes: asset.sizeBytes,
        totalBytes: asset.sizeBytes,
      });
      if (opts.downloadGate !== null) await opts.downloadGate;
      // `extractHostSource`'s bare-file branch copies using the SOURCE
      // file's own basename, so the archive's basename must be exactly
      // the expected executable name - not version-prefixed. Each call
      // gets its own unique directory so overlapping/sequential calls in
      // one test never collide.
      const callDir = mkdtempSync(join(archiveTmpDir, "arc-"));
      const archivePath = join(callDir, executableBasename());
      writeFileSync(archivePath, "fake host binary");
      // The real client stages into the shared download cache and stamps
      // the archive with an ownership marker holding ITS OWN process identity
      // (registry/download-cache.ts). Mirror that sibling faithfully - the
      // release path is a compare-and-delete, so a marker recording someone
      // else's pid is deliberately left alone.
      writeFileSync(
        `${archivePath}.owner`,
        JSON.stringify({ pid: process.pid, startedAtMs: null }),
      );
      lastFakeArchivePath = archivePath;
      return {
        archivePath,
        archiveSha256: "fake-sha256",
        signatureKeyId: "fake-key-id",
        signatureVerifiedAt: new Date().toISOString(),
      };
    },
  };
}

// Downloads "successfully" but stages an archive whose basename is not the
// expected host executable, so `resolveHostExecutable` throws AFTER the
// transfer and verification have both passed. Reproduces every local
// post-download failure - a bad extract, a tree missing the binary, a
// `cli-lock` wait that times out - in the one shape this harness can force.
function unresolvableArchiveRegistryClient(
  base: RegistryClient,
  onArchive: (archivePath: string) => void,
): RegistryClient {
  return {
    ...base,
    async downloadAndVerify(entry, asset, onProgress) {
      onProgress({
        downloadedBytes: asset.sizeBytes,
        totalBytes: asset.sizeBytes,
      });
      const callDir = mkdtempSync(join(archiveTmpDir, "arc-"));
      const archivePath = join(callDir, "not-the-host-binary");
      writeFileSync(archivePath, "fake host binary");
      writeFileSync(
        `${archivePath}.owner`,
        JSON.stringify({ pid: process.pid, startedAtMs: null }),
      );
      onArchive(archivePath);
      return {
        archivePath,
        archiveSha256: "fake-sha256",
        signatureKeyId: "fake-key-id",
        signatureVerifiedAt: new Date().toISOString(),
      };
    },
  };
}

// Every method throws - the `resolveUpdatePlan` seam for proving an intent
// that must complete with the registry unreachable never actually calls it.
// A `RegistryClient` the plan never touches is the only honest way to prove
// "never touches the registry": a spy that merely counts calls would still
// let the plan reach the network in a real run.
function unreachableRegistryClient(): RegistryClient {
  return {
    async fetchManifest() {
      throw new Error("resolveUpdatePlan must not call fetchManifest here");
    },
    async resolveAsset() {
      throw new Error("resolveUpdatePlan must not call resolveAsset here");
    },
    async downloadAndVerify() {
      throw new Error("resolveUpdatePlan must not call downloadAndVerify here");
    },
  };
}

function throwingRegistryClient(base: RegistryClient): RegistryClient {
  return {
    ...base,
    async downloadAndVerify() {
      throw new Error("simulated download failure");
    },
  };
}

async function writeInstall(
  version: string,
  overrides: Partial<HostInstallRecord>,
): Promise<HostInstallRecord> {
  const installDir = installDirFor(ENV);
  mkdirSync(installDir, { recursive: true });
  const executablePath = join(installDir, executableBasename());
  writeFileSync(executablePath, "binary");
  const record: HostInstallRecord = {
    installId: null,
    version,
    runtimeVersion: null,
    platform: currentInstallPlatform(),
    arch: currentInstallArch(),
    installedAt: new Date().toISOString(),
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: new Date().toISOString(),
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath,
    executableSha256: null,
    ...overrides,
  };
  await writeHostInstallRecord(ENV, record);
  return record;
}

function noopProgress(): void {
  // Progress events aren't asserted in most tests - a no-op sink keeps
  // call sites terse.
}

function attemptRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "1.2.0",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

// Promote-time STATE INJECTION: a raw, test-only write straight to the
// canonical `update-attempt.json` path `download-stage.ts`'s promote-time
// guard reads - NOT a conforming reproduction of a real concurrent-process
// race. The public `downloadAndStageHost` holds its outer stage-maintenance
// capability for the whole segment (acquire through transfer through
// promote) and currently exposes no adoption input a second contender could
// use to legitimately hold or hand off that same capability mid-segment, so
// there is no way, today, for a second REAL contender to reach and write
// this file while this call's transfer is in flight without that write
// itself being refused by the very capability this call holds. This helper
// bypasses that entirely and writes the bytes directly, which is sufficient
// to exercise the guard's OWN read-and-decide logic in isolation, but it is
// not evidence that the modeled race is reachable through any currently
// public API. If `downloadAndStageHost` (or its shared segment machinery)
// ever gains an adoption input - the same shape `withCliUpdateExecutionSegment`
// already supports for other callers - this locking argument, and whether
// the race these tests model becomes actually reachable, must be revisited.
function writeAttemptRecord(overrides: Partial<HostUpdateAttemptRecord>): void {
  const home = hostHomeFor(ENV);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    updateAttemptRecordPath(home),
    `${JSON.stringify(attemptRecord(overrides))}\n`,
  );
}

// Recursive path->content snapshot of a directory tree, for `resolveUpdatePlan`'s
// no-writes pin: a plan that reads the install/staged records and the
// registry must leave every byte on disk exactly as it found it. Returns
// `{}` for a directory that does not exist, so "the host home was never
// created" and "the host home was created but left empty" both snapshot
// identically, matching what a genuine no-write function does either way.
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const entryPath = join(dir, name);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath);
      } else {
        out[entryPath] = readFileSync(entryPath, "utf8");
      }
    }
  };
  walk(root);
  return out;
}

// A manually-releasable gate for simulating a slow download. Stored as an
// object property (rather than a bare `let` reassigned inside the promise
// executor) so `release()` stays soundly typed as `() => void` at every
// call site - TS's control-flow narrowing doesn't track reassignment
// through a closure reliably for a plain nullable `let`.
interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}
function makeGate(): Gate {
  const state: { resolve: (() => void) | null } = { resolve: null };
  const promise = new Promise<void>((resolve) => {
    state.resolve = resolve;
  });
  return {
    promise,
    release: () => state.resolve?.(),
  };
}

describe("downloadAndStageHost", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-download-stage-test-"));
    osHome.current = sandboxRoot;
    archiveTmpDir = mkdtempSync(
      join(tmpdir(), "traycer-download-stage-archives-"),
    );
    // Cleared per test so an absence assertion cannot pass against a stale
    // path from an earlier test whose files are already gone - that would
    // make a "the slot was released" check succeed without a release.
    lastFakeArchivePath = "";
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
    rmSync(archiveTmpDir, { recursive: true, force: true });
  });

  it("throws E_HOST_NOT_INSTALLED when no host is installed", async () => {
    const client = fakeRegistryClient({
      latest: "1.0.0",
      versions: [{ version: "1.0.0", yanked: false }],
      downloadGate: null,
      onDownloadStart: null,
    });
    await expect(
      downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: false,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_NOT_INSTALLED });
  });
  it("throws before any lock or transfer when the manifest's latest is not valid SemVer", async () => {
    await writeInstall("1.0.0", {});
    let downloadStarted = false;
    const client = fakeRegistryClient({
      // Malformed - the "v" prefix is not valid SemVer. A real registry
      // publisher bug, not user input.
      latest: "v2.0.0",
      versions: [{ version: "v2.0.0", yanked: false }],
      downloadGate: null,
      onDownloadStart: () => {
        downloadStarted = true;
      },
    });
    await expect(
      downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: false,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE });
    expect(downloadStarted).toBe(false);
    expect(await readHostStagedRecord(ENV)).toBeNull();
  });
  it("short-circuits when the installed version is already at or above the target", async () => {
    await writeInstall("1.5.0", {});
    let downloadStarted = false;
    const client = fakeRegistryClient({
      latest: "1.5.0",
      versions: [{ version: "1.5.0", yanked: false }],
      downloadGate: null,
      onDownloadStart: () => {
        downloadStarted = true;
      },
    });
    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: client,
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(outcome).toMatchObject({
      outcome: "short-circuit",
      reason: "installed-up-to-date",
    });
    expect(downloadStarted).toBe(false);
  });

  it("EXPLICIT request for another build of the installed release (2.0.0+foo over 2.0.0+bar): refused as E_HOST_UPDATE_NOT_NEWER before any transfer, not 'up to date'", async () => {
    // Codex r3945280604: the comparator calls the pair equal, so this read
    // as installed-up-to-date and `host update --version 2.0.0+foo` exited 0
    // with the requested artifact never delivered. Falsification: drop the
    // string check in phase 1 and this resolves as a short-circuit.
    await writeInstall("2.0.0+bar", {});
    let downloadStarted = false;
    let announced = false;
    await expect(
      downloadAndStageHost({
        environment: ENV,
        versionRequest: "2.0.0+foo",
        automatic: false,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "2.0.0+foo",
          versions: [{ version: "2.0.0+foo", yanked: false }],
          downloadGate: null,
          onDownloadStart: () => {
            downloadStarted = true;
          },
        }),
        onWillDownload: async () => {
          announced = true;
        },
        beforeExtract: async () => {},
        ownAttempt: null,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      details: { targetVersion: "2.0.0+foo", installedVersion: "2.0.0+bar" },
    });
    expect(downloadStarted).toBe(false);
    expect(announced).toBe(false);
    expect(await readHostStagedRecord(ENV)).toBeNull();
  });

  it("EXPLICIT request BELOW the installed record (1.2.0 over 2.0.0): refused as E_HOST_UPDATE_NOT_NEWER before any transfer - a request that delivered nothing does not report 'up to date'", async () => {
    // Falsification: narrow the phase-1 check back to the comparator's
    // "equal" and this resolves as installed-up-to-date, exit 0, with
    // nothing delivered for 1.2.0.
    await writeInstall("2.0.0", {});
    let downloadStarted = false;
    await expect(
      downloadAndStageHost({
        environment: ENV,
        versionRequest: "1.2.0",
        automatic: false,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "2.0.0",
          versions: [
            { version: "1.2.0", yanked: false },
            { version: "2.0.0", yanked: false },
          ],
          downloadGate: null,
          onDownloadStart: () => {
            downloadStarted = true;
          },
        }),
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      message: expect.stringContaining("newer than the requested 1.2.0"),
      details: { targetVersion: "1.2.0", installedVersion: "2.0.0" },
    });
    expect(downloadStarted).toBe(false);
    expect(await readHostStagedRecord(ENV)).toBeNull();
  });

  it("EXPLICIT request for the installed record's own string (2.0.0+bar over 2.0.0+bar): up to date (control)", async () => {
    await writeInstall("2.0.0+bar", {});
    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: "2.0.0+bar",
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "2.0.0+bar",
        versions: [{ version: "2.0.0+bar", yanked: false }],
        downloadGate: null,
        onDownloadStart: null,
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(outcome).toMatchObject({
      outcome: "short-circuit",
      reason: "installed-up-to-date",
      installedVersion: "2.0.0+bar",
    });
  });

  it("IMPLICIT latest 2.0.0 over an installed 2.0.0+bar: up to date - the registry's release is installed, in a build the promote gate would not replace (control)", async () => {
    await writeInstall("2.0.0+bar", {});
    let downloadStarted = false;
    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "2.0.0",
        versions: [{ version: "2.0.0", yanked: false }],
        downloadGate: null,
        onDownloadStart: () => {
          downloadStarted = true;
        },
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(outcome).toMatchObject({
      outcome: "short-circuit",
      reason: "installed-up-to-date",
    });
    expect(downloadStarted).toBe(false);
  });

  it("short-circuits when the target is already staged", async () => {
    await writeInstall("1.0.0", {});
    let downloadStarted = false;
    const versions = [
      { version: "1.0.0", yanked: false },
      { version: "1.5.0", yanked: false },
    ];
    // First call stages 1.5.0.
    await downloadAndStageHost({
      environment: ENV,
      versionRequest: "1.5.0",
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: null,
        onDownloadStart: null,
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect((await readHostStagedRecord(ENV))?.version).toBe("1.5.0");

    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: null,
        onDownloadStart: () => {
          downloadStarted = true;
        },
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(outcome).toMatchObject({
      outcome: "short-circuit",
      reason: "already-staged",
    });
    expect(downloadStarted).toBe(false);
  });

  it("replaces a legacy target-stage with no handoff fingerprint instead of short-circuiting it forever", async () => {
    await writeInstall("1.0.0", {});
    const versions = [
      { version: "1.0.0", yanked: false },
      { version: "1.5.0", yanked: false },
    ];
    await downloadAndStageHost({
      environment: ENV,
      versionRequest: "1.5.0",
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: null,
        onDownloadStart: null,
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    const recordPath = join(stagedDirFor(ENV), "staged.json");
    const legacy = JSON.parse(readFileSync(recordPath, "utf8")) as {
      stageId?: unknown;
    };
    delete legacy.stageId;
    writeFileSync(recordPath, JSON.stringify(legacy));

    let downloadStarted = false;
    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: true,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: null,
        onDownloadStart: () => {
          downloadStarted = true;
        },
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });

    expect(outcome).toMatchObject({
      outcome: "promoted",
      stagedVersion: "1.5.0",
    });
    expect(downloadStarted).toBe(true);
    expect((await readHostStagedRecord(ENV))?.stageId).not.toBeNull();
  });

  it("downloads and promotes a fresh, strictly-newer version by default (latest)", async () => {
    await writeInstall("1.0.0", {});
    const client = fakeRegistryClient({
      latest: "1.5.0",
      versions: [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ],
      downloadGate: null,
      onDownloadStart: null,
    });
    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: client,
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(outcome).toMatchObject({
      outcome: "promoted",
      stagedVersion: "1.5.0",
      installedVersion: "1.0.0",
    });
    const staged = await readHostStagedRecord(ENV);
    expect(staged?.version).toBe("1.5.0");
    expect(staged?.platform).toBe(currentInstallPlatform());
    expect(staged?.arch).toBe(currentInstallArch());
    expect(staged?.source).toEqual({ kind: "registry", value: "1.5.0" });
  });

  it("releases the download slot - archive and ownership marker - on a successful promote, without touching the cache dir", async () => {
    await writeInstall("1.0.0", {});
    const client = fakeRegistryClient({
      latest: "1.5.0",
      versions: [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ],
      downloadGate: null,
      onDownloadStart: null,
    });
    await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: client,
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    // The archive now lives in the SHARED download cache keyed by
    // version+sha (registry/download-cache.ts), so the consumer must drop
    // its own archive plus the ownership marker and nothing else. The old
    // `rm(dirname(archivePath))` would take the whole cache with it -
    // including another process's in-flight partial.
    // The download actually ran, so the absence checks below are about this
    // test's own archive rather than an empty path.
    expect(lastFakeArchivePath).not.toBe("");
    expect(existsSync(lastFakeArchivePath)).toBe(false);
    expect(existsSync(`${lastFakeArchivePath}.owner`)).toBe(false);
    expect(existsSync(dirname(lastFakeArchivePath))).toBe(true);
  });

  it("keeps the verified archive and drops only the claim when the work AFTER the download fails", async () => {
    await writeInstall("1.0.0", {});
    let stagedArchivePath = "";
    const client = unresolvableArchiveRegistryClient(
      fakeRegistryClient({
        latest: "1.5.0",
        versions: [
          { version: "1.0.0", yanked: false },
          { version: "1.5.0", yanked: false },
        ],
        downloadGate: null,
        onDownloadStart: null,
      }),
      (archivePath) => {
        stagedArchivePath = archivePath;
      },
    );
    await expect(
      downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: false,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      }),
    ).rejects.toThrow(/expected executable/);
    // These bytes already cleared sha256 AND minisign. Whatever failed
    // afterwards is local, so re-downloading them over the throttled link
    // this whole feature exists for could not produce anything different -
    // the next run resumes this file over a single 416 instead. Only the
    // ownership claim comes off, so another process is free to take it.
    expect(existsSync(stagedArchivePath)).toBe(true);
    expect(existsSync(`${stagedArchivePath}.owner`)).toBe(false);
  });

  it("yank-heal: discards a now-yanked stage with no download when the target resolves back to installed", async () => {
    await writeInstall("1.0.0", {});
    const olderVersions = [
      { version: "1.0.0", yanked: false },
      { version: "1.5.0", yanked: false },
    ];
    await downloadAndStageHost({
      environment: ENV,
      versionRequest: "1.5.0",
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.5.0",
        versions: olderVersions,
        downloadGate: null,
        onDownloadStart: null,
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect((await readHostStagedRecord(ENV))?.version).toBe("1.5.0");

    // 1.5.0 gets yanked and the registry's latest reverts to 1.0.0
    // (already installed).
    let downloadStarted = false;
    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.0.0",
        versions: [
          { version: "1.0.0", yanked: false },
          { version: "1.5.0", yanked: true },
        ],
        downloadGate: null,
        onDownloadStart: () => {
          downloadStarted = true;
        },
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(downloadStarted).toBe(false);
    expect(outcome).toMatchObject({
      outcome: "short-circuit",
      reason: "installed-up-to-date",
    });
    expect(await readHostStagedRecord(ENV)).toBeNull();
  });

  it("yank-heal: discards a yanked stage and re-stages a newer replacement", async () => {
    await writeInstall("1.0.0", {});
    await downloadAndStageHost({
      environment: ENV,
      versionRequest: "1.5.0",
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.5.0",
        versions: [
          { version: "1.0.0", yanked: false },
          { version: "1.5.0", yanked: false },
        ],
        downloadGate: null,
        onDownloadStart: null,
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect((await readHostStagedRecord(ENV))?.version).toBe("1.5.0");

    // 1.5.0 gets yanked; 2.0.0 is now latest.
    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "2.0.0",
        versions: [
          { version: "1.0.0", yanked: false },
          { version: "1.5.0", yanked: true },
          { version: "2.0.0", yanked: false },
        ],
        downloadGate: null,
        onDownloadStart: null,
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(outcome).toMatchObject({
      outcome: "promoted",
      stagedVersion: "2.0.0",
    });
    expect((await readHostStagedRecord(ENV))?.version).toBe("2.0.0");
  });

  it("--automatic refuses to stage over an incomparable (local-*) installed version, without announcing a download", async () => {
    await writeInstall("local-custom-build-2026", {});
    let downloadStarted = false;
    // The third short-circuit named in `onWillDownload`'s doc: nothing is
    // transferred, so nothing is announced. Falsification: move the hook
    // above the promotion decision and it fires here.
    const onWillDownload = vi.fn(async () => undefined);
    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: true,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.5.0",
        versions: [{ version: "1.5.0", yanked: false }],
        downloadGate: null,
        onDownloadStart: () => {
          downloadStarted = true;
        },
      }),
      onWillDownload,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(outcome).toMatchObject({
      outcome: "short-circuit",
      reason: "automatic-refused-incomparable-installed",
    });
    expect(downloadStarted).toBe(false);
    expect(onWillDownload).not.toHaveBeenCalled();
  });
  it("an explicit version request proceeds over an incomparable (local-*) installed version", async () => {
    await writeInstall("local-custom-build-2026", {});
    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: "1.5.0",
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.5.0",
        versions: [{ version: "1.5.0", yanked: false }],
        downloadGate: null,
        onDownloadStart: null,
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(outcome).toMatchObject({
      outcome: "promoted",
      stagedVersion: "1.5.0",
    });
  });

  it("an explicit download discards when the installed version overtakes it during the unlocked transfer", async () => {
    await writeInstall("1.0.0", {});
    const gate = makeGate();
    const started = makeGate();
    const client = fakeRegistryClient({
      latest: "1.5.0",
      versions: [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
        { version: "2.0.0", yanked: false },
      ],
      downloadGate: gate.promise,
      onDownloadStart: () => started.release(),
    });
    const downloadPromise = downloadAndStageHost({
      environment: ENV,
      versionRequest: "1.5.0",
      automatic: false,
      onProgress: noopProgress,
      registryClient: client,
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    await started.promise;
    // Simulate a concurrent, faster `host install 2.0.0` completing while
    // this explicit download for 1.5.0 is still in flight - the fresh
    // locked read at promote time must catch that 1.5.0 is no longer
    // newer than what's now installed.
    await writeInstall("2.0.0", {});
    gate.release();
    const outcome = await downloadPromise;
    expect(outcome).toMatchObject({
      outcome: "discarded",
      reason: "not-newer-than-installed",
    });
    expect(await readHostStagedRecord(ENV)).toBeNull();
  });

  it("--automatic discards when the installed version becomes incomparable during the unlocked transfer", async () => {
    await writeInstall("1.0.0", {});
    const gate = makeGate();
    const started = makeGate();
    const client = fakeRegistryClient({
      latest: "1.5.0",
      versions: [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ],
      downloadGate: gate.promise,
      onDownloadStart: () => started.release(),
    });
    const downloadPromise = downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: true,
      onProgress: noopProgress,
      registryClient: client,
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    await started.promise;
    // Simulate a concurrent local-file install swapping in an
    // incomparable build while this automatic download is still in
    // flight - phase 1 saw a comparable installed version and let the
    // download proceed, but phase 3's fresh locked read must re-refuse.
    await writeInstall("local-swapped-build-2026", {});
    gate.release();
    const outcome = await downloadPromise;
    expect(outcome).toMatchObject({
      outcome: "discarded",
      reason: "automatic-refused-incomparable-installed",
    });
    expect(await readHostStagedRecord(ENV)).toBeNull();
  });

  it("an explicit version request replaces any existing stage, even a newer one", async () => {
    await writeInstall("1.0.0", {});
    const versions = [
      { version: "1.0.0", yanked: false },
      { version: "1.2.0", yanked: false },
      { version: "1.5.0", yanked: false },
    ];
    await downloadAndStageHost({
      environment: ENV,
      versionRequest: "1.5.0",
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: null,
        onDownloadStart: null,
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect((await readHostStagedRecord(ENV))?.version).toBe("1.5.0");

    const outcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: "1.2.0",
      automatic: false,
      onProgress: noopProgress,
      registryClient: fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: null,
        onDownloadStart: null,
      }),
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(outcome).toMatchObject({
      outcome: "promoted",
      stagedVersion: "1.2.0",
    });
    expect((await readHostStagedRecord(ENV))?.version).toBe("1.2.0");
  });

  it("serializes overlapping downloads across the transfer", async () => {
    await writeInstall("1.0.0", {});
    const gate = makeGate();
    const slowStarted = makeGate();
    let fastStarted = false;
    const slowClient = fakeRegistryClient({
      latest: "1.2.0",
      versions: [
        { version: "1.0.0", yanked: false },
        { version: "1.2.0", yanked: false },
      ],
      downloadGate: gate.promise,
      onDownloadStart: () => slowStarted.release(),
    });
    const fastClient = fakeRegistryClient({
      latest: "1.5.0",
      versions: [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ],
      downloadGate: null,
      onDownloadStart: () => {
        fastStarted = true;
      },
    });

    const slowPromise = downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: slowClient,
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    await slowStarted.promise;
    const firstFastAttempt = downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: fastClient,
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    const firstFastResult = firstFastAttempt.then(
      (outcome) => ({ kind: "outcome" as const, outcome }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    // T2 serialization: one outer stage-maintenance capability spans the
    // transfer, so overlapping downloads in one segment are unrepresentable.
    // Positively prove the second transfer has not started while the first
    // owns that capability.
    expect(fastStarted).toBe(false);
    const busyResult = await firstFastResult;
    expect(busyResult.kind).toBe("error");
    if (busyResult.kind !== "error") {
      throw new Error("concurrent same-process download unexpectedly ran");
    }
    expect(busyResult.error).toBeInstanceOf(CliError);
    expect((busyResult.error as CliError).code).toBe(
      CLI_ERROR_CODES.CLI_LOCK_BUSY,
    );

    gate.release();
    const slowOutcome = await slowPromise;
    expect(slowOutcome).toMatchObject({
      outcome: "promoted",
      stagedVersion: "1.2.0",
    });

    const fastOutcome = await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: fastClient,
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(fastOutcome).toMatchObject({
      outcome: "promoted",
      stagedVersion: "1.5.0",
    });
    expect(fastStarted).toBe(true);
    expect((await readHostStagedRecord(ENV))?.version).toBe("1.5.0");
  });

  it("keeps latest-stage promotion monotonic for either completion order", () => {
    expect(
      decideHostDownloadPromotion({
        candidateVersion: "1.2.0",
        installedVersion: "1.0.0",
        stagedVersion: "1.5.0",
        stagedStageId: "newer-stage",
        explicitVersionRequested: false,
        automatic: false,
      }),
    ).toEqual({ kind: "discard", reason: "not-strictly-newer" });
    expect(
      decideHostDownloadPromotion({
        candidateVersion: "1.5.0",
        installedVersion: "1.0.0",
        stagedVersion: "1.2.0",
        stagedStageId: "older-stage",
        explicitVersionRequested: false,
        automatic: false,
      }),
    ).toEqual({ kind: "promote" });
  });

  it("promote-after-uninstall does not resurrect a stage", async () => {
    await writeInstall("1.0.0", {});
    const gate = makeGate();
    // Handshake so the simulated uninstall only fires once the download
    // has genuinely reached phase 2 (past phase 1's own install-record
    // read) - without it, the synchronous `rmSync` below can race ahead
    // of `downloadAndStageHost`'s first `await` and delete the install
    // dir before phase 1 even runs, making the whole call throw
    // E_HOST_NOT_INSTALLED instead of exercising the promote-time
    // "install-record-vanished" discard path this test targets.
    const started = makeGate();
    const client = fakeRegistryClient({
      latest: "1.5.0",
      versions: [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ],
      downloadGate: gate.promise,
      onDownloadStart: () => started.release(),
    });
    const downloadPromise = downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: client,
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    await started.promise;
    // Simulate a concurrent `host uninstall` completing while the download
    // is still in flight (no lock is held during transfer, so this is a
    // legitimate interleaving).
    rmSync(installDirFor(ENV), { recursive: true, force: true });

    gate.release();
    const outcome = await downloadPromise;
    expect(outcome).toMatchObject({
      outcome: "discarded",
      reason: "install-record-vanished",
    });
    expect(await readHostStagedRecord(ENV)).toBeNull();
  });

  it("holds no cli-lock during the download/extract transfer", async () => {
    await writeInstall("1.0.0", {});
    const gate = makeGate();
    let lockAcquiredDuringTransfer = false;
    const client = fakeRegistryClient({
      latest: "1.5.0",
      versions: [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ],
      downloadGate: gate.promise,
      onDownloadStart: () => {
        // Fires once download has started, i.e. past the phase-1 lock
        // section. A contender (standing in for `host ensure`) must be
        // able to acquire the lock promptly.
        void (async () => {
          const handle = await acquireCliLock({
            environment: ENV,
            reason: "ensure-probe",
            waitMs: 2000,
            pollIntervalMs: 25,
          });
          lockAcquiredDuringTransfer = true;
          await handle.release();
          gate.release();
        })();
      },
    });
    await downloadAndStageHost({
      environment: ENV,
      versionRequest: null,
      automatic: false,
      onProgress: noopProgress,
      registryClient: client,
      onWillDownload: null,
      beforeExtract: async () => {},
      ownAttempt: null,
    });
    expect(lockAcquiredDuringTransfer).toBe(true);
  });

  it("leaves no stage or temp litter when download/verify fails", async () => {
    await writeInstall("1.0.0", {});
    const base = fakeRegistryClient({
      latest: "1.5.0",
      versions: [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ],
      downloadGate: null,
      onDownloadStart: null,
    });
    await expect(
      downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: false,
        onProgress: noopProgress,
        registryClient: throwingRegistryClient(base),
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      }),
    ).rejects.toThrow(/simulated download failure/);

    expect(await readHostStagedRecord(ENV)).toBeNull();
    const stagingRoot = stagingRootFor(ENV);
    const leftoverEntries = (() => {
      try {
        return readdirSync(stagingRoot);
      } catch {
        return [];
      }
    })();
    expect(leftoverEntries).toEqual([]);
  });

  // Promote-time attempt guard (Host Update Layer Redesign): these tests use
  // promote-time STATE INJECTION after the outer admission snapshot and
  // before phase 3's re-read. This is focused fault injection, not proof of a
  // currently representable conforming race: public download owns its outer
  // capability across the transfer and exposes no adoption input for a second
  // writer. The gate/release timing exercises the guard's real read-and-decide
  // behavior against real staged I/O; if download adoption is ever added, the
  // reachability and locking argument must be revisited separately.
  describe("promote-time attempt guard", () => {
    it("a parked waiting-to-activate attempt appearing during a background/latest download's transfer window yields at promote and preserves the parked attempt's staged bytes", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.2.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      // Stage 1.2.0 first - stands in for the parked attempt's already-
      // placed bytes, exactly as `waiting-to-activate` means "bytes are
      // already placed; only activation may proceed".
      await downloadAndStageHost({
        environment: ENV,
        versionRequest: "1.2.0",
        automatic: false,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      const stagedBefore = await readHostStagedRecord(ENV);
      expect(stagedBefore?.version).toBe("1.2.0");
      const executablePath = join(stagedDirFor(ENV), executableBasename());
      const executableBefore = readFileSync(executablePath);

      const gate = makeGate();
      const started = makeGate();
      const client = fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: gate.promise,
        onDownloadStart: () => started.release(),
      });
      const downloadPromise = downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: true,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      await started.promise;
      // Promote-time STATE INJECTION after the outer admission snapshot and
      // before phase 3's re-read. A conforming second writer cannot currently
      // produce this state while public download holds its outer capability;
      // this case isolates the guard's response if those bytes are observed.
      writeAttemptRecord({
        attemptId: "parked-attempt-1",
        targetVersion: "1.2.0",
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
      });
      gate.release();

      const result = await downloadPromise.then(
        (outcome) => ({ kind: "outcome" as const, outcome }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );

      // The load-bearing negative: the parked attempt's staged record AND
      // its staged bytes are byte-for-byte untouched by the yielded
      // download - not merely "some record still exists at some version".
      const stagedAfter = await readHostStagedRecord(ENV);
      expect(stagedAfter).toEqual(stagedBefore);
      expect(readFileSync(executablePath)).toEqual(executableBefore);
      expect(result).toMatchObject({
        kind: "error",
        error: {
          code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
          details: expect.objectContaining({
            disposition: "yield",
            attemptId: "parked-attempt-1",
            phase: "waiting-to-activate",
            targetVersion: "1.2.0",
            candidateVersion: "1.5.0",
          }),
        },
      });
    });

    it("fails closed on corrupt attempt bytes appearing during transfer and preserves the existing stage", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.2.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      await downloadAndStageHost({
        environment: ENV,
        versionRequest: "1.2.0",
        automatic: false,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      const stagedBefore = await readHostStagedRecord(ENV);
      const executablePath = join(stagedDirFor(ENV), executableBasename());
      const executableBefore = readFileSync(executablePath);

      const gate = makeGate();
      const started = makeGate();
      const downloadPromise = downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: true,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: gate.promise,
          onDownloadStart: () => started.release(),
        }),
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      await started.promise;
      writeFileSync(
        updateAttemptRecordPath(hostHomeFor(ENV)),
        "{not-valid-json\n",
      );
      gate.release();

      const result = await downloadPromise.then(
        (outcome) => ({ kind: "outcome" as const, outcome }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const stagedAfter = await readHostStagedRecord(ENV);
      expect(stagedAfter).toEqual(stagedBefore);
      expect(readFileSync(executablePath)).toEqual(executableBefore);
      expect(result).toMatchObject({
        kind: "error",
        error: {
          code: CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID,
          details: expect.objectContaining({
            reason: "host-download-promote",
            recordKind: "corrupt",
          }),
        },
      });
    });

    it("ablation: a TERMINAL attempt present at the same promote-time race does not block the background/latest promotion", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.2.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      await downloadAndStageHost({
        environment: ENV,
        versionRequest: "1.2.0",
        automatic: false,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });

      const gate = makeGate();
      const started = makeGate();
      const client = fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: gate.promise,
        onDownloadStart: () => started.release(),
      });
      const downloadPromise = downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: true,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      await started.promise;
      // Same timing as the positive case above - only `phase`/`execution`
      // differ (a finished, terminal attempt instead of a park). Proves the
      // guard keys on nonterminal execution, not merely "a record exists".
      writeAttemptRecord({
        attemptId: "finished-attempt-1",
        targetVersion: "1.2.0",
        phase: "complete",
        execution: "terminal",
        continuation: null,
        completedAt: "2026-01-01T00:05:00.000Z",
      });
      gate.release();

      const outcome = await downloadPromise;
      expect(outcome).toMatchObject({
        outcome: "promoted",
        stagedVersion: "1.5.0",
      });
      expect((await readHostStagedRecord(ENV))?.version).toBe("1.5.0");
    }); // The absent-attempt direction of the same ablation (no `update-attempt.json`

    it("an explicit `host download <version>` yields at promote when a parked attempt appears during transfer, preserving the parked attempt's staged bytes", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.2.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      await downloadAndStageHost({
        environment: ENV,
        versionRequest: "1.2.0",
        automatic: false,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      const stagedBefore = await readHostStagedRecord(ENV);
      const executablePath = join(stagedDirFor(ENV), executableBasename());
      const executableBefore = readFileSync(executablePath);

      const gate = makeGate();
      const started = makeGate();
      const client = fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: gate.promise,
        onDownloadStart: () => started.release(),
      });
      // Explicit version request - normally replaces ANY existing stage,
      // even a newer one (see "an explicit version request replaces any
      // existing stage" above). The promote-time guard must still yield in
      // front of that otherwise-unconditional replace-any-stage policy.
      const downloadPromise = downloadAndStageHost({
        environment: ENV,
        versionRequest: "1.5.0",
        automatic: false,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      await started.promise;
      writeAttemptRecord({
        attemptId: "parked-attempt-2",
        targetVersion: "1.2.0",
        phase: "waiting-to-activate",
        execution: "parked",
        continuation: "activate",
      });
      gate.release();

      const result = await downloadPromise.then(
        (outcome) => ({ kind: "outcome" as const, outcome }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );

      const stagedAfter = await readHostStagedRecord(ENV);
      expect(stagedAfter).toEqual(stagedBefore);
      expect(readFileSync(executablePath)).toEqual(executableBefore);
      expect(result).toMatchObject({
        kind: "error",
        error: {
          code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
          details: expect.objectContaining({
            disposition: "yield",
            attemptId: "parked-attempt-2",
            phase: "waiting-to-activate",
            targetVersion: "1.2.0",
            candidateVersion: "1.5.0",
          }),
        },
      });
    });

    it("ablation: a TERMINAL attempt present at the same explicit-download promote-time race does not block the replace-any-stage promotion", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.2.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      await downloadAndStageHost({
        environment: ENV,
        versionRequest: "1.2.0",
        automatic: false,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });

      const gate = makeGate();
      const started = makeGate();
      const client = fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: gate.promise,
        onDownloadStart: () => started.release(),
      });
      const downloadPromise = downloadAndStageHost({
        environment: ENV,
        versionRequest: "1.5.0",
        automatic: false,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      await started.promise;
      writeAttemptRecord({
        attemptId: "finished-attempt-2",
        targetVersion: "1.2.0",
        phase: "complete",
        execution: "terminal",
        continuation: null,
        completedAt: "2026-01-01T00:05:00.000Z",
      });
      gate.release();

      const outcome = await downloadPromise;
      expect(outcome).toMatchObject({
        outcome: "promoted",
        stagedVersion: "1.5.0",
      });
      expect((await readHostStagedRecord(ENV))?.version).toBe("1.5.0");
    });
    // at all at promote time) is already load-bearing coverage from the
    // pre-existing "downloads and promotes a fresh, strictly-newer version by
    // default (latest)" and "an explicit version request replaces any
    // existing stage, even a newer one" tests above - every test in this
    // file before this `describe` block runs with no attempt record ever
    // written, so those promotions already prove the absent direction.

    it("promotes over its own nonterminal attempt when ownAttempt names the same attemptId AND the candidate target", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      const gate = makeGate();
      const started = makeGate();
      const client = fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: gate.promise,
        onDownloadStart: () => started.release(),
      });
      const ownAttempt: HostUpdateAttemptIdentity = {
        attemptId: "own-attempt-1",
        generation: 1,
        sequence: 1,
      };
      const downloadPromise = downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: true,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt,
      });
      await started.promise;
      // The record this run is itself advancing - same attemptId, same
      // target as the candidate. Generation/sequence are deliberately
      // mismatched from `ownAttempt` above: the guard's identity is the
      // attempt id and target only, per the ticket's own-attempt rule.
      writeAttemptRecord({
        attemptId: "own-attempt-1",
        generation: 9,
        sequence: 9,
        targetVersion: "1.5.0",
        phase: "downloading",
        execution: "active",
        continuation: null,
      });
      gate.release();

      const outcome = await downloadPromise;
      expect(outcome).toMatchObject({
        outcome: "promoted",
        stagedVersion: "1.5.0",
      });
      expect((await readHostStagedRecord(ENV))?.version).toBe("1.5.0");
      // Falsification: drop the target-match half of the exemption (compare
      // only `attemptId`) and this still passes, but the next test - same
      // id, DIFFERENT target - would wrongly promote too.
    });

    it("yields HOST_UPDATE_ATTEMPT_ACTIVE when ownAttempt's attemptId matches but the record's target does not", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.2.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      const gate = makeGate();
      const started = makeGate();
      const client = fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: gate.promise,
        onDownloadStart: () => started.release(),
      });
      const ownAttempt: HostUpdateAttemptIdentity = {
        attemptId: "own-attempt-2",
        generation: 1,
        sequence: 1,
      };
      const downloadPromise = downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: true,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt,
      });
      await started.promise;
      // Same attemptId as `ownAttempt`, but pointed at a DIFFERENT target
      // (1.2.0, not the 1.5.0 candidate) - this run has moved on from
      // whatever that record describes, so it is not "this run's own work".
      writeAttemptRecord({
        attemptId: "own-attempt-2",
        targetVersion: "1.2.0",
        phase: "downloading",
        execution: "active",
        continuation: null,
      });
      gate.release();

      const result = await downloadPromise.then(
        (outcome) => ({ kind: "outcome" as const, outcome }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );

      expect(result).toMatchObject({
        kind: "error",
        error: {
          code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
          details: expect.objectContaining({
            disposition: "yield",
            attemptId: "own-attempt-2",
            targetVersion: "1.2.0",
            candidateVersion: "1.5.0",
          }),
        },
      });
      // Falsification: drop the target comparison from the guard (own-id
      // match alone exempts) and this reddens with a "promoted" outcome.
    });

    it("yields HOST_UPDATE_ATTEMPT_ACTIVE for a foreign nonterminal attempt even when ownAttempt is set to a different id", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      const gate = makeGate();
      const started = makeGate();
      const client = fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: gate.promise,
        onDownloadStart: () => started.release(),
      });
      const ownAttempt: HostUpdateAttemptIdentity = {
        attemptId: "own-attempt-3",
        generation: 1,
        sequence: 1,
      };
      const downloadPromise = downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: true,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt,
      });
      await started.promise;
      // A DIFFERENT attemptId at the very same target this run is staging -
      // a foreign contender, not this run's own work.
      writeAttemptRecord({
        attemptId: "foreign-attempt-1",
        targetVersion: "1.5.0",
        phase: "downloading",
        execution: "active",
        continuation: null,
      });
      gate.release();

      const result = await downloadPromise.then(
        (outcome) => ({ kind: "outcome" as const, outcome }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );

      expect(result).toMatchObject({
        kind: "error",
        error: {
          code: CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE,
          details: expect.objectContaining({
            disposition: "yield",
            attemptId: "foreign-attempt-1",
            targetVersion: "1.5.0",
            candidateVersion: "1.5.0",
          }),
        },
      });
      // Falsification: exempt on target match alone (ignore attemptId) and
      // this reddens with a "promoted" outcome.
    });

    it("ablation: a TERMINAL attempt never yields even when ownAttempt is set and does not match it", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      const gate = makeGate();
      const started = makeGate();
      const client = fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: gate.promise,
        onDownloadStart: () => started.release(),
      });
      const ownAttempt: HostUpdateAttemptIdentity = {
        attemptId: "own-attempt-4",
        generation: 1,
        sequence: 1,
      };
      const downloadPromise = downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: true,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt,
      });
      await started.promise;
      writeAttemptRecord({
        attemptId: "finished-attempt-3",
        targetVersion: "1.5.0",
        phase: "complete",
        execution: "terminal",
        continuation: null,
        completedAt: "2026-01-01T00:05:00.000Z",
      });
      gate.release();

      const outcome = await downloadPromise;
      expect(outcome).toMatchObject({
        outcome: "promoted",
        stagedVersion: "1.5.0",
      });
    });
  });

  describe("beforeExtract barrier (shared with stageHostInstallSource)", () => {
    it("blocks extraction until the hook RESOLVES, after downloadAndVerify has returned", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      const order: string[] = [];
      const downloadGate = makeGate();
      const downloadStarted = makeGate();
      // Released by the FIRST `extract` progress event, which
      // `stageVerifiedSource` emits immediately before `extractHostSource`.
      // While the hook is pending this must never fire.
      const extractionStarted = makeGate();
      const hookEntered = makeGate();
      const hookGate = makeGate();
      const client = fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: downloadGate.promise,
        onDownloadStart: () => {
          order.push("download-start");
          downloadStarted.release();
        },
      });

      const downloadPromise = downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: true,
        onProgress: (info) => {
          // `createExtractHeartbeat` emits its own "extract" ticks per entry
          // on top of that single boundary event, so only the FIRST one
          // marks the edge - dedupe consecutive repeats.
          if (
            info.stage === "extract" &&
            order[order.length - 1] !== "progress-extract"
          ) {
            order.push("progress-extract");
            extractionStarted.release();
          }
        },
        registryClient: client,
        onWillDownload: null,
        beforeExtract: async () => {
          order.push("before-extract");
          // The AFTER-verification edge: `downloadAndVerify` has already
          // RETURNED (sha256 in the transport, minisign in the registry
          // client both happen inside it), so its verified archive is on
          // disk by the time this runs.
          expect(existsSync(lastFakeArchivePath)).toBe(true);
          hookEntered.release();
          await hookGate.promise;
        },
        ownAttempt: null,
      });

      await downloadStarted.promise;
      downloadGate.release();
      await expectReached(hookEntered.promise, "beforeExtract");
      // The BEFORE-extraction edge, and the one an ordering array cannot
      // prove on its own: while this hook is pending, extraction has not
      // begun. An unawaited call would have raced ahead by now.
      await expectStillGated(extractionStarted.promise, "extraction started");
      expect(order).toEqual(["download-start", "before-extract"]);

      hookGate.release();
      const outcome = await downloadPromise;

      expect(outcome).toMatchObject({
        outcome: "promoted",
        stagedVersion: "1.5.0",
      });
      expect(order).toEqual([
        "download-start",
        "before-extract",
        "progress-extract",
      ]);
      // Falsification: change `await opts.beforeExtract()` in
      // `stageVerifiedSource` to `void opts.beforeExtract()` and extraction
      // runs while this hook is still pending - `expectStillGated` above
      // sees "fired" and the interim `order` assertion also reddens.
    });

    it("propagates a rejecting hook, extracts nothing, and leaves no owned temp behind", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      let extractProgressSeen = false;
      const client = fakeRegistryClient({
        latest: "1.5.0",
        versions,
        downloadGate: null,
        onDownloadStart: null,
      });

      await expect(
        downloadAndStageHost({
          environment: ENV,
          versionRequest: null,
          automatic: true,
          onProgress: (info) => {
            if (info.stage === "extract") extractProgressSeen = true;
          },
          registryClient: client,
          onWillDownload: null,
          beforeExtract: async () => {
            throw new Error("the writer refused the preparing phase");
          },
          ownAttempt: null,
        }),
      ).rejects.toThrow("the writer refused the preparing phase");

      // Nothing was extracted and nothing was promoted: the barrier is
      // upstream of both.
      expect(extractProgressSeen).toBe(false);
      expect(await readHostStagedRecord(ENV)).toBeNull();
      // The `finally` cleanup owns the owner-tokened temp on every throw
      // path, this new one included - a hook that refuses must not leak a
      // staging tree.
      expect(readdirSync(stagingRootFor(ENV))).toEqual([]);
      // Falsification: swallow the hook's rejection in `stageVerifiedSource`
      // (call it inside a `try {} catch {}`) and this resolves `promoted`
      // with `extractProgressSeen` true.
    });
  });

  describe("resolveUpdatePlan", () => {
    it("reports not-installed with no install record at all", async () => {
      const plan = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "install",
          versionRequest: null,
          allowDowngrade: false,
        },
        onProgress: noopProgress,
        registryClient: unreachableRegistryClient(),
      });
      expect(plan).toEqual({ kind: "not-installed" });
    });

    it("activate: never touches the registry and returns the identity facts", async () => {
      const installed = await writeInstall("1.2.0", {});
      const before = snapshotTree(hostHomeFor(ENV));

      const plan = await resolveUpdatePlan({
        environment: ENV,
        request: { intent: "activate" },
        onProgress: noopProgress,
        registryClient: unreachableRegistryClient(),
      });

      expect(plan).toEqual({
        kind: "activate",
        identity: {
          installedVersion: "1.2.0",
          installGeneration: encodeInstallGeneration({
            installId: installed.installId,
            installedAt: installed.installedAt,
            archiveSha256: installed.archiveSha256,
            version: installed.version,
          }),
          installedRuntimeVersion: installed.runtimeVersion,
          stagedVersion: null,
          stageFingerprint: null,
        },
      });
      expect(snapshotTree(hostHomeFor(ENV))).toEqual(before);
      // Falsification: have `resolveUpdatePlan` call `planRegistryClient`
      // unconditionally (even on `activate`) and this throws instead of
      // resolving.
    });

    it("continue with needsTransfer: false: never touches the registry", async () => {
      await writeInstall("1.2.0", {});
      const before = snapshotTree(hostHomeFor(ENV));

      const plan = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "continue",
          targetVersion: "1.5.0",
          needsTransfer: false,
        },
        onProgress: noopProgress,
        registryClient: unreachableRegistryClient(),
      });

      expect(plan).toMatchObject({
        kind: "resume",
        targetVersion: "1.5.0",
        entry: null,
        asset: null,
      });
      expect(snapshotTree(hostHomeFor(ENV))).toEqual(before);
    });

    it("continue with needsTransfer: true resolves the manifest/asset for the resumed target", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      const plan = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "continue",
          targetVersion: "1.5.0",
          needsTransfer: true,
        },
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
      });

      expect(plan).toMatchObject({ kind: "resume", targetVersion: "1.5.0" });
      if (plan.kind === "resume") {
        expect(plan.entry?.version).toBe("1.5.0");
        expect(plan.asset).not.toBeNull();
      }
    });

    it("install: an EXPLICIT request BELOW the installed record is REFUSED, not a no-op - the request delivered nothing (#1752 round 14)", async () => {
      // The rule this replaces read "installed is at or above the target ->
      // no-op", which answered `host update --version 1.0.0` with exit 0 over
      // a host at 1.5.0, having delivered nothing the caller asked for. It is
      // the same "a request for X is never answered `already at Y`" the apply
      // binding and the under-lock activation check enforce, applied at the
      // first place the executor can see it. Falsification: drop the
      // `explicitOtherArtifact` guard and this resolves `no-op` again.
      await writeInstall("1.5.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      const before = snapshotTree(hostHomeFor(ENV));

      await expect(
        resolveUpdatePlan({
          environment: ENV,
          request: {
            intent: "install",
            versionRequest: "1.0.0",
            allowDowngrade: false,
          },
          onProgress: noopProgress,
          registryClient: fakeRegistryClient({
            latest: "1.5.0",
            versions,
            downloadGate: null,
            onDownloadStart: null,
          }),
        }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
        details: { installedVersion: "1.5.0", targetVersion: "1.0.0" },
      });
      // Refused before anything is fetched, staged or written.
      expect(snapshotTree(hostHomeFor(ENV))).toEqual(before);
    });

    it("install: an IMPLICIT latest at or above the installed record IS the no-op - the binding is the explicit request's alone", async () => {
      await writeInstall("1.5.0", {});
      const before = snapshotTree(hostHomeFor(ENV));

      const plan = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "install",
          versionRequest: null,
          allowDowngrade: false,
        },
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions: [{ version: "1.5.0", yanked: false }],
          downloadGate: null,
          onDownloadStart: null,
        }),
      });

      expect(plan).toMatchObject({ kind: "no-op", targetVersion: "1.5.0" });
      expect(snapshotTree(hostHomeFor(ENV))).toEqual(before);
    });

    it("install: an EXPLICIT request for the installed record's OWN STRING is the no-op (control)", async () => {
      // The separator between this and the refusal above is string equality,
      // not the comparator: it is what makes the two `2.0.0+…` cases below
      // land on opposite sides.
      await writeInstall("1.5.0", {});

      const plan = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "install",
          versionRequest: "1.5.0",
          allowDowngrade: false,
        },
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions: [{ version: "1.5.0", yanked: false }],
          downloadGate: null,
          onDownloadStart: null,
        }),
      });

      expect(plan).toMatchObject({ kind: "no-op", targetVersion: "1.5.0" });
    });

    it("install: ANOTHER BUILD of the installed release (2.0.0+foo over 2.0.0+bar) is refused without consent and takes the OWNED installer with it", async () => {
      // The comparator orders these two EQUAL - it ignores build metadata -
      // so the old at-or-above reading called it up to date and the requested
      // artifact was never delivered. Identity is the STRING. With consent
      // the owned installer takes it, because the shared monotonic stage
      // would refuse to promote a candidate that is not strictly newer.
      // Falsification: compare with `compareHostVersions` instead of `===`
      // and both halves collapse into `no-op`.
      await writeInstall("2.0.0+bar", {});
      const registry = {
        latest: "2.0.0+foo",
        versions: [{ version: "2.0.0+foo", yanked: false }],
        downloadGate: null,
        onDownloadStart: null,
      };

      await expect(
        resolveUpdatePlan({
          environment: ENV,
          request: {
            intent: "install",
            versionRequest: "2.0.0+foo",
            allowDowngrade: false,
          },
          onProgress: noopProgress,
          registryClient: fakeRegistryClient(registry),
        }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_UPDATE_NOT_NEWER,
      });

      const consented = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "install",
          versionRequest: "2.0.0+foo",
          allowDowngrade: true,
        },
        onProgress: noopProgress,
        registryClient: fakeRegistryClient(registry),
      });
      expect(consented).toMatchObject({
        kind: "downgrade",
        targetVersion: "2.0.0+foo",
      });
    });

    it("install: --allow-downgrade on the record's OWN STRING stays the no-op - the installer never runs (control)", async () => {
      await writeInstall("2.0.0+bar", {});

      const plan = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "install",
          versionRequest: "2.0.0+bar",
          allowDowngrade: true,
        },
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "2.0.0+bar",
          versions: [{ version: "2.0.0+bar", yanked: false }],
          downloadGate: null,
          onDownloadStart: null,
        }),
      });

      expect(plan).toMatchObject({ kind: "no-op", targetVersion: "2.0.0+bar" });
    });

    it("install: already-staged when the target is already staged and promotable", async () => {
      const installed = await writeInstall("1.0.0", {});
      const stagedDir = stagedDirFor(ENV);
      mkdirSync(stagedDir, { recursive: true });
      const stagedRecord: HostStagedRecord = {
        schemaVersion: HOST_STAGED_RECORD_SCHEMA_VERSION,
        stageId: "test-stage-id",
        version: "1.5.0",
        runtimeVersion: null,
        archiveSha256: "b".repeat(64),
        sizeBytes: 1,
        source: { kind: "registry", value: "1.5.0" },
        signatureKeyId: "test-key",
        signatureVerifiedAt: new Date().toISOString(),
        executablePath: executableBasename(),
        platform: currentInstallPlatform(),
        arch: currentInstallArch(),
        executableSha256: null,
      };
      await writeHostStagedRecordAt(stagedDir, stagedRecord);
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      const before = snapshotTree(hostHomeFor(ENV));

      const plan = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "install",
          versionRequest: "1.5.0",
          allowDowngrade: false,
        },
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
      });

      expect(plan).toEqual({
        kind: "already-staged",
        targetVersion: "1.5.0",
        identity: {
          installedVersion: "1.0.0",
          installGeneration: encodeInstallGeneration({
            installId: installed.installId,
            installedAt: installed.installedAt,
            archiveSha256: installed.archiveSha256,
            version: installed.version,
          }),
          installedRuntimeVersion: installed.runtimeVersion,
          stagedVersion: "1.5.0",
          stageFingerprint: "test-stage-id",
        },
      });
      expect(snapshotTree(hostHomeFor(ENV))).toEqual(before);
    });

    it("install: upgrade when the target is newer and nothing is staged for it", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      const before = snapshotTree(hostHomeFor(ENV));

      const plan = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "install",
          versionRequest: null,
          allowDowngrade: false,
        },
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
      });

      expect(plan).toMatchObject({ kind: "upgrade", targetVersion: "1.5.0" });
      expect(snapshotTree(hostHomeFor(ENV))).toEqual(before);
    });

    it("install: downgrade requires BOTH allowDowngrade and an explicit versionRequest below installed", async () => {
      await writeInstall("2.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "2.0.0", yanked: false },
      ];
      const before = snapshotTree(hostHomeFor(ENV));

      const downgradePlan = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "install",
          versionRequest: "1.0.0",
          allowDowngrade: true,
        },
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "2.0.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
      });
      expect(downgradePlan).toMatchObject({
        kind: "downgrade",
        targetVersion: "1.0.0",
      });
      expect(snapshotTree(hostHomeFor(ENV))).toEqual(before);

      // `allowDowngrade` alone, resolving `latest` (which stays at or below
      // installed) is still up to date - the flag is not itself a downgrade
      // request without an EXPLICIT below-installed version.
      const noOpPlan = await resolveUpdatePlan({
        environment: ENV,
        request: {
          intent: "install",
          versionRequest: null,
          allowDowngrade: true,
        },
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.0.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
      });
      expect(noOpPlan).toMatchObject({ kind: "no-op", targetVersion: "1.0.0" });
      // Falsification: drop the `request.versionRequest !== null` clause
      // from the downgrade branch and `noOpPlan` reddens to `kind:
      // "downgrade"`.
    });
  });

  // `onWillDownload` (Host Update Layer Redesign - busy park + early
  // marker): awaited exactly once, after the phase-1 short-circuit decision
  // and before the first network call of the transfer itself.
  describe("onWillDownload hook", () => {
    it("calls onWillDownload exactly once with the target version, before resolveAsset and before downloadAndVerify", async () => {
      await writeInstall("1.0.0", {});
      const order: string[] = [];
      const baseClient = fakeRegistryClient({
        latest: "1.5.0",
        versions: [
          { version: "1.0.0", yanked: false },
          { version: "1.5.0", yanked: false },
        ],
        downloadGate: null,
        onDownloadStart: () => {
          order.push("download-start");
        },
      });
      const client: RegistryClient = {
        ...baseClient,
        async resolveAsset(versionRequest, platformKey) {
          order.push("resolve-asset");
          return baseClient.resolveAsset(versionRequest, platformKey);
        },
      };
      let willDownloadCalls = 0;
      const outcome = await downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: false,
        onProgress: noopProgress,
        registryClient: client,
        onWillDownload: async (targetVersion) => {
          willDownloadCalls += 1;
          expect(targetVersion).toBe("1.5.0");
          order.push("will-download");
        },
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      expect(willDownloadCalls).toBe(1);
      expect(order).toEqual([
        "will-download",
        "resolve-asset",
        "download-start",
      ]);
      expect(outcome).toMatchObject({
        outcome: "promoted",
        stagedVersion: "1.5.0",
      });
    });

    it("never calls onWillDownload on the installed-up-to-date short-circuit", async () => {
      await writeInstall("1.5.0", {});
      let called = false;
      const outcome = await downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: false,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions: [{ version: "1.5.0", yanked: false }],
          downloadGate: null,
          onDownloadStart: null,
        }),
        onWillDownload: async () => {
          called = true;
        },
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      expect(outcome).toMatchObject({
        outcome: "short-circuit",
        reason: "installed-up-to-date",
      });
      // Falsification: move the hook call above the phase-1 short-circuit
      // return and this goes red.
      expect(called).toBe(false);
    });

    it("never calls onWillDownload on the already-staged short-circuit", async () => {
      await writeInstall("1.0.0", {});
      const versions = [
        { version: "1.0.0", yanked: false },
        { version: "1.5.0", yanked: false },
      ];
      await downloadAndStageHost({
        environment: ENV,
        versionRequest: "1.5.0",
        automatic: false,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
        onWillDownload: null,
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      let called = false;
      const outcome = await downloadAndStageHost({
        environment: ENV,
        versionRequest: null,
        automatic: false,
        onProgress: noopProgress,
        registryClient: fakeRegistryClient({
          latest: "1.5.0",
          versions,
          downloadGate: null,
          onDownloadStart: null,
        }),
        onWillDownload: async () => {
          called = true;
        },
        beforeExtract: async () => {},
        ownAttempt: null,
      });
      expect(outcome).toMatchObject({
        outcome: "short-circuit",
        reason: "already-staged",
      });
      // Falsification: move the hook call above the phase-1 short-circuit
      // return and this goes red.
      expect(called).toBe(false);
    });

    it("never calls onWillDownload when the manifest's latest is not valid SemVer", async () => {
      await writeInstall("1.0.0", {});
      let called = false;
      await expect(
        downloadAndStageHost({
          environment: ENV,
          versionRequest: null,
          automatic: false,
          onProgress: noopProgress,
          registryClient: fakeRegistryClient({
            latest: "v2.0.0",
            versions: [{ version: "v2.0.0", yanked: false }],
            downloadGate: null,
            onDownloadStart: null,
          }),
          onWillDownload: async () => {
            called = true;
          },
          beforeExtract: async () => {},
          ownAttempt: null,
        }),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.REGISTRY_UNAVAILABLE });
      // Falsification: move the manifest-validity check below the hook call
      // and this goes red.
      expect(called).toBe(false);
    });

    it("propagates a rejecting onWillDownload and starts no transfer", async () => {
      await writeInstall("1.0.0", {});
      let downloadStarted = false;
      await expect(
        downloadAndStageHost({
          environment: ENV,
          versionRequest: null,
          automatic: false,
          onProgress: noopProgress,
          registryClient: fakeRegistryClient({
            latest: "1.5.0",
            versions: [
              { version: "1.0.0", yanked: false },
              { version: "1.5.0", yanked: false },
            ],
            downloadGate: null,
            onDownloadStart: () => {
              downloadStarted = true;
            },
          }),
          onWillDownload: async () => {
            throw new Error("hook failed");
          },
          beforeExtract: async () => {},
          ownAttempt: null,
        }),
      ).rejects.toThrow("hook failed");
      // Falsification: swallow the hook's rejection (e.g. wrap the `await
      // opts.onWillDownload(...)` call in a try/catch) and this goes red.
      expect(downloadStarted).toBe(false);
      expect(await readHostStagedRecord(ENV)).toBeNull();
    });
  });

  it("structurally pins capability checks on every deliberate discard and release edge", () => {
    // The public function currently owns its contender internally, so this is
    // a source-contract guard for the exact cleanup boundary. Runtime holder
    // loss is exercised by the contender/lifecycle suites; this assertion
    // prevents a future refactor from moving these checks outside the edges.
    //
    // The promote-time discard edge still checks and THROWS directly (a
    // capability loss there aborts the promote decision itself). The three
    // `finally`-block cleanup edges route through the shared
    // `cleanupAdmitted()` helper instead (fixup ticket, change 11): a
    // capability loss there must skip the destructive op and return `false`
    // rather than throw, so it can never replace the primary promote/discard
    // outcome the caller classifies with a spurious `E_CLI_LOCK_BUSY`.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../download-stage.ts"),
      "utf8",
    );
    expect(source).toContain('reason: "host-download-discard"');
    expect(source).toContain(
      "const cleanupAdmitted = async (reason: string): Promise<boolean>",
    );
    expect(source).toContain('cleanupAdmitted("host-download-temp-cleanup")');
    expect(source).toContain(
      'cleanupAdmitted("host-download-archive-release")',
    );
    expect(source).toContain("await releaseDownloadSlot(");
    expect(source).toContain("await releaseDownloadSlotOwnership(");
    // The helper never throws: a lost capability returns `false` instead.
    expect(source).toMatch(
      /cleanupAdmitted[\s\S]*?catch\s*{\s*return false;\s*}/,
    );
    expect(
      source.indexOf('cleanupAdmitted("host-download-temp-cleanup")'),
    ).toBeLessThan(source.indexOf("await rm(ownedPath"));
    expect(
      source.lastIndexOf('cleanupAdmitted("host-download-archive-release")'),
    ).toBeLessThan(source.lastIndexOf("await releaseDownloadSlotOwnership("));
  });
});
