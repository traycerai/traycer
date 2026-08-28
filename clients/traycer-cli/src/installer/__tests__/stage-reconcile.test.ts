import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { PathLike, RmOptions } from "node:fs";
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

// Lets one test force `unlink`/`rm` to fail for a specific path (the exact
// two operations round-1's aside-invalidation depended on entirely), while
// every other path proxies straight through to the real implementation -
// see the "forced double failure" test below.
const mocks = vi.hoisted(() => ({
  forceRenameFailureForPath: null as string | null,
  forceUnlinkFailureForPath: null as string | null,
  forceRmFailureForPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (path: PathLike) => {
      if (path === mocks.forceUnlinkFailureForPath) {
        throw Object.assign(new Error("simulated unlink failure"), {
          code: "EPERM",
        });
      }
      return actual.unlink(path);
    },
    rm: async (path: PathLike, options: RmOptions) => {
      if (path === mocks.forceRmFailureForPath) {
        throw Object.assign(new Error("simulated rm failure"), {
          code: "EPERM",
        });
      }
      return actual.rm(path, options);
    },
  };
});

vi.mock("../rename-retry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rename-retry")>();
  return {
    ...actual,
    renameWithRetry: async (from: string, to: string): Promise<void> => {
      if (from === mocks.forceRenameFailureForPath) {
        throw Object.assign(new Error("simulated rename failure"), {
          code: "EPERM",
        });
      }
      return actual.renameWithRetry(from, to);
    },
  };
});

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
import { purgeHostStage, reconcileHostStage } from "../stage-reconcile";

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
    stageId: overrides.stageId ?? "test-stage-id",
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
    osHome.current = sandboxRoot;
  });

  afterEach(() => {
    mocks.forceRenameFailureForPath = null;
    mocks.forceUnlinkFailureForPath = null;
    mocks.forceRmFailureForPath = null;
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
      stageId: "test-stage-id",
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

  it("deletes a stage whose version is not valid SemVer as invalid-sidecar", async () => {
    // The staged (registry) side of the version domain must always be
    // valid SemVer - a non-parseable staged version is corrupt/foreign
    // data, not a legitimate incomparable case (that policy applies only
    // to the installed side - see the incomparable-INSTALLED test above).
    await writeInstall("1.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "not-a-version", {});
    const result = await reconcileHostStage(ENV);
    expect(result.stageDeletedReason).toBe("invalid-sidecar");
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

  it("does not delete a valid stage on the version rule alone when the INSTALLED version is incomparable", async () => {
    // Incomparability is a policy reserved for the installed side only -
    // the staged (registry) side must always be valid SemVer (see the
    // "invalid-sidecar" tests below), so this exercises the legitimate
    // incomparable case: a local-file install with a genuinely
    // SemVer-valid stage sitting alongside it.
    await writeInstall("local-custom-build-2026", {});
    await writeStagedAt(stagedDirFor(ENV), "1.5.0", {});
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

  it("re-evaluates a step-4-restored aside against step 3 and deletes it again within the same pass if it fails", async () => {
    // The aside is structurally VALID (step 4's own lighter check would
    // happily restore it: parseable sidecar, matching platform/arch,
    // executable present) but its version is stale against the CURRENT
    // installed version - a rule step 4 doesn't itself apply. One
    // reconcile pass must not end with a restored stage that violates
    // step 3.
    await writeInstall("2.0.0", {});
    const asideDir = `${stagedDirFor(ENV)}.old-${Date.now()}`;
    await writeStagedAt(asideDir, "2.0.0", {});

    const result = await reconcileHostStage(ENV);
    expect(result.stagedAsideOutcome).toBe("restored");
    expect(result.stageDeletedReason).toBe("stale-or-equal-version");
    expect(existsSync(stagedDirFor(ENV))).toBe(false);
  });

  it("never restores an aside whose sidecar was removed but the rest of the directory is intact (partial-delete litter)", async () => {
    // Simulates the exact failure mode the sidecar-first deletion order
    // guards against: the sidecar unlink succeeded, but the subsequent
    // best-effort recursive removal did not (a lock, a transient error),
    // leaving the rest of the aside - including the "executable" -
    // fully intact. Without a sidecar, this candidate must never be
    // mistaken for a valid stage and restored.
    await writeInstall("1.0.0", {});
    const asideDir = `${stagedDirFor(ENV)}.old-${Date.now()}`;
    const record = await writeStagedAt(asideDir, "1.5.0", {});
    rmSync(join(asideDir, "staged.json"));
    expect(existsSync(join(asideDir, record.executablePath))).toBe(true);

    const result = await reconcileHostStage(ENV);
    expect(result.stagedAsideOutcome).not.toBe("restored");
    expect(existsSync(stagedDirFor(ENV))).toBe(false);
  });

  it("invalidates a pure-litter aside even when the sidecar unlink AND the recursive removal both fail", async () => {
    // Round-1's aside cleanup depended entirely on unlink+rm succeeding -
    // if BOTH failed (e.g. a Windows open-file handle blocking both), a
    // fully valid, restorable aside was left behind. Round-2's fix makes
    // the rename-to-`.dead-*` the PRIMARY defense: it runs first and, on
    // success, the candidate is already structurally invisible to step
    // 4's restore path before unlink/rm are ever reached - so forcing
    // exactly the two operations that were round-1's whole defense to
    // fail no longer matters. `rename` itself is deliberately left real
    // (not forced to fail) so this proves the NEW primary layer's success
    // path, not the deepest accepted-residual fallback.
    await writeInstall("1.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "1.5.0", {});
    const asideDir = `${stagedDirFor(ENV)}.old-${Date.now()}`;
    mkdirSync(asideDir, { recursive: true });
    writeFileSync(join(asideDir, "staged.json"), '{"version":"1.0.0"}');
    mocks.forceUnlinkFailureForPath = join(asideDir, "staged.json");
    mocks.forceRmFailureForPath = asideDir;

    const result = await reconcileHostStage(ENV);
    expect(result.stagedAsideOutcome).toBe("deleted");
    expect(existsSync(asideDir)).toBe(false);

    // Not restorable by a SUBSEQUENT reconcile either: the candidate no
    // longer exists under the `.old-*` prefix `reconcileStagedAside`
    // scans for, so even if `staged/` were removed and reconcile ran
    // again, there is nothing left to find.
    rmSync(stagedDirFor(ENV), { recursive: true, force: true });
    const second = await reconcileHostStage(ENV);
    expect(second.stagedAsideOutcome).toBe("none");
    expect(existsSync(stagedDirFor(ENV))).toBe(false);
  });

  it("sweeps a .dead-* aside sibling even when there are no .old-* candidates at all", async () => {
    // `.dead-*` is what `invalidateStagedAsideDir`'s layer-1 rename
    // leaves behind - a structurally different prefix `.old-*` scanning
    // never matches, so it can only be cleaned up by the unconditional
    // sweep in `reconcileHostStage`, never by a call site nested inside
    // `reconcileStagedAside`'s own pure-litter branch. No `.old-*`
    // candidates at all is the ORDINARY case once a prior pass has
    // already invalidated them - the call site this replaces was
    // unreachable on exactly this path, so `.dead-*` trees accumulated
    // forever across every completed replacement.
    await writeInstall("1.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "1.5.0", {});
    const deadDir = `${stagedDirFor(ENV)}.dead-${Date.now()}`;
    mkdirSync(deadDir, { recursive: true });
    writeFileSync(join(deadDir, "leftover.txt"), "litter");

    const result = await reconcileHostStage(ENV);
    expect(result.stagedAsideOutcome).toBe("none");
    expect(existsSync(deadDir)).toBe(false);
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
  });

  it("purges canonical staged bytes and every recoverable aside without letting reconcile restore one", async () => {
    await writeInstall("1.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "1.5.0", {});
    const asideDir = `${stagedDirFor(ENV)}.old-${Date.now()}`;
    renameSync(stagedDirFor(ENV), asideDir);
    await writeStagedAt(stagedDirFor(ENV), "1.6.0", {});

    await purgeHostStage(ENV, null);

    expect(existsSync(stagedDirFor(ENV))).toBe(false);
    expect(existsSync(asideDir)).toBe(false);
    const reconciled = await reconcileHostStage(ENV);
    expect(reconciled.stagedAsideOutcome).toBe("none");
    expect(existsSync(stagedDirFor(ENV))).toBe(false);
  });

  it("does not report a yanked stage purged when every invalidation layer leaves a recoverable aside", async () => {
    await writeInstall("1.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "1.5.0", {});
    const asideDir = `${stagedDirFor(ENV)}.old-${Date.now()}`;
    await writeStagedAt(asideDir, "1.5.0", {});
    mocks.forceRenameFailureForPath = asideDir;
    mocks.forceUnlinkFailureForPath = join(asideDir, "staged.json");
    mocks.forceRmFailureForPath = asideDir;

    await expect(purgeHostStage(ENV, null)).rejects.toThrow(
      "Could not invalidate every recoverable staged aside",
    );
    expect(existsSync(asideDir)).toBe(true);

    mocks.forceRenameFailureForPath = null;
    mocks.forceUnlinkFailureForPath = null;
    mocks.forceRmFailureForPath = null;
    const reconciled = await reconcileHostStage(ENV);
    expect(reconciled.stagedAsideOutcome).toBe("restored");
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
  });

  it("keeps a replacement stage when the expected yanked-stage fingerprint is stale", async () => {
    await writeInstall("1.0.0", {});
    await writeStagedAt(stagedDirFor(ENV), "1.8.0", { stageId: "stage-b" });

    const outcome = await purgeHostStage(ENV, "stage-a");

    expect(outcome).toEqual({
      outcome: "stage-fingerprint-mismatch",
      purged: false,
      actualStageFingerprint: "stage-b",
    });
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
  });

  it("reports the installed record is still readable after reconcile", async () => {
    const written = await writeInstall("1.0.0", {});
    await reconcileHostStage(ENV);
    const read = await readHostInstallRecord(ENV);
    expect(read?.version).toBe(written.version);
  });
});
