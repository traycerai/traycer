import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostPlatformAsset,
  HostVersionEntry,
  HostVersionsManifest,
  RegistryClient,
} from "../../registry";
import type { HostInstallRecord } from "../../manifest/host-install";
import type { CommandContext } from "../../runner/runner";

// `host install --release` over what a side-loaded install leaves behind,
// through the real command, the real early gate and the real commit tail.
// Faked at the edges only: the sandboxed home, the manifest the gate fetches,
// the registry client staging resolves through, and the service manager.

const sandbox = vi.hoisted(() => ({ root: "" }));
const registry = vi.hoisted(() => ({
  client: null as RegistryClient | null,
  fetchText: vi.fn<() => Promise<string>>(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => sandbox.root || actual.tmpdir() };
});

function hostHome(): string {
  return join(sandbox.root, "host");
}

vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  const { mkdirSync: mkdir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  const home = (): string => joinPath(sandbox.root, "host");
  const installDir = (): string => joinPath(home(), "install");
  return {
    ...actual,
    hostHomeDir: home,
    hostInstallDir: installDir,
    hostInstallRecordPath: () => joinPath(installDir(), "install.json"),
    hostStagingRoot: () => joinPath(home(), "install-staging"),
    ensureHostHomeDir: async () => {
      mkdir(home(), { recursive: true });
    },
    ensureHostInstallDir: async () => {
      mkdir(installDir(), { recursive: true });
    },
    ensureHostStagingRoot: async () => {
      mkdir(joinPath(home(), "install-staging"), { recursive: true });
    },
  };
});

vi.mock("../../registry/fetch-resource", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../registry/fetch-resource")>();
  return { ...actual, fetchText: () => registry.fetchText() };
});

vi.mock("../../registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../registry")>();
  return {
    ...actual,
    createDefaultRegistryClient: async (): Promise<RegistryClient> => {
      if (registry.client === null) throw new Error("no fake registry client");
      return registry.client;
    },
  };
});

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    serviceManagerMayRespawn: async () => false,
    createServiceController: () => ({
      status: async () => ({
        state: "stopped",
        version: null,
        listenUrl: null,
        pid: null,
      }),
    }),
  };
});

import { EPIC_STATE_DIRNAME } from "../../host/chat-store-survey";
import {
  readHostInstallRecord,
  writeHostInstallRecord,
} from "../../manifest/host-install";
import { currentHostPlatformKey } from "../../registry";
import { CliError } from "../../runner/errors";
import { buildHostInstallCommand } from "../host-install";

const ENV = "production";
const INSTALLED_LABEL =
  "local-traycer-host-macos-arm64.tar.gz-2026-11-01T07-54-28-844Z";
const INSTALLED_SHA = "1".repeat(64);
const TARGET_SHA = "2".repeat(64);

interface InstalledFixture {
  readonly runtimeVersion: string | null;
  readonly sidecar: Record<string, unknown> | null;
  readonly archiveSha256: string;
}

/** The record and tree `host install --from` leaves on disk. */
async function writeSideLoadedInstall(
  fixture: InstalledFixture,
): Promise<void> {
  const runtimeDir = join(hostHome(), "install", "host-runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "traycer-host"), "installed bytes");
  if (fixture.sidecar !== null) {
    writeFileSync(
      join(runtimeDir, "version.json"),
      JSON.stringify(fixture.sidecar),
    );
  }
  const record: HostInstallRecord = {
    installId: randomUUID(),
    version: INSTALLED_LABEL,
    runtimeVersion: fixture.runtimeVersion,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-11-01T07:54:30.662Z",
    source: { kind: "local-file", value: "dl/traycer-host.tar.gz" },
    archiveSha256: fixture.archiveSha256,
    signatureVerifiedAt: "2026-11-01T07:54:28.844Z",
    signatureKeyId: "local-file:unsigned",
    sizeBytes: 1,
    executablePath: join(runtimeDir, "traycer-host"),
    executableSha256: null,
  };
  await writeHostInstallRecord(ENV, record);
}

async function writeStampedChatDb(
  epicId: string,
  schemaVersion: number,
): Promise<void> {
  const dir = join(hostHome(), EPIC_STATE_DIRNAME, epicId, "chat");
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "chat.db"));
  try {
    db.exec(
      "CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO chat_db_meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(schemaVersion),
    );
  } finally {
    db.close();
  }
}

function writeUnreadableChatDb(epicId: string): void {
  const dir = join(hostHome(), EPIC_STATE_DIRNAME, epicId, "chat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chat.db"), "not a sqlite file");
}

interface TargetFixture {
  readonly version: string;
  readonly storeFormats: { readonly chatDb: number } | null;
  readonly archiveSha256: string;
  readonly sidecar: Record<string, unknown> | null;
}

/** A real archive, so staging extracts it and reads its sidecar. */
function writeTargetArchive(target: TargetFixture): string {
  const treeDir = join(sandbox.root, "archive-tree", randomUUID());
  const runtimeDir = join(treeDir, "host-runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "traycer-host"), "target bytes", {
    mode: 0o755,
  });
  if (target.sidecar !== null) {
    writeFileSync(
      join(runtimeDir, "version.json"),
      JSON.stringify(target.sidecar),
    );
  }
  const archiveDir = join(sandbox.root, "archives", randomUUID());
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, "traycer-host.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", treeDir, "host-runtime"]);
  return archivePath;
}

const downloadStarts = vi.fn();

function publish(target: TargetFixture): void {
  const asset: HostPlatformAsset = {
    available: true,
    unavailableReason: null,
    url: `https://example.com/${target.version}/traycer-host.tar.gz`,
    sizeBytes: 1,
    sha256: target.archiveSha256,
    signatureUrl: `https://example.com/${target.version}/traycer-host.minisig`,
    signatureAlgorithm: "minisign",
    publicKeyId: "fake-key-id",
  };
  const entry: HostVersionEntry = {
    version: target.version,
    releasedAt: "2026-11-01T06:35:57.677Z",
    releaseNotesUrl: "https://example.com/notes",
    yanked: false,
    deprecationReason: null,
    requiredCliVersion: null,
    minimumEpoch: null,
    storeFormats: target.storeFormats,
    platforms: { [currentHostPlatformKey()]: asset },
  };
  const manifest: HostVersionsManifest = {
    schemaVersion: 1,
    generatedAt: "2026-11-01T06:36:16.580Z",
    latest: target.version,
    versions: [entry],
  };
  registry.fetchText.mockResolvedValue(JSON.stringify(manifest));
  registry.client = {
    fetchManifest: async () => manifest,
    resolveAsset: async () => ({ entry, asset }),
    downloadAndVerify: async () => {
      downloadStarts();
      return {
        archivePath: writeTargetArchive(target),
        archiveSha256: target.archiveSha256,
        signatureKeyId: "fake-key-id",
        signatureVerifiedAt: "2026-11-01T08:00:00.000Z",
      };
    },
  };
}

/** The manifest read the early gate makes gave up, as it did on rc.2. */
function manifestReadTimesOut(): void {
  registry.fetchText.mockRejectedValue(new Error("watchdog expired"));
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function context(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: true,
      noProgress: true,
      noBootstrap: false,
      nonInteractive: true,
      environment: ENV,
      logger,
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

async function installRelease(version: string): Promise<void> {
  await buildHostInstallCommand({
    versionRequest: version,
    fromPath: null,
    enableLinger: false,
    allowSelfInvocation: false,
    noServiceRegister: true,
    ifIdle: false,
    force: false,
    acceptStoreFormatLoss: false,
    attemptAdoption: null,
    lifecycleOrigin: "terminal",
  })(context());
}

async function refusalOf(version: string): Promise<CliError> {
  const refusal: unknown = await installRelease(version).then(
    () => null,
    (err: unknown) => err,
  );
  if (!(refusal instanceof CliError)) {
    throw new Error(`expected a refusal, got ${String(refusal)}`);
  }
  expect(refusal.code).toBe("E_HOST_STORE_FORMAT_FLOOR");
  return refusal;
}

async function expectInstalledFromRegistry(version: string): Promise<void> {
  await expect(readHostInstallRecord(ENV)).resolves.toMatchObject({
    version,
    source: { kind: "registry", value: version },
  });
}

const RC2 = "1.5.2-rc.2";
const RC2_SIDECAR = { version: RC2, storeFormats: { chatDb: 22 } };

beforeEach(() => {
  sandbox.root = mkdtempSync(join(tmpdir(), "store-floor-provenance-"));
  registry.client = null;
  registry.fetchText.mockReset();
  downloadStarts.mockReset();
  logger.info.mockClear();
});

afterEach(() => {
  rmSync(sandbox.root, { recursive: true, force: true });
});

describe("host install --release over a side-loaded install", () => {
  it("judges the installed side by its runtime version, not its label, so the same release needs no manifest read", async () => {
    await writeSideLoadedInstall({
      runtimeVersion: RC2,
      sidecar: RC2_SIDECAR,
      archiveSha256: INSTALLED_SHA,
    });
    await writeStampedChatDb("epic-at-22", 22);
    publish({
      version: RC2,
      storeFormats: { chatDb: 22 },
      archiveSha256: TARGET_SHA,
      sidecar: RC2_SIDECAR,
    });

    await installRelease(RC2);

    expect(registry.fetchText).not.toHaveBeenCalled();
    await expectInstalledFromRegistry(RC2);
  });

  it("places a side-loaded build with no sidecar through its runtime version, past an unreadable store", async () => {
    // Table-covered, so its runtime version alone places both sides at 9. Its
    // label places nothing, and the walk would refuse on the unreadable store.
    const version = "1.3.0-rc.4";
    await writeSideLoadedInstall({
      runtimeVersion: version,
      sidecar: null,
      archiveSha256: INSTALLED_SHA,
    });
    writeUnreadableChatDb("epic-unreadable");
    publish({
      version,
      storeFormats: null,
      archiveSha256: TARGET_SHA,
      sidecar: { version },
    });

    await installRelease(version);

    await expectInstalledFromRegistry(version);
  });

  it("proceeds when the manifest read gives up, judging the target at the commit tail", async () => {
    // The rc.2 refusal: nothing placed the target before the transfer, so a
    // read that timed out was taken for a target that publishes nothing.
    await writeSideLoadedInstall({
      runtimeVersion: null,
      sidecar: RC2_SIDECAR,
      archiveSha256: INSTALLED_SHA,
    });
    await writeStampedChatDb("epic-at-22", 22);
    publish({
      version: RC2,
      storeFormats: { chatDb: 22 },
      archiveSha256: TARGET_SHA,
      sidecar: RC2_SIDECAR,
    });
    manifestReadTimesOut();

    await installRelease(RC2);

    expect(downloadStarts).toHaveBeenCalledTimes(1);
    await expectInstalledFromRegistry(RC2);
  });

  it("answers from the staged registry entry when the gate's read gave up and the archive declares nothing", async () => {
    await writeSideLoadedInstall({
      runtimeVersion: null,
      sidecar: RC2_SIDECAR,
      archiveSha256: INSTALLED_SHA,
    });
    await writeStampedChatDb("epic-at-22", 22);
    publish({
      version: RC2,
      storeFormats: { chatDb: 22 },
      archiveSha256: TARGET_SHA,
      sidecar: { version: RC2 },
    });
    manifestReadTimesOut();

    await installRelease(RC2);

    await expectInstalledFromRegistry(RC2);
  });

  it("still refuses a real downgrade when the manifest read gives up, once the staged entry names the format", async () => {
    await writeSideLoadedInstall({
      runtimeVersion: RC2,
      sidecar: RC2_SIDECAR,
      archiveSha256: INSTALLED_SHA,
    });
    await writeStampedChatDb("epic-at-22", 22);
    publish({
      version: "1.5.1",
      storeFormats: { chatDb: 20 },
      archiveSha256: TARGET_SHA,
      sidecar: { version: "1.5.1", storeFormats: { chatDb: 20 } },
    });
    manifestReadTimesOut();

    const refusal = await refusalOf("1.5.1");

    expect(refusal.message).toContain("it reads chat store format 20");
    await expect(readHostInstallRecord(ENV)).resolves.toMatchObject({
      version: INSTALLED_LABEL,
    });
  });

  it("lets a byte-identical archive through whatever the stores say", async () => {
    // Nothing else can clear this: no runtime version, no sidecar, and a store
    // that cannot be read.
    await writeSideLoadedInstall({
      runtimeVersion: null,
      sidecar: null,
      archiveSha256: INSTALLED_SHA,
    });
    writeUnreadableChatDb("epic-unreadable");
    publish({
      version: RC2,
      storeFormats: { chatDb: 22 },
      archiveSha256: INSTALLED_SHA,
      sidecar: { version: RC2 },
    });

    await installRelease(RC2);

    await expectInstalledFromRegistry(RC2);
    expect(logger.info).toHaveBeenCalledWith(
      "Host store-format floor cleared: the target is the installed archive",
      expect.objectContaining({ targetVersion: RC2 }),
    );
  });

  it("refuses a target that reads older than the stores, before any transfer, and says the chats are lost", async () => {
    await writeSideLoadedInstall({
      runtimeVersion: RC2,
      sidecar: RC2_SIDECAR,
      archiveSha256: INSTALLED_SHA,
    });
    await writeStampedChatDb("epic-at-22", 22);
    publish({
      version: "1.5.1",
      storeFormats: { chatDb: 20 },
      archiveSha256: TARGET_SHA,
      sidecar: null,
    });

    const refusal = await refusalOf("1.5.1");

    expect(downloadStarts).not.toHaveBeenCalled();
    expect(refusal.message).toBe(
      `host install: refusing to install host 1.5.1 over the installed ${RC2} (from a local archive) - it reads chat store format 20, and 1 epic on this machine carries a newer one (epic-at-22 at format 22). Those chats would be unreadable to it, and a host that meets a store it cannot open crash-loops rather than reporting it. Install a host that can read them instead, or rerun with --accept-store-format-loss to install it anyway and lose access to those chats.`,
    );
  });

  it("names the target, and promises no loss, when neither its entry nor its archive places it", async () => {
    await writeSideLoadedInstall({
      runtimeVersion: null,
      sidecar: RC2_SIDECAR,
      archiveSha256: INSTALLED_SHA,
    });
    await writeStampedChatDb("epic-at-22", 22);
    publish({
      version: RC2,
      storeFormats: null,
      archiveSha256: TARGET_SHA,
      sidecar: { version: RC2 },
    });

    const refusal = await refusalOf(RC2);

    expect(refusal.message).toBe(
      `host install: refusing to install host ${RC2} over the installed ${INSTALLED_LABEL} (from a local archive) - this CLI cannot tell which chat store format ${RC2} reads (its registry entry publishes none, its archive declares none, and it is newer than the versions this CLI has a built-in answer for), so it cannot be shown that those chats survive the swap. Install a host that can read them instead, or rerun with --accept-store-format-loss to install it anyway, which may lose access to those chats.`,
    );
  });

  it("names the installed side when nothing places it and a store cannot be read", async () => {
    await writeSideLoadedInstall({
      runtimeVersion: null,
      sidecar: null,
      archiveSha256: INSTALLED_SHA,
    });
    writeUnreadableChatDb("epic-unreadable");
    publish({
      version: RC2,
      storeFormats: { chatDb: 22 },
      archiveSha256: TARGET_SHA,
      sidecar: RC2_SIDECAR,
    });

    const refusal = await refusalOf(RC2);

    expect(refusal.message).toBe(
      `host install: refusing to install host ${RC2} over the installed ${INSTALLED_LABEL} (from a local archive) - 1 epic on this machine could not be read (epic-unreadable: chat.db could not be read), so it cannot be shown that those chats survive the swap. The installed side gave no answer either: its record says ${INSTALLED_LABEL}, no runtime version, from a local archive, and its files declare no store format. Install a host that can read them instead, or rerun with --accept-store-format-loss to install it anyway, which may lose access to those chats.`,
    );
  });
});
