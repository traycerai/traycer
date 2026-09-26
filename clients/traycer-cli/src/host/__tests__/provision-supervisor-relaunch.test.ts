import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withUpdateContender } from "@traycer-clients/shared/host-update";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { SupervisorRecord } from "@traycer/protocol/config/supervisor-record";

// `provisionHost`'s start branch (installed + registered + not running) is
// where CRASH-RELAUNCH-ENSURE-RACE actually surfaces end to end: a
// `startHostServiceWithAttempt` that finds the service's own supervisor
// alive must not escalate to a re-register, and `provisionHost` must wait
// for that relaunch OUTSIDE the update-attempt lock the relaunch itself
// contends for.
//
// This suite gives `provisionHost` full control of the host home (real
// records, real identity for THIS process) while keeping every other
// dependency a fast, deterministic stub - the same style
// `provision.test.ts` already uses, plus the one thing that suite never
// mocks: `../../store/paths`, needed here to point `findLiveServiceSupervisor`
// at a controlled temp directory instead of the real machine's host home.

const homeRef = vi.hoisted(() => ({ current: "" }));
vi.mock("../../store/paths", () => ({
  hostHomeDir: () => homeRef.current,
}));

const incumbentRef = vi.hoisted(() => ({
  // `null` = no incumbent host answering; anything else = found.
  current: null as {
    pid: number;
    version: string;
    websocketUrl: string;
  } | null,
}));
vi.mock("../incumbent-check", () => ({
  findLiveIncumbentHost: async () => incumbentRef.current,
}));

const mocks = vi.hoisted(() => ({
  readHostInstallRecordMock: vi.fn(),
  createServiceControllerMock: vi.fn(),
  serviceLabelForMock: vi.fn(),
  assertHostNotBusyMock: vi.fn(),
  lockHeld: false,
  lockAcquisitions: 0,
}));

vi.mock("../../manifest/host-install", () => ({
  readHostInstallRecord: mocks.readHostInstallRecordMock,
}));

vi.mock("../../service", () => ({
  createServiceController: mocks.createServiceControllerMock,
  serviceLabelFor: mocks.serviceLabelForMock,
}));

vi.mock("../busy-check", () => ({
  assertHostNotBusy: mocks.assertHostNotBusyMock,
}));

// The INNER cli-lock only - orthogonal to what this suite pins (the OUTER
// update-attempt lock, real and unmocked below). A fast async passthrough,
// matching provision.test.ts's own convention.
vi.mock("../../store/cli-lock", () => ({
  withCliLock: async <T>(_opts: unknown, fn: () => Promise<T>): Promise<T> => {
    mocks.lockAcquisitions += 1;
    mocks.lockHeld = true;
    try {
      return await fn();
    } finally {
      mocks.lockHeld = false;
    }
  },
}));

import { provisionHost, type ProvisionHostOptions } from "../provision";
import { readProcessStartIdentity } from "../../store/process-identity";
import {
  writeSupervisorRecords,
  removeSupervisorRecords,
  type SupervisorRunState,
} from "../lifecycle-files";
import type { RuntimeContext } from "../../runner/runtime";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES } from "../../runner/errors";
import type { HostInstallRecord } from "@traycer/protocol/config/installation-records";
import type { SupervisorRelaunchWaitDeps } from "../service-supervisor-relaunch";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "provision-supervisor-relaunch-test-"),
  );
  roots.push(root);
  return join(root, "host-home");
}

afterEach(async () => {
  homeRef.current = "";
  incumbentRef.current = null;
  mocks.lockHeld = false;
  mocks.lockAcquisitions = 0;
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function sampleInstallRecord(version: string): HostInstallRecord {
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

function sampleSupervisorRecord(pid: number): SupervisorRecord {
  return {
    v: 1,
    pid,
    cliVersion: "1.0.0",
    capabilities: [],
    startedAt: new Date().toISOString(),
  };
}

function sampleRunState(
  pid: number,
  admission: SupervisorRunState["admission"],
  identity: ProcessStartIdentity | null,
): SupervisorRunState {
  return {
    v: 1,
    supervisorPid: pid,
    supervisorStartIdentity: identity,
    admission,
    origin: null,
    adopted: false,
    lastPresence: null,
    updatedAt: new Date().toISOString(),
  };
}

async function writeLiveSupervisor(pid: number): Promise<void> {
  const identity = readProcessStartIdentity(pid);
  await writeSupervisorRecords("production", {
    record: sampleSupervisorRecord(pid),
    runState: sampleRunState(pid, "granted", identity),
  });
}

async function removeSupervisor(pid: number): Promise<void> {
  await removeSupervisorRecords("production", pid, "all");
}

/** installed + registered + NOT running - the branch `runStart` handles. */
function stoppedController(): {
  readonly controller: unknown;
  readonly calls: Record<string, number>;
} {
  const calls: Record<string, number> = { install: 0, start: 0, status: 0 };
  return {
    controller: {
      status: async () => {
        calls.status += 1;
        return {
          state: "stopped" as const,
          version: "2.0.0",
          listenUrl: null,
          pid: null,
        };
      },
      install: async () => {
        calls.install += 1;
      },
      start: async () => {
        calls.start += 1;
        // Deliberately never calls `atServiceSpawnEdge()` - see
        // update-mutation-supervisor-relaunch.test.ts for why.
      },
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    },
    calls,
  };
}

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
    resolveInstallSource: () => {
      throw new Error("install branch must not be reached in this suite");
    },
    satisfaction: { kind: "exact", version: "2.0.0" },
    recordVersionOverride: null,
    enableLinger: true,
    allowSelfInvocation: true,
    registerService: true,
    lockReason: "test-provision-supervisor-relaunch",
    onProgress: null,
    force: false,
    acceptStoreFormatLoss: false,
    yankLookup: {
      isVersionYanked: async () => {
        throw new Error("yank lookup must not be reached in this suite");
      },
    },
    holdExplicitDowngrade: false,
    adoption: undefined,
    lifecycleOrigin: "terminal",
    beforeMutate: null,
    supervisorRelaunchWait: null,
    ...overrides,
  };
}

function immediateWaitDeps(
  extra: Partial<SupervisorRelaunchWaitDeps>,
): SupervisorRelaunchWaitDeps {
  return {
    now: () => Date.now(),
    sleep: async () => undefined,
    waitMs: 60_000,
    pollIntervalMs: 1,
    ...extra,
  };
}

function testLabel(): {
  readonly id: string;
  readonly displayName: string;
  readonly environment: "production";
  readonly devSlot: null;
} {
  return {
    id: "ai.traycer.host",
    displayName: "Traycer Host",
    environment: "production",
    devSlot: null,
  };
}

describe("provisionHost - the start branch, with a live service supervisor", () => {
  it("(3a) does not escalate to installHostServiceWithAttempt / re-register (controller.install is never called)", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord("2.0.0"),
    );
    mocks.serviceLabelForMock.mockReturnValue(testLabel());
    const { controller, calls } = stoppedController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeLiveSupervisor(process.pid);
    // Readiness resolves immediately - see (3b) below for the same fact
    // asserted from the result's angle.
    incumbentRef.current = {
      pid: 4242,
      version: "2.0.0",
      websocketUrl: "ws://127.0.0.1:1/rpc",
    };

    await provisionHost(
      makeOpts({ supervisorRelaunchWait: immediateWaitDeps({}) }),
    );

    expect(calls.install).toBe(0);
    expect(calls.start).toBe(0);
  });

  it("(3b) resolves to a noop result once the wait sees the host come back", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord("2.0.0"),
    );
    mocks.serviceLabelForMock.mockReturnValue(testLabel());
    const { controller } = stoppedController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeLiveSupervisor(process.pid);
    incumbentRef.current = {
      pid: 4242,
      version: "2.0.0",
      websocketUrl: "ws://127.0.0.1:1/rpc",
    };

    const result = await provisionHost(
      makeOpts({ supervisorRelaunchWait: immediateWaitDeps({}) }),
    );

    expect(result.action).toBe("noop");
  });

  it("(3c) rejects with E_SERVICE_SUPERVISOR_RELAUNCHING when the wait times out, with nothing started", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord("2.0.0"),
    );
    mocks.serviceLabelForMock.mockReturnValue(testLabel());
    const { controller, calls } = stoppedController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeLiveSupervisor(process.pid);
    // The host never comes up, and the supervisor never goes away - the
    // only way out of the wait is the deadline.
    incumbentRef.current = null;
    const clock = { value: 0 };

    await expect(
      provisionHost(
        makeOpts({
          supervisorRelaunchWait: {
            now: () => clock.value,
            sleep: async (ms) => {
              clock.value += ms;
            },
            waitMs: 100,
            pollIntervalMs: 40,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_SUPERVISOR_RELAUNCHING,
    });

    expect(calls.start).toBe(0);
    expect(calls.install).toBe(0);
  });

  it("(3d) provisions again once the supervisor exits without bringing the host back, and takes today's start on the retry", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord("2.0.0"),
    );
    mocks.serviceLabelForMock.mockReturnValue(testLabel());
    const { controller, calls } = stoppedController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeLiveSupervisor(process.pid);
    incumbentRef.current = null;
    let removed = false;

    const result = await provisionHost(
      makeOpts({
        supervisorRelaunchWait: immediateWaitDeps({
          sleep: async () => {
            if (!removed) {
              removed = true;
              await removeSupervisor(process.pid);
            }
          },
        }),
      }),
    );

    expect(result.action).toBe("started");
    expect(calls.start).toBe(1);
  });

  it("(3e) the wait runs with the update-attempt lock released - a concurrent contender for the same host home is admitted", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord("2.0.0"),
    );
    mocks.serviceLabelForMock.mockReturnValue(testLabel());
    const { controller, calls } = stoppedController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeLiveSupervisor(process.pid);
    incumbentRef.current = null;
    let probedOutcomeKind: string | null = null;
    const clock = { value: 0 };

    await expect(
      provisionHost(
        makeOpts({
          supervisorRelaunchWait: {
            now: () => clock.value,
            sleep: async (ms) => {
              // The supervisor's own relaunch contends for this very lock
              // (`withSupervisorRelaunchContender`); a caller still holding
              // it here would starve the relaunch it is waiting for. Probe
              // with waitMs: 0 so a held lock fails FAST rather than
              // blocking this test. Only the FIRST call's result is kept:
              // a caller waiting for THIS supervisor's relaunch runs exactly
              // one wait when the segment is correctly released before it -
              // capturing only the first probe keeps the assertion pinned to
              // that first wait even if a mutation (R7) makes the mechanism
              // loop an extra time around a second, correctly-released wait.
              const outcome = await withUpdateContender(
                {
                  hostHomeDir,
                  reason: "concurrent-contender-probe",
                  waitMs: 0,
                  pollIntervalMs: 10,
                  admission: "service-maintenance",
                },
                async () => "probed",
              );
              if (probedOutcomeKind === null) probedOutcomeKind = outcome.kind;
              clock.value += ms + 1_000_000;
            },
            waitMs: 100,
            pollIntervalMs: 10,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_SUPERVISOR_RELAUNCHING,
    });

    expect(probedOutcomeKind).toBe("ran");
    expect(calls.start).toBe(0);
  });

  it("(3f) beforeMutate runs exactly once across a wait and a re-provision", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord("2.0.0"),
    );
    mocks.serviceLabelForMock.mockReturnValue(testLabel());
    const { controller } = stoppedController();
    mocks.createServiceControllerMock.mockReturnValue(controller);
    await writeLiveSupervisor(process.pid);
    incumbentRef.current = null;
    let removed = false;
    const beforeMutate = vi.fn(async () => undefined);

    const result = await provisionHost(
      makeOpts({
        beforeMutate,
        supervisorRelaunchWait: immediateWaitDeps({
          sleep: async () => {
            if (!removed) {
              removed = true;
              await removeSupervisor(process.pid);
            }
          },
        }),
      }),
    );

    expect(result.action).toBe("started");
    expect(beforeMutate).toHaveBeenCalledTimes(1);
  });

  // R6: a bound on how many live-supervisor relaunches one `provisionHost`
  // call will wait out. Two waits, each ended by the supervisor genuinely
  // going away (not a deadline), and each followed by a re-provision that
  // finds a DIFFERENT live supervisor already there (a service manager
  // restarting a failed unit). The third relaunching outcome must throw
  // immediately - MAX_SUPERVISOR_RELAUNCH_WAITS(2) waits have already run.
  it("(3g) throws after the bounded number of waits even when supervisors keep reappearing, never starting anything", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleInstallRecord("2.0.0"),
    );
    mocks.serviceLabelForMock.mockReturnValue(testLabel());
    incumbentRef.current = null;

    const supervisorA = process.pid;
    // Two additional "alive" pids for the successors - this process's own
    // pid plus small, stable offsets are alive for the whole test (this is
    // still the same OS process; the pid is only used as a dictionary key
    // here, and readLiveSupervisorRun's identity check runs against
    // whatever pid is RECORDED, so writing this process's OWN pid for every
    // successor - re-admitted each time under a fresh identity read - models
    // "a live supervisor" faithfully without needing three real processes).
    await writeLiveSupervisor(supervisorA);

    let statusCalls = 0;
    const calls = { install: 0, start: 0 };
    const controller = {
      status: async () => {
        statusCalls += 1;
        // Call #1 = the fast unlocked read (before the loop).
        // Call #2 = iteration 1's locked re-read (supervisor A already set).
        // Call #3 = iteration 2's locked re-read - write successor B here,
        //   BEFORE the fresh startHostServiceWithAttempt call that follows
        //   in the same synchronous continuation.
        // Call #4 = iteration 3's locked re-read - write successor C here.
        if (statusCalls === 3) await writeLiveSupervisor(supervisorA);
        if (statusCalls === 4) await writeLiveSupervisor(supervisorA);
        return {
          state: "stopped" as const,
          version: "2.0.0",
          listenUrl: null,
          pid: null,
        };
      },
      install: async () => {
        calls.install += 1;
      },
      start: async () => {
        calls.start += 1;
      },
      hostStartAdoptionLabel: async (l: { id: string }) => l.id,
    };
    mocks.createServiceControllerMock.mockReturnValue(controller);

    let sleepCalls = 0;
    await expect(
      provisionHost(
        makeOpts({
          supervisorRelaunchWait: immediateWaitDeps({
            sleep: async () => {
              sleepCalls += 1;
              // Ends WAIT #1 and WAIT #2 with "supervisor-gone" - the
              // supervisor genuinely disappears; the successor is written
              // separately, from the NEXT attempt's status read above, not
              // from here.
              await removeSupervisor(supervisorA);
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_SUPERVISOR_RELAUNCHING,
    });

    // Exactly two waits ran (each ended by one sleep call finding the
    // records gone on the recheck immediately after); the third relaunching
    // outcome hit the bound and threw without waiting a third time.
    expect(sleepCalls).toBe(2);
    expect(calls.start).toBe(0);
    expect(calls.install).toBe(0);
  });
});
