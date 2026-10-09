import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Desktop kills a CLI that prints no NDJSON line
// for 600s (`CLI_STREAM_IDLE_TIMEOUT_MS`). The fix (already in the tree) is
// `reportBoundedWait` (bounded-wait-progress.ts), called as each bounded wait
// BEGINS, so the longest silence a caller can see is one wait's own bound,
// never the sum of a command's several. Each row below drives a real
// production call chain under fake timers, with a fake actuator standing in
// for the OS/host round trip each wait actually spends, and asserts that no
// gap between two consecutive progress reports (or the call's start/end)
// exceeds that row's own longest single step - proving the fix collapses the
// SUM into a MAX.
//
// HOME isolation: run only through
// `heavy.sh <owner> sh <sweep-home.sh path> <traycer-cli clone path> src/runner/__tests__/bounded-wait-progress-sweep.test.ts`
// - that script points `HOME`/`USERPROFILE` at a fresh temp dir for the whole
// process before vitest starts, so every `os.homedir()`-derived path (real,
// unmocked reads included - s2's install/staged lookups) resolves under it.

const requireCapabilityMock = vi.hoisted(() => ({
  fn: vi.fn(async () => undefined),
}));
vi.mock("../../host/update-contender", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/update-contender")>();
  return {
    ...actual,
    requireCliUpdateMutationCapability: requireCapabilityMock.fn,
  };
});

const hostRpcMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return { ...actual, callHostRpcAtEndpoint: hostRpcMock.fn };
});

const pidMetadataMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/pid-metadata")>();
  return { ...actual, readHostPidMetadata: pidMetadataMock.fn };
});

const processIdentityMock = vi.hoisted(() => ({
  fn: vi.fn(async () => "current"),
}));
vi.mock("../../store/process-identity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/process-identity")>();
  return {
    ...actual,
    getPublishedProcessIdentityVerdict: processIdentityMock.fn,
  };
});

// s2 only: real fs I/O settles through the real event loop's I/O completion,
// which fake timers do not drive. The two record reads
// (readHostInstallRecord/readHostStagedRecord) are stubbed directly instead of
// exercised against a real (if empty) HOME. The `lstat` that proves the staged
// record's absence (`pathAbsentOrUnreadable`) stays real I/O; the pump yields
// real macrotasks while no fake timer is pending so it can complete.
const installRecordMock = vi.hoisted(() => ({ fn: vi.fn(async () => null) }));
vi.mock("../../manifest/host-install", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../manifest/host-install")>();
  return { ...actual, readHostInstallRecord: installRecordMock.fn };
});
const stagedRecordMock = vi.hoisted(() => ({ fn: vi.fn(async () => null) }));
vi.mock("../../manifest/host-staged", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../manifest/host-staged")>();
  return { ...actual, readHostStagedRecord: stagedRecordMock.fn };
});

// The real `setTimeout` and clock, captured before any test installs fake
// timers, so the pump below and the held `lstat` can still wait on the real
// event loop and read real time.
const realTimers = vi.hoisted(() => ({
  setTimeout: globalThis.setTimeout,
  now: Date.now.bind(Date),
}));

const renameMock = vi.hoisted(() => ({ fn: vi.fn() }));
// (s2-io) only: while `hold` is set, `lstat` stays pending until the FAKE
// clock has moved more than `ceilingMs` past the call, or 200 ms of REAL time
// has passed, then runs the real `lstat`.
const lstatHold = vi.hoisted(() => ({ hold: false, ceilingMs: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: renameMock.fn,
    lstat: async (path: string) => {
      if (lstatHold.hold) {
        const calledAtFake = Date.now();
        for (let polls = 0; polls < 20; polls += 1) {
          if (Date.now() - calledAtFake > lstatHold.ceilingMs) break;
          await new Promise<void>((resolve) => {
            realTimers.setTimeout(resolve, 10);
          });
        }
      }
      return actual.lstat(path);
    },
  };
});

import type { ProgressInfo } from "../output";
import { withBoundedWaitProgress } from "../bounded-wait-progress";
import {
  stopHostServiceWithAttempt,
  uninstallHostServiceWithAttempt,
} from "../../host/update-mutation";
import type { WithCliUpdateContenderOptions } from "../../host/update-contender";
import type { UpdateMutationCapability } from "@traycer-clients/shared/host-update";
import { serviceLabelFor } from "../../service/label";
import type {
  ServiceController,
  StopServiceOptions,
  UninstallServiceOptions,
} from "../../service";
import { observeAttemptRecoveryEvidence } from "../../host/update-recovery-evidence";
import { hostHomeDir } from "../../store/paths";
import { renameWithRetryPlan } from "../../installer/rename-retry";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Under vitest's default 5 s test timeout, so a run that never settles fails
// with the pump's own message rather than a bare timeout.
const PUMP_REAL_DEADLINE_MS = 4_000;

function yieldRealMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    realTimers.setTimeout(resolve, 0);
  });
}

/**
 * Drive `run` to completion under fake timers.
 *
 * Each pass looks at whether a fake timer is pending. If one is, the clock
 * moves to exactly that timer (`advanceTimersToNextTimerAsync`), which also
 * flushes the microtasks around it. If none is, the fake clock is left alone
 * and one REAL macrotask is yielded instead, so any real, unmocked I/O the
 * chain is waiting on (s2's `lstat`) can complete and the chain can schedule
 * its next timer. The fake clock therefore moves only to a timer the chain
 * has already scheduled, and never while the chain's only pending work is
 * real I/O. The loop is bounded by a real-time deadline, not an iteration
 * count, and throws if it is hit.
 */
async function pumpFakeTimersUntilSettled(
  run: Promise<unknown>,
): Promise<void> {
  let settled = false;
  run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = realTimers.now() + PUMP_REAL_DEADLINE_MS;
  while (!settled) {
    if (realTimers.now() > deadline) {
      throw new Error(
        `pumpFakeTimersUntilSettled: run still pending after ${PUMP_REAL_DEADLINE_MS}ms of real time`,
      );
    }
    if (vi.getTimerCount() > 0) {
      await vi.advanceTimersToNextTimerAsync();
    } else {
      await yieldRealMacrotask();
    }
  }
}

/** [start, ...every reportBoundedWait, end] - the full silence timeline. */
function maxConsecutiveGap(timeline: readonly number[]): number {
  let max = 0;
  for (let i = 1; i < timeline.length; i += 1) {
    const gap = timeline[i]! - timeline[i - 1]!;
    if (gap > max) max = gap;
  }
  return max;
}

function recorderInto(timeline: number[]): (info: ProgressInfo) => void {
  return () => {
    timeline.push(Date.now());
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("bounded-wait-progress sweep", () => {
  it("(s1) `host uninstall --all`, Windows shape: uninstall then stop never silence longer than either actuator's own span", async () => {
    // Windows uninstall: schtasks /End + kill ladder (300s) + the
    // invocation-record txn (30s) - one lump, one actuator call.
    const UNINSTALL_MS = 330_000; // host-uninstall.ts:209-258 / update-mutation.ts:176-189
    // Windows stop: schtasks /End + kill ladder.
    const STOP_MS = 253_000; // update-mutation.ts:207-222
    const CEILING_MS = 330_000; // the longer of the two actuator spans above

    const timeline: number[] = [];
    const capability = {
      hostHomeDir: "/irrelevant",
    } as UpdateMutationCapability;
    const contenderOptions: WithCliUpdateContenderOptions = {
      environment: "production",
      reason: "bounded-wait-sweep-s1",
      waitMs: 0,
      pollIntervalMs: 10,
      admission: "attempt-executor",
    };
    const label = serviceLabelFor("production");
    const uninstallController: Pick<ServiceController, "uninstall"> = {
      uninstall: async (_options: UninstallServiceOptions) => {
        await sleep(UNINSTALL_MS);
      },
    };
    const stopController: Pick<ServiceController, "stop"> = {
      stop: async (_label, _options: StopServiceOptions) => {
        await sleep(STOP_MS);
      },
    };

    const run = withBoundedWaitProgress(recorderInto(timeline), async () => {
      timeline.push(Date.now());
      await uninstallHostServiceWithAttempt(
        capability,
        contenderOptions,
        uninstallController,
        { label, leaveForegroundRun: null },
      );
      await stopHostServiceWithAttempt(
        capability,
        contenderOptions,
        stopController,
        label,
        { force: true },
        "unconditional",
      );
      timeline.push(Date.now());
    });

    await pumpFakeTimersUntilSettled(run);
    await run;

    const maxGap = maxConsecutiveGap(timeline);
    expect(maxGap, `observed max gap ${maxGap}ms`).toBeLessThanOrEqual(
      CEILING_MS,
    );
  });

  it("(s2) recovery evidence: the two `host update-verify` RPC reads never silence longer than one RPC's own span", async () => {
    const RPC_MS = 225_600; // one `host.status` round trip this row simulates
    const CEILING_MS = 225_600;

    const timeline: number[] = [];
    const environment = "production";
    const version = "2.0.0";
    const websocketUrl = "ws://127.0.0.1:54999/rpc";
    pidMetadataMock.fn.mockResolvedValue({
      pid: 4242,
      hostId: "sweep-host",
      version,
      websocketUrl,
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: "sweep-stamp",
      processStartIdentityRead: "present",
      layer0: null,
      layer0Slot: null,
    });
    processIdentityMock.fn.mockResolvedValue("current");
    hostRpcMock.fn.mockImplementation(async () => {
      await sleep(RPC_MS);
      return { ready: true, hostVersion: version };
    });

    const run = withBoundedWaitProgress(recorderInto(timeline), async () => {
      timeline.push(Date.now());
      await observeAttemptRecoveryEvidence(
        environment,
        hostHomeDir(environment),
        "identity-required",
      );
      timeline.push(Date.now());
    });

    await pumpFakeTimersUntilSettled(run);
    await run;

    const maxGap = maxConsecutiveGap(timeline);
    expect(maxGap, `observed max gap ${maxGap}ms`).toBeLessThanOrEqual(
      CEILING_MS,
    );
  });

  it("(s2-io) recovery evidence with the real lstat held pending: the fake clock must not run ahead of pending real I/O", async () => {
    const RPC_MS = 225_600;
    const CEILING_MS = 225_600;
    lstatHold.hold = true;
    lstatHold.ceilingMs = CEILING_MS;

    const timeline: number[] = [];
    const environment = "production";
    const version = "2.0.0";
    const websocketUrl = "ws://127.0.0.1:54999/rpc";
    pidMetadataMock.fn.mockResolvedValue({
      pid: 4242,
      hostId: "sweep-host",
      version,
      websocketUrl,
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: "sweep-stamp",
      processStartIdentityRead: "present",
      layer0: null,
      layer0Slot: null,
    });
    processIdentityMock.fn.mockResolvedValue("current");
    hostRpcMock.fn.mockImplementation(async () => {
      await sleep(RPC_MS);
      return { ready: true, hostVersion: version };
    });

    const run = withBoundedWaitProgress(recorderInto(timeline), async () => {
      timeline.push(Date.now());
      await observeAttemptRecoveryEvidence(
        environment,
        hostHomeDir(environment),
        "identity-required",
      );
      timeline.push(Date.now());
    });

    try {
      // A pump bounded by an iteration count can return while the held
      // `lstat` is still pending. The real pause lets that `lstat` finish and
      // the second pass drives the rest, so such a pump fails on the gap
      // below rather than on the test timeout.
      await pumpFakeTimersUntilSettled(run);
      await new Promise<void>((resolve) => {
        realTimers.setTimeout(resolve, 300);
      });
      await pumpFakeTimersUntilSettled(run);
      await run;
    } finally {
      lstatHold.hold = false;
    }

    const maxGap = maxConsecutiveGap(timeline);
    expect(maxGap, `observed max gap ${maxGap}ms`).toBeLessThanOrEqual(
      CEILING_MS,
    );
  });

  it("(s3) the Windows install swap's two renames: each re-kill's own span is the ceiling, never their sum", async () => {
    const REKILL_MS = 210_000; // one Windows re-kill (rename-retry.ts's onRetry)
    const BACKOFF_MS = 250; // rename-retry.ts's delaysMs[0]
    const CEILING_MS = REKILL_MS + BACKOFF_MS; // one re-kill plus its own backoff

    const timeline: number[] = [];
    let renameCalls = 0;
    renameMock.fn.mockImplementation(async () => {
      renameCalls += 1;
      // First try of EACH of the two calls below fails; the retried second
      // try of each succeeds.
      if (renameCalls === 1 || renameCalls === 3) {
        const err = new Error("resource busy or locked");
        (err as NodeJS.ErrnoException).code = "EBUSY";
        throw err;
      }
    });
    const onRetry = async (): Promise<void> => {
      await sleep(REKILL_MS);
    };
    const plan = {
      delaysMs: [BACKOFF_MS],
      onRetry,
      maxTotalMs: 120_000,
      verifyBeforeAttempt: async () => undefined,
    };

    const run = withBoundedWaitProgress(recorderInto(timeline), async () => {
      timeline.push(Date.now());
      await renameWithRetryPlan(
        "/tmp/host-aside-from",
        "/tmp/host-aside-to",
        plan,
      );
      await renameWithRetryPlan(
        "/tmp/host-promote-from",
        "/tmp/host-promote-to",
        plan,
      );
      timeline.push(Date.now());
    });

    await pumpFakeTimersUntilSettled(run);
    await run;

    const maxGap = maxConsecutiveGap(timeline);
    expect(maxGap, `observed max gap ${maxGap}ms`).toBeLessThanOrEqual(
      CEILING_MS,
    );
  });
});
