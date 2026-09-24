import { describe, expect, it } from "vitest";
import type { DesktopPresence } from "@traycer/protocol/config/desktop-presence";
import type {
  HostLifecycleMode,
  HostLifecyclePolicy,
} from "@traycer/protocol/config/host-lifecycle-policy";
import type { ILogger, LogFields } from "../../logger";
import type { Environment } from "../../runner/environment";
import type {
  DesktopPresenceLiveness,
  LifecycleRecordRead,
  ObservedDesktopPresence,
} from "../lifecycle-files";
import {
  applyLifecycleTick,
  evaluateStopRule,
  LIFECYCLE_OBSERVER_POLL_MS,
  LIFECYCLE_PRESENCE_CRASH_GRACE_MS,
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
  };
  const readsImpl: LifecycleRecordReads = {
    readPolicy: async () => reads.policy,
    readPresence: async () => reads.presence,
    probePresence: async () => reads.liveness,
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

describe("startLifecycleObserver", () => {
  it("adopts late and republishes run state once", async () => {
    const r = rig({
      initialAdopted: false,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "dead",
      watchAvailable: true,
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

  it("a record that goes missing after adoption still fires", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "alive",
      watchAvailable: true,
    });
    await runTick(r);
    r.reads.liveness = "dead";
    await runTick(r);
    for (const missing of [
      { kind: "absent" },
      { kind: "invalid" },
      { kind: "unreadable", cause: "EACCES" },
    ] as const) {
      r.reads.presence = missing;
      r.clock.now += 1;
      await runTick(r);
    }
    r.clock.now += GRACE;
    await runTick(r);
    expect(r.attempts.count).toBe(1);
  });

  it("indeterminate probes never fire", async () => {
    const r = rig({
      initialAdopted: true,
      mode: "linked",
      presence: presenceRecord(10, "stop"),
      liveness: "indeterminate",
      watchAvailable: true,
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
});
