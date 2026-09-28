import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopPresence } from "@traycer/protocol/config/desktop-presence";
import type {
  HostLifecycleMode,
  HostLifecyclePolicy,
} from "@traycer/protocol/config/host-lifecycle-policy";
import type { SpawnFreeProcessExistence } from "@traycer-clients/shared/host-lock/process-identity";
import type { ILogger, LogFields } from "../../logger";
import type { Environment } from "../../runner/environment";
import type {
  DesktopPresenceLiveness,
  LifecycleRecordRead,
  ObservedDesktopPresence,
  SupervisorRunAdmission,
} from "../lifecycle-files";
import {
  applyLifecycleTick,
  evaluateStopRule,
  LIFECYCLE_OBSERVER_POLL_MS,
  LIFECYCLE_PRESENCE_CRASH_GRACE_MS,
  LIFECYCLE_PRESENCE_ALIVE_REUSE_MS,
  runIsAdoptable,
  startLifecycleObserver,
  type HostHomeWatch,
  type LifecycleObserverHandle,
  type LifecycleObserverRuntime,
  type LifecycleObserverState,
  type LifecycleRecordReads,
} from "../lifecycle-observer";
import type {
  LifecycleTeardown,
  TeardownAttemptResult,
} from "../lifecycle-teardown";
import { hostHomeDir } from "../../store/paths";

// HOME is redirected to a private temp dir BEFORE anything reads it:
// `store/paths` binds `homedir()` at module load, so without this the suite
// would resolve this machine's REAL `~/.traycer`.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync: makeTempDir } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "") {
    osHome.current = makeTempDir(
      joinPath(actual.tmpdir(), "traycer-lifecycle-observer-test-home-"),
    );
  }
  return { ...actual, homedir: () => osHome.current };
});

beforeAll(() => {
  expect(osHome.current).not.toBe("");
  expect(hostHomeDir("production").startsWith(osHome.current)).toBe(true);
});

afterAll(() => {
  rmSync(osHome.current, { recursive: true, force: true });
});

const GRACE = LIFECYCLE_PRESENCE_CRASH_GRACE_MS;

function presence(
  pid: number,
  onExit: "stop" | "keep" | "handoff",
  liveness: DesktopPresenceLiveness,
): ObservedDesktopPresence {
  return { pid, onExit, liveness, observedAt: "2026-01-01T00:00:00.000Z" };
}

function state(
  overrides: Partial<LifecycleObserverState>,
): LifecycleObserverState {
  return {
    adopted: false,
    lastPresence: null,
    mode: "background",
    rev: null,
    condition: null,
    // Constant for the run, defaulted to the admission every
    // existing fixture here implicitly assumed.
    admission: "granted" as SupervisorRunAdmission,
    ...overrides,
  };
}

describe("evaluateStopRule", () => {
  const modes: readonly HostLifecycleMode[] = [
    "background",
    "linked",
    "ask",
    "stop-if-idle",
    "none",
  ];
  const verdicts = ["stop", "keep", "handoff", null] as const;
  const livenesses = ["alive", "dead", "indeterminate", "gone"] as const;

  it("holds only for the full conjunction, across the whole input space", () => {
    for (const adopted of [true, false]) {
      for (const mode of modes) {
        for (const lastVerdict of verdicts) {
          for (const live of livenesses) {
            const result = evaluateStopRule({
              adopted,
              mode,
              lastVerdict,
              presence: live,
            });
            const gate =
              adopted &&
              mode !== "background" &&
              mode !== "none" &&
              lastVerdict === "stop";
            let expected: "holds" | "does-not-hold" | "unknown";
            if (!gate || live === "alive") expected = "does-not-hold";
            else if (live === "indeterminate") expected = "unknown";
            else expected = "holds";
            expect(result).toBe(expected);
          }
        }
      }
    }
  });
});

describe("applyLifecycleTick", () => {
  const stopDead = presence(10, "stop", "dead");

  it("adopts stickily once a live presence is seen", () => {
    const first = applyLifecycleTick(
      state({}),
      { mode: "linked", rev: 1, presence: presence(10, "stop", "alive") },
      0,
      GRACE,
    );
    expect(first.state.adopted).toBe(true);
    expect(first.runStateChanged).toBe(true);
    const second = applyLifecycleTick(
      first.state,
      { mode: "linked", rev: 1, presence: stopDead },
      1,
      GRACE,
    );
    expect(second.state.adopted).toBe(true);
    expect(second.verdict).toBe("holds");
  });

  it("starts the clock on the first holding tick and is due only after the grace", () => {
    const adopted = state({
      adopted: true,
      mode: "linked",
      lastPresence: presence(10, "stop", "alive"),
    });
    const t0 = applyLifecycleTick(
      adopted,
      { mode: "linked", rev: 1, presence: stopDead },
      1_000,
      GRACE,
    );
    expect(t0.teardownDue).toBe(false);
    expect(t0.state.condition).toEqual({ sinceMs: 1_000, presencePid: 10 });
    const before = applyLifecycleTick(
      t0.state,
      { mode: "linked", rev: 1, presence: stopDead },
      1_000 + GRACE - 1,
      GRACE,
    );
    expect(before.teardownDue).toBe(false);
    const due = applyLifecycleTick(
      before.state,
      { mode: "linked", rev: 1, presence: stopDead },
      1_000 + GRACE,
      GRACE,
    );
    expect(due.teardownDue).toBe(true);
    expect(due.state.condition?.sinceMs).toBe(1_000);
  });

  it("continues the clock across a missing record (gone)", () => {
    const start = applyLifecycleTick(
      state({
        adopted: true,
        mode: "linked",
        lastPresence: presence(10, "stop", "alive"),
      }),
      { mode: "linked", rev: 1, presence: stopDead },
      0,
      GRACE,
    );
    const gone = applyLifecycleTick(
      start.state,
      { mode: "linked", rev: 1, presence: null },
      GRACE,
      GRACE,
    );
    expect(gone.verdict).toBe("holds");
    expect(gone.teardownDue).toBe(true);
    expect(gone.state.condition?.sinceMs).toBe(0);
  });

  it("indeterminate never starts the clock and does not reset a running one for the same pid", () => {
    const adopted = state({
      adopted: true,
      mode: "linked",
      lastPresence: presence(10, "stop", "alive"),
    });
    const unknownFirst = applyLifecycleTick(
      adopted,
      {
        mode: "linked",
        rev: 1,
        presence: presence(10, "stop", "indeterminate"),
      },
      0,
      GRACE,
    );
    expect(unknownFirst.verdict).toBe("unknown");
    expect(unknownFirst.state.condition).toBeNull();
    expect(unknownFirst.teardownDue).toBe(false);

    const running = applyLifecycleTick(
      adopted,
      { mode: "linked", rev: 1, presence: stopDead },
      0,
      GRACE,
    );
    const unknown = applyLifecycleTick(
      running.state,
      {
        mode: "linked",
        rev: 1,
        presence: presence(10, "stop", "indeterminate"),
      },
      100,
      GRACE,
    );
    expect(unknown.state.condition).toEqual({ sinceMs: 0, presencePid: 10 });
    expect(unknown.teardownDue).toBe(false);

    const differentPid = applyLifecycleTick(
      running.state,
      {
        mode: "linked",
        rev: 1,
        presence: presence(11, "stop", "indeterminate"),
      },
      100,
      GRACE,
    );
    expect(differentPid.state.condition).toBeNull();
  });

  it("keep and handoff never hold", () => {
    for (const onExit of ["keep", "handoff"] as const) {
      const result = applyLifecycleTick(
        state({
          adopted: true,
          mode: "linked",
          lastPresence: presence(10, onExit, "alive"),
        }),
        { mode: "linked", rev: 1, presence: presence(10, onExit, "dead") },
        GRACE * 10,
        GRACE,
      );
      expect(result.verdict).toBe("does-not-hold");
      expect(result.teardownDue).toBe(false);
    }
  });

  it("a verdict change from stop to keep resets the clock", () => {
    const running = applyLifecycleTick(
      state({ adopted: true, mode: "linked" }),
      { mode: "linked", rev: 1, presence: stopDead },
      0,
      GRACE,
    );
    expect(running.state.condition).not.toBeNull();
    const flipped = applyLifecycleTick(
      running.state,
      { mode: "linked", rev: 1, presence: presence(10, "keep", "dead") },
      10,
      GRACE,
    );
    expect(flipped.state.condition).toBeNull();
  });

  it("flipping to background or none resets a running clock", () => {
    for (const mode of ["background", "none"] as const) {
      const running = applyLifecycleTick(
        state({ adopted: true, mode: "linked" }),
        { mode: "linked", rev: 1, presence: stopDead },
        0,
        GRACE,
      );
      const flipped = applyLifecycleTick(
        running.state,
        { mode, rev: 2, presence: stopDead },
        GRACE,
        GRACE,
      );
      expect(flipped.verdict).toBe("does-not-hold");
      expect(flipped.state.condition).toBeNull();
      expect(flipped.teardownDue).toBe(false);
    }
  });

  it("a different presence pid restarts the clock", () => {
    const running = applyLifecycleTick(
      state({ adopted: true, mode: "linked" }),
      { mode: "linked", rev: 1, presence: presence(10, "stop", "dead") },
      0,
      GRACE,
    );
    const next = applyLifecycleTick(
      running.state,
      { mode: "linked", rev: 1, presence: presence(11, "stop", "dead") },
      GRACE,
      GRACE,
    );
    expect(next.state.condition).toEqual({ sinceMs: GRACE, presencePid: 11 });
    expect(next.teardownDue).toBe(false);
  });

  it("never holds when never adopted", () => {
    const result = applyLifecycleTick(
      state({}),
      { mode: "linked", rev: 1, presence: stopDead },
      GRACE * 10,
      GRACE,
    );
    expect(result.state.adopted).toBe(false);
    expect(result.verdict).toBe("does-not-hold");
    expect(result.teardownDue).toBe(false);
  });

  it("reports runStateChanged only when the ownership facts differ", () => {
    const seen = applyLifecycleTick(
      state({}),
      { mode: "linked", rev: 1, presence: presence(10, "stop", "alive") },
      0,
      GRACE,
    );
    const same = applyLifecycleTick(
      seen.state,
      {
        mode: "linked",
        rev: 1,
        presence: {
          ...presence(10, "stop", "alive"),
          observedAt: "2030-01-01T00:00:00.000Z",
        },
      },
      5,
      GRACE,
    );
    expect(same.runStateChanged).toBe(false);
    const livenessChanged = applyLifecycleTick(
      same.state,
      { mode: "linked", rev: 1, presence: presence(10, "stop", "dead") },
      6,
      GRACE,
    );
    expect(livenessChanged.runStateChanged).toBe(true);
  });
});

describe("runIsAdoptable", () => {
  it("a foreground run is never adoptable; granted and unattended are", () => {
    // Red on head: `runIsAdoptable` does not exist yet.
    expect(runIsAdoptable("foreground")).toBe(false);
    expect(runIsAdoptable("granted")).toBe(true);
    expect(runIsAdoptable("unattended")).toBe(true);
  });
});

describe("applyLifecycleTick - observer admission gate", () => {
  it("a foreground run never adopts, even with a live 'stop' presence", () => {
    // Red on head: `applyLifecycleTick` has no notion of `admission` and
    // adopts on any live presence regardless of how the run was admitted.
    const result = applyLifecycleTick(
      state({ admission: "foreground" }),
      { mode: "linked", rev: 1, presence: presence(10, "stop", "alive") },
      0,
      GRACE,
    );
    expect(result.state.adopted).toBe(false);
  });

  it("a foreground run initially adopted (a live Linked desktop at start) is un-adopted on the first tick", () => {
    // Red on head: `applyLifecycleTick` only ever sets `adopted` to `true`
    // once seen (or leaves a `true` initial value alone) - it never clears
    // one that should never have been set for a `foreground` run.
    const result = applyLifecycleTick(
      state({ admission: "foreground", adopted: true }),
      { mode: "linked", rev: 1, presence: presence(10, "stop", "dead") },
      0,
      GRACE,
    );
    expect(result.state.adopted).toBe(false);
  });

  it("granted and unattended runs still adopt on a live presence (control)", () => {
    for (const admission of ["granted", "unattended"] as const) {
      const result = applyLifecycleTick(
        state({ admission }),
        { mode: "linked", rev: 1, presence: presence(10, "stop", "alive") },
        0,
        GRACE,
      );
      expect(result.state.adopted).toBe(true);
    }
  });
});

describe("applyLifecycleTick - indeterminate vs absent presence", () => {
  it("an 'indeterminate' observation (an invalid/unreadable record) answers unknown, never fires, and keeps lastPresence", () => {
    // Red on head: `LifecycleTickObservation.presence` has no `"indeterminate"`
    // member yet, so head's `presence === null` / `.liveness` logic does not
    // recognize this at all and does not preserve `lastPresence`.
    const adoptedStopState = state({
      adopted: true,
      mode: "linked",
      lastPresence: presence(10, "stop", "dead"),
      condition: { sinceMs: 0, presencePid: 10 },
    });
    const result = applyLifecycleTick(
      adoptedStopState,
      { mode: "linked", rev: 1, presence: "indeterminate" },
      100,
      GRACE,
    );
    expect(result.verdict).toBe("unknown");
    expect(result.teardownDue).toBe(false);
    expect(result.state.lastPresence).toEqual(presence(10, "stop", "dead"));
  });
});

// ---- runner ----------------------------------------------------------------

const ENVIRONMENT: Environment = "dev";

interface LogLine {
  readonly level: "debug" | "info" | "warn";
  readonly message: string;
  readonly fields: LogFields;
}

function recordingLogger(lines: LogLine[]): ILogger {
  return {
    debug: (message, fields) => lines.push({ level: "debug", message, fields }),
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    error: () => undefined,
  };
}

function policyRecord(
  mode: HostLifecycleMode,
  rev: number,
): LifecycleRecordRead<HostLifecyclePolicy> {
  return {
    kind: "valid",
    record: { v: 1, rev, mode, updatedAt: "t", updatedBy: "cli" },
  };
}

function presenceRecord(
  pid: number,
  onExit: "stop" | "keep" | "handoff",
): LifecycleRecordRead<DesktopPresence> {
  return {
    kind: "valid",
    record: {
      v: 1,
      pid,
      processStartIdentity: "id",
      onExit,
      policyRev: 1,
      writtenAt: "t",
    },
  };
}

interface Rig {
  readonly lines: LogLine[];
  readonly published: Array<{ adopted: boolean; pid: number | null }>;
  readonly attempts: { count: number };
  readonly completes: { count: number };
  readonly abortedSeen: boolean[];
  readonly tick: () => void;
  readonly clock: { now: number };
  readonly reads: {
    policy: LifecycleRecordRead<HostLifecyclePolicy>;
    presence: LifecycleRecordRead<DesktopPresence>;
    liveness: DesktopPresenceLiveness;
  };
  readonly existence: { value: SpawnFreeProcessExistence };
  readonly probeCalls: { count: number };
  readonly teardownResults: TeardownAttemptResult[];
  readonly watch: {
    installs: number;
    onChange: (() => void) | null;
    failed: boolean;
    closed: number;
    available: boolean;
  };
  readonly cancelled: { count: number };
  readonly handle: LifecycleObserverHandle;
  readonly setCommitted: (value: boolean) => void;
  readonly reconfirmResults: boolean[];
  readonly gateAttempt: { promise: Promise<void> | null };
  readonly settle: () => Promise<void>;
}

function rig(input: {
  readonly initialAdopted: boolean;
  readonly mode: HostLifecycleMode;
  readonly presence: LifecycleRecordRead<DesktopPresence>;
  readonly liveness: DesktopPresenceLiveness;
  readonly watchAvailable: boolean;
  readonly admission: SupervisorRunAdmission;
  readonly existence: SpawnFreeProcessExistence;
}): Rig {
  const lines: LogLine[] = [];
  const published: Array<{ adopted: boolean; pid: number | null }> = [];
  const attempts = { count: 0 };
  const completes = { count: 0 };
  const abortedSeen: boolean[] = [];
  const reconfirmResults: boolean[] = [];
  const clock = { now: 0 };
  const cancelled = { count: 0 };
  let tickFn: () => void = () => undefined;
  const teardownResults: TeardownAttemptResult[] = [];
  const gateAttempt: { promise: Promise<void> | null } = { promise: null };
  let committed = false;
  const reads = {
    policy: policyRecord(input.mode, 1),
    presence: input.presence,
    liveness: input.liveness,
  };
  const existence: { value: SpawnFreeProcessExistence } = {
    value: input.existence,
  };
  const probeCalls = { count: 0 };
  const watch: Rig["watch"] = {
    installs: 0,
    onChange: null,
    failed: false,
    closed: 0,
    available: input.watchAvailable,
  };
  const runtime: LifecycleObserverRuntime = {
    nowMs: () => clock.now,
    scheduleTicks: (_interval, tick) => {
      tickFn = tick;
      return () => {
        cancelled.count += 1;
      };
    },
    watchHostHome: (_env, onChange) => {
      if (!watch.available) return null;
      watch.installs += 1;
      watch.onChange = onChange;
      const handle: HostHomeWatch = {
        close: () => {
          watch.closed += 1;
        },
        failed: () => watch.failed,
      };
      watch.failed = false;
      return handle;
    },
    // Red on head - `LifecycleObserverRuntime` has no `processExists`
    // seam yet, so this is simply ignored by production code today.
    processExists: (_pid: number) => existence.value,
  };
  const readsImpl: LifecycleRecordReads = {
    readPolicy: async () => reads.policy,
    readPresence: async () => reads.presence,
    probePresence: async () => {
      probeCalls.count += 1;
      return reads.liveness;
    },
  };
  const teardown: LifecycleTeardown = {
    committed: () => committed,
    attempt: async (reconfirm, aborted) => {
      attempts.count += 1;
      abortedSeen.push(aborted());
      if (gateAttempt.promise !== null) await gateAttempt.promise;
      reconfirmResults.push(await reconfirm());
      abortedSeen.push(aborted());
      return teardownResults.shift() ?? { kind: "cancelled", reason: "x" };
    },
  };
  const handle = startLifecycleObserver({
    environment: ENVIRONMENT,
    logger: recordingLogger(lines),
    runtime,
    reads: readsImpl,
    nowIso: () => "2026-01-01T00:00:00.000Z",
    pollMs: LIFECYCLE_OBSERVER_POLL_MS,
    graceMs: GRACE,
    // Red on head - `LifecycleObserverInput` has no
    // top-level `admission` field yet, so this is simply ignored.
    admission: input.admission,
    initial: { adopted: input.initialAdopted, lastPresence: null },
    publishRunState: async (facts) => {
      published.push({
        adopted: facts.adopted,
        pid: facts.lastPresence?.pid ?? null,
      });
    },
    teardown,
    onTeardownComplete: () => {
      completes.count += 1;
    },
  });
  return {
    lines,
    published,
    attempts,
    completes,
    abortedSeen,
    tick: () => tickFn(),
    clock,
    reads,
    existence,
    probeCalls,
    teardownResults,
    watch,
    cancelled,
    handle,
    setCommitted: (value) => {
      committed = value;
    },
    reconfirmResults,
    gateAttempt,
    settle: async () => {
      await handle.idle();
      // A tick is scheduled as a microtask chain; let it drain.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await handle.idle();
    },
  };
}

async function runTick(r: Rig): Promise<void> {
  r.tick();
  await r.settle();
}

describe("startLifecycleObserver - observer admission gate", () => {
  it("a foreground run's presence dying past the grace never attempts a teardown", async () => {
    // Red on head: `rig`'s `admission: "granted"` is ignored by production
    // (`LifecycleObserverInput` has no `admission` field), so a `foreground`
    // run here adopts and tears down exactly like a `granted` one.
    const r = rig({
      initialAdopted: false,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "alive",
      watchAvailable: true,
      admission: "foreground",
      existence: "gone",
    });
    await runTick(r);
    r.reads.liveness = "dead";
    await runTick(r);
    r.reads.presence = { kind: "absent" };
    r.clock.now += GRACE * 5;
    await runTick(r);
    expect(r.attempts.count).toBe(0);
    expect(r.published.some((p) => p.adopted === true)).toBe(false);
  });

  it("a foreground run initially adopted (host-start.ts's own publish beside a live Linked desktop) is un-adopted on the first tick", async () => {
    // Red on head: production only ever moves `adopted` from false to true,
    // sticky - it never un-adopts an initial value it was handed.
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
      admission: "foreground",
      existence: "gone",
    });
    await runTick(r);
    expect(r.published.at(-1)).toEqual({ adopted: false, pid: 10 });
    r.clock.now += GRACE * 5;
    await runTick(r);
    expect(r.attempts.count).toBe(0);
  });

  it("granted and unattended runs still adopt and attempt after the grace (control)", async () => {
    for (const admission of ["granted", "unattended"] as const) {
      const r = rig({
        initialAdopted: false,
        mode: "linked",
        presence: presenceRecord(10, "stop"),
        liveness: "alive",
        watchAvailable: true,
        admission,
        existence: "gone",
      });
      await runTick(r);
      r.reads.liveness = "dead";
      await runTick(r);
      r.clock.now += GRACE * 5;
      await runTick(r);
      expect(r.attempts.count).toBe(1);
    }
  });
});

describe("startLifecycleObserver - presence-probe reuse", () => {
  it("background and none modes never probe presence", async () => {
    for (const mode of ["background", "none"] as const) {
      // Red on head: `observe()` unconditionally calls `reads.probePresence`
      // whenever a presence record parses, regardless of mode.
      const r = rig({
        initialAdopted: false,
        mode,
        presence: presenceRecord(10, "stop"),
        liveness: "alive",
        watchAvailable: true,
        admission: "granted",
        existence: "exists",
      });
      await runTick(r);
      r.clock.now += 1_000;
      await runTick(r);
      r.clock.now += 1_000;
      await runTick(r);
      r.clock.now += 1_000;
      await runTick(r);
      expect(r.probeCalls.count).toBe(0);
    }
  });

  it("an alive verdict is reused for the same pid+identity while runtime.processExists() === 'exists', within the reuse window", async () => {
    // Red on head: `LifecycleObserverRuntime` has no `processExists` seam and
    // `observe()` always re-probes, so this counts 4, not 1.
    const r = rig({
      initialAdopted: false,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "alive",
      watchAvailable: true,
      admission: "granted",
      existence: "exists",
    });
    await runTick(r);
    r.clock.now += 1_000;
    await runTick(r);
    r.clock.now += 2_000;
    await runTick(r);
    r.clock.now += 3_000;
    await runTick(r);
    expect(r.probeCalls.count).toBe(1);
  });

  it("re-probes once LIFECYCLE_PRESENCE_ALIVE_REUSE_MS has elapsed since the last probe (control-ish, exercises the constant)", async () => {
    const r = rig({
      initialAdopted: false,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "alive",
      watchAvailable: true,
      admission: "granted",
      existence: "exists",
    });
    await runTick(r);
    expect(r.probeCalls.count).toBe(1);
    r.clock.now += LIFECYCLE_PRESENCE_ALIVE_REUSE_MS;
    await runTick(r);
    expect(r.probeCalls.count).toBe(2);
  });

  it("existence 'gone' or 'unknown' forces a fresh probe every tick, never reusing an alive verdict", async () => {
    for (const existence of ["gone", "unknown"] as const) {
      const r = rig({
        initialAdopted: false,
        mode: "linked",
        presence: presenceRecord(10, "stop"),
        liveness: "alive",
        watchAvailable: true,
        admission: "granted",
        existence,
      });
      await runTick(r);
      r.clock.now += 1_000;
      await runTick(r);
      r.clock.now += 1_000;
      await runTick(r);
      expect(r.probeCalls.count).toBe(3);
    }
  });

  it("a new pid forces a fresh probe even inside the reuse window", async () => {
    const r = rig({
      initialAdopted: false,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "alive",
      watchAvailable: true,
      admission: "granted",
      existence: "exists",
    });
    await runTick(r);
    expect(r.probeCalls.count).toBe(1);
    r.reads.presence = presenceRecord(11, "stop");
    r.clock.now += 1_000;
    await runTick(r);
    expect(r.probeCalls.count).toBe(2);
  });

  it("dead and indeterminate verdicts are never reused - each tick probes again", async () => {
    for (const liveness of ["dead", "indeterminate"] as const) {
      const r = rig({
        initialAdopted: false,
        mode: "linked",
        presence: presenceRecord(10, "stop"),
        liveness,
        watchAvailable: true,
        admission: "granted",
        existence: "exists",
      });
      await runTick(r);
      r.clock.now += 1_000;
      await runTick(r);
      expect(r.probeCalls.count).toBe(2);
    }
  });
});

describe("startLifecycleObserver", () => {
  it("adopts late and republishes run state once", async () => {
    const r = rig({
      initialAdopted: false,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    await runTick(r);
    // Never seen alive: dead presence does not adopt, nothing is torn down.
    expect(r.attempts.count).toBe(0);
    r.reads.liveness = "alive";
    await runTick(r);
    expect(r.published.at(-1)).toEqual({ adopted: true, pid: 10 });
    const publishes = r.published.length;
    await runTick(r);
    expect(r.published.length).toBe(publishes);
  });

  it("holds the teardown until the grace has elapsed, then attempts it", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    r.clock.now = 1_000;
    await runTick(r);
    expect(r.attempts.count).toBe(0);
    r.clock.now = 1_000 + GRACE - 1;
    await runTick(r);
    expect(r.attempts.count).toBe(0);
    r.clock.now = 1_000 + GRACE;
    await runTick(r);
    expect(r.attempts.count).toBe(1);
    // The reconfirm re-reads and agrees.
    expect(r.reconfirmResults).toEqual([true]);
  });

  it("a record that goes missing (absent) after adoption still fires", async () => {
    // Rewritten from the earlier pin, which looped absent -> invalid ->
    // unreadable and asserted all three still fired. That was the defect: an
    // `invalid` or `unreadable` record is not evidence the desktop is gone,
    // only that this read could not confirm either way, and treating it as
    // `gone` fires a teardown on a read failure, not on absence. Only a
    // genuinely ABSENT record reads as gone here now; the invalid/unreadable
    // cases get their own dedicated reds below ("indeterminate records
    // never fire").
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "alive",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    await runTick(r);
    r.reads.liveness = "dead";
    await runTick(r);
    r.reads.presence = { kind: "absent" };
    r.clock.now += 1;
    await runTick(r);
    r.clock.now += GRACE;
    await runTick(r);
    expect(r.attempts.count).toBe(1);
  });

  it("indeterminate records (invalid/unreadable) never fire, past the grace, with no 'stop rule holds' line", async () => {
    for (const missing of [
      { kind: "invalid" },
      { kind: "unreadable", cause: "EACCES" },
    ] as const) {
      // Red on head: an invalid/unreadable presence read collapses to `null`
      // in `observe()` today, which reads exactly like `gone` and fires the
      // teardown after the grace - it must instead answer `unknown` and never
      // fire.
      const r = rig({
        initialAdopted: true,
        mode: "linked",
        presence: presenceRecord(10, "stop"),
        liveness: "alive",
        watchAvailable: true,
        admission: "granted",
        existence: "gone",
      });
      await runTick(r);
      r.reads.liveness = "dead";
      await runTick(r);
      r.reads.presence = missing;
      r.clock.now += GRACE * 5;
      const linesBefore = r.lines.length;
      await runTick(r);
      expect(r.attempts.count).toBe(0);
      expect(
        r.lines
          .slice(linesBefore)
          .some((line) => line.message.includes("stop rule holds")),
      ).toBe(false);
    }
  });

  it("indeterminate probes never fire", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "indeterminate",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    r.clock.now = 0;
    await runTick(r);
    r.clock.now = GRACE * 5;
    await runTick(r);
    expect(r.attempts.count).toBe(0);
  });

  it("keep, handoff, background and none never fire; a mode flip cancels a running clock", async () => {
    for (const onExit of ["keep", "handoff"] as const) {
      const r = rig({
        initialAdopted: true,
        mode: "linked",
        presence: presenceRecord(10, onExit),
        liveness: "dead",
        watchAvailable: true,
        admission: "granted",
        existence: "gone",
      });
      await runTick(r);
      r.clock.now = GRACE * 5;
      await runTick(r);
      expect(r.attempts.count).toBe(0);
    }
    for (const mode of ["background", "none"] as const) {
      const r = rig({
        initialAdopted: true,
        mode,
        presence: presenceRecord(10, "stop"),
        liveness: "dead",
        watchAvailable: true,
        admission: "granted",
        existence: "gone",
      });
      await runTick(r);
      r.clock.now = GRACE * 5;
      await runTick(r);
      expect(r.attempts.count).toBe(0);
    }
    const flip = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    await runTick(flip);
    flip.reads.policy = policyRecord("background", 2);
    flip.clock.now = GRACE - 1;
    await runTick(flip);
    flip.reads.policy = policyRecord("linked", 3);
    flip.clock.now = GRACE + 1;
    await runTick(flip);
    // The clock restarted at GRACE + 1, so it is not due yet.
    expect(flip.attempts.count).toBe(0);
    flip.clock.now = GRACE + 1 + GRACE;
    await runTick(flip);
    expect(flip.attempts.count).toBe(1);
  });

  it("unreadable policy is background and never fires", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    r.reads.policy = { kind: "unreadable", cause: "EIO" };
    await runTick(r);
    r.clock.now = GRACE * 3;
    await runTick(r);
    expect(r.attempts.count).toBe(0);
  });

  it("the poll alone observes and fires when fs.watch is unavailable", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: false,
      admission: "granted",
      existence: "gone",
    });
    expect(r.watch.installs).toBe(0);
    await runTick(r);
    r.clock.now = GRACE;
    await runTick(r);
    expect(r.attempts.count).toBe(1);
  });

  it("re-arms a failed watcher on the next tick", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "keep"),
      liveness: "alive",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    expect(r.watch.installs).toBe(1);
    await runTick(r);
    expect(r.watch.installs).toBe(1);
    r.watch.failed = true;
    await runTick(r);
    expect(r.watch.installs).toBe(2);
    expect(r.watch.closed).toBeGreaterThanOrEqual(1);
  });

  it("a watch event triggers a tick", async () => {
    const r = rig({
      initialAdopted: false,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "alive",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    r.watch.onChange?.();
    await r.settle();
    expect(r.published.at(-1)).toEqual({ adopted: true, pid: 10 });
  });

  it("coalesces triggers during a running tick into exactly one more tick", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    r.clock.now = 0;
    await runTick(r);
    r.clock.now = GRACE;
    let release: () => void = () => undefined;
    r.gateAttempt.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(r.attempts.count).toBe(1);
    // Five triggers while the tick is in flight.
    for (let i = 0; i < 5; i += 1) r.tick();
    r.teardownResults.push({ kind: "retry", reason: "x" });
    r.gateAttempt.promise = null;
    release();
    await r.settle();
    // One in-flight tick + exactly one coalesced follow-up.
    expect(r.attempts.count).toBe(2);
  });

  it("warns once on a repeated retry reason, then logs at debug", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    await runTick(r);
    r.clock.now = GRACE;
    r.teardownResults.push(
      { kind: "retry", reason: "cli-lock-busy" },
      { kind: "retry", reason: "cli-lock-busy" },
    );
    await runTick(r);
    await runTick(r);
    const warns = r.lines.filter(
      (l) => l.level === "warn" && l.fields["reason"] === "cli-lock-busy",
    );
    const debugs = r.lines.filter(
      (l) => l.level === "debug" && l.fields["reason"] === "cli-lock-busy",
    );
    expect(warns).toHaveLength(1);
    expect(debugs).toHaveLength(1);
    expect(Object.keys(warns[0].fields).sort()).toEqual([
      "admission",
      "reason",
    ]);
    expect(warns[0].fields).toEqual({
      reason: "cli-lock-busy",
      admission: "lifecycle-teardown-maintenance",
    });
  });

  it("a committed teardown resumes without re-reading the records", async () => {
    const r = rig({
      initialAdopted: false,
      mode: "linked",
      presence: presenceRecord(10, "keep"),
      liveness: "alive",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    r.setCommitted(true);
    r.teardownResults.push({ kind: "retry", reason: "host-survived" });
    await runTick(r);
    expect(r.attempts.count).toBe(1);
    // No observation happened: nothing was adopted or published.
    expect(r.published).toHaveLength(0);
    expect(r.reconfirmResults).toEqual([true]);
  });

  it("complete stops the observer and calls onTeardownComplete once, after the tick", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    await runTick(r);
    r.clock.now = GRACE;
    r.teardownResults.push({ kind: "complete" });
    r.tick();
    await r.settle();
    expect(r.completes.count).toBe(1);
    expect(r.cancelled.count).toBe(1);
    expect(r.watch.closed).toBeGreaterThanOrEqual(1);
    // Stopped: further triggers do nothing.
    r.tick();
    await r.settle();
    expect(r.completes.count).toBe(1);
    expect(r.attempts.count).toBe(1);
  });

  it("stop() during a tick lets it finish, idle resolves after, and aborted() is true", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    await runTick(r);
    r.clock.now = GRACE;
    let release: () => void = () => undefined;
    r.gateAttempt.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(r.abortedSeen.at(-1)).toBe(false);
    r.handle.stop();
    r.handle.stop();
    expect(r.cancelled.count).toBe(1);
    let idle = false;
    const idled = r.handle.idle().then(() => {
      idle = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(idle).toBe(false);
    release();
    await idled;
    expect(idle).toBe(true);
    expect(r.abortedSeen.at(-1)).toBe(true);
  });

  it("nudge() ticks immediately, coalesced like any other trigger", async () => {
    const r = rig({
      initialAdopted: false,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "alive",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    r.handle.nudge();
    await r.settle();
    expect(r.published.at(-1)).toEqual({ adopted: true, pid: 10 });
    r.handle.stop();
    const publishes = r.published.length;
    r.handle.nudge();
    await r.settle();
    expect(r.published.length).toBe(publishes);
  });

  it("while gated inside the lock, a fresh reconfirm that sees the desktop come back alive cancels - no commit", async () => {
    // Green on head: the reconfirm closure passed to `teardown.attempt` is a
    // fresh `observeAndApply()`, not the stale observation that triggered the
    // attempt, so a desktop that reappears while the attempt is gated inside
    // the lock is seen and the teardown stands down.
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
      admission: "granted",
      existence: "gone",
    });
    await runTick(r);
    r.clock.now = GRACE;
    let release: () => void = () => undefined;
    r.gateAttempt.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(r.attempts.count).toBe(1);
    // The desktop reappears while the attempt is gated inside the lock.
    r.reads.liveness = "alive";
    release();
    await r.settle();
    expect(r.reconfirmResults).toEqual([false]);
    expect(r.completes.count).toBe(0);
  });
});
