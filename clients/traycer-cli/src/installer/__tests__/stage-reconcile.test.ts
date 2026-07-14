import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  };
});

import { currentInstallArch, currentInstallPlatform } from "../install";
import {
  readHostInstallRecord,
  writeHostInstallRecord,
  type HostInstallRecord,
} from "../../manifest/host-install";
import {
  HOST_STAGED_RECORD_SCHEMA_VERSION,
  writeHostStagedRecordAt,
  type HostStagedRecord,
} from "../../manifest/host-staged";
import { reconcileHostStage } from "../stage-reconcile";

const ENV: Environment = "production";

async function writeInstall(
  version: string,
  overrides: Partial<HostInstallRecord>,
): Promise<HostInstallRecord> {
  const installDir = installDirFor(ENV);
  mkdirSync(installDir, { recursive: true });
  const executablePath = join(installDir, "traycer-host");
  writeFileSync(executablePath, "binary");
  const record: HostInstallRecord = {
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
    ...overrides,
  };
  await writeHostInstallRecord(ENV, record);
  return record;
}

async function writeStagedAt(
  stagedDir: string,
  version: string,
  overrides: Partial<HostStagedRecord>,
): Promise<HostStagedRecord> {
  mkdirSync(stagedDir, { recursive: true });
  const executableRelPath = "traycer-host";
  writeFileSync(join(stagedDir, executableRelPath), "binary");
  const record: HostStagedRecord = {
    schemaVersion: HOST_STAGED_RECORD_SCHEMA_VERSION,
    version,
    runtimeVersion: null,
    archiveSha256: "b".repeat(64),
    sizeBytes: 1,
    source: { kind: "registry", value: version },
    signatureKeyId: "test-key",
    signatureVerifiedAt: new Date().toISOString(),
    executablePath: executableRelPath,
    platform: currentInstallPlatform(),
    arch: currentInstallArch(),
    ...overrides,
  };
  await writeHostStagedRecordAt(stagedDir, record);
  return record;
}

describe("reconcileHostStage", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-stage-reconcile-test-"));
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("restores install/ from install.old-* before the orphan rule runs, keeping a still-newer stage", async () => {
    await writeInstall("1.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "1.5.0", {});
    // Simulate the crash window between rename-aside and commit: install/
    // is moved aside and never renamed back in.
    const asideDir = `${installDirFor(ENV)}.old-${Date.now()}`;
    renameSync(installDirFor(ENV), asideDir);
    expect(existsSync(installDirFor(ENV))).toBe(false);

    const result = await reconcileHostStage(ENV);

    expect(result.targetMissingRecovered).toBe(true);
    expect(existsSync(installDirFor(ENV))).toBe(true);
    // Had the orphan rule run BEFORE recovery, the still-valid 1.5.0 stage
    // would have been wrongly deleted as "no install record".
    expect(result.stageDeletedReason).toBeNull();
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
  });

  it("does not recover install/ from an aside whose platform/arch doesn't match this machine", async () => {
    await writeInstall("1.0.0", {});
    const asideDir = `${installDirFor(ENV)}.old-${Date.now()}`;
    renameSync(installDirFor(ENV), asideDir);
    // Corrupt the aside's recorded platform so it reads as foreign.
    const badRecordPath = join(asideDir, "install.json");
    const raw = JSON.parse(readFileSync(badRecordPath, "utf8")) as Record<
      string,
      unknown
    >;
    raw.platform = "some-other-platform";
    writeFileSync(badRecordPath, JSON.stringify(raw));

    const result = await reconcileHostStage(ENV);
    expect(result.targetMissingRecovered).toBe(false);
    expect(existsSync(installDirFor(ENV))).toBe(false);
  });

  it("sweeps install.old-* trash once the target exists", async () => {
    await writeInstall("1.0.0", {});
    const staleTrash = `${installDirFor(ENV)}.old-${Date.now() - 1000}`;
    mkdirSync(staleTrash, { recursive: true });

    const result = await reconcileHostStage(ENV);

    expect(result.installTrashSwept).toBe(true);
    expect(existsSync(staleTrash)).toBe(false);
  });

  it("deletes a stage with a malformed sidecar", async () => {
    await writeInstall("1.0.0", {});
    const stagedDir = stagedDirFor(ENV);
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(join(stagedDir, "staged.json"), "{not valid json");

    const result = await reconcileHostStage(ENV);
    expect(result.stageDeletedReason).toBe("invalid-sidecar");
    expect(existsSync(stagedDir)).toBe(false);
  });

  it("deletes a stage whose platform/arch doesn't match this machine", async () => {
    await writeInstall("1.0.0", {});
    // A structurally VALID platform value that simply isn't this
    // machine's - distinct from "invalid-sidecar", which covers a
    // platform string the schema doesn't even recognize.
    const foreignPlatform =
      currentInstallPlatform() === "win32" ? "linux" : "win32";
    await writeStagedAt(stagedDirFor(ENV), "2.0.0", {
      platform: foreignPlatform,
    });

    const result = await reconcileHostStage(ENV);
    expect(result.stageDeletedReason).toBe("platform-arch-mismatch");
    expect(existsSync(stagedDirFor(ENV))).toBe(false);
  });

  it("deletes a stage whose executable is missing", async () => {
    await writeInstall("1.0.0", {});
    const stagedDir = stagedDirFor(ENV);
    mkdirSync(stagedDir, { recursive: true });
    await writeHostStagedRecordAt(stagedDir, {
      schemaVersion: HOST_STAGED_RECORD_SCHEMA_VERSION,
      version: "2.0.0",
      runtimeVersion: null,
      archiveSha256: "b".repeat(64),
      sizeBytes: 1,
      source: { kind: "registry", value: "2.0.0" },
      signatureKeyId: "test-key",
      signatureVerifiedAt: new Date().toISOString(),
      executablePath: "traycer-host",
      platform: currentInstallPlatform(),
      arch: currentInstallArch(),
    });
    // Deliberately never write the executable file itself.

    const result = await reconcileHostStage(ENV);
    expect(result.stageDeletedReason).toBe("executable-missing");
  });

  it("deletes a stage whose version is stale or equal to the installed version", async () => {
    await writeInstall("2.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "2.0.0", {});
    const result = await reconcileHostStage(ENV);
    expect(result.stageDeletedReason).toBe("stale-or-equal-version");
  });

  it("deletes an orphan stage with no install record at all", async () => {
    await writeStagedAt(stagedDirFor(ENV), "2.0.0", {});
    const result = await reconcileHostStage(ENV);
    expect(result.stageDeletedReason).toBe("orphan-no-install-record");
  });

  it("keeps a valid stage strictly newer than the installed version", async () => {
    await writeInstall("1.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "1.5.0", {});
    const result = await reconcileHostStage(ENV);
    expect(result.stageDeletedReason).toBeNull();
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
  });

  it("does not delete an incomparable-version stage on the version rule alone", async () => {
    await writeInstall("1.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "local-custom-build-2026", {});
    const result = await reconcileHostStage(ENV);
    expect(result.stageDeletedReason).toBeNull();
  });

  it("deletes staged.old-* asides when staged/ still exists (pure litter)", async () => {
    await writeInstall("1.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "1.5.0", {});
    const asideDir = `${stagedDirFor(ENV)}.old-${Date.now()}`;
    mkdirSync(asideDir, { recursive: true });

    const result = await reconcileHostStage(ENV);
    expect(result.stagedAsideOutcome).toBe("deleted");
    expect(existsSync(asideDir)).toBe(false);
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
  });

  it("restores staged/ from a valid staged.old-* aside when staged/ is missing", async () => {
    await writeInstall("1.0.0", {});
    const asideDir = `${stagedDirFor(ENV)}.old-${Date.now()}`;
    await writeStagedAt(asideDir, "1.5.0", {});

    const result = await reconcileHostStage(ENV);
    expect(result.stagedAsideOutcome).toBe("restored");
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
    expect(existsSync(asideDir)).toBe(false);
  });

  it("sweeps an invalid staged.old-* aside when staged/ is missing and no candidate is valid", async () => {
    await writeInstall("1.0.0", {});
    const asideDir = `${stagedDirFor(ENV)}.old-${Date.now()}`;
    mkdirSync(asideDir, { recursive: true });
    writeFileSync(join(asideDir, "staged.json"), "{not valid json");

    const result = await reconcileHostStage(ENV);
    expect(result.stagedAsideOutcome).toBe("deleted");
    expect(existsSync(stagedDirFor(ENV))).toBe(false);
    expect(existsSync(asideDir)).toBe(false);
  });

  it("reports the installed record is still readable after reconcile", async () => {
    const written = await writeInstall("1.0.0", {});
    await reconcileHostStage(ENV);
    const read = await readHostInstallRecord(ENV);
    expect(read?.version).toBe(written.version);
  });
});
