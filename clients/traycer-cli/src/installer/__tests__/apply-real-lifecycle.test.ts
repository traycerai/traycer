import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceController, ServiceLabel } from "../../service";

// Cold review A, finding R2. `apply.test.ts` replaces
// `service/install-lifecycle` with a stub that forwards the phase hooks
// itself, so the REAL forwarding could be deleted without a single failure,
// and its synchronous hook bodies could not tell an awaited barrier from a
// dropped promise. This suite closes both gaps: the lifecycle constructors
// are the real ones, only the controller / OS / contender boundaries are
// mocked, and every barrier is held open on a deferred promise so the
// actuator behind it must be proven not to have run.

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
  sandboxHome: "",
  controller: null as ServiceController | null,
  busyCheckCalls: 0,
  verifyCapabilityCalls: 0,
  // Every `(serviceLabel)` the wrapper's adoption publisher was invoked
  // with. Non-empty proves the publisher reached a real service start, not
  // merely that it was handed to the lifecycle (D-15's assertion, upgraded:
  // the real lifecycle actually calls it).
  adoptionPublishedFor: [] as string[],
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mocks.sandboxHome || actual.tmpdir(),
  };
});

vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  return {
    ...actual,
    createCliLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock("../../host/busy-check", () => ({
  assertHostNotBusy: async () => {
    mocks.busyCheckCalls += 1;
  },
}));

// The one function that would refuse a test-authored capability. Everything
// else in the contender module stays real - see `apply.test.ts` for the same
// narrow stub and why the capability itself cannot be forged.
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

// The far end of the wrapper's adoption chain: `update-mutation.ts` closes
// over this, `apply.ts` hands the closure to the lifecycle, and the real
// lifecycle invokes it immediately before asking the OS to start the host.
vi.mock("../../host/host-start-adoption", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/host-start-adoption")>();
  return {
    ...actual,
    publishHostStartAdoption: async (
      _capability: unknown,
      _contenderOptions: unknown,
      serviceLabel: string,
    ) => {
      mocks.adoptionPublishedFor.push(serviceLabel);
      return {
        waitForSpawn: async (): Promise<void> => undefined,
        cancel: async (): Promise<void> => undefined,
      };
    },
  };
});

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: (): ServiceController => {
      const controller = mocks.controller;
      if (controller === null) {
        throw new Error("no controller harness installed for this test");
      }
      return controller;
    },
    serviceLabelFor: (environment: Environment): ServiceLabel => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
  };
});

vi.mock("../../service/cli-binary", () => ({
  resolveServiceCliInvocation: async () => ({
    command: "/usr/local/bin/traycer",
    args: ["host", "start"],
  }),
}));

// Reads the invoking user's REAL LaunchAgent plist on darwin.
vi.mock("../../service/platforms/macos", () => ({
  readRegisteredCliInvocation: async () => null,
}));

// Shell out to schtasks / powershell / taskkill.
vi.mock("../../service/platforms/windows", () => ({
  killLingeringSlotProcesses: async () => undefined,
  describeSlotLockHolders: async () => [],
  epochMicrosNow: () => 0,
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

import { applyHostWithAttempt } from "../../host/update-mutation";
import type { WithCliUpdateContenderOptions } from "../../host/update-contender";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import {
  commitInstallFromSource,
  currentInstallArch,
  currentInstallPlatform,
  type InstallPhaseHooks,
} from "../install";
import { createBytesOnlyInstallLifecycle } from "../../service/install-lifecycle";
import {
  writeHostInstallRecord,
  type HostInstallRecord,
} from "../../manifest/host-install";
import {
  HOST_STAGED_RECORD_SCHEMA_VERSION,
  writeHostStagedRecordAt,
  type HostStagedRecord,
} from "../../manifest/host-staged";
import {
  expectReached,
  expectStillGated,
  makeBarrierGate,
  type BarrierGate,
} from "../../__tests__/support/barrier-gate";

const ENV: Environment = "production";
const INSTALLED_BYTES = "installed-bytes";
const STAGED_BYTES = "staged-bytes";

const fakeCapability: UpdateMutationCapability = { hostHomeDir: "unused" };
const fakeContenderOptions: WithCliUpdateContenderOptions = {
  environment: ENV,
  reason: "test-apply-real-lifecycle",
  waitMs: 0,
  pollIntervalMs: 0,
  admission: "legacy-update-shadow",
};

function installedExecutablePath(): string {
  return join(installDirFor(ENV), "traycer-host");
}

// What is at `install/traycer-host` right now: the swap is exactly the
// moment this flips from the installed bytes to the staged ones.
function installedBytes(): string {
  return existsSync(installedExecutablePath())
    ? readFileSync(installedExecutablePath(), "utf8")
    : "<absent>";
}

async function writeInstall(version: string): Promise<void> {
  const installDir = installDirFor(ENV);
  mkdirSync(installDir, { recursive: true });
  writeFileSync(installedExecutablePath(), INSTALLED_BYTES);
  const record: HostInstallRecord = {
    installId: "installed-id",
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
    executablePath: installedExecutablePath(),
    executableSha256: null,
  };
  await writeHostInstallRecord(ENV, record);
}

async function writeStaged(version: string): Promise<void> {
  const stagedDir = stagedDirFor(ENV);
  mkdirSync(stagedDir, { recursive: true });
  writeFileSync(join(stagedDir, "traycer-host"), STAGED_BYTES);
  const record: HostStagedRecord = {
    schemaVersion: HOST_STAGED_RECORD_SCHEMA_VERSION,
    stageId: "test-stage-id",
    version,
    runtimeVersion: null,
    archiveSha256: "b".repeat(64),
    sizeBytes: 1,
    source: { kind: "registry", value: version },
    signatureKeyId: "test-key",
    signatureVerifiedAt: new Date().toISOString(),
    executablePath: "traycer-host",
    platform: currentInstallPlatform(),
    arch: currentInstallArch(),
    executableSha256: null,
  };
  await writeHostStagedRecordAt(stagedDir, record);
}

interface ControllerHarness {
  readonly controller: ServiceController;
  readonly order: string[];
  // Released the moment the named actuator is entered, so a test can prove
  // it has NOT been entered while an earlier barrier is still open.
  readonly stopEntered: BarrierGate;
  readonly registerEntered: BarrierGate;
}

// A controller whose pre-swap stop is held open by `stopGate`, and whose
// post-swap registration records its own entry. Nothing here touches the OS.
function makeController(stopGate: Promise<void>): ControllerHarness {
  const order: string[] = [];
  const stopEntered = makeBarrierGate();
  const registerEntered = makeBarrierGate();
  const controller: ServiceController = {
    status: async () => ({
      state: "running",
      version: null,
      listenUrl: null,
      pid: null,
    }),
    install: async () => {
      order.push("controller.install");
      registerEntered.release();
    },
    uninstall: async () => undefined,
    stop: async () => {
      order.push("controller.stop");
      stopEntered.release();
      await stopGate;
    },
    start: async () => {
      order.push("controller.start");
      registerEntered.release();
    },
    restart: async () => undefined,
    stopForRestart: async () => ({ forcedRecycle: false }),
    relaunchAfterRestart: async () => {
      order.push("controller.relaunchAfterRestart");
      registerEntered.release();
    },
    hostStartAdoptionLabel: async (serviceLabel) => serviceLabel.id,
    retireCompetingRegistration: async () => ({ kind: "nothing-to-retire" }),
    takeoverDesktopRegistration: async () => ({ kind: "not-applicable" }),
  };
  return { controller, order, stopEntered, registerEntered };
}

describe("applyHostWithAttempt through the REAL service install lifecycle", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-apply-real-lifecycle-"));
    mocks.sandboxHome = sandboxRoot;
    mocks.controller = null;
    mocks.busyCheckCalls = 0;
    mocks.verifyCapabilityCalls = 0;
    mocks.adoptionPublishedFor = [];
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("holds the swap behind the real stop AND the real beforeSwapCommit forwarding, and the relaunch behind afterSwap", async () => {
    await writeInstall("1.0.0");
    await writeStaged("2.0.0");
    const stopGate = makeBarrierGate();
    const harness = makeController(stopGate.promise);
    mocks.controller = harness.controller;

    const swapProgressSeen = makeBarrierGate();
    const commitHookEntered = makeBarrierGate();
    const commitHookGate = makeBarrierGate();
    const afterSwapEntered = makeBarrierGate();
    const afterSwapGate = makeBarrierGate();
    const hooks: InstallPhaseHooks = {
      beforeSwapCommit: async () => {
        harness.order.push("hooks.beforeSwapCommit");
        commitHookEntered.release();
        await commitHookGate.promise;
      },
      afterSwap: async () => {
        harness.order.push("hooks.afterSwap");
        afterSwapEntered.release();
        await afterSwapGate.promise;
      },
    };

    const applyPromise = applyHostWithAttempt(
      fakeCapability,
      fakeContenderOptions,
      {
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        onProgress: (info) => {
          if (info.stage === "swap") swapProgressSeen.release();
        },
        hooks,
      },
    );

    // 1. The stop is running. Neither the commit barrier nor the swap may
    //    have happened: `beforeSwapCommit` sits on the far side of a
    //    RESOLVED stop, which is the whole reason a busy denial cannot
    //    announce work.
    await expectReached(harness.stopEntered.promise, "the pre-swap stop");
    await expectStillGated(commitHookEntered.promise, "beforeSwapCommit ran");
    expect(installedBytes()).toBe(INSTALLED_BYTES);

    // 2. The stop resolves; the commit barrier opens and holds the swap.
    stopGate.release();
    await expectReached(commitHookEntered.promise, "beforeSwapCommit");
    await expectStillGated(swapProgressSeen.promise, "the swap started");
    expect(installedBytes()).toBe(INSTALLED_BYTES);

    // 3. The swap runs, and the post-swap barrier holds the relaunch. The
    //    bytes have moved by the time `afterSwap` is entered - that is what
    //    makes "restarting" truthful when a caller writes it from here.
    commitHookGate.release();
    await expectReached(afterSwapEntered.promise, "the post-swap hook");
    expect(installedBytes()).toBe(STAGED_BYTES);
    await expectStillGated(
      harness.registerEntered.promise,
      "the service was asked to come back up",
    );

    // 4. Everything completes once the last barrier opens.
    afterSwapGate.release();
    const outcome = await applyPromise;

    expect(outcome.outcome).toBe("applied");
    expect(harness.order).toEqual([
      "controller.stop",
      "hooks.beforeSwapCommit",
      "hooks.afterSwap",
      "controller.install",
    ]);
    expect(mocks.busyCheckCalls).toBe(1);
    // The wrapper's own two contributions, through the real lifecycle: the
    // capability verifier, and the adoption publisher, which the lifecycle
    // invokes for real immediately before the registration start (D-15).
    expect(mocks.verifyCapabilityCalls).toBeGreaterThan(0);
    expect(mocks.adoptionPublishedFor).toEqual(["ai.traycer.host"]);
    // Falsification: replace the real `beforeSwapCommit` forwarding in
    // `service/install-lifecycle.ts` with `async () => {}` and step 3's
    // `installedBytes()` check reddens (nothing was holding the swap, so it
    // already ran) along with the order assertion. Drop the `await` before
    // `opts.lifecycle.beforeSwapCommit()` in `commitInstallFromSource`, or
    // before `options.hooks.afterSwap()` in the lifecycle, and step 2 or
    // step 3's `expectStillGated` reddens.
  });

  it("never reaches beforeSwapCommit when the real stop denies, and swaps nothing", async () => {
    await writeInstall("1.0.0");
    await writeStaged("2.0.0");
    const harness = makeController(Promise.resolve());
    // A busy host's cooperative refusal, raised where the real controller
    // raises it.
    const denyingController: ServiceController = {
      ...harness.controller,
      stop: async () => {
        harness.order.push("controller.stop");
        throw Object.assign(new Error("host is busy"), {
          code: "E_HOST_BUSY",
        });
      },
    };
    mocks.controller = denyingController;
    let beforeSwapCommitCalled = false;

    await expect(
      applyHostWithAttempt(fakeCapability, fakeContenderOptions, {
        environment: ENV,
        force: false,
        noService: false,
        expectedStageFingerprint: null,
        onProgress: () => {},
        hooks: {
          beforeSwapCommit: async () => {
            beforeSwapCommitCalled = true;
          },
          afterSwap: async () => {},
        },
      }),
    ).rejects.toThrow("host is busy");

    expect(harness.order).toEqual(["controller.stop"]);
    expect(beforeSwapCommitCalled).toBe(false);
    expect(installedBytes()).toBe(INSTALLED_BYTES);
    expect(existsSync(stagedDirFor(ENV))).toBe(true);
    // Falsification: forward `beforeSwapCommit` from the lifecycle's
    // `beforeSwap` instead of its own member, or move its await ahead of
    // the stop in `commitInstallFromSource`, and this flips to `true`.
  });
});

describe("createBytesOnlyInstallLifecycle forwarding, through the real commit", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-apply-real-lifecycle-"));
    mocks.sandboxHome = sandboxRoot;
    mocks.controller = null;
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("holds the swap behind its forwarded beforeSwapCommit and returns only after afterSwap resolves", async () => {
    // The bytes-only lifecycle starts nothing of its own, so its `afterSwap`
    // IS the caller's barrier - which is exactly why its forwarding needs
    // pinning separately: a dropped await here has no service actuator
    // downstream to notice.
    const sourceDir = join(sandboxRoot, "pre-staged");
    mkdirSync(sourceDir, { recursive: true });
    const executablePath = join(sourceDir, "traycer-host");
    writeFileSync(executablePath, STAGED_BYTES);
    await writeInstall("1.0.0");

    const harness = makeController(Promise.resolve());
    const order: string[] = [];
    const swapProgressSeen = makeBarrierGate();
    const commitHookEntered = makeBarrierGate();
    const commitHookGate = makeBarrierGate();
    const afterSwapEntered = makeBarrierGate();
    const afterSwapGate = makeBarrierGate();

    const lifecycle = createBytesOnlyInstallLifecycle(
      harness.controller,
      {
        id: "ai.traycer.host",
        displayName: "Traycer Host",
        environment: ENV,
        devSlot: null,
      },
      {
        beforeSwapCommit: async () => {
          order.push("hooks.beforeSwapCommit");
          commitHookEntered.release();
          await commitHookGate.promise;
        },
        afterSwap: async () => {
          order.push("hooks.afterSwap");
          afterSwapEntered.release();
          await afterSwapGate.promise;
        },
      },
    );

    const commitPromise = commitInstallFromSource({
      environment: ENV,
      sourceDir,
      executablePath,
      version: "2.0.0",
      runtimeVersion: null,
      source: { kind: "local-file", value: sourceDir },
      archiveSha256: null,
      signatureVerifiedAt: new Date().toISOString(),
      signatureKeyId: "local-file:unsigned",
      sizeBytes: 0,
      onProgress: (info) => {
        if (info.stage === "swap") swapProgressSeen.release();
      },
      lifecycle,
      onCommitted: () => {},
      verifyMutationCapability: async () => undefined,
    });

    await expectReached(commitHookEntered.promise, "beforeSwapCommit");
    await expectStillGated(swapProgressSeen.promise, "the swap started");
    expect(installedBytes()).toBe(INSTALLED_BYTES);

    commitHookGate.release();
    await expectReached(afterSwapEntered.promise, "the post-swap hook");
    expect(installedBytes()).toBe(STAGED_BYTES);
    // The commit itself must not resolve while the post-swap barrier is
    // open - the caller's write has to land before its caller moves on.
    const commitSettled = makeBarrierGate();
    void commitPromise.then(() => commitSettled.release());
    await expectStillGated(commitSettled.promise, "the commit resolved");

    afterSwapGate.release();
    const { record } = await commitPromise;

    expect(record.version).toBe("2.0.0");
    expect(order).toEqual(["hooks.beforeSwapCommit", "hooks.afterSwap"]);
    // This lifecycle asks for no start of its own on POSIX.
    expect(harness.order).toEqual([]);
    // Falsification: replace either forwarding in
    // `createBytesOnlyInstallLifecycle` with an async no-op, or drop an
    // await around it, and one of the three gates above reddens.
  });
});
