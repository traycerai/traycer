import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noopLogger } from "../../logger";
import { hostPidMetadataPath } from "../../store/paths";
import { removeHostPidMetadataForPurge } from "../uninstall";

describe("removeHostPidMetadataForPurge", () => {
  it("continues when locked pid metadata cannot be removed", async () => {
    const receivedPaths: string[] = [];

    await expect(
      removeHostPidMetadataForPurge(
        "dev",
        noopLogger,
        async (path, options) => {
          receivedPaths.push(path);
          expect(options).toEqual({ force: true });
          throw Object.assign(new Error("file is locked"), { code: "EBUSY" });
        },
      ),
    ).resolves.toBeUndefined();

    expect(receivedPaths).toEqual([hostPidMetadataPath("dev")]);
  });
});

// `uninstallHost` (Tech Plan, "host uninstall ... removes staged/
// alongside install/") - a genuine sandbox exercising the real
// filesystem removal, not a mocked call-count check, since the whole
// point is that BOTH directories are actually gone from disk afterward.
type Environment = "dev" | "production";

let sandboxRoot = "";

function hostHomeFor(environment: Environment): string {
  return join(sandboxRoot, "host", environment);
}
function installDirFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install");
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
    hostStagedDir: (environment: Environment) => stagedDirFor(environment),
    ensureHostInstallDir: async (environment: Environment) => {
      mkdirSync(installDirFor(environment), { recursive: true });
    },
  };
});

const ENV: Environment = "production";

function sampleInstallRecordJson(version: string): Record<string, unknown> {
  return {
    installId: `install-${version}`,
    version,
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: join(installDirFor(ENV), "traycer-host"),
  };
}

describe("uninstallHost", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-uninstall-test-"));
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("removes both install/ and staged/ from disk, alongside the install record", async () => {
    const { uninstallHost } = await import("../uninstall");
    const installDir = installDirFor(ENV);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "traycer-host"), "binary");
    writeFileSync(
      join(installDir, "install.json"),
      JSON.stringify(sampleInstallRecordJson("1.0.0")),
    );
    const stagedDir = stagedDirFor(ENV);
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(join(stagedDir, "staged.json"), '{"version":"2.0.0"}');

    const result = await uninstallHost({
      environment: ENV,
      purgeChannelRuntime: false,
    });

    expect(result.removedInstallDir).toBe(true);
    expect(result.removedStagedDir).toBe(true);
    expect(existsSync(installDir)).toBe(false);
    expect(existsSync(stagedDir)).toBe(false);
  });

  it("removes staged/ under --all too (purgeChannelRuntime does not gate staged-dir removal)", async () => {
    const { uninstallHost } = await import("../uninstall");
    mkdirSync(installDirFor(ENV), { recursive: true });
    const stagedDir = stagedDirFor(ENV);
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(join(stagedDir, "staged.json"), '{"version":"2.0.0"}');

    const result = await uninstallHost({
      environment: ENV,
      purgeChannelRuntime: true,
    });

    expect(result.removedStagedDir).toBe(true);
    expect(existsSync(stagedDir)).toBe(false);
  });

  it("reports removedStagedDir: true even when staged/ never existed", async () => {
    const { uninstallHost } = await import("../uninstall");
    mkdirSync(installDirFor(ENV), { recursive: true });
    // No staged/ directory created - `rm(..., { force: true })` on an
    // absent path resolves successfully, matching `removedInstallDir`'s
    // identical existing semantics.
    expect(existsSync(stagedDirFor(ENV))).toBe(false);

    const result = await uninstallHost({
      environment: ENV,
      purgeChannelRuntime: false,
    });

    expect(result.removedStagedDir).toBe(true);
  });
});
