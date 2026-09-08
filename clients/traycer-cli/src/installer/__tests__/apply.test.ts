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
import type { HostStartAdoptionPublisher } from "../../host/host-start-adoption";

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
  lifecycleCalls: [] as Array<{ bootstrap: unknown; force: boolean }>,
  // What `applyHost` handed the lifecycle as its pre-stop boundary, so a
  // pin can assert the SAME function reaches both actuators.
  lifecycleStopHooks: [] as Array<(() => void) | null>,
  lifecycleBeforeSwapShouldThrow: false,
  lifecyclePostSwapAction: "restart" as
    | "restart"
    | "start"
    | "install"
    | "none",
  lifecyclePostSwapError: null as string | null,
  // `vi.mock` factories are hoisted above this file's own top-level `let
  // sandboxRoot` - a direct reference there hits a TDZ `ReferenceError`,
  // so the live sandbox value has to live in this hoisted object instead.
  sandboxHome: "",
  // Cross-mock ordering timeline for the `onWillCommitStaged` placement
  // pins below: `assertHostNotBusy` and `createServiceInstallLifecycle`
  // (whose construction is `applyHost`'s first commit-path step after the
  // hook) both push into this SHARED array, alongside the hook itself, so
  // a single assertion can pin the hook strictly between the busy check
  // and the commit machinery.
  callOrder: [] as string[],
  // Counts calls into the mocked `requireCliUpdateMutationCapability` below
  // - proof that a test went through the real `applyHostWithAttempt`
  // wrapper (`host/update-mutation.ts`), not a bypassed `applyHost` call.
  verifyCapabilityCalls: 0,
  // Whatever `apply.ts` handed the lifecycle through
  // `setHostStartAdoptionPublisher`. Non-null only when the caller supplied
  // a publisher at all, which is exactly what the contender wrapper does
  // and a direct `applyHost` call does not.
  hostStartAdoptionPublisher: null as HostStartAdoptionPublisher | null,
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
    mocks.callOrder.push("busy-check");
    if (mocks.busyOverride === "busy") {
      throw Object.assign(new Error("host is busy"), { code: "E_HOST_BUSY" });
    }
  },
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: (options: {
    bootstrap: unknown;
    force: boolean;
    onWillStopHost: (() => void) | null;
    hooks: {
      beforeSwapCommit: () => Promise<void>;
      afterSwap: () => Promise<void>;
    };
  }) => {
    mocks.callOrder.push("lifecycle-created");
    mocks.lifecycleCalls.push({
      bootstrap: options.bootstrap,
      force: options.force,
    });
    mocks.lifecycleStopHooks.push(options.onWillStopHost);
    const state = {
      priorState: "running" as const,
      stoppedBeforeSwap: false,
      postSwapAction: "none" as "restart" | "start" | "install" | "none",
      postSwapError: null as string | null,
    };
    return {
      state,
      lifecycle: {
        // Present so `apply.ts`'s optional-chained
        // `setHostStartAdoptionPublisher?.(...)` is a real call rather than
        // a silent no-op - without it the wrapper's adoption wiring is
        // unobservable from this suite. Recording only; the four
        // `onWillCommitStaged` pins call `applyHost` directly, pass no
        // publisher, and therefore never reach this.
        setHostStartAdoptionPublisher: (
          publish: HostStartAdoptionPublisher,
        ) => {
          mocks.hostStartAdoptionPublisher = publish;
        },
        beforeSwap: async () => {
          if (mocks.lifecycleBeforeSwapShouldThrow) {
            throw new Error("simulated stop failure");
          }
          state.stoppedBeforeSwap = true;
        },
        // Forwarded exactly as the real `createServiceInstallLifecycle`
        // does, so the barrier pins observe the production call sites in
        // `commitInstallFromSource` rather than this stub's own bookkeeping.
        beforeSwapCommit: () => options.hooks.beforeSwapCommit(),
        afterSwap: async () => {
          // At the TOP, as the real lifecycle runs it.
          await options.hooks.afterSwap();
          state.postSwapAction = mocks.lifecyclePostSwapAction;
          state.postSwapError = mocks.lifecyclePostSwapError;
        },
        swapLockRecovery: null,
      },
    };
  },
}));

// `applyHostWithAttempt` (the real `host/update-mutation.ts` wrapper) checks
// a live `UpdateMutationCapability` through this function - a brand only its
// own module can mint, so a plain test-authored object literal cannot pass
// the real check. Stubbing this one function (and nothing else in the
// module - the executor facades, adoption helpers, etc. are untouched) lets
// the wrapper-level describe block below exercise the REAL
// `applyHostWithAttempt` -> `applyHost` call path with a fake capability,
// without rebuilding the lock/contender machinery `update-contender.ts`
// exists to own.
vi.mock("../../host/update-contender", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-contender")>();
  return {
    ...actual,
    requireCliUpdateMutationCapability: async (): Promise<void> => {
      mocks.verifyCapabilityCalls += 1;
    },
  };
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

import { applyHost as applyHostWithAuthority } from "../apply";
import {
  currentInstallArch,
  currentInstallPlatform,
  NO_INSTALL_PHASE_HOOKS,
  type InstallPhaseHooks,
} from "../install";
import { applyHostWithAttempt } from "../../host/update-mutation";
import type { WithCliUpdateContenderOptions } from "../../host/update-contender";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import { readHostInstallRecord } from "../../manifest/host-install";
import {
  HOST_STAGED_RECORD_SCHEMA_VERSION,
  writeHostStagedRecordAt,
  type HostStagedRecord,
} from "../../manifest/host-staged";
import { writeHostInstallRecord } from "../../manifest/host-install";
import type { HostInstallRecord } from "../../manifest/host-install";

const testMutationVerifier = async (): Promise<void> => undefined;
type ApplyOptions = Parameters<typeof applyHostWithAuthority>[0];
// The fields every call must state in production default to their "not
// tracking / not pinning" values here: a test that pins one passes it.
type ApplyDefaultedOptions =
  | "verifyMutationCapability"
  | "expectedStagedVersion"
  | "onWillCommitStaged"
  | "onWillDisruptHost"
  | "hooks";
const applyHost = (
  options: Omit<ApplyOptions, ApplyDefaultedOptions> &
    Partial<Pick<ApplyOptions, ApplyDefaultedOptions>>,
) =>
  applyHostWithAuthority({
    ...options,
    verifyMutationCapability:
      options.verifyMutationCapability ?? testMutationVerifier,
    expectedStagedVersion: options.expectedStagedVersion ?? null,
    onWillCommitStaged: options.onWillCommitStaged ?? null,
    onWillDisruptHost: options.onWillDisruptHost ?? null,
    hooks: options.hooks ?? NO_INSTALL_PHASE_HOOKS,
  });

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
    executableSha256: null,
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
    executableSha256: null,
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
    mocks.callOrder = [];
    mocks.lifecycleStopHooks = [];
    mocks.verifyCapabilityCalls = 0;
    mocks.hostStartAdoptionPublisher = null;
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

  describe("onWillCommitStaged", () => {
    it("is called exactly once with the staged version, after the busy check and before the commit", async () => {
      // Falsification: move the `onWillCommitStaged` call above the busy
      // gate in `apply.ts` and "busy-check" would land AFTER "hook" in the
      // order below instead of before it.
      await writeInstall("1.0.0", {});
      await writeStaged("2.0.0", {});
      const onWillCommitStaged = vi.fn(async (stagedVersion: string) => {
        mocks.callOrder.push("hook");
        expect(stagedVersion).toBe("2.0.0");
      });

      const result = await applyHost({
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        onProgress: () => {},
        onWillCommitStaged,
      });

      expect(result.outcome).toBe("applied");
      expect(onWillCommitStaged).toHaveBeenCalledTimes(1);
      expect(onWillCommitStaged).toHaveBeenCalledWith("2.0.0");
      // Strictly between the busy check and the commit machinery
      // (`createServiceInstallLifecycle` is `applyHost`'s first commit-path
      // step once it decides to proceed).
      expect(mocks.callOrder).toEqual([
        "busy-check",
        "hook",
        "lifecycle-created",
      ]);
    });

    it("is not called when nothing is staged (the no-op outcome)", async () => {
      await writeInstall("1.0.0", {});
      const onWillCommitStaged = vi.fn(async () => undefined);

      const result = await applyHost({
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        onProgress: () => {},
        onWillCommitStaged,
      });

      expect(result).toEqual({ outcome: "no-op", installedVersion: "1.0.0" });
      expect(onWillCommitStaged).not.toHaveBeenCalled();
    });

    it("is not called on a fingerprint mismatch", async () => {
      await writeInstall("1.0.0", {});
      await writeStaged("2.0.0", { stageId: "stage-a" });
      const onWillCommitStaged = vi.fn(async () => undefined);

      const result = await applyHost({
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: "stage-b",
        onProgress: () => {},
        onWillCommitStaged,
      });

      expect(result.outcome).toBe("stage-fingerprint-mismatch");
      expect(onWillCommitStaged).not.toHaveBeenCalled();
    });

    it("is not called when the busy check throws", async () => {
      await writeInstall("1.0.0", {});
      await writeStaged("2.0.0", {});
      mocks.busyOverride = "busy";
      const onWillCommitStaged = vi.fn(async () => undefined);

      await expect(
        applyHost({
          environment: ENV,
          force: false,
          noService: false,
          expectedStageFingerprint: null,
          onProgress: () => {},
          onWillCommitStaged,
        }),
      ).rejects.toMatchObject({ code: "E_HOST_BUSY" });

      expect(onWillCommitStaged).not.toHaveBeenCalled();
    });
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
    // `--force` is not just the busy-check bypass above - it also has to
    // reach the service lifecycle's pre-swap stop (service/install-
    // lifecycle.ts's `beforeSwap`), or a busy Desktop-managed host would
    // still deny the cooperative shutdown claim and abort anyway.
    expect(mocks.lifecycleCalls).toEqual([{ bootstrap: null, force: true }]);
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

  describe("expectedStagedVersion", () => {
    it("refuses a stage naming another version before the busy gate and the hook, consuming nothing", async () => {
      // Falsification: move the version check below the busy gate and
      // "busy-check" appears in the order; drop it and the outcome is
      // `applied` for a version the caller never confirmed.
      await writeInstall("1.0.0", {});
      await writeStaged("2.1.0", {});
      const onWillCommitStaged = vi.fn(async () => undefined);

      const result = await applyHost({
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        expectedStagedVersion: "2.0.0",
        onProgress: () => {},
        onWillCommitStaged,
      });

      expect(result).toEqual({
        outcome: "stage-version-mismatch",
        installedVersion: "1.0.0",
        expectedStagedVersion: "2.0.0",
        actualStagedVersion: "2.1.0",
      });
      expect(mocks.callOrder).toEqual([]);
      expect(onWillCommitStaged).not.toHaveBeenCalled();
      expect(existsSync(stagedDirFor(ENV))).toBe(true);
      expect((await readHostInstallRecord(ENV))?.version).toBe("1.0.0");
    });

    it("commits the stage that names the confirmed version", async () => {
      await writeInstall("1.0.0", {});
      await writeStaged("2.0.0", {});

      const result = await applyHost({
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        expectedStagedVersion: "2.0.0",
        onProgress: () => {},
      });

      expect(result.outcome).toBe("applied");
      expect((await readHostInstallRecord(ENV))?.version).toBe("2.0.0");
    });
  });

  describe("onWillDisruptHost", () => {
    it("reaches the lifecycle as its pre-stop boundary and, when the lifecycle does not stop, fires from the swap itself before the install directory changes", async () => {
      // The mocked lifecycle's `beforeSwap` never calls the hook (it models
      // "decided not to stop"), so the one call below is the swap's - and
      // it sees the OLD install record. Falsification: fire the boundary
      // from the `swap` progress line instead and it still fires once, but
      // the lifecycle-side assertion reddens (no hook handed over); fire it
      // after `atomicSwap` and the record read inside it is 2.0.0.
      await writeInstall("1.0.0", {});
      await writeStaged("2.0.0", {});
      const versionsAtBoundary: string[] = [];
      const onWillDisruptHost = (): void => {
        mocks.callOrder.push("disrupt");
        const record = JSON.parse(
          readFileSync(join(installDirFor(ENV), "install.json"), "utf8"),
        ) as { version: string };
        versionsAtBoundary.push(record.version);
      };

      const result = await applyHost({
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        onProgress: () => {},
        onWillDisruptHost,
      });

      expect(result.outcome).toBe("applied");
      expect(mocks.lifecycleStopHooks).toEqual([onWillDisruptHost]);
      expect(versionsAtBoundary).toEqual(["1.0.0"]);
      expect(mocks.callOrder).toEqual([
        "busy-check",
        "lifecycle-created",
        "disrupt",
      ]);
    });

    it("is NOT fired by the `service-stop` progress line: a lifecycle that fails before its actuator leaves the boundary unreported", async () => {
      // Falsification: derive the boundary from progress stages (the shape
      // `host update` used to have) and the hook fires here although the
      // host was never touched.
      await writeInstall("1.0.0", {});
      await writeStaged("2.0.0", {});
      mocks.lifecycleBeforeSwapShouldThrow = true;
      const onWillDisruptHost = vi.fn();
      const stages: string[] = [];

      await expect(
        applyHost({
          environment: ENV,
          force: false,
          noService: false,
          expectedStageFingerprint: null,
          onProgress: (info) => {
            stages.push(info.stage);
          },
          onWillDisruptHost,
        }),
      ).rejects.toThrow("simulated stop failure");

      expect(stages).toContain("service-stop");
      expect(onWillDisruptHost).not.toHaveBeenCalled();
      expect((await readHostInstallRecord(ENV))?.version).toBe("1.0.0");
    });
  });
});

// Ticket 03 acceptance: the barrier sequence pinned through `applyHost`
// above must also hold through the REAL contender wrapper,
// `host/update-mutation.ts`'s `applyHostWithAttempt` - not only the lower
// installer. A new describe block (rather than folding this into
// `describe("applyHost", ...)` above) keeps the four `onWillCommitStaged`
// position pins in that suite untouched: this block adds one extra mock
// (`../../host/update-contender`) that those pins never needed and must not
// be coupled to.
describe("applyHostWithAttempt (through the real host/update-mutation wrapper)", () => {
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
    mocks.callOrder = [];
    mocks.lifecycleStopHooks = [];
    mocks.verifyCapabilityCalls = 0;
    mocks.hostStartAdoptionPublisher = null;
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  // The capability itself carries no brand a plain object literal could
  // forge in production (`UpdateMutationCapability`'s doc comment says so
  // explicitly) - it is only usable here because the module-level mock
  // above replaces the one function that would otherwise check it.
  const fakeCapability: UpdateMutationCapability = { hostHomeDir: "unused" };
  const fakeContenderOptions: WithCliUpdateContenderOptions = {
    environment: ENV,
    reason: "test-apply-through-wrapper",
    waitMs: 0,
    pollIntervalMs: 0,
    admission: "legacy-update-shadow",
  };

  it("runs busy pre-check -> onWillCommitStaged -> stop -> beforeSwapCommit -> swap -> afterSwap -> start, with the wrapper's capability verifier invoked", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    const onWillCommitStaged = vi.fn(async (): Promise<void> => {
      mocks.callOrder.push("onWillCommitStaged");
    });
    const hooks: InstallPhaseHooks = {
      beforeSwapCommit: async () => {
        mocks.callOrder.push("beforeSwapCommit");
      },
      afterSwap: async () => {
        mocks.callOrder.push("afterSwap");
      },
    };

    const result = await applyHostWithAttempt(
      fakeCapability,
      fakeContenderOptions,
      {
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        expectedStagedVersion: null,
        onProgress: (info) => {
          if (
            info.stage === "service-stop" ||
            info.stage === "swap" ||
            info.stage === "service-start"
          ) {
            mocks.callOrder.push(`progress:${info.stage}`);
          }
        },
        onWillCommitStaged,
        onWillDisruptHost: null,
        hooks,
      },
    );

    expect(result.outcome).toBe("applied");
    expect(mocks.callOrder).toEqual([
      "busy-check",
      "onWillCommitStaged",
      "lifecycle-created",
      "progress:service-stop",
      "beforeSwapCommit",
      "progress:swap",
      // `commitInstallFromSource` emits the "service-start" progress event
      // BEFORE calling `lifecycle.afterSwap()` - the stub's `afterSwap`
      // (mirroring the real `createServiceInstallLifecycle`) is what
      // forwards `hooks.afterSwap()` at its own top.
      "progress:service-start",
      "afterSwap",
    ]);
    // Proof the REAL wrapper ran (not a call to `applyHost` that skipped
    // it): its capability verifier fires at least once, and the adoption
    // publisher it builds around the capability reached the lifecycle. Both
    // are things only `applyHostWithAttempt` supplies - `applyHost` called
    // directly leaves `publishHostStartAdoption` undefined, so `apply.ts`'s
    // optional-chained `setHostStartAdoptionPublisher?.(...)` never runs.
    expect(mocks.verifyCapabilityCalls).toBeGreaterThan(0);
    expect(mocks.hostStartAdoptionPublisher).not.toBeNull();
    // Falsification: call `applyHost` directly instead of
    // `applyHostWithAttempt` and `verifyCapabilityCalls` stays 0 and the
    // publisher stays null, while every other assertion above still passes.
  });

  it("denies the stop after onWillCommitStaged and never reaches beforeSwapCommit, even through the wrapper", async () => {
    await writeInstall("1.0.0", {});
    await writeStaged("2.0.0", {});
    mocks.lifecycleBeforeSwapShouldThrow = true;
    const onWillCommitStaged = vi.fn(async (): Promise<void> => {
      mocks.callOrder.push("onWillCommitStaged");
    });
    let beforeSwapCommitCalled = false;
    const hooks: InstallPhaseHooks = {
      beforeSwapCommit: async () => {
        beforeSwapCommitCalled = true;
      },
      afterSwap: async () => {},
    };

    await expect(
      applyHostWithAttempt(fakeCapability, fakeContenderOptions, {
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        expectedStagedVersion: null,
        onProgress: () => {},
        onWillCommitStaged,
        onWillDisruptHost: null,
        hooks,
      }),
    ).rejects.toThrow("simulated stop failure");

    expect(onWillCommitStaged).toHaveBeenCalledTimes(1);
    expect(beforeSwapCommitCalled).toBe(false);
    // Pre-commit failure - stage intact, install intact (recovery table),
    // same as the existing `lifecycleBeforeSwapShouldThrow` seam's pin
    // above, now proven through the real wrapper too.
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
    const stored = await readHostInstallRecord(ENV);
    expect(stored?.version).toBe("1.0.0");
    // Falsification: move `beforeSwapCommit`'s await ahead of the stop (or
    // swallow the stop's rejection) and `beforeSwapCommitCalled` flips to
    // `true`.
  });
});
