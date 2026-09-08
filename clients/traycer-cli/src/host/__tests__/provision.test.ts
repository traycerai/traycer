import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";

// Finding 1 (ticket-2 review round 1): a lock-free fast read can predict
// "no install needed" (register/start only) and skip staging; if the
// locked re-read then discovers install IS needed (a genuinely concurrent
// provisioning actor changed state in the window), the ONLY correct move
// is to release the lock, stage OUTSIDE it, and reacquire - staging is a
// network transfer, and the plan's no-transfer-in-a-critical-section rule
// is absolute. This suite pins that lock-scope invariant directly: the
// stage fake asserts it is never called while `withCliLock`'s callback is
// executing.

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  stageHostInstallSourceMock: vi.fn(),
  commitHostInstallSourceMock: vi.fn(),
  discardStagedHostInstallSourceMock: vi.fn(),
  readHostInstallRecordMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  createServiceInstallLifecycleMock: vi.fn(),
  assertHostNotBusyMock: vi.fn(),
  isVersionYankedMock: vi.fn(),
  resolveServiceCliInvocationMock: vi.fn(),
  lockHeld: false,
  lockAcquisitions: 0,
  gateStoreFormatFloorMock: vi.fn(),
}));

vi.mock("../../installer", () => ({
  // The two swap barriers this command observes: none. Inlined rather than
  // re-exported from the real module so this factory keeps the installer out
  // of the module graph entirely, which is what it exists for.
  NO_INSTALL_PHASE_HOOKS: {
    beforeSwapCommit: async () => {},
    afterSwap: async () => {},
  },
  stageHostInstallSource: async (
    ...callArgs: Parameters<typeof mocks.stageHostInstallSourceMock>
  ) => {
    // The invariant Finding 1 fixes: staging must never run while cli-lock
    // is held.
    expect(mocks.lockHeld).toBe(false);
    mocks.callOrder.push("stage");
    return mocks.stageHostInstallSourceMock(...callArgs);
  },
  commitHostInstallSource: async (
    ...callArgs: Parameters<typeof mocks.commitHostInstallSourceMock>
  ) => {
    mocks.callOrder.push("commit");
    return mocks.commitHostInstallSourceMock(...callArgs);
  },
  discardStagedHostInstallSource: async (
    ...callArgs: Parameters<typeof mocks.discardStagedHostInstallSourceMock>
  ) => {
    mocks.callOrder.push("discard");
    return mocks.discardStagedHostInstallSourceMock(...callArgs);
  },
}));

// `commitHostInstallSourceWithAttempt` (update-mutation.ts) imports
// `commitHostInstallSource` straight from `../../installer/install`, not
// the barrel above - that direct import bypasses the barrel mock, so the
// REAL committer (and the real attempt-lock machinery it drives) would
// otherwise run against this process's actual host home. Mirror the same
// fake here.
vi.mock("../../installer/install", () => ({
  commitHostInstallSource: async (
    ...callArgs: Parameters<typeof mocks.commitHostInstallSourceMock>
  ) => {
    mocks.callOrder.push("commit");
    return mocks.commitHostInstallSourceMock(...callArgs);
  },
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

// `gateStoreFormatFloor` (unmocked) resolves `hostHomeDir` from
// `os.homedir()` at module load and walks it for real - against the
// operator's actual `~/.traycer/host`, which has real chat stores on it on
// any machine that has run the CLI. This suite pins lock-scope and branch
// selection, not the floor's own semantics (that is
// `store-format-floor.test.ts`, against an explicit temp `hostHome`), so the
// gate is mocked here; `ungatedStoreFormatFloorEvidence` is kept real (a pure
// function, nothing to fake).
vi.mock("../store-format-floor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store-format-floor")>();
  return {
    ...actual,
    gateStoreFormatFloor: (
      ...callArgs: Parameters<typeof mocks.gateStoreFormatFloorMock>
    ) => mocks.gateStoreFormatFloorMock(...callArgs),
  };
});

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

// Reviewer C, measuring the Q7 patch: this factory used to be a bare `vi.fn()`
// with no return value, because no row in this suite had ever reached the
// service-register branch - every shape here either no-ops or installs. The
// `registerService: true` row below is the first, and an unresolved invocation
// throws inside `runServiceRegister` for reasons unrelated to what it pins.
vi.mock("../../service/cli-binary", () => ({
  resolveServiceCliInvocation: mocks.resolveServiceCliInvocationMock,
}));

vi.mock("../../service/install-lifecycle", () => ({
  createServiceInstallLifecycle: mocks.createServiceInstallLifecycleMock,
}));

vi.mock("../../store/cli-lock", () => ({
  withCliLock: async <T>(_opts: unknown, fn: () => Promise<T>): Promise<T> => {
    mocks.lockAcquisitions += 1;
    mocks.callOrder.push("lock-enter");
    mocks.lockHeld = true;
    try {
      return await fn();
    } finally {
      mocks.lockHeld = false;
      mocks.callOrder.push("lock-exit");
    }
  },
}));

vi.mock("../busy-check", () => ({
  assertHostNotBusy: mocks.assertHostNotBusyMock,
}));

// The real `publishHostStartAdoption` waits (up to 30s) for a service-
// manager child to ack a spawn that never happens under a stubbed
// controller. This suite pins `provisionHost`'s orchestration, not the
// adoption handshake (that's `host-start-adoption.test.ts`), so replace it
// with an immediately-satisfied lease.
vi.mock("../host-start-adoption", () => ({
  publishHostStartAdoption: async () => ({
    waitForSpawn: async () => undefined,
    cancel: async () => undefined,
  }),
}));

// Finding D: `provisionHost` constructs a registry yank-lookup up front. The
// Finding-1 suite uses exact satisfaction (which never consults the manifest);
// the Finding-D suite drives this stub directly to exercise the
// implicit-registry-minimum branch.
vi.mock("../../registry/client", () => ({
  createRegistryYankLookup: () => ({
    isVersionYanked: mocks.isVersionYankedMock,
  }),
}));

const {
  stageHostInstallSourceMock,
  commitHostInstallSourceMock,
  discardStagedHostInstallSourceMock,
  readHostInstallRecordMock,
  createServiceControllerMock,
  serviceLabelForMock,
  createServiceInstallLifecycleMock,
  assertHostNotBusyMock,
  isVersionYankedMock,
  resolveServiceCliInvocationMock,
} = mocks;

import { provisionHost, type ProvisionHostOptions } from "../provision";
import type { HostInstallRecord } from "../../manifest/host-install";
import type { StagedHostInstallSource } from "../../installer";
import type { ServiceInstallLifecycleHandle } from "../../service/install-lifecycle";

function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
}

function makeOpts(
  overrides: Partial<ProvisionHostOptions>,
): ProvisionHostOptions {
  return {
    runtime: makeRuntime(),
    resolveInstallSource: async () => ({
      kind: "registry",
      versionRequest: "2.0.0",
    }),
    satisfaction: { kind: "exact", version: "2.0.0" },
    recordVersionOverride: null,
    enableLinger: true,
    allowSelfInvocation: true,
    registerService: true,
    lockReason: "test-provision",
    onProgress: null,
    force: false,
    acceptStoreFormatLoss: false,
    adoption: undefined,
    beforeMutate: null,
    ...overrides,
  };
}

function sampleRecord(version: string): HostInstallRecord {
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
    executablePath: "/tmp/traycer-host",
    executableSha256: null,
  };
}

function sampleStaged(version: string): StagedHostInstallSource {
  return {
    stagingDir: "/tmp/staging-dir",
    archivePath: "/tmp/staging-dir/archive.tar.gz",
    archiveIsTemporary: true,
    executablePath: "/tmp/staging-dir/traycer-host",
    version,
    runtimeVersion: null,
    source: { kind: "registry", value: version },
    archiveSha256: "b".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
  };
}

function sampleLifecycleHandle(): ServiceInstallLifecycleHandle {
  return {
    state: {
      priorState: "not-installed",
      stoppedBeforeSwap: false,
      postSwapAction: "install",
      postSwapError: null,
    },
    lifecycle: {
      beforeSwap: async () => {},
      beforeSwapCommit: async () => {},
      afterSwap: async () => {},
      swapLockRecovery: null,
    },
  };
}

// Runs before every nested describe's own `beforeEach` (outer-first), so
// every test gets a clearing default without each describe having to repeat
// it. `vi.clearAllMocks()` (this file's convention, not `resetAllMocks`)
// clears call history but keeps a configured implementation, so this default
// survives between tests; individual tests still override it per-test to
// exercise a refusal or to assert the exact operands passed.
beforeEach(() => {
  mocks.gateStoreFormatFloorMock.mockResolvedValue({
    clearedVersion: null,
    publishedStoreFormats: null,
    acceptStoreFormatLoss: false,
    site: "host ensure",
  });
});

describe("provisionHost - Finding 1: lost fast-path prediction never stages inside cli-lock", () => {
  beforeEach(() => {
    mocks.callOrder = [];
    mocks.lockHeld = false;
    mocks.lockAcquisitions = 0;
    serviceLabelForMock.mockReturnValue({
      id: "ai.traycer.host",
      environment: "production",
    });
    assertHostNotBusyMock.mockResolvedValue(undefined);
    discardStagedHostInstallSourceMock.mockResolvedValue(undefined);
    createServiceInstallLifecycleMock.mockReturnValue(sampleLifecycleHandle());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("releases and reacquires the lock instead of staging while it is held", async () => {
    // Fast (unlocked) read: installed + at target version, but not yet
    // registered/running - predicts the register/start path, so staging is
    // skipped up front (`predictedInstall === false`).
    const controllerStatusCalls: number[] = [];
    let statusCallCount = 0;
    createServiceControllerMock.mockReturnValue({
      status: async () => {
        statusCallCount += 1;
        controllerStatusCalls.push(statusCallCount);
        return {
          state: "not-installed",
          version: null,
          listenUrl: null,
          pid: null,
        };
      },
      install: vi.fn(),
      start: vi.fn(),
      hostStartAdoptionLabel: vi.fn(async (label: { id: string }) => label.id),
    });

    let installRecordCall = 0;
    readHostInstallRecordMock.mockImplementation(async () => {
      installRecordCall += 1;
      // Call 1: the fast, unlocked read - reports installed at target.
      if (installRecordCall === 1) return sampleRecord("2.0.0");
      // Call 2: the FIRST locked re-read - a concurrent uninstall landed in
      // the race window, so the install branch is now required and
      // `preStaged` is null -> must signal "need-stage", not download here.
      if (installRecordCall === 2) return null;
      // Call 3: the SECOND locked re-read (after staging outside the first
      // lock) - still not installed, so the (now-staged) install branch
      // commits.
      return null;
    });

    stageHostInstallSourceMock.mockResolvedValue(sampleStaged("2.0.0"));
    commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const result = await provisionHost(makeOpts({}));

    expect(result.action).toBe("installed");
    // Exactly one stage call (the retry's), and it ran strictly between the
    // two lock spans - never inside either.
    expect(stageHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(mocks.lockAcquisitions).toBe(2);
    expect(mocks.callOrder).toEqual([
      "lock-enter",
      "lock-exit",
      "stage",
      "lock-enter",
      "commit",
      "lock-exit",
    ]);
    // Nothing was ever staged-then-abandoned.
    expect(discardStagedHostInstallSourceMock).not.toHaveBeenCalled();
  });

  it("stages once, upfront, when the fast read already predicts install (the common case)", async () => {
    createServiceControllerMock.mockReturnValue({
      status: async () => ({
        state: "not-installed",
        version: null,
        listenUrl: null,
        pid: null,
      }),
      install: vi.fn(),
      start: vi.fn(),
      hostStartAdoptionLabel: vi.fn(async (label: { id: string }) => label.id),
    });
    // Fast read: not installed at all - predicts the install branch, so
    // staging happens up front, outside any lock.
    readHostInstallRecordMock.mockResolvedValue(null);
    stageHostInstallSourceMock.mockResolvedValue(sampleStaged("2.0.0"));
    commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const result = await provisionHost(makeOpts({}));

    expect(result.action).toBe("installed");
    expect(stageHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(mocks.lockAcquisitions).toBe(1);
    expect(mocks.callOrder).toEqual([
      "stage",
      "lock-enter",
      "commit",
      "lock-exit",
    ]);
  });
});

describe("provisionHost - Finding D: implicit-registry-minimum satisfaction", () => {
  beforeEach(() => {
    mocks.callOrder = [];
    mocks.lockHeld = false;
    mocks.lockAcquisitions = 0;
    serviceLabelForMock.mockReturnValue({
      id: "ai.traycer.host",
      environment: "production",
    });
    assertHostNotBusyMock.mockResolvedValue(undefined);
    discardStagedHostInstallSourceMock.mockResolvedValue(undefined);
    createServiceInstallLifecycleMock.mockReturnValue(sampleLifecycleHandle());
    stageHostInstallSourceMock.mockResolvedValue(sampleStaged("1.7.2"));
    commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("1.7.2"),
      previous: null,
      installGeneration: "id:install-1.7.2",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function runningController() {
    return {
      status: async () => ({
        state: "running" as const,
        version: "host",
        listenUrl: "ws://127.0.0.1:7100/rpc",
        pid: 4242,
      }),
      install: vi.fn(),
      start: vi.fn(),
      hostStartAdoptionLabel: vi.fn(async (label: { id: string }) => label.id),
    };
  }

  it("treats a newer non-yanked install as satisfied and never downgrades it", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.8.0"));
    isVersionYankedMock.mockResolvedValue(false);

    const result = await provisionHost(
      makeOpts({
        satisfaction: { kind: "implicit-registry-minimum", version: "1.7.2" },
      }),
    );

    expect(result.action).toBe("noop");
    expect(isVersionYankedMock).toHaveBeenCalledWith("1.8.0");
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
  });

  it("reinstalls a newer install the registry marks yanked", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.8.0"));
    isVersionYankedMock.mockResolvedValue(true);

    const result = await provisionHost(
      makeOpts({
        satisfaction: { kind: "implicit-registry-minimum", version: "1.7.2" },
      }),
    );

    expect(result.action).toBe("installed");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
  });

  it("keeps another build of the requested release only when the registry has not yanked it - the string is the artifact, the comparator only ranks it", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0+bar"));
    isVersionYankedMock.mockResolvedValue(false);

    const kept = await provisionHost(
      makeOpts({
        satisfaction: {
          kind: "implicit-registry-minimum",
          version: "2.0.0+foo",
        },
      }),
    );
    expect(kept.action).toBe("noop");
    expect(isVersionYankedMock).toHaveBeenCalledWith("2.0.0+bar");

    isVersionYankedMock.mockReset();
    isVersionYankedMock.mockResolvedValue(true);
    const replaced = await provisionHost(
      makeOpts({
        satisfaction: {
          kind: "implicit-registry-minimum",
          version: "2.0.0+foo",
        },
      }),
    );
    expect(replaced.action).toBe("installed");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
  });

  it("treats the exact requested string as satisfied without a yank lookup (control for the other-build row)", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0+bar"));

    const result = await provisionHost(
      makeOpts({
        satisfaction: {
          kind: "implicit-registry-minimum",
          version: "2.0.0+bar",
        },
      }),
    );

    expect(result.action).toBe("noop");
    expect(isVersionYankedMock).not.toHaveBeenCalled();
  });

  it("reinstalls an older install and never consults the yank list for it", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.6.0"));

    const result = await provisionHost(
      makeOpts({
        satisfaction: { kind: "implicit-registry-minimum", version: "1.7.2" },
      }),
    );

    expect(result.action).toBe("installed");
    // The `less` ordering short-circuits before the advisory yank lookup.
    expect(isVersionYankedMock).not.toHaveBeenCalled();
  });
});

// Q7: the OWN-BUILD policy - the packaged archive, and the `--from` the
// Windows desktop passes for that same archive. It was `exact`, and equality
// reverted a user whose host had been updated out of band past the app's
// bundle: the desktop asks for a convergence whenever the local host is down
// or has not been dialed, so the revert repeated after every outage and every
// launch with a remote serving, and the update put it back. `own-build-minimum`
// moves exactly one direction of that predicate - a comparably NEWER install is
// kept - and every other direction still converges, which is what the rows
// below hold in place. The install record is asserted UNCHANGED on the kept
// row: "no install branch" and "the newer host's record survives intact" are
// different claims, and it is the second one the user cares about.
describe("provisionHost - Q7: own-build-minimum satisfaction", () => {
  beforeEach(() => {
    mocks.callOrder = [];
    mocks.lockHeld = false;
    mocks.lockAcquisitions = 0;
    serviceLabelForMock.mockReturnValue({
      id: "ai.traycer.host",
      environment: "production",
    });
    assertHostNotBusyMock.mockResolvedValue(undefined);
    discardStagedHostInstallSourceMock.mockResolvedValue(undefined);
    createServiceInstallLifecycleMock.mockReturnValue(sampleLifecycleHandle());
    resolveServiceCliInvocationMock.mockResolvedValue({
      command: "/usr/local/bin/traycer",
      args: [],
    });
    stageHostInstallSourceMock.mockResolvedValue(sampleStaged("1.7.2"));
    commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("1.7.2"),
      previous: null,
      installGeneration: "id:install-1.7.2",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function runningController() {
    return {
      status: async () => ({
        state: "running" as const,
        version: "host",
        listenUrl: "ws://127.0.0.1:7100/rpc",
        pid: 4242,
      }),
      install: vi.fn(),
      start: vi.fn(),
      hostStartAdoptionLabel: vi.fn(async (label: { id: string }) => label.id),
    };
  }

  // The shape the desktop's own convergence actually meets: bytes on disk, no
  // OS service registration, nothing listening. Every other row in this suite
  // runs against `runningController()`.
  function downController() {
    return {
      ...runningController(),
      status: async () => ({
        state: "not-installed" as const,
        version: null,
        listenUrl: null,
        pid: null,
      }),
    };
  }

  function ownBuild(version: string): ProvisionHostOptions["satisfaction"] {
    return { kind: "own-build-minimum", version };
  }

  it("keeps a comparably NEWER install and leaves its record untouched (the anti-downgrade row)", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    const installed = sampleRecord("1.8.0");
    readHostInstallRecordMock.mockResolvedValue(installed);
    isVersionYankedMock.mockResolvedValue(false);

    const result = await provisionHost(
      makeOpts({
        satisfaction: ownBuild("1.7.2"),
        // What the desktop passes: the bundled build stamps itself as the
        // recorded version, which is exactly the value that used to overwrite
        // the newer host's record.
        recordVersionOverride: "1.7.2",
      }),
    );

    expect(result.action).toBe("noop");
    expect(isVersionYankedMock).toHaveBeenCalledWith("1.8.0");
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    // The record the user's own update wrote is still the one on disk -
    // version AND install id, since a restamp would also mint a new identity.
    expect(result.version).toBe("1.8.0");
    expect(installed.version).toBe("1.8.0");
    expect(installed.installId).toBe("install-1.8.0");
  });

  it("keeps the exact stamp without consulting the yank list", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.7.2"));

    const result = await provisionHost(
      makeOpts({ satisfaction: ownBuild("1.7.2") }),
    );

    expect(result.action).toBe("noop");
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    // Equality answers before the comparator, so an unchanged build costs no
    // manifest lookup - and this is the control that keeps the row below
    // (another build of the same release) honest.
    expect(isVersionYankedMock).not.toHaveBeenCalled();
  });

  it("reinstalls an OLDER install", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.6.0"));

    const result = await provisionHost(
      makeOpts({ satisfaction: ownBuild("1.7.2") }),
    );

    expect(result.action).toBe("installed");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(isVersionYankedMock).not.toHaveBeenCalled();
  });

  it("reinstalls an UNORDERABLE install - a staging or dev stamp converges exactly as it did under `exact`", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(
      sampleRecord("staging.1788716277681.312db41da0"),
    );

    const result = await provisionHost(
      makeOpts({
        satisfaction: ownBuild("staging.1788780730120.1d4be2fe71"),
      }),
    );

    // Neither stamp can be ranked, so nothing can be shown to be newer and
    // the build's own archive wins - the behaviour every dev and staging slot
    // has today. Also why a staging slot cannot MEASURE this change.
    expect(result.action).toBe("installed");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
    expect(isVersionYankedMock).not.toHaveBeenCalled();
  });

  it("reinstalls another build of the same release - the comparator ranks it equal, the string says it is a different artifact", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0+bar"));

    const result = await provisionHost(
      makeOpts({ satisfaction: ownBuild("2.0.0+foo") }),
    );

    // The registry arm KEEPS this one (yank-checked); an own build must not,
    // or `ensure`'s "a rebuilt host is reinstalled" promise dies quietly.
    expect(result.action).toBe("installed");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
  });

  it("reinstalls a newer install the registry has YANKED", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.8.0"));
    isVersionYankedMock.mockResolvedValue(true);

    const result = await provisionHost(
      makeOpts({ satisfaction: ownBuild("1.7.2") }),
    );

    expect(result.action).toBe("installed");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
  });

  it("announces the replacement of a DIFFERENT version at INFO, before the swap, and stays quiet otherwise", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.6.0"));
    const info = vi.fn();

    await provisionHost(
      makeOpts({
        satisfaction: ownBuild("1.7.2"),
        runtime: { ...makeRuntime(), logger: { ...noopLogger, info } },
      }),
    );

    // Both versions and the source kind; no install id, no generation, no
    // path. This is the line whose absence made Q7 an afternoon of log
    // archaeology - the completion line reports the outcome, by which point
    // the previous bytes are gone.
    expect(info).toHaveBeenCalledWith(
      "Host provisioning replacing a different installed version",
      {
        environment: "production",
        installedVersion: "1.6.0",
        targetVersion: "1.7.2",
        sourceKind: "registry",
      },
    );

    // A FIRST install replaces nothing and must not claim to.
    info.mockClear();
    readHostInstallRecordMock.mockResolvedValue(null);
    await provisionHost(
      makeOpts({
        satisfaction: ownBuild("1.7.2"),
        runtime: { ...makeRuntime(), logger: { ...noopLogger, info } },
      }),
    );
    expect(info).not.toHaveBeenCalledWith(
      "Host provisioning replacing a different installed version",
      expect.anything(),
    );

    // Neither does a forced reinstall of the SAME version.
    info.mockClear();
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.7.2"));
    await provisionHost(
      makeOpts({
        satisfaction: ownBuild("1.7.2"),
        force: true,
        runtime: { ...makeRuntime(), logger: { ...noopLogger, info } },
      }),
    );
    expect(info).not.toHaveBeenCalledWith(
      "Host provisioning replacing a different installed version",
      expect.anything(),
    );
  });

  // Reviewer C, P2a: the row above freezes `sourceKind` to `"registry"`,
  // because that is what the shared staged fixture carries - so the pins could
  // not tell a bundled replacement from a registry one, and `local-file` is
  // the source kind that motivated Q7 in the first place. The field exists to
  // answer "was it the app's own build that replaced my host?", and until this
  // row it never had to.
  it("names `local-file` as the source kind when it is the OWN BUILD doing the replacing", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.8.0"));
    isVersionYankedMock.mockResolvedValue(false);
    stageHostInstallSourceMock.mockResolvedValue({
      ...sampleStaged("1.7.2"),
      source: { kind: "local-file", value: "/bundle/host.tar.gz" },
    });
    const info = vi.fn();

    await provisionHost(
      makeOpts({
        // `--force`, because a newer install is exactly what this policy now
        // declines to replace on its own - forcing is the only way an own
        // build reaches the swap over one, and it is the case an operator
        // most needs named in the log.
        satisfaction: ownBuild("1.7.2"),
        recordVersionOverride: "1.7.2",
        force: true,
        runtime: { ...makeRuntime(), logger: { ...noopLogger, info } },
      }),
    );

    expect(info).toHaveBeenCalledWith(
      "Host provisioning replacing a different installed version",
      {
        environment: "production",
        installedVersion: "1.8.0",
        targetVersion: "1.7.2",
        sourceKind: "local-file",
      },
    );
  });

  // Reviewer C, P2b: every other row here runs against a RUNNING host, and the
  // state the desktop actually leans on is the opposite one - its ensure is
  // bytes-only (`registerService: false`), so the host is routinely down when
  // the convergence runs, and starting it is the desktop's own job afterwards.
  // If the newer install were only kept while the host happened to be up, Q7
  // would be unfixed for exactly the case it was reported from.
  //
  // READ THIS BEFORE EDITING EITHER NO-OP GUARD: the shape below is held by
  // TWO independent ones - `isSatisfied`'s host-owned arm and the locked
  // path's `installed && versionSatisfied && !registerService` - and a
  // single-conjunct mutation of either leaves this row GREEN, because the
  // other still returns `noop`. Do not read a green suite as proof that the
  // guard you just changed is covered; it is covered only against the version
  // predicate both of them route through. See the body for the mutation that
  // does negate this row.
  it("keeps a newer install when the host is NOT running and registration is host-owned", async () => {
    createServiceControllerMock.mockReturnValue(downController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.8.0"));
    isVersionYankedMock.mockResolvedValue(false);

    const result = await provisionHost(
      makeOpts({
        satisfaction: ownBuild("1.7.2"),
        recordVersionOverride: "1.7.2",
        registerService: false,
      }),
    );

    // Two independent guards hold this, and a single-conjunct mutation of
    // either one leaves the row green: `isSatisfied` asks only for `installed`
    // once registration is host-owned, and the locked path's second no-op
    // guard (`installed && versionSatisfied && !registerService`) does not
    // consult the service state at all. What both of them route through is
    // the VERSION predicate, which is why the mutation that reddens this row
    // is a `state.running` conjunct added to `own-build-minimum` - the exact
    // regression the row exists to forbid.
    expect(result.action).toBe("noop");
    expect(result.running).toBe(false);
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
    // The version handed back is the host the user actually has, not the
    // bundle that declined to replace it - what the desktop reads after a
    // kept convergence.
    expect(result.version).toBe("1.8.0");
  });

  // Reviewer C, measured: the Windows path (`convergeReadyCliOwned`) sends no
  // `--no-service-register`, so the row above's second no-op guard - the one
  // gated on `!registerService` - does not exist there. A newer, unregistered
  // host fails `isSatisfied` outright and falls through to the branch chain,
  // and the ONLY thing standing between it and a downgrade swap is the third
  // conjunct of the install gate (`!reinstallVersionSatisfied`). Q7 protects
  // Windows through a single predicate, so it is pinned here rather than left
  // to the Mac row's coincidence.
  it("registers instead of replacing when a newer install is unregistered and the CLI owns the service", async () => {
    createServiceControllerMock.mockReturnValue(downController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.8.0"));
    isVersionYankedMock.mockResolvedValue(false);

    const result = await provisionHost(
      makeOpts({
        satisfaction: ownBuild("1.7.2"),
        recordVersionOverride: "1.7.2",
        registerService: true,
      }),
    );

    expect(result.action).toBe("service-registered");
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
  });

  it("still replaces a newer install under `--force` - the operator's own escape hatch is unchanged", async () => {
    createServiceControllerMock.mockReturnValue(runningController());
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.8.0"));
    isVersionYankedMock.mockResolvedValue(false);

    const result = await provisionHost(
      makeOpts({ satisfaction: ownBuild("1.7.2"), force: true }),
    );

    expect(result.action).toBe("installed");
    expect(commitHostInstallSourceMock).toHaveBeenCalledTimes(1);
  });
});

// Reviewer finding (host-ensure): `beforeMutate` must fire ONLY once this
// call has committed to mutating the host, never on the lock-free no-op
// fast path - `host ensure` hangs its sign-in pre-flight there precisely so
// a signed-out operator whose host is already healthy is never prompted
// for a command that then does nothing. The command-level suite
// (`commands/__tests__/host-ensure.test.ts`) only proves `host-ensure.ts`
// THREADS a callback into `ensureHost`'s options; it mocks `ensureHost`
// wholesale, so it cannot prove `provisionHost` itself gates the call. This
// suite pins the gate directly, against the real fast-path/install-branch
// code paths above.
describe("provisionHost - beforeMutate gate", () => {
  beforeEach(() => {
    mocks.callOrder = [];
    mocks.lockHeld = false;
    mocks.lockAcquisitions = 0;
    serviceLabelForMock.mockReturnValue({
      id: "ai.traycer.host",
      environment: "production",
    });
    assertHostNotBusyMock.mockResolvedValue(undefined);
    discardStagedHostInstallSourceMock.mockResolvedValue(undefined);
    createServiceInstallLifecycleMock.mockReturnValue(sampleLifecycleHandle());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not invoke beforeMutate when the lock-free fast path is already satisfied (noop)", async () => {
    createServiceControllerMock.mockReturnValue({
      status: async () => ({
        state: "running",
        version: "host",
        listenUrl: "ws://127.0.0.1:7100/rpc",
        pid: 4242,
      }),
      install: vi.fn(),
      start: vi.fn(),
      hostStartAdoptionLabel: vi.fn(async (label: { id: string }) => label.id),
    });
    // Installed at the exact target version, registered and running - the
    // fast path's `isSatisfied` is true, so this returns before ever
    // reaching the `beforeMutate` call site in `provisionHost`.
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("2.0.0"));
    const beforeMutateMock = vi.fn().mockResolvedValue(undefined);

    const result = await provisionHost(
      makeOpts({ beforeMutate: beforeMutateMock }),
    );

    expect(result.action).toBe("noop");
    expect(beforeMutateMock).not.toHaveBeenCalled();
  });

  it("invokes beforeMutate before the install branch's work, and before staging, when work is required", async () => {
    createServiceControllerMock.mockReturnValue({
      status: async () => ({
        state: "not-installed",
        version: null,
        listenUrl: null,
        pid: null,
      }),
      install: vi.fn(),
      start: vi.fn(),
      hostStartAdoptionLabel: vi.fn(async (label: { id: string }) => label.id),
    });
    // Nothing installed - the fast path predicts (and the locked re-read
    // confirms) the install branch, so `beforeMutate` must run before
    // `prepareInstallStage` (network staging) and before the locked commit.
    readHostInstallRecordMock.mockResolvedValue(null);
    stageHostInstallSourceMock.mockResolvedValue(sampleStaged("2.0.0"));
    commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });
    const beforeMutateMock = vi.fn(async () => {
      mocks.callOrder.push("before-mutate");
    });

    const result = await provisionHost(
      makeOpts({ beforeMutate: beforeMutateMock }),
    );

    expect(result.action).toBe("installed");
    expect(beforeMutateMock).toHaveBeenCalledTimes(1);
    // "before-mutate" precedes "stage" (staging outside any lock), which in
    // turn precedes the lock span that commits the install - beforeMutate
    // runs before BOTH the install work and staging, exactly where
    // `host/provision.ts` places the call: above `prepareInstallStage` and
    // the locked commit.
    expect(mocks.callOrder).toEqual([
      "before-mutate",
      "stage",
      "lock-enter",
      "commit",
      "lock-exit",
    ]);
  });

  it("beforeMutate: null does not crash a mutating run", async () => {
    createServiceControllerMock.mockReturnValue({
      status: async () => ({
        state: "not-installed",
        version: null,
        listenUrl: null,
        pid: null,
      }),
      install: vi.fn(),
      start: vi.fn(),
      hostStartAdoptionLabel: vi.fn(async (label: { id: string }) => label.id),
    });
    readHostInstallRecordMock.mockResolvedValue(null);
    stageHostInstallSourceMock.mockResolvedValue(sampleStaged("2.0.0"));
    commitHostInstallSourceMock.mockResolvedValue({
      record: sampleRecord("2.0.0"),
      previous: null,
      installGeneration: "id:install-2.0.0",
    });

    const result = await provisionHost(makeOpts({ beforeMutate: null }));

    expect(result.action).toBe("installed");
  });
});

// This is the single most important test in the store-format-floor gate-site
// set: `--force` means "replace a host with work in progress" - it skips the
// BUSY probe, never the floor. The floor protects data the user cannot get
// back by waiting, and conflating the two would put the escape hatch behind
// the exact flag an operator already reaches for when a host misbehaves,
// which is precisely the desktop's "Force restart" path.
describe("provisionHost - --force does not bypass the store-format floor", () => {
  beforeEach(() => {
    mocks.callOrder = [];
    mocks.lockHeld = false;
    mocks.lockAcquisitions = 0;
    serviceLabelForMock.mockReturnValue({
      id: "ai.traycer.host",
      environment: "production",
    });
    assertHostNotBusyMock.mockResolvedValue(undefined);
    discardStagedHostInstallSourceMock.mockResolvedValue(undefined);
    createServiceInstallLifecycleMock.mockReturnValue(sampleLifecycleHandle());
    createServiceControllerMock.mockReturnValue({
      status: async () => ({
        state: "running" as const,
        version: "1.8.0",
        listenUrl: "ws://127.0.0.1:7100/rpc",
        pid: 4242,
      }),
      install: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
    });
    readHostInstallRecordMock.mockResolvedValue(sampleRecord("1.8.0"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("still refuses, and never stages, when the floor rejects even with force: true", async () => {
    mocks.gateStoreFormatFloorMock.mockRejectedValue(
      Object.assign(new Error("host ensure: refusing to install host 1.2.0"), {
        code: "E_HOST_STORE_FORMAT_FLOOR",
      }),
    );

    await expect(
      provisionHost(
        makeOpts({
          satisfaction: { kind: "exact", version: "1.2.0" },
          force: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "E_HOST_STORE_FORMAT_FLOOR" });

    expect(mocks.gateStoreFormatFloorMock).toHaveBeenCalledTimes(1);
    expect(mocks.gateStoreFormatFloorMock.mock.calls[0]?.[0]).toMatchObject({
      targetVersion: "1.2.0",
      site: "host ensure",
    });
    expect(stageHostInstallSourceMock).not.toHaveBeenCalled();
    expect(commitHostInstallSourceMock).not.toHaveBeenCalled();
  });
});
