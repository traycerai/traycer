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

const mocks = vi.hoisted(() => ({
  platformOverride: null as "win32" | null,
  busyOverride: null as "busy" | null,
  lifecycleCalls: [] as Array<{ bootstrap: unknown }>,
  lifecycleBeforeSwapShouldThrow: false,
  lifecyclePostSwapAction: "restart" as
    "restart" | "start" | "install" | "none",
  lifecyclePostSwapError: null as string | null,
  // `vi.mock` factories are hoisted above this file's own top-level `let
  // sandboxRoot` - a direct reference there hits a TDZ `ReferenceError`,
  // so the live sandbox value has to live in this hoisted object instead.
  sandboxHome: "",
}));

// `store/paths` computes `TRAYCER_HOME` from `os.homedir()` once at module
// load - any export the `store/paths` mock below leaves un-overridden
// would otherwise resolve against the REAL production `~/.traycer`, not
// this sandbox. `homedir` redirects `vi.importActual`'s fresh module
// evaluation to the sandbox (falling back to the real tmpdir, never the
// real home, before the first `beforeEach` has set `sandboxRoot`).
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    platform: () => mocks.platformOverride ?? actual.platform(),
    homedir: () => mocks.sandboxHome || actual.tmpdir(),
  };
});

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async () => {
    if (mocks.busyOverride === "busy") {
      throw Object.assign(new Error("host is busy"), { code: "E_HOST_BUSY" });
    }
  },
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: (options: { bootstrap: unknown }) => {
    mocks.lifecycleCalls.push({ bootstrap: options.bootstrap });
    const state = {
      priorState: "running" as const,
      stoppedBeforeSwap: false,
      postSwapAction: "none" as "restart" | "start" | "install" | "none",
      postSwapError: null as string | null,
    };
    return {
      state,
      lifecycle: {
        beforeSwap: async () => {
          if (mocks.lifecycleBeforeSwapShouldThrow) {
            throw new Error("simulated stop failure");
          }
          state.stoppedBeforeSwap = true;
        },
        afterSwap: async () => {
          state.postSwapAction = mocks.lifecyclePostSwapAction;
          state.postSwapError = mocks.lifecyclePostSwapError;
        },
      },
    };
  },
}));

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

import { applyHost } from "../apply";
import { currentInstallArch, currentInstallPlatform } from "../install";
import { readHostInstallRecord } from "../../manifest/host-install";
import {
  HOST_STAGED_RECORD_SCHEMA_VERSION,
  writeHostStagedRecordAt,
  type HostStagedRecord,
} from "../../manifest/host-staged";
import { writeHostInstallRecord } from "../../manifest/host-install";
import type { HostInstallRecord } from "../../manifest/host-install";

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

async function writeStaged(
  version: string,
  overrides: Partial<HostStagedRecord>,
): Promise<HostStagedRecord> {
  const stagedDir = stagedDirFor(ENV);
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

describe("applyHost", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-apply-test-"));
    mocks.sandboxHome = sandboxRoot;
  });

  afterEach(() => {
    mocks.platformOverride = null;
    mocks.busyOverride = null;
    mocks.lifecycleCalls = [];
    mocks.lifecycleBeforeSwapShouldThrow = false;
    mocks.lifecyclePostSwapAction = "restart";
    mocks.lifecyclePostSwapError = null;
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("no-ops when nothing is staged", async () => {
    await writeInstall("1.0.0", {});

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
    });

    expect(result).toEqual({ outcome: "no-op", installedVersion: "1.0.0" });
    expect(mocks.lifecycleCalls).toHaveLength(0);
  });

  it("rejects a different staged handoff under the apply lock without consuming it", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", { stageId: "stage-a" });

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: "stage-b",
      onProgress: () => {},
    });

    expect(result).toEqual({
      outcome: "stage-fingerprint-mismatch",
      installedVersion: "1.0.0",
      expectedStageFingerprint: "stage-b",
      actualStageFingerprint: "stage-a",
    });
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
    expect(mocks.lifecycleCalls).toHaveLength(0);
  });

  it("rejects a legacy staged record with no stageId when the production apply command was given an expected handoff", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    const recordPath = join(stagedDirFor(ENV), "staged.json");
    const legacyRecord = JSON.parse(readFileSync(recordPath, "utf8")) as {
      stageId?: unknown;
    };
    delete legacyRecord.stageId;
    writeFileSync(recordPath, JSON.stringify(legacyRecord));

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: "stage-a",
      onProgress: () => {},
    });

    expect(result).toEqual({
      outcome: "stage-fingerprint-mismatch",
      installedVersion: "1.0.0",
      expectedStageFingerprint: "stage-a",
      actualStageFingerprint: null,
    });
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
    expect(mocks.lifecycleCalls).toHaveLength(0);
  });

  it("checks the expected fingerprint after reconcile restores a replacement, before any commit can consume it", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", { stageId: "stage-b" });
    const replacementAside = `${stagedDirFor(ENV)}.old-${Date.now()}`;
    renameSync(stagedDirFor(ENV), replacementAside);
    // This expected stage is deliberately stale/equal and reconcile removes
    // it. Its valid aside replacement is then restored as canonical stage-b.
    await writeStaged("1.0.0", { stageId: "stage-a" });

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: "stage-a",
      onProgress: () => {},
    });

    expect(result).toEqual({
      outcome: "stage-fingerprint-mismatch",
      installedVersion: "1.0.0",
      expectedStageFingerprint: "stage-a",
      actualStageFingerprint: "stage-b",
    });
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
    expect(existsSync(replacementAside)).toBe(false);
    expect(mocks.lifecycleCalls).toHaveLength(0);
  });

  it("no-ops when the only staged version is comparable and not newer than installed (swept by reconcile's own stale-or-equal-version rule)", async () => {
    await writeInstall("2.0.0", {});
    await writeStaged("2.0.0", {});

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
    });

    expect(result).toEqual({ outcome: "no-op", installedVersion: "2.0.0" });
    // Reconcile (applyHost's own first step) deletes a stale-or-equal
    // stage BEFORE applyHost ever reads it - there is no separate "staged
    // but not newer" outcome left to preserve a stage for.
    expect(existsSync(stagedDirFor(ENV))).toBe(false);
  });

  it("proceeds (does not no-op) when the installed version is incomparable to a comparable stage", async () => {
    await writeInstall("local-custom-build-2026", {});
    await writeStaged("1.5.0", {});

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
    });

    expect(result.outcome).toBe("applied");
  });

  it("throws E_HOST_NOT_INSTALLED with no install record at all", async () => {
    await expect(
      applyHost({
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code: "E_HOST_NOT_INSTALLED" });
  });

  it("refuses a busy host with the stage left intact", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    mocks.busyOverride = "busy";

    await expect(
      applyHost({
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code: "E_HOST_BUSY" });

    expect(existsSync(stagedDirFor(ENV))).toBe(true);
    expect(existsSync(installDirFor(ENV))).toBe(true);
  });

  it("--force bypasses the busy check", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    mocks.busyOverride = "busy";

    const result = await applyHost({
      environment: ENV,
      force: true,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
    });

    expect(result.outcome).toBe("applied");
  });

  it("--no-service skips the busy check and the service lifecycle entirely, reporting runningActivated: false", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    mocks.busyOverride = "busy";

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: true,
      expectedStageFingerprint: null,
      onProgress: () => {},
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.runningActivated).toBe(false);
      expect(result.postSwapError).toBeNull();
      // `--no-service` never constructs a lifecycle - no service facts
      // to report, not a synthesized "not-installed" guess.
      expect(result.serviceLifecycle).toBeNull();
    }
    expect(mocks.lifecycleCalls).toHaveLength(0);
  });

  it("--no-service is rejected on Windows", async () => {
    mocks.platformOverride = "win32";
    await writeInstall("1.0.0", { platform: "win32" });
    await writeStaged("2.0.0", { platform: "win32" });

    await expect(
      applyHost({
        environment: ENV,
        force: false,
        noService: true,
        expectedStageFingerprint: null,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code: "E_INVALID_ARGUMENT" });
  });

  it("commits a null-runtime source normally, yielding a null-runtime record with a fresh installId", async () => {
    const previous = await writeInstall("1.0.0", {
      installId: "prior-install-id",
    });
    await writeStaged("2.0.0", { runtimeVersion: null });

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.record.runtimeVersion).toBeNull();
      expect(result.record.installId).not.toBeNull();
      expect(result.record.installId).not.toBe(previous.installId);
      expect(result.previous?.installId).toBe(previous.installId);
    }
  });

  it("reports runningActivated: true and the committed installGeneration on a clean apply", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    mocks.lifecyclePostSwapAction = "restart";
    mocks.lifecyclePostSwapError = null;

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.runningActivated).toBe(true);
      expect(result.installGeneration).toContain(result.record.installId);
      expect(result.postSwapError).toBeNull();
      expect(result.serviceLifecycle).toEqual({
        priorServiceState: "running",
        stoppedBeforeSwap: true,
        postSwapAction: "restart",
      });
    }
  });

  it("reports a postSwapError without throwing when the post-swap start fails (no rollback)", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    mocks.lifecyclePostSwapAction = "restart";
    mocks.lifecyclePostSwapError = "simulated start failure";

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
    });

    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.postSwapError).toBe("simulated start failure");
      expect(result.runningActivated).toBe(false);
    }
    // No rollback - the new bytes stay installed despite the start failure.
    const stored = await readHostInstallRecord(ENV);
    expect(stored?.version).toBe("2.0.0");
  });

  it("propagates a pre-commit stop failure (beforeSwap) rather than swallowing it, leaving the stage intact", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    mocks.lifecycleBeforeSwapShouldThrow = true;

    await expect(
      applyHost({
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        onProgress: () => {},
      }),
    ).rejects.toThrow("simulated stop failure");

    // Pre-commit failure - stage intact, install intact (recovery table).
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
    const stored = await readHostInstallRecord(ENV);
    expect(stored?.version).toBe("1.0.0");
  });

  it("consumes the stage exactly at commit", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});

    await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
    });

    expect(existsSync(stagedDirFor(ENV))).toBe(false);
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "binary",
    );
  });

  // Finding 10 (ticket-2 review round 1): `stage-reconcile.test.ts` already
  // pins these two crash-boundary recoveries by calling `reconcileHostStage`
  // directly - that proves the helper's own logic, but not that `applyHost`
  // (the actual command entry point, which owns calling reconcile as its
  // first step before touching anything else) genuinely wires it in and
  // completes normally afterward. These two mirror those fixtures exactly,
  // driven through `applyHost` end-to-end instead.
  it("recovers install/ from a target-missing install.old-* aside via its own pre-reconcile, then applies normally (crash window: a prior rename-aside never followed by its commit)", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    // Simulate the crash window between a PRIOR operation's rename-aside
    // and its commit (installer/install.ts's atomicSwap pattern): install/
    // was moved aside and never renamed back in.
    const asideDir = `${installDirFor(ENV)}.old-${Date.now()}`;
    renameSync(installDirFor(ENV), asideDir);
    expect(existsSync(installDirFor(ENV))).toBe(false);

    const result = await applyHost({
      environment: ENV,
      force: false,
      noService: false,
      expectedStageFingerprint: null,
      onProgress: () => {},
    });

    // Pre-reconcile recovered install/ from the aside BEFORE applyHost's
    // own "no install record" check, busy check, or commit ever ran - had
    // it not, this would have thrown E_HOST_NOT_INSTALLED instead of
    // completing the apply.
    expect(result.outcome).toBe("applied");
    if (result.outcome === "applied") {
      expect(result.record.version).toBe("2.0.0");
      expect(result.previous?.version).toBe("1.0.0");
    }
    expect(existsSync(installDirFor(ENV))).toBe(true);
  });

  it("sweeps install.old-* trash litter via its own pre-reconcile even when the apply itself is refused as busy and never reaches commit", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    // Pure litter: install/ already exists (canonical), but a prior
    // apply/install left its own trash aside behind uncleaned.
    const staleTrash = `${installDirFor(ENV)}.old-${Date.now() - 1000}`;
    mkdirSync(staleTrash, { recursive: true });
    // Busy: applyHost throws AFTER its pre-reconcile step but BEFORE
    // commit (`commitInstallFromSource`'s own `atomicSwap` - which
    // ALSO unconditionally sweeps `install.old-*` on entry - never runs
    // at all). Trash being gone here can only be pre-reconcile's own
    // doing, not commit's redundant sweep riding along with a
    // successful apply.
    mocks.busyOverride = "busy";

    await expect(
      applyHost({
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code: "E_HOST_BUSY" });

    expect(existsSync(staleTrash)).toBe(false);
    // The busy refusal only swept trash litter - the live stage itself
    // is untouched (recovery table: busy -> stage kept).
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
  });
});
