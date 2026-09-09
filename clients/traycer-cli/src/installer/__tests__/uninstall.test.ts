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
import {
  removeHostPidMetadataForPurge,
  removeHostPidMetadataForPurgeWithVerifier,
} from "../uninstall";

describe("removeHostPidMetadataForPurge", () => {
  it("propagates capability loss before pid metadata removal", async () => {
    let removeCalls = 0;
    const verify = async (): Promise<void> => {
      throw new Error("mutation authority lost");
    };

    await expect(
      removeHostPidMetadataForPurgeWithVerifier(
        "dev",
        noopLogger,
        async () => {
          removeCalls += 1;
        },
        verify,
      ),
    ).rejects.toThrow("mutation authority lost");
    expect(removeCalls).toBe(0);
  });

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

// `store/paths` computes `TRAYCER_HOME` from `os.homedir()` once at module
// load - any export this mock leaves un-overridden (falls through via
// `...actual` below, e.g. `hostPidMetadataPath`/`cliLogPath` via
// `createCliLogger`) would otherwise resolve against the REAL production
// `~/.traycer`, not this sandbox - confirmed root cause of a real prod-host
// kill (host.log rotated, pid.json deleted for real). Redirect the `os`
// boundary itself so `vi.importActual`'s fresh module evaluation picks up
// the sandbox (falling back to the real tmpdir, never the real home,
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
    hostStagedDir: (environment: Environment) => stagedDirFor(environment),
    ensureHostInstallDir: async (environment: Environment) => {
      mkdirSync(installDirFor(environment), { recursive: true });
    },
  };
});

const ENV: Environment = "production";
const testMutationVerifier = async (): Promise<void> => undefined;

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
    osHome.current = sandboxRoot;
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
      verifyMutationCapability: testMutationVerifier,
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
      verifyMutationCapability: testMutationVerifier,
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
      verifyMutationCapability: testMutationVerifier,
    });

    expect(result.removedStagedDir).toBe(true);
  });

  // Final hold model: uninstall is the ONE place a version hold is removed
  // (`resetHeldHostVersion`) - a later fresh install of the same version must
  // not inherit a stale hold and silently park its updates. Exercised against
  // the real hold-record file (same sandboxed `os.homedir()` this suite
  // already mocks for `store/paths`), not a mock, since the point is the
  // record is actually gone from disk afterward.
  it("resets the held-host-version record on uninstall", async () => {
    const { uninstallHost } = await import("../uninstall");
    const { setHeldHostVersion } = await import("../../host/held-host-version");
    const { hostHeldVersionRecordPath, readHostHeldVersion } =
      await import("@traycer/protocol/config/installation");
    mkdirSync(installDirFor(ENV), { recursive: true });
    // `setHeldHostVersion` reaches the record through the CLI's OWN
    // `ensureHostHomeDir` (module-constant `HOST_HOME`, frozen at this
    // suite's static import time - before `beforeEach` ever points
    // `os.homedir()` at the sandbox), while the record's actual path comes
    // from the protocol package's call-time `hostHeldVersionRecordPath`
    // (which DOES see the sandbox). Pre-creating the real parent here keeps
    // the write inside the sandbox rather than leaking into whatever
    // pre-sandbox path `HOST_HOME` froze to.
    mkdirSync(join(hostHeldVersionRecordPath(ENV), ".."), {
      recursive: true,
    });
    await setHeldHostVersion(ENV, "1.2.0", "install-a");
    expect(existsSync(hostHeldVersionRecordPath(ENV))).toBe(true);

    await uninstallHost({
      environment: ENV,
      purgeChannelRuntime: false,
      verifyMutationCapability: testMutationVerifier,
    });

    expect(existsSync(hostHeldVersionRecordPath(ENV))).toBe(false);
    await expect(readHostHeldVersion(ENV)).resolves.toBeNull();
  });

  it("uninstalling with nothing held is a no-op for the hold record (never throws)", async () => {
    const { uninstallHost } = await import("../uninstall");
    const { hostHeldVersionRecordPath } =
      await import("@traycer/protocol/config/installation");
    mkdirSync(installDirFor(ENV), { recursive: true });
    expect(existsSync(hostHeldVersionRecordPath(ENV))).toBe(false);

    await expect(
      uninstallHost({
        environment: ENV,
        purgeChannelRuntime: false,
        verifyMutationCapability: testMutationVerifier,
      }),
    ).resolves.toBeDefined();

    expect(existsSync(hostHeldVersionRecordPath(ENV))).toBe(false);
  });
});
