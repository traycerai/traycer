import type { DesktopPresenceOnExit } from "@traycer/protocol/config/desktop-presence";
import {
  refreshOnModeChange,
  type HostLifecycleMode,
  type HostLifecyclePolicy,
} from "@traycer/protocol/config/host-lifecycle-policy";
import type {
  HostLifecycleRunAdmission,
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
  HostLifecycleStopChoice,
  HostLifecycleView,
  LocalHostCapability,
} from "../../ipc-contracts/host-lifecycle-types";
import { log, type SafeLogFields } from "../app/logger";
import type {
  ApplyStagedOk,
  ApplyStagedTrigger,
  ConvergeReadyOk,
  ConvergeReadyVersionPolicy,
  GuardedMutationOutcome,
  LocalHostMutationIntent,
  MutationOutcome,
  ServiceDefinitionRefreshOk,
  StopHostOutcome,
  StopHostRequest,
} from "./host-controller-types";
import type { AutomaticIntentHold } from "./host-controller";
import type {
  DesktopPresenceWriteOutcome,
  HostLifecyclePolicyRead,
  HostLifecyclePolicyStore,
} from "./host-lifecycle-policy";

// Desktop main's side of the host lifecycle modes: the mode transitions with
// their commit boundary, the presence verdict this desktop publishes, and the
// renderer-facing view with its change event.
//
// The CLI is a co-writer of the policy (`traycer host lifecycle set`), so
// every decision here starts with a fresh read of the file and every side
// effect is stamped with the `rev` it acted on. Its writes are OBSERVED and
// never replayed destructively: an observed change rewrites this desktop's
// (non-destructive) presence verdict and refreshes the view, and a CLI-written
// `none` stops nothing - it takes effect at the next launch, as the CLI verb
// documents.

/** How often the view is re-derived when no watcher edge arrived. */
export const HOST_LIFECYCLE_OBSERVATION_POLL_MS = 15_000;

/** The modes whose promise needs a supervisor that enforces the policy. */
const SUPERVISOR_ENFORCED_MODES: ReadonlySet<HostLifecycleMode> = new Set([
  "linked",
  "ask",
  "stop-if-idle",
]);

/**
 * The presence verdict a mode publishes while the app runs. Linked's promise
 * is that the host ends with the app, so its verdict is `stop` (the
 * supervisor's backstop for a crashed or force-killed app); every other mode
 * leaves the host running unless a quit decides otherwise, which the quit
 * transaction writes itself. A CLI-written `none` observed mid-session is
 * `keep`: it takes effect at the next launch and stops nothing now.
 */
export function presenceVerdictForMode(
  mode: HostLifecycleMode,
): DesktopPresenceOnExit {
  return mode === "linked" ? "stop" : "keep";
}

/** The slice of `HostController` the transitions drive. */
export interface HostLifecycleTransitionsController {
  convergeReady(
    force: boolean,
    intent: LocalHostMutationIntent,
    versionPolicy: ConvergeReadyVersionPolicy,
  ): Promise<GuardedMutationOutcome<ConvergeReadyOk>>;
  applyStaged(
    trigger: ApplyStagedTrigger,
    force: boolean,
  ): Promise<MutationOutcome<ApplyStagedOk>>;
  stopHost(request: StopHostRequest): Promise<StopHostOutcome>;
  refreshServiceDefinition(): Promise<
    MutationOutcome<ServiceDefinitionRefreshOk>
  >;
  quiesce(): void;
  holdAutomaticIntents(): AutomaticIntentHold;
  deferMutationsUntil(barrier: Promise<unknown>): void;
}

/** The slice of `HostLifecycle` that observes the host home. */
export interface HostLifecycleRecordWatch {
  watchLifecycleRecords(): Promise<void>;
  onLifecycleRecordsChanged(listener: () => void): () => void;
}

export interface HostLifecycleServiceOptions {
  readonly store: HostLifecyclePolicyStore;
  readonly controller: HostLifecycleTransitionsController;
  readonly records: HostLifecycleRecordWatch;
  /** This instance's boot capability; see `local-host-capability.ts`. */
  readonly localHostCapability: LocalHostCapability;
  readonly pollIntervalMs: number;
}

/**
 * What writing a quit verdict did.
 *
 * - `written` / `identity-unavailable` - see `DesktopPresenceWriteOutcome`.
 * - `no-local-host` - this instance runs no local-host lanes (booted in
 *   `none`, or `none` was committed), so it publishes no presence at all.
 * - `write-failed` - the write itself failed; the previous record stands.
 */
export type QuitVerdictWriteOutcome =
  | DesktopPresenceWriteOutcome
  | "no-local-host"
  | "write-failed";

/** See `HostLifecycleService.readQuitPolicy`. */
export interface QuitPolicyRead {
  readonly mode: HostLifecycleMode;
  readonly rev: number;
}

/** The policy a presence verdict was derived from. */
interface PolicyStamp {
  readonly rev: number;
  readonly mode: HostLifecycleMode;
}

/** A presence this process wrote and saw land. */
interface LandedPresence extends PolicyStamp {
  readonly onExit: DesktopPresenceOnExit;
}

/**
 * `applySetMode`'s answer when the change is a `→ none` that needs its stop:
 * the stop runs off the serialized chain (see `commitNone`).
 */
interface NoneStopFirst {
  readonly kind: "stop-first";
  readonly stop: HostLifecycleStopChoice;
  readonly observed: HostLifecyclePolicyRead;
}

/**
 * A failure's errno-style code, or `null`. What the lifecycle log lines carry
 * instead of the error text: a filesystem message names the host home path,
 * which a support-pasted INFO+ line does not need.
 */
function errnoCode(error: unknown): string | null {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

export class HostLifecycleService {
  private readonly store: HostLifecyclePolicyStore;
  private readonly controller: HostLifecycleTransitionsController;
  private readonly records: HostLifecycleRecordWatch;
  private readonly localHostCapability: LocalHostCapability;
  private readonly pollIntervalMs: number;

  /**
   * Every write, observation and transition runs one at a time, in order.
   * Nothing on it waits on the host: `→ none`'s stop runs off it, so a
   * job here is file I/O and at most this process's identity probe.
   */
  private chain: Promise<void> = Promise.resolve();
  /** `none` was committed from this session: the lanes are off until restart. */
  private noneCommitted = false;
  /**
   * The presence this process last saw land - its verdict and the policy
   * `(rev, mode)` it was derived from - or `null` until one lands. What an
   * observation compares against; see `observe`.
   */
  private landed: LandedPresence | null = null;
  /**
   * Presence writes that failed since the last one that landed. The first
   * failure of a streak is a WARN and the rest are DEBUG: the observation tick
   * retries every `pollIntervalMs` until one lands, and a line per tick would
   * bury the one that says why.
   */
  private presenceFailures = 0;
  /**
   * The verdict a quit wrote (`handoff`, or a quit prompt's answer). While it
   * is held, a mode change or an observed CLI write does not overwrite it:
   * the quit's answer is what the supervisor must enforce once the app is
   * gone.
   */
  private quitVerdict: DesktopPresenceOnExit | null = null;
  /**
   * How the running supervisor's run was started, as the last derived view
   * read it (`currentRunAdmission`); `null` before the first one.
   */
  private viewRunAdmission: HostLifecycleRunAdmission | null = null;
  /**
   * The same, as the last OBSERVATION read it: what `observe` compares the
   * next read against to see a terminal run end. Kept apart from
   * `viewRunAdmission` so a `getView` between two observations cannot consume
   * that edge.
   */
  private observedRunAdmission: HostLifecycleRunAdmission | null = null;
  private observationQueued = false;
  private lastEmittedViewKey: string | null = null;
  private readonly listeners = new Set<(view: HostLifecycleView) => void>();
  private disposeWatch: (() => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(options: HostLifecycleServiceOptions) {
    this.store = options.store;
    this.controller = options.controller;
    this.records = options.records;
    this.localHostCapability = options.localHostCapability;
    this.pollIntervalMs = options.pollIntervalMs;
  }

  /** Whether this instance runs the local-host lanes right now. */
  private lanesActive(): boolean {
    return this.localHostCapability === "managed" && !this.noneCommitted;
  }

  // ---- Reads -----------------------------------------------------------------

  /** A fresh read of the policy, for a caller deciding on it (the quit path). */
  readPolicy(): Promise<HostLifecyclePolicyRead> {
    return this.store.readPolicy();
  }

  /** Whether this instance runs the local-host lanes right now. */
  localHostLanesActive(): boolean {
    return this.lanesActive();
  }

  /**
   * The mode a quit, or a closing last window, acts on: a fresh read of the
   * policy while this instance runs the local-host lanes, and `none` once they
   * are off (booted in `none`, or `none` committed this session) - there is
   * no local host to keep or stop then, whatever the file says. A CLI-written
   * `none` observed while the lanes still run reads as `none` too: it takes
   * effect at the next launch and stops nothing now.
   */
  async readQuitPolicy(): Promise<QuitPolicyRead> {
    const read = await this.store.readPolicy();
    return {
      mode: this.lanesActive() ? read.mode : "none",
      rev: read.rev,
    };
  }

  async getView(): Promise<HostLifecycleView> {
    const read = await this.store.readPolicy();
    const run = await this.store.readSupervisorRun();
    this.viewRunAdmission = run.admittedAs;
    // Restart-to-apply is judged against the BOOT capability, which is what
    // both processes act on until the next launch - including the renderer,
    // whose local-host surfaces a committed `none` does not take away. Once
    // `none` is committed the lanes are off for this session whatever is
    // chosen next, so every mode then needs the restart.
    //
    // `restart-host` is a running host that does not apply an enforced mode
    // until it restarts: an older supervisor, or one a person started in a
    // terminal, which the mode never governs. Only that person restarts the
    // second; the view says which through `admittedAs`, and the renderer
    // offers no restart for it.
    const bootedWithoutLocalHost = this.localHostCapability === "none";
    const runIgnoresMode =
      run.state === "not-enforcing" || run.admittedAs === "foreground";
    const pending =
      this.noneCommitted || (read.mode === "none") !== bootedWithoutLocalHost
        ? "restart-app"
        : runIgnoresMode && SUPERVISOR_ENFORCED_MODES.has(read.mode)
          ? "restart-host"
          : "none";
    return {
      desired: {
        mode: read.mode,
        rev: read.rev,
        updatedBy: read.policy === null ? null : read.policy.updatedBy,
        updatedAt: read.policy === null ? null : read.policy.updatedAt,
      },
      applied: {
        localHostCapability: this.localHostCapability,
        supervisor: run.state,
        admittedAs: run.admittedAs,
      },
      pending,
    };
  }

  /**
   * How the running supervisor's run was started, read fresh: `foreground`
   * for a host a person started in a terminal, which this app leaves alone.
   * `null` when no live supervisor record says (none, a dead one's leftover,
   * or one from a CLI that predates the field). Never rejects.
   */
  async readRunAdmission(): Promise<HostLifecycleRunAdmission | null> {
    try {
      return (await this.store.readSupervisorRun()).admittedAs;
    } catch {
      return null;
    }
  }

  /**
   * `readRunAdmission` as the last derived view read it, for a caller that
   * cannot wait (the tray and app menus): `null` before the first view. Every
   * `onChange` notification is derived after it is updated.
   */
  currentRunAdmission(): HostLifecycleRunAdmission | null {
    return this.viewRunAdmission;
  }

  /** See `HostLifecyclePolicyStore.readIdentifiedSupervisorPid`. */
  readIdentifiedSupervisorPid(): Promise<number | null> {
    return this.store.readIdentifiedSupervisorPid();
  }

  onChange(listener: (view: HostLifecycleView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- Launch, observation, teardown ------------------------------------------

  /**
   * Launch: publish the launch presence and hold the controller's mutation
   * lane on it (`HostController.deferMutationsUntil`), so it lands before any
   * converge can spawn the CLI - a supervisor that desktop's own grant admits,
   * and a crash relaunch shortly after, both see a live presence. The lane is
   * held rather than first paint waiting: the record needs this process's
   * start identity, which on Windows is a PowerShell probe.
   *
   * The hold covers only mutations submitted after it, so launch calls this
   * as soon as the controller and this service exist, before anything can
   * submit one. Returns the write, which settles once the record is on disk -
   * at once with the lanes off, when nothing is written.
   */
  holdLaneOnLaunchPresence(): Promise<void> {
    const launchPresence = this.writeLaunchPresence();
    this.controller.deferMutationsUntil(launchPresence);
    return launchPresence;
  }

  /**
   * The launch presence: this process with the mode's verdict, stamped with
   * the policy `rev` it read; see `holdLaneOnLaunchPresence`. Writes nothing
   * while the lanes are off. Never rejects.
   */
  writeLaunchPresence(): Promise<void> {
    return this.serialize(async () => {
      if (!this.lanesActive()) return;
      const read = await this.store.readPolicy();
      await this.publishPresence(presenceVerdictForMode(read.mode), read);
    });
  }

  /**
   * Start following the host home: the directory watcher is the primary
   * signal, and an unref'd poll is the backstop for an edge the platform
   * dropped (macOS FSEvents coalesces, and a watcher can die) - it also
   * re-installs a dead watcher. Every tick re-reads and emits only when the
   * view changed.
   */
  startObserving(): void {
    if (this.disposed || this.disposeWatch !== null) return;
    this.disposeWatch = this.records.onLifecycleRecordsChanged(() => {
      this.scheduleObservation();
    });
    void this.records.watchLifecycleRecords().catch((error: unknown) => {
      log.warn("[host-lifecycle] lifecycle record watch failed", {
        reason: "watch-failed",
        code: errnoCode(error),
      });
    });
    const timer = setInterval(() => {
      void this.records.watchLifecycleRecords().catch(() => undefined);
      this.scheduleObservation();
    }, this.pollIntervalMs);
    timer.unref();
    this.pollTimer = timer;
    this.scheduleObservation();
  }

  dispose(): void {
    this.disposed = true;
    this.disposeWatch?.();
    this.disposeWatch = null;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.listeners.clear();
  }

  private scheduleObservation(): void {
    if (this.disposed || this.observationQueued) return;
    this.observationQueued = true;
    void this.serialize(async () => {
      this.observationQueued = false;
      await this.observe();
    });
  }

  /**
   * One observation: bring the presence on disk to the verdict it should
   * carry now, then refresh the view.
   *
   * It follows a policy change nobody in this process made (the CLI) with a
   * non-destructive presence rewrite. The change is recognised by the
   * policy's `(rev, mode)`, never by `rev` alone: both writers write one past
   * the `rev` they read, so a CLI write racing this desktop's can land at the
   * SAME `rev` with another mode, and a verdict derived from the loser's mode
   * would stand for the rest of the session.
   *
   * It is also the retry of a presence that never landed - an identity probe
   * that timed out on a loaded machine, or a failed write, a quit verdict's
   * and a release's included. Without one the supervisor never adopts
   * this desktop, or enforces a verdict nobody chose, so Linked's promise
   * (the host ends with the app, crash included) silently does not hold
   * The supervisor adopts on whichever tick first sees the
   * presence alive, so a late write restores it. A held quit verdict is what
   * gets published if one is held, and a policy change under it does not
   * restamp it; with the lanes off there is nothing to publish.
   */
  private async observe(): Promise<void> {
    const read = await this.store.readPolicy();
    if (this.lanesActive()) {
      const onExit = this.quitVerdict ?? presenceVerdictForMode(read.mode);
      const landed = this.landed;
      const policyMoved =
        this.quitVerdict === null &&
        landed !== null &&
        (landed.rev !== read.rev || landed.mode !== read.mode);
      if (landed === null || landed.onExit !== onExit || policyMoved) {
        if (policyMoved) {
          log.info("[host-lifecycle] policy changed outside this app", {
            mode: read.mode,
            rev: read.rev,
          });
        }
        await this.publishPresence(onExit, read);
      }
    }
    await this.followTerminalRun();
    await this.emitIfChanged();
  }

  /**
   * Finish an update a terminal run held back, once that run is gone.
   *
   * A host a person started in a terminal refuses every update this app would
   * make (`E_HOST_NOT_SERVICE_RUN`), so a stage that is ready while it runs
   * waits on it, and the renderer says "stop it to finish the update". When
   * an observation finds that run ended - its record gone, stale, or a
   * service run in its place - this runs the launch reconcile's own step,
   * `applyStaged("launch")` (`host apply --respect-hold`): a no-op with
   * nothing staged, and a deliberately held version stays. Without it the
   * next start - the selection authority's or the health monitor's, both
   * `--keep-installed` - would bring the old bytes back and leave the stage
   * waiting for the next launch.
   *
   * With the lanes off there is no local host for this app to start. The
   * apply runs on the controller's lane, off this chain; its outcome is only
   * logged.
   */
  private async followTerminalRun(): Promise<void> {
    const previous = this.observedRunAdmission;
    const run = await this.store.readSupervisorRun();
    this.observedRunAdmission = run.admittedAs;
    if (previous !== "foreground" || run.admittedAs === "foreground") return;
    if (!this.lanesActive()) return;
    log.info("[host-lifecycle] terminal host run ended", {
      reason: "terminal-run-ended",
    });
    void this.controller.applyStaged("launch", false).then(
      (outcome) => {
        log.info("[host-lifecycle] update after the terminal run settled", {
          reason: outcome.kind,
        });
      },
      () => {
        log.warn("[host-lifecycle] update after the terminal run settled", {
          reason: "threw",
        });
      },
    );
  }

  // ---- Mode transitions ------------------------------------------------------

  /**
   * Change the mode, with the commit boundary of the lifecycle mechanics'
   * transition table:
   *
   * - `→ background | ask | stop-if-idle | linked`: write the policy, then
   *   rewrite the presence verdict for it; `→ linked` also brings a down host
   *   up.
   * - `→ none` from a desktop running the lanes: the confirmed stop first
   *   (`request.stop`), and only once it succeeded write the policy, remove
   *   the presence and quiesce the automatic intents. A refused or failed stop
   *   commits nothing. A stop that finds only a host a person started in a
   *   terminal (`not-service-run`) commits too: the mode governs the service
   *   run alone, there is none to stop, and that host is left running.
   * - Anything while the lanes are off (booted in `none`, or `none` committed
   *   this session): write the policy only - it takes effect at the next
   *   launch.
   *
   * Setting the mode the file already has writes nothing.
   */
  async setMode(
    request: HostLifecycleSetRequest,
  ): Promise<HostLifecycleSetResult> {
    const step = await this.serialize(async () => {
      const decided = await this.applySetMode(request);
      if (decided.kind !== "stop-first") await this.emitIfChanged();
      return decided;
    });
    if (step.kind !== "stop-first") return step;
    return this.commitNone(step.stop, step.observed);
  }

  private async applySetMode(
    request: HostLifecycleSetRequest,
  ): Promise<HostLifecycleSetResult | NoneStopFirst> {
    const current = await this.store.readPolicy();
    const lanesActive = this.lanesActive();
    // `none` while the lanes still run is never "already applied": it may be a
    // CLI-written `none` waiting for the next launch, and choosing it here is
    // a request to apply it now, which needs the stop.
    if (request.mode === "none" && lanesActive) {
      if (request.stop === null) {
        return {
          kind: "failed",
          reason: "confirmation-required",
          message:
            "Turning off the local host stops Traycer Host. Confirm the stop to continue.",
          view: await this.getView(),
        };
      }
      return { kind: "stop-first", stop: request.stop, observed: current };
    }
    if (current.mode === request.mode) {
      return { kind: "applied", view: await this.getView() };
    }
    let written: HostLifecyclePolicy;
    try {
      written = await this.store.writePolicy(request.mode);
    } catch (error) {
      return this.writeFailed(request.mode, error);
    }
    // Before the lanes test on purpose: a mode chosen while this launch runs
    // no local host still governs the next login start, and the refresh
    // starts and stops nothing.
    this.refreshDefinitionAfterWrite(current.mode, request.mode);
    if (!lanesActive) {
      return { kind: "applied", view: await this.getView() };
    }
    if (this.quitVerdict === null) {
      await this.publishPresence(presenceVerdictForMode(request.mode), written);
    }
    if (request.mode === "linked") {
      void this.convergeIfDown(written.rev);
    }
    return { kind: "applied", view: await this.getView() };
  }

  /**
   * After a policy write that parks (`refreshOnModeChange`): bring the
   * registered service definition to the current launcher through the
   * controller's one `host service refresh` lane call, so a definition that
   * predates labelled starts cannot run the host at the next login under a
   * mode meant to park it. The CLI's `lifecycle set` runs the same refresh
   * for its own writes.
   *
   * Off the serialized chain: the write is the commitment and the result is
   * `applied` either way, so a refresh waiting on the CLI lock must not hold
   * up the next observation. A failure is logged by its outcome kind alone
   * (no path, no id), and the doctor's HOST_SERVICE_DEFINITION_STALE is the
   * surface that offers the retry.
   */
  private refreshDefinitionAfterWrite(
    previous: HostLifecycleMode,
    next: HostLifecycleMode,
  ): void {
    if (!refreshOnModeChange(previous, next)) return;
    void this.controller
      .refreshServiceDefinition()
      .then((outcome) => {
        if (outcome.kind === "ok") {
          log.info("[host-lifecycle] service definition refreshed", {
            mode: next,
            result: outcome.value.result,
            appliesAt: outcome.value.appliesAt,
          });
          return;
        }
        log.warn("[host-lifecycle] service definition refresh failed", {
          mode: next,
          reason: outcome.kind,
        });
      })
      .catch(() => {
        log.warn("[host-lifecycle] service definition refresh failed", {
          mode: next,
          reason: "threw",
        });
      });
  }

  /**
   * `→ none` from a desktop running the lanes: the confirmed stop, then the
   * commit. The automatic intents - and every other host start - are held
   * from before the stop until the commit has quiesced them or did not
   * happen, so nothing brings the host back in between; a refused stop
   * leaves the session exactly as it was.
   *
   * The stop runs OFF the serialized chain. It is an attached CLI child
   * that waits its turn on the controller's lane and cannot be withdrawn once
   * it runs, so holding the chain across it held every quit verdict, release,
   * observation and mode change behind it - an update install's `handoff`
   * included - for as long as the stop took. The commit runs on the chain
   * and re-reads the policy there.
   */
  private async commitNone(
    stop: HostLifecycleStopChoice,
    observed: HostLifecyclePolicyRead,
  ): Promise<HostLifecycleSetResult> {
    const hold = this.controller.holdAutomaticIntents();
    let result: HostLifecycleSetResult;
    try {
      const outcome = await this.controller.stopHost({
        mode: stop,
        spawn: "attached",
        withdrawal: null,
      });
      // `not-service-run`: the host running is a terminal's `traycer host
      // start`, which the mode never governs, so there is no service run
      // to stop and `none` commits over it, leaving that host alone.
      result =
        outcome.kind === "stopped" || outcome.kind === "not-service-run"
          ? await this.serialize(async () => {
              const committed = await this.commitNoneAfterStop(
                stop,
                outcome.kind,
                observed,
              );
              await this.emitIfChanged();
              return committed;
            })
          : await this.stopNotCommitted(outcome);
    } finally {
      hold.release();
    }
    // A `→ linked` chosen while the stop ran superseded this `none`: its
    // converge was refused under the hold, and the stop has since taken the
    // host down. Now that nothing holds the host starts, bring it up.
    if (
      result.kind === "superseded" &&
      result.view.desired.mode === "linked" &&
      this.lanesActive()
    ) {
      void this.convergeIfDown(result.view.desired.rev);
    }
    return result;
  }

  /**
   * `commitNone`'s commit, once the stop succeeded or found only a terminal's
   * run (`not-service-run`). Runs on the chain.
   */
  private async commitNoneAfterStop(
    stop: HostLifecycleStopChoice,
    stopped: "stopped" | "not-service-run",
    observed: HostLifecyclePolicyRead,
  ): Promise<HostLifecycleSetResult> {
    // A second `→ none` whose stop queued behind this one's on the lane:
    // the first already committed, so there is nothing left to do.
    if (!this.lanesActive()) {
      return { kind: "applied", view: await this.getView() };
    }
    // The stop is irreversible; the policy is not written yet. Re-read: a
    // newer choice written while the stop ran (the CLI, or this app - the
    // chain was free meanwhile) must not be overwritten by this older one.
    const after = await this.store.readPolicy();
    if (after.rev !== observed.rev && after.mode !== "none") {
      log.info("[host-lifecycle] none superseded by a newer policy", {
        mode: after.mode,
        rev: after.rev,
        reason: "superseded",
      });
      return { kind: "superseded", view: await this.getView() };
    }
    // Already `none` on disk (a CLI `none` applied from here, or one the CLI
    // wrote while the stop ran): the choice is recorded, nothing to write.
    if (after.mode !== "none") {
      try {
        await this.store.writePolicy("none");
      } catch (error) {
        return this.writeFailed("none", error);
      }
      // Only for this write: an `after` that already says `none` was
      // written by the CLI, whose own `lifecycle set` ran the refresh.
      this.refreshDefinitionAfterWrite(after.mode, "none");
    }
    await this.store.removeOwnPresence();
    this.landed = null;
    this.noneCommitted = true;
    this.controller.quiesce();
    log.info("[host-lifecycle] none committed", {
      mode: "none",
      reason:
        stopped === "not-service-run"
          ? "not-service-run"
          : stop === "force"
            ? "stopped-forced"
            : "stopped-idle",
    });
    return { kind: "applied", view: await this.getView() };
  }

  private async stopNotCommitted(
    outcome: Exclude<
      StopHostOutcome,
      { readonly kind: "stopped" | "not-service-run" }
    >,
  ): Promise<HostLifecycleSetResult> {
    const view = await this.getView();
    switch (outcome.kind) {
      case "host-busy":
        return {
          kind: "stop-refused",
          reason: "host-busy",
          message: outcome.message,
          view,
        };
      case "lock-busy":
        return {
          kind: "stop-refused",
          reason: "lock-busy",
          message: outcome.message,
          view,
        };
      case "update-active":
        return {
          kind: "stop-refused",
          reason: "update-active",
          message: outcome.message,
          view,
        };
      case "withdrawn":
        return {
          kind: "failed",
          reason: "stop-failed",
          message: "The host stop was withdrawn before it ran.",
          view,
        };
      case "failed":
        return {
          kind: "failed",
          reason: "stop-failed",
          message: outcome.message,
          view,
        };
    }
  }

  private async writeFailed(
    mode: HostLifecycleMode,
    error: unknown,
  ): Promise<HostLifecycleSetResult> {
    log.warn("[host-lifecycle] policy write failed", {
      mode,
      reason: "write-failed",
      code: errnoCode(error),
    });
    return {
      kind: "failed",
      reason: "write-failed",
      message: `The host lifecycle setting could not be saved: ${String(error)}`,
      view: await this.getView(),
    };
  }

  /**
   * `→ linked` promises a host running beside the app, so a host that is down
   * is brought up - through the background converge, which honours the
   * removed-by-user sentinel and the automatic-intent suspension like every
   * other automatic start. Fire-and-forget: the transition has already
   * committed, and the outcome is only logged.
   */
  private async convergeIfDown(rev: number): Promise<void> {
    const supervisor = await this.store.readSupervisorState();
    if (supervisor !== "not-running") return;
    const outcome = await this.controller.convergeReady(
      false,
      { kind: "background" },
      "keep-installed",
    );
    log.info("[host-lifecycle] linked converge settled", {
      mode: "linked",
      rev,
      reason: outcome.kind,
    });
  }

  // ---- Presence verdicts -----------------------------------------------------

  /**
   * The quit path's verdict: `handoff` for an update-install quit, or the quit
   * prompt's `keep` / `stop`. Held until `releaseQuitVerdict`, so no mode
   * change or observed CLI write overwrites what the supervisor must enforce
   * once the app is gone. A write that fails is retried by the next
   * observation, like every presence that did not land.
   */
  writeQuitVerdict(
    onExit: DesktopPresenceOnExit,
  ): Promise<QuitVerdictWriteOutcome> {
    return this.serialize(async () => {
      if (!this.lanesActive()) return "no-local-host";
      this.quitVerdict = onExit;
      const read = await this.store.readPolicy();
      return this.publishPresence(onExit, read);
    });
  }

  /**
   * A cancelled quit (or one that stayed open): drop the held verdict and
   * republish the verdict of the mode in force now.
   */
  releaseQuitVerdict(): Promise<void> {
    return this.serialize(async () => {
      if (this.quitVerdict === null) return;
      this.quitVerdict = null;
      if (!this.lanesActive()) return;
      const read = await this.store.readPolicy();
      await this.publishPresence(presenceVerdictForMode(read.mode), read);
    });
  }

  private async publishPresence(
    onExit: DesktopPresenceOnExit,
    policy: PolicyStamp,
  ): Promise<QuitVerdictWriteOutcome> {
    const rev = policy.rev;
    try {
      const outcome = await this.store.writePresence(onExit, rev);
      if (outcome === "written") {
        this.landed = { onExit, rev, mode: policy.mode };
        if (this.presenceFailures > 0) {
          log.info("[host-lifecycle] presence written after retry", {
            onExit,
            rev,
            attempts: this.presenceFailures + 1,
          });
          this.presenceFailures = 0;
        }
        return outcome;
      }
      this.notePresenceFailure("[host-lifecycle] presence not written", {
        reason: "identity-unavailable",
        onExit,
        rev,
      });
      return outcome;
    } catch (error) {
      this.notePresenceFailure("[host-lifecycle] presence write failed", {
        reason: "write-failed",
        onExit,
        rev,
        code: errnoCode(error),
      });
      return "write-failed";
    }
  }

  // ---- Plumbing --------------------------------------------------------------

  /**
   * A presence write that did not land. WARN for the first of a streak, DEBUG
   * for the retries after it (see `presenceFailures`); a write that lands
   * ends the streak with one INFO naming the attempts.
   */
  private notePresenceFailure(message: string, fields: SafeLogFields): void {
    this.presenceFailures += 1;
    const line = { ...fields, attempt: this.presenceFailures };
    if (this.presenceFailures === 1) {
      log.warn(message, line);
    } else {
      log.debug(message, line);
    }
  }

  private async emitIfChanged(): Promise<void> {
    if (this.disposed || this.listeners.size === 0) return;
    const view = await this.getView();
    const key = JSON.stringify(view);
    if (key === this.lastEmittedViewKey) return;
    this.lastEmittedViewKey = key;
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch (error) {
        log.warn("[host-lifecycle] change listener threw", {
          reason: "listener-threw",
          code: errnoCode(error),
        });
      }
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
