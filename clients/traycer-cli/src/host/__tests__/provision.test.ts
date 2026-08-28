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
  lockHeld: false,
  lockAcquisitions: 0,
}));

vi.mock("../../installer", () => ({
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

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

vi.mock("../../service/cli-binary", () => ({
  resolveServiceCliInvocation: vi.fn(),
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
      afterSwap: async () => {},
      swapLockRecovery: null,
    },
  };
}

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
