import { watch } from "node:fs";
import { basename } from "node:path";
import {
  desktopPresencePath,
  type DesktopPresence,
  type DesktopPresenceOnExit,
} from "@traycer/protocol/config/desktop-presence";
import {
  hostLifecyclePolicyPath,
  type HostLifecycleMode,
  type HostLifecyclePolicy,
} from "@traycer/protocol/config/host-lifecycle-policy";
import type { Environment } from "../runner/environment";
import { errorFromUnknown, type ILogger } from "../logger";
import { hostHomeDir } from "../store/paths";
import {
  effectiveModeOf,
  type DesktopPresenceLiveness,
  type LifecycleRecordRead,
  type ObservedDesktopPresence,
} from "./lifecycle-files";
import {
  LIFECYCLE_TEARDOWN_ADMISSION,
  type LifecycleTeardown,
  type TeardownAttemptResult,
} from "./lifecycle-teardown";

// The supervisor's policy observer and its stop rule (lifecycle mechanics,
// "The policy observer and the stop rule"; critique round 1, R2).
//
// ONE observer per supervisor, for the supervisor's whole life after its
// first admitted spawn, WHATEVER mode was in force at spawn: a Background
// supervisor must notice a later switch to Linked, and a terminal-started run
// must become desktop-owned the moment a Linked desktop appears beside it -
// neither needs a host restart. Every tick re-reads BOTH records from disk
// and never acts on a value it read on an earlier tick.
//
// The observer only decides. What it decides is handed to the teardown
// actuator (`./lifecycle-teardown.ts`), which alone touches the host.

/** How often the observer re-reads both records when `fs.watch` is silent. */
export const LIFECYCLE_OBSERVER_POLL_MS = 5_000;

/**
 * How long the stop rule must hold before the supervisor stops its host.
 *
 * The crash grace: a desktop that crashes and is relaunched (by the user, by
 * the OS restoring the session) writes a fresh presence record within it, and
 * that record's live process resets the clock. A deliberate quit under a
 * `stop` verdict normally ends the host itself through the quit transaction;
 * this is the backstop for a crashed or force-killed app.
 */
export const LIFECYCLE_PRESENCE_CRASH_GRACE_MS = 30_000;

/** The observer's reads, the same seams the admission gate reads through. */
export interface LifecycleRecordReads {
  readonly readPolicy: (
    environment: Environment,
  ) => Promise<LifecycleRecordRead<HostLifecyclePolicy>>;
  readonly readPresence: (
    environment: Environment,
  ) => Promise<LifecycleRecordRead<DesktopPresence>>;
  readonly probePresence: (
    presence: DesktopPresence,
  ) => Promise<DesktopPresenceLiveness>;
}

// ---- The stop rule (pure) ---------------------------------------------------

/**
 * What one tick read, fresh from disk.
 *
 * `presence` is `null` when there is no well-formed record - absent, torn or
 * unreadable alike, the rule every reader of these files follows.
 */
export interface LifecycleTickObservation {
  readonly mode: HostLifecycleMode;
  /** The policy record's `rev`; `null` when no well-formed record exists. */
  readonly rev: number | null;
  readonly presence: ObservedDesktopPresence | null;
}

/**
 * - `holds` - every clause of the stop rule is positively true this tick.
 * - `does-not-hold` - at least one clause is positively false.
 * - `unknown` - nothing is false, but the presence probe could not tell
 *   whether the desktop is running (`indeterminate`). Never evidence of death:
 *   it neither starts the grace clock nor fires a teardown, and it does not
 *   reset a clock already running either - a process positively seen dead
 *   does not come back.
 */
export type StopRuleVerdict = "holds" | "does-not-hold" | "unknown";

/**
 * The stop rule itself:
 *
 * 1. the run is desktop-owned (`adopted`),
 * 2. the last verdict a well-formed record carried is `stop`,
 * 3. the presence process is positively dead, or the record is `gone`
 *    (missing or unreadable after adoption - distinct from never present,
 *    which clause 1 already excludes),
 * 4. the mode is neither `background` nor `none`.
 *
 * `keep` and `handoff` never stop.
 */
export function evaluateStopRule(input: {
  readonly adopted: boolean;
  readonly mode: HostLifecycleMode;
  readonly lastVerdict: DesktopPresenceOnExit | null;
  readonly presence: DesktopPresenceLiveness | "gone";
}): StopRuleVerdict {
  if (!input.adopted) return "does-not-hold";
  if (input.mode === "background" || input.mode === "none") {
    return "does-not-hold";
  }
  if (input.lastVerdict !== "stop") return "does-not-hold";
  switch (input.presence) {
    case "alive":
      return "does-not-hold";
    case "indeterminate":
      return "unknown";
    case "dead":
    case "gone":
      return "holds";
  }
}

/**
 * When the stop rule started holding, and for which desktop.
 *
 * Keyed by the presence record's pid: the grace measures ONE desktop's death,
 * so a different record - a relaunched desktop that wrote its own and then
 * died too - starts its own clock rather than inheriting the first one's.
 */
interface StopConditionClock {
  readonly sinceMs: number;
  readonly presencePid: number | null;
}

/** What the observer carries from one tick to the next. */
export interface LifecycleObserverState {
  /** A live presence has been observed during this run. Sticky. */
  readonly adopted: boolean;
  /**
   * The last well-formed presence record observed, as `supervisor-run.json`
   * reports it. Its `onExit` is the stop rule's "last observed verdict"; a
   * record that later goes missing leaves it in place.
   */
  readonly lastPresence: ObservedDesktopPresence | null;
  readonly mode: HostLifecycleMode;
  readonly rev: number | null;
  readonly condition: StopConditionClock | null;
}

export interface LifecycleTickResult {
  readonly state: LifecycleObserverState;
  readonly verdict: StopRuleVerdict;
  /** The rule has held past the grace: time to hand over to the actuator. */
  readonly teardownDue: boolean;
  /**
   * `adopted` or the last presence (pid, verdict, liveness) changed, so
   * `supervisor-run.json` is stale. A tick that only re-read the same facts
   * does not rewrite the file every five seconds.
   */
  readonly runStateChanged: boolean;
}

/** Fold one tick's fresh observation into the observer's state. */
export function applyLifecycleTick(
  previous: LifecycleObserverState,
  observation: LifecycleTickObservation,
  nowMs: number,
  graceMs: number,
): LifecycleTickResult {
  const presence = observation.presence;
  const adopted = previous.adopted || presence?.liveness === "alive";
  const lastPresence = presence ?? previous.lastPresence;
  const verdict = evaluateStopRule({
    adopted,
    mode: observation.mode,
    lastVerdict: lastPresence?.onExit ?? null,
    presence: presence === null ? "gone" : presence.liveness,
  });
  // A missing record continues the clock of the desktop it last named.
  const presencePid =
    presence?.pid ??
    previous.condition?.presencePid ??
    previous.lastPresence?.pid ??
    null;
  const sameDesktop =
    previous.condition !== null &&
    previous.condition.presencePid === presencePid;
  let condition: StopConditionClock | null;
  switch (verdict) {
    case "holds":
      condition =
        sameDesktop && previous.condition !== null
          ? previous.condition
          : { sinceMs: nowMs, presencePid };
      break;
    case "unknown":
      condition = sameDesktop ? previous.condition : null;
      break;
    case "does-not-hold":
      condition = null;
      break;
  }
  const state: LifecycleObserverState = {
    adopted,
    lastPresence,
    mode: observation.mode,
    rev: observation.rev,
    condition,
  };
  return {
    state,
    verdict,
    teardownDue:
      verdict === "holds" &&
      condition !== null &&
      nowMs - condition.sinceMs >= graceMs,
    runStateChanged:
      adopted !== previous.adopted ||
      !samePresenceFacts(lastPresence, previous.lastPresence),
  };
}

function samePresenceFacts(
  left: ObservedDesktopPresence | null,
  right: ObservedDesktopPresence | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.pid === right.pid &&
    left.onExit === right.onExit &&
    left.liveness === right.liveness
  );
}

// ---- The runner -------------------------------------------------------------

/** A live `fs.watch` on the host home; `failed` once it has errored. */
export interface HostHomeWatch {
  readonly close: () => void;
  readonly failed: () => boolean;
}

/**
 * The observer's clock, timers and watcher. Injected with the rest of the
 * supervisor's lifecycle seams so a test never arms a real interval or
 * watches a real host home.
 */
export interface LifecycleObserverRuntime {
  /** Monotonic milliseconds; the grace is measured on this, never wall time. */
  readonly nowMs: () => number;
  /**
   * Arm the ticks: `tick` once promptly (the first observation) and then
   * every `intervalMs`, never synchronously from inside this call. Returns
   * the canceller.
   */
  readonly scheduleTicks: (intervalMs: number, tick: () => void) => () => void;
  /**
   * Watch the host home for writes to the two records, or `null` when a
   * watch cannot be installed (the poll still runs).
   */
  readonly watchHostHome: (
    environment: Environment,
    onChange: () => void,
  ) => HostHomeWatch | null;
}

/**
 * Production runtime. The interval is deliberately NOT `unref()`ed: after a
 * committed teardown has stopped the child, a retrying actuator can be the
 * only thing this supervisor is still doing, and an unref'd timer would let
 * Node drain and exit 0 with `pid.json` and `supervisor.json` left behind.
 * The supervisor always leaves through `exitSupervisor`, which stops it.
 */
export const defaultLifecycleObserverRuntime: LifecycleObserverRuntime = {
  nowMs: () => performance.now(),
  scheduleTicks: (intervalMs, tick) => {
    const first = setImmediate(tick);
    const interval = setInterval(tick, intervalMs);
    return () => {
      clearImmediate(first);
      clearInterval(interval);
    };
  },
  watchHostHome: (environment, onChange) => {
    const home = hostHomeDir(environment);
    const names = new Set([
      basename(hostLifecyclePolicyPath(home)),
      basename(desktopPresencePath(home)),
    ]);
    let failed = false;
    try {
      // The host home also holds `host.log`, which the host appends to
      // constantly; the name filter keeps those events at a Set lookup. A
      // `null` filename (some platforms drop it) is treated as a change.
      const watcher = watch(home, (_event, filename) => {
        if (filename === null || names.has(String(filename))) onChange();
      });
      watcher.on("error", () => {
        failed = true;
        watcher.close();
      });
      return {
        close: () => {
          watcher.close();
        },
        failed: () => failed,
      };
    } catch {
      return null;
    }
  },
};

export interface LifecycleObserverInput {
  readonly environment: Environment;
  readonly logger: ILogger;
  readonly runtime: LifecycleObserverRuntime;
  readonly reads: LifecycleRecordReads;
  readonly nowIso: () => string;
  readonly pollMs: number;
  readonly graceMs: number;
  /** What the admission gate already knew: its observed presence, if any. */
  readonly initial: {
    readonly adopted: boolean;
    readonly lastPresence: ObservedDesktopPresence | null;
  };
  /** Rewrite `supervisor-run.json` with changed ownership facts. Never throws. */
  readonly publishRunState: (facts: {
    readonly adopted: boolean;
    readonly lastPresence: ObservedDesktopPresence | null;
  }) => Promise<void>;
  readonly teardown: LifecycleTeardown;
  /**
   * Called once, after the tick that completed the teardown has returned and
   * the observer has stopped itself: the supervisor exits 0 from here.
   */
  readonly onTeardownComplete: () => void;
}

export interface LifecycleObserverHandle {
  /**
   * Stop observing: synchronous and idempotent. Cancels the ticks, closes the
   * watcher, and tells a teardown that has not committed yet to stand down.
   * A tick already running finishes; `idle` resolves when it has.
   */
  readonly stop: () => void;
  readonly idle: () => Promise<void>;
  /**
   * Tick now rather than at the next poll (coalesced like any other trigger).
   * The supervisor's exit calls it when it starts waiting on a committed
   * teardown, whose remaining step may just have become possible.
   */
  readonly nudge: () => void;
}

/**
 * Start the observer. Ticks never overlap: a watch event or poll that lands
 * while a tick runs is coalesced into one more tick after it, so the Windows
 * presence probe (`tasklist` + PowerShell, seconds each) never stacks.
 */
export function startLifecycleObserver(
  input: LifecycleObserverInput,
): LifecycleObserverHandle {
  const { environment, logger, runtime } = input;
  let state: LifecycleObserverState = {
    adopted: input.initial.adopted,
    lastPresence: input.initial.lastPresence,
    mode: "background",
    rev: null,
    condition: null,
  };
  let stopped = false;
  let completed = false;
  let running = false;
  let pending = false;
  let idleWaiters: Array<() => void> = [];
  // The last retry reason logged at WARN; a teardown that keeps failing the
  // same way every five seconds says so once, then at DEBUG.
  let lastRetryReason: string | null = null;
  let watcher: HostHomeWatch | null = null;
  // Replaced by the real canceller once the ticks are armed, below.
  let cancelTicks = (): void => undefined;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancelTicks();
    watcher?.close();
    watcher = null;
  };

  const armWatcher = (): void => {
    if (stopped) return;
    if (watcher !== null && !watcher.failed()) return;
    watcher?.close();
    watcher = runtime.watchHostHome(environment, () => {
      requestTick();
    });
  };

  const observe = async (): Promise<LifecycleTickObservation> => {
    const policyRead = await input.reads.readPolicy(environment);
    const presenceRead = await input.reads.readPresence(environment);
    let presence: ObservedDesktopPresence | null = null;
    if (presenceRead.kind === "valid") {
      presence = {
        pid: presenceRead.record.pid,
        onExit: presenceRead.record.onExit,
        liveness: await input.reads.probePresence(presenceRead.record),
        observedAt: input.nowIso(),
      };
    }
    return {
      mode: effectiveModeOf(policyRead),
      rev: policyRead.kind === "valid" ? policyRead.record.rev : null,
      presence,
    };
  };

  // One fresh read, folded into the state, with its side effects: the
  // transition log lines and a run-state rewrite when ownership changed.
  const observeAndApply = async (): Promise<LifecycleTickResult> => {
    const observation = await observe();
    const previous = state;
    const result = applyLifecycleTick(
      previous,
      observation,
      runtime.nowMs(),
      input.graceMs,
    );
    state = result.state;
    const fields = {
      mode: state.mode,
      rev: state.rev,
      verdict: state.lastPresence?.onExit ?? null,
    };
    if (state.adopted && !previous.adopted) {
      logger.info("Host supervisor run is now owned by a live desktop", fields);
    }
    if (state.condition !== null && previous.condition === null) {
      logger.info(
        "Host lifecycle stop rule holds; waiting out the crash grace",
        fields,
      );
    }
    if (state.condition === null && previous.condition !== null) {
      logger.info("Host lifecycle stop rule no longer holds", {
        ...fields,
        reason: describeClearedCondition(state, observation),
      });
    }
    if (result.runStateChanged) {
      await input.publishRunState({
        adopted: state.adopted,
        lastPresence: state.lastPresence,
      });
    }
    return result;
  };

  const settle = (result: TeardownAttemptResult): void => {
    switch (result.kind) {
      case "complete":
        completed = true;
        stop();
        return;
      case "cancelled":
        // The fresh read inside the lock no longer satisfied the rule (the
        // observation that said so has already moved the clock), or the
        // supervisor began exiting for another reason first.
        logger.info("Host lifecycle teardown stood down before committing", {
          reason: result.reason,
        });
        lastRetryReason = null;
        return;
      case "retry":
        if (result.reason !== lastRetryReason) {
          logger.warn(
            "Host lifecycle teardown step could not complete; retrying on the next tick",
            { reason: result.reason, admission: LIFECYCLE_TEARDOWN_ADMISSION },
          );
          lastRetryReason = result.reason;
        } else {
          logger.debug("Host lifecycle teardown still retrying", {
            reason: result.reason,
          });
        }
        return;
    }
  };

  const tickOnce = async (): Promise<void> => {
    armWatcher();
    // Committed: the host has been told to stop and the supervisor owes the
    // rest of the sequence whatever the records now say.
    if (input.teardown.committed()) {
      settle(
        await input.teardown.attempt(
          async () => true,
          () => stopped,
        ),
      );
      return;
    }
    const result = await observeAndApply();
    if (!result.teardownDue || stopped) return;
    settle(
      await input.teardown.attempt(
        // Re-read inside the lock: the decision to commit is taken on what
        // the records say NOW, not on the observation that sent us here.
        async () => (await observeAndApply()).teardownDue,
        () => stopped,
      ),
    );
  };

  const requestTick = (): void => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          pending = false;
          try {
            await tickOnce();
          } catch (cause) {
            // A tick is evidence-gathering plus a bounded actuator; neither
            // may take the supervisor down. The next tick starts clean.
            logger.warn("Host lifecycle observer tick failed", {
              reason: "tick-threw",
              errorName: errorFromUnknown(cause).name,
            });
          }
        } while (pending && !stopped);
      } finally {
        running = false;
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
        if (completed) {
          completed = false;
          input.onTeardownComplete();
        }
      }
    })();
  };

  armWatcher();
  cancelTicks = runtime.scheduleTicks(input.pollMs, requestTick);

  return {
    stop,
    nudge: requestTick,
    idle: () =>
      running
        ? new Promise<void>((resolve) => {
            idleWaiters.push(resolve);
          })
        : Promise.resolve(),
  };
}

// Why a running clock was reset, as a bounded enum for the INFO line.
function describeClearedCondition(
  state: LifecycleObserverState,
  observation: LifecycleTickObservation,
): string {
  if (state.mode === "background" || state.mode === "none") {
    return "mode-changed";
  }
  if (state.lastPresence?.onExit !== "stop") return "verdict-changed";
  if (observation.presence?.liveness === "alive") return "desktop-alive";
  return "presence-changed";
}
