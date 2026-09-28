import type { DesktopPresenceOnExit } from "@traycer/protocol/config/desktop-presence";
import {
  refreshOnModeChange,
  type HostLifecycleMode,
} from "@traycer/protocol/config/host-lifecycle-policy";
import type {
  HostLifecycleSetRequest,
  HostLifecycleSetResult,
} from "../../ipc-contracts/host-lifecycle-types";
import type {
  HostQuitDecision,
  HostQuitDecisionMode,
  HostQuitDecisionRequest,
  HostQuitDecisionResponse,
  HostQuitStateEvent,
} from "../../ipc-contracts/host-quit-types";
import { log } from "../app/logger";
import type { AutomaticIntentHold } from "../host/host-controller";
import type {
  LifecycleAdmissionBlock,
  ServiceDefinitionRefreshSpawn,
  StopHostMode,
  StopHostOutcome,
  StopHostRequest,
} from "../host/host-controller-types";
import type {
  QuitPolicyRead,
  QuitVerdictWriteOutcome,
} from "../host/host-lifecycle-transitions";
import type { HostQuitPrompt } from "../ipc/runner-ipc-bridge";

// The quit transaction (host-lifecycle-modes, lifecycle mechanics "The
// quit transaction"): every way the app quits - the app menu's Quit, Cmd/Ctrl+Q,
// the tray's "Quit Traycer", the renderer's `appLifecycleQuit`, and
// `window-all-closed` on Windows/Linux - reaches `before-quit`, and every
// `before-quit` pass main has not authorized lands here. The first pass
// creates ONE transaction; a repeat joins it; Cancel disposes it.
//
// The reason is fixed before any prompt, from whether a relaunch is intended -
// the updater's `installingUpdate` flag, or the macOS move to /Applications
// that relaunches the moved copy:
//
//   relaunch        presence `handoff` FIRST, then the existing update drain
//                   and renderer projection drain, unchanged. Never a host
//                   stop: a relaunch-intended quit keeps the host, and
//                   `handoff` - not a timeout - is what tells the supervisor.
//   user            the existing unsynced-edits decision, then a hold on the
//                   automatic host intents, then a FRESH policy read:
//                     background / none  quit.
//                     linked             "stopping", `host stop --if-idle`,
//                                        on E_HOST_BUSY `--force` (the mode is
//                                        the consent), quit at completion or
//                                        at the deadline.
//                     ask                the host quit modal ("initial").
//                     stop-if-idle       `host stop --if-idle` with no prompt;
//                                        E_HOST_BUSY asks ("busy"), an
//                                        unknown outcome asks ("initial").
//                   No prompt is shown for a host that is not running: there
//                   is nothing to keep or stop, and the quit goes on.
//                   A host a person started in a terminal is left alone in
//                   every mode: the mode governs the service run only, so no
//                   prompt, no stop, presence `keep`. A stop that reaches one
//                   anyway (`not-service-run`: the record predates the field)
//                   leaves `keep` too, and is never asked again.
//
// A Stop chosen over an idle list runs `--if-idle` too; E_HOST_BUSY there
// asks again ("busy-retry": something started meanwhile). Both busy rounds'
// Stop is the force. The host's refusal text is the CLI's instruction to its
// own caller and never reaches a prompt; `HostController` logs its code.
//
// Force happens only under Linked or after the user pressed Stop on a list
// that disclosed busy work. Presence `stop` is what the supervisor
// enforces once the app is gone - forcing whatever it then finds running - so
// an idle-only stop writes `keep` BEFORE it runs, and the work it does not end
// (a busy host, a parked update, a stop cut off by the deadline, a crash while
// the busy-retry question is up) is never forced without disclosure. Only once
// it has ENDED `stopped` is `stop` written: the verdict outlives the host, and
// status and doctor show it as what the user chose.
// "Remember my choice" is applied only when the quit commits, after its stop
// has settled: a Cancel leaves the mode as it was, and the mode write's
// service refresh never queues ahead of the stop.
//
// The one deadline is a budget over VISIBLE stopping time (15 s): it pauses
// while a modal is up, and a stop still queued on the mutation lane when it
// runs out is withdrawn - never spawned later. An admitted CLI child is
// detached with file-backed stdio and finishes after the app exits; the
// presence verdict covers whatever the deadline cut off.
// `awaitMutationLaneIdle` is never used here: it only times out a wait.
//
// A relaunch that arrives mid-quit takes it over, unless a stop is already
// committed. Stop-if-idle's automatic stop, still queued, is withdrawn and the
// relaunch takes over at once; while the lane runs a stop, the relaunch
// follows it, so its `handoff` never stands over a running stop.

/** Visible "Stopping host…" budget for one quit (lifecycle mechanics). */
export const QUIT_STOP_DEADLINE_MS = 15_000;

/**
 * How long a stop may run before a hidden window is shown for its progress
 * ("never a silent multi-second hang"). An idle stop settles well inside it,
 * so it never flashes a window up just before the exit.
 */
export const QUIT_STOPPING_REVEAL_DELAY_MS = 1_000;

export type QuitReason = "relaunch" | "user";

/** Where a decision came from, for its INFO line. */
export type HostQuitDecisionSource = "renderer" | "native" | "tray";

/** What `before-quit` does with a pass: let Electron quit now, or prevent it. */
export type BeforeQuitVerdict = "allow" | "prevent";

/** The slice of `HostLifecycleService` a quit drives. */
export interface QuitTransactionLifecycle {
  readQuitPolicy(): Promise<QuitPolicyRead>;
  writeQuitVerdict(
    onExit: DesktopPresenceOnExit,
  ): Promise<QuitVerdictWriteOutcome>;
  releaseQuitVerdict(): Promise<void>;
  setMode(request: HostLifecycleSetRequest): Promise<HostLifecycleSetResult>;
}

/** The slice of `HostController` a quit drives. */
export interface QuitTransactionController {
  stopHost(request: StopHostRequest): Promise<StopHostOutcome>;
  holdAutomaticIntents(): AutomaticIntentHold;
  quiesce(): void;
  spawnServiceDefinitionRefresh(): Promise<ServiceDefinitionRefreshSpawn>;
  /** The exclusive mutation lane's running job, read synchronously. */
  readonly lifecycleAdmissionBlock: LifecycleAdmissionBlock | null;
}

/** The hooks the existing update-install sequence takes from the transaction. */
export interface UpdateInstallQuitHooks {
  readonly authorizeQuit: () => void;
  readonly stayOpen: () => void;
}

export interface QuitTransactionDeps {
  /**
   * This quit hands over to a relaunch: an update install, or the macOS move
   * to /Applications relaunching the moved copy.
   */
  readonly isRelaunchIntended: () => boolean;
  readonly lifecycle: QuitTransactionLifecycle;
  readonly controller: QuitTransactionController;
  /**
   * Whether a local host is running, read fresh. Resolves, never rejects: a
   * read that cannot tell says `true`, so a live host is never skipped.
   */
  readonly isLocalHostRunning: () => Promise<boolean>;
  /**
   * Whether the running host was started by a person in a terminal (its
   * supervisor admitted `foreground`), read fresh. Resolves, never rejects: a
   * read that cannot tell - a record from a CLI that predates the field
   * included - says `false`, and the CLI's refusal of a desktop stop over that
   * run (`not-service-run`) is the backstop.
   */
  readonly isForegroundHostRun: () => Promise<boolean>;
  /**
   * The host quit modal round-trip (`RunnerIpcBridge.requestHostQuitDecision`).
   * Rejects when no renderer can answer - none listening, no servicing ack,
   * the window closed or reset - and the transaction then asks natively.
   */
  readonly requestDecision: (
    prompt: HostQuitPrompt,
  ) => Promise<HostQuitDecisionResponse>;
  /** Withdraw a pending modal question (the quit was superseded). */
  readonly withdrawDecision: (error: Error) => void;
  /**
   * Main's own Keep / Stop / Cancel dialog, for when no renderer can answer.
   * Resolves; `signal` closes it where the platform allows.
   */
  readonly askNatively: (
    prompt: HostQuitPrompt,
    signal: AbortSignal,
  ) => Promise<HostQuitDecision>;
  readonly publishState: (event: HostQuitStateEvent) => void;
  /**
   * A stop is still running `revealDelayMs` after "stopping" was published:
   * show and focus the MRU window if none is visible (a close-to-tray hid
   * it), so the progress renders. Never creates a window.
   */
  readonly revealStopping: () => void;
  /** The tray's "Stopping host…" line, on for the whole stopping phase. */
  readonly setStoppingIndicator: (stopping: boolean) => void;
  readonly revealDelayMs: number;
  /**
   * The existing unsynced-edits intercept: `proceed` when nothing is unsynced
   * or the user chose to quit anyway, `stay-open` when they cancelled or the
   * intercept failed.
   */
  readonly unsyncedEditsGate: () => Promise<"proceed" | "stay-open">;
  /** The existing update-install quit sequence (`runUpdateInstallQuitSequence`). */
  readonly runUpdateInstallSequence: (
    hooks: UpdateInstallQuitHooks,
  ) => Promise<void>;
  /** Flush shell state, then let the quit through. */
  readonly authorizeQuitAfterFlush: () => void;
  /** Let the quit through now: the update path's second pass. */
  readonly authorizeQuitNow: () => void;
  /** Leave the app running (`quitState.resetQuitting()`, and a reachable window). */
  readonly stayOpen: () => void;
  readonly deadlineMs: number;
}

/** A stop's result, or the deadline running out first. */
type StopRun = StopHostOutcome | { readonly kind: "deadline" };

interface AnsweredDecision {
  /** The modal request this answers, or `null` for a native or tray decision. */
  readonly requestId: string | null;
  readonly decision: HostQuitDecision;
  readonly source: HostQuitDecisionSource;
}

/** "Remember my choice", held until the quit commits. */
interface PendingRemember {
  readonly mode: "background" | "linked";
  readonly source: HostQuitDecisionSource;
}

/** The context a decision is applied in. */
interface DecisionContext {
  /** The policy mode in force for this quit. */
  readonly mode: HostLifecycleMode;
  /** The modal's mode for a re-prompt, or `null` where none can follow (tray). */
  readonly promptMode: HostQuitDecisionMode | null;
  readonly round: HostQuitDecisionRequest["round"] | "none";
}

/**
 * The quit transactions of this process: at most one active at a time. Owned
 * by `wireAppLifecycle`, which calls `onBeforeQuit` on every `before-quit`
 * pass it has not authorized.
 */
export class QuitTransactions {
  private readonly deps: QuitTransactionDeps;
  private active: QuitTransaction | null = null;
  /** A decision taken before the quit began (the tray's "Quit and Stop Host"). */
  private preset: HostQuitDecision | null = null;

  constructor(deps: QuitTransactionDeps) {
    this.deps = deps;
  }

  onBeforeQuit(): BeforeQuitVerdict {
    const active = this.active;
    if (active === null) {
      this.start(
        this.deps.isRelaunchIntended() ? "relaunch" : "user",
        this.takePreset(),
      );
      return "prevent";
    }
    const verdict = active.join();
    if (verdict === "supersede") {
      this.handOverToRelaunch(active);
      return "prevent";
    }
    return verdict;
  }

  /**
   * The tray's "Quit and Stop Host", after its confirm disclosed the force:
   * the next quit applies `stop{force: true}` without asking. Ignored while a
   * quit is already in progress - that quit's own decision stands.
   */
  quitAndStopHost(remember: boolean, requestQuit: () => void): void {
    if (this.active !== null) {
      log.info("[host-quit] quit and stop host ignored", {
        reason: "quit-in-progress",
      });
      return;
    }
    this.preset = { kind: "stop", force: true, remember };
    requestQuit();
  }

  private takePreset(): HostQuitDecision | null {
    const preset = this.preset;
    this.preset = null;
    return preset;
  }

  private start(reason: QuitReason, preset: HostQuitDecision | null): void {
    const transaction = new QuitTransaction(
      this.deps,
      reason,
      preset,
      () => {
        if (this.active === transaction) this.active = null;
      },
      () => {
        if (this.active === transaction) this.handOverToRelaunch(transaction);
      },
    );
    this.active = transaction;
    log.info("[host-quit] quit transaction started", { reason });
    void transaction.run();
  }

  /** A relaunch takes this user quit over: it ends, and the relaunch's starts. */
  private handOverToRelaunch(transaction: QuitTransaction): void {
    transaction.supersede();
    this.start("relaunch", null);
  }
}

type JoinVerdict = BeforeQuitVerdict | "supersede";

class QuitTransaction {
  private readonly deps: QuitTransactionDeps;
  readonly reason: QuitReason;
  private readonly preset: HostQuitDecision | null;
  private readonly onEnded: () => void;
  /** Hand this quit to the relaunch whose takeover waited for its stop. */
  private readonly onRelaunchTakeover: () => void;

  /** The transaction ended without quitting (Cancel, a failure, supersede). */
  private ended = false;
  /** A relaunch took over this user quit. */
  private superseded = false;
  /**
   * A relaunch arrived while this quit's automatic stop was in flight. It
   * takes over once that stop settles (`join`).
   */
  private relaunchTakeoverPending = false;
  /** The quit is authorized; only the final pass is left. */
  private quitting = false;
  /** A stop the user (or Linked) committed to is running. */
  private stopCommitted = false;
  /** The relaunch path's `handoff` write has settled. */
  private handoffSettled = false;
  /** A second relaunch pass arrived before the handoff settled. */
  private releaseAfterHandoff = false;
  /** Something was shown to the renderer this quit, so it hears the ending. */
  private announced = false;
  /** The modal request the latest decision answered, for the state events. */
  private requestId: string | null = null;
  private hold: AutomaticIntentHold | null = null;
  /** The policy mode this user quit read, for the remembered mode's refresh. */
  private policyMode: HostLifecycleMode | null = null;
  private pendingRemember: PendingRemember | null = null;
  private remainingMs: number;
  private currentStop: AbortController | null = null;
  /**
   * The controller's own promise for the stop last submitted, until it
   * settles - which may be after the deadline gave up waiting for it.
   */
  private inFlightStop: Promise<StopHostOutcome> | null = null;
  private readonly nativeDialog = new AbortController();
  /** A stopping phase is on (published and not yet ended). */
  private stopping = false;
  private revealTimer: NodeJS.Timeout | null = null;

  constructor(
    deps: QuitTransactionDeps,
    reason: QuitReason,
    preset: HostQuitDecision | null,
    onEnded: () => void,
    onRelaunchTakeover: () => void,
  ) {
    this.deps = deps;
    this.reason = reason;
    this.preset = preset;
    this.onEnded = onEnded;
    this.onRelaunchTakeover = onRelaunchTakeover;
    this.remainingMs = deps.deadlineMs;
  }

  async run(): Promise<void> {
    try {
      if (this.reason === "relaunch") {
        await this.runRelaunch();
      } else {
        await this.runUser();
      }
    } catch (error) {
      // Nothing above is expected to throw; if it does, a quit that has not
      // committed a stop stays open (the user can quit again), and one that has
      // quits - the presence verdict already says what the supervisor enforces.
      log.warn("[host-quit] quit transaction failed", {
        reason: this.reason,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      if (this.superseded || this.ended || this.quitting) return;
      if (this.stopCommitted) {
        await this.commitQuit();
      } else {
        this.stayOpen("failed");
      }
    }
  }

  /** A repeat `before-quit` pass while this transaction runs. */
  join(): JoinVerdict {
    if (this.reason === "relaunch") {
      // The existing second pass: the updater re-fires `quit()` and it is let
      // through - once the `handoff` verdict is on disk, so a fast re-quit can
      // never leave the launch verdict (Linked: `stop`) standing over an
      // update the supervisor must wait out.
      if (!this.deps.isRelaunchIntended()) return "prevent";
      if (this.handoffSettled) {
        this.quitting = true;
        return "allow";
      }
      this.releaseAfterHandoff = true;
      return "prevent";
    }
    if (
      !this.quitting &&
      !this.ended &&
      !this.stopCommitted &&
      this.deps.isRelaunchIntended()
    ) {
      // Stop-if-idle's automatic stop, if one is in flight, is still queued:
      // the supersede withdraws it and it never spawns. What the lane runs
      // ahead of it is the update sequence's to drain, under its own bound.
      if (this.inFlightStop === null || !this.laneRunsStop()) {
        return "supersede";
      }
      // The lane runs a stop. Admitted, ours runs to its outcome as the
      // user's quit asked, and the relaunch follows it - `handoff` is never
      // written while a spawned stop runs. The lane cannot say whose stop it
      // runs, so ours is withdrawn too: still queued behind another, it never
      // spawns, and the wait is the running stop's.
      if (!this.relaunchTakeoverPending) {
        this.relaunchTakeoverPending = true;
        this.currentStop?.abort();
        log.info("[host-quit] relaunch waits for the host stop", {
          reason: "host-stop-in-flight",
        });
      }
    }
    return "prevent";
  }

  /** Whether the mutation lane is running a host stop right now. */
  private laneRunsStop(): boolean {
    const block = this.deps.controller.lifecycleAdmissionBlock;
    return (
      block !== null &&
      block.kind === "mutation" &&
      block.lane.kind === "stopHost"
    );
  }

  /**
   * A relaunch took over this user quit before any stop was committed: its
   * pending question is withdrawn, a stop still queued is withdrawn, and it
   * ends silently - the relaunch's transaction owns the quit from here.
   */
  supersede(): void {
    // Ended too: a continuation still awaiting (a verdict write, a remembered
    // mode) must neither quit nor stay open on the relaunch's behalf.
    this.superseded = true;
    this.ended = true;
    log.info("[host-quit] quit superseded", { reason: "relaunch" });
    this.endStopping();
    this.currentStop?.abort();
    this.nativeDialog.abort();
    this.deps.withdrawDecision(
      new Error("Host quit decision superseded by a relaunch"),
    );
    this.releaseHold();
    if (this.announced) {
      this.deps.publishState({ requestId: this.requestId, phase: "cancelled" });
    }
    this.onEnded();
  }

  // ---- relaunch ------------------------------------------------------------

  private async runRelaunch(): Promise<void> {
    await this.writeVerdict("handoff");
    this.handoffSettled = true;
    if (this.releaseAfterHandoff) {
      this.quitting = true;
      log.info(
        "[desktop] before-quit - update install in progress, allowing quit",
      );
      this.deps.authorizeQuitNow();
      return;
    }
    log.info(
      "[desktop] before-quit - install pending; draining any in-flight host mutation first",
    );
    await this.deps.runUpdateInstallSequence({
      authorizeQuit: () => {
        this.quitting = true;
        this.deps.authorizeQuitAfterFlush();
      },
      stayOpen: () => {
        this.stayOpen("relaunch-failed");
      },
    });
  }

  // ---- user ----------------------------------------------------------------

  private async runUser(): Promise<void> {
    const gate = await this.deps.unsyncedEditsGate();
    if (this.superseded) return;
    if (gate === "stay-open") {
      this.stayOpen("unsynced-edits");
      return;
    }
    // Reversible until the quit is committed: a Cancel must give the session
    // its health monitor and ensure port back.
    this.hold = this.deps.controller.holdAutomaticIntents();
    const policy = await this.readPolicy();
    if (this.superseded) return;
    const mode = policy.mode;
    this.policyMode = mode;
    if (mode === "none") {
      // No local host lanes (or a CLI-written `none` pending the next
      // launch): nothing to keep or stop.
      log.info("[host-quit] quit", { mode, reason: "no-local-host" });
      await this.commitQuit();
      return;
    }
    // A host a person started in a terminal is theirs: the mode governs the
    // service run only. Nothing is asked and nothing is stopped - the tray's
    // stop included - and nothing is remembered, since nothing was decided.
    if (await this.deps.isForegroundHostRun()) {
      if (this.superseded) return;
      log.info("[host-quit] quit", { mode, reason: "foreground-run" });
      await this.writeVerdict("keep");
      await this.commitQuit();
      return;
    }
    if (this.superseded) return;
    if (this.preset !== null) {
      await this.applyDecision(
        { mode, promptMode: null, round: "none" },
        { requestId: null, decision: this.preset, source: "tray" },
      );
      return;
    }
    switch (mode) {
      case "background":
        log.info("[host-quit] quit", { mode, reason: "host-kept" });
        await this.commitQuit();
        return;
      case "linked":
        await this.runLinked();
        return;
      case "ask":
        await this.prompt("ask", "initial");
        return;
      case "stop-if-idle":
        await this.runStopIfIdle();
        return;
    }
  }

  private async readPolicy(): Promise<QuitPolicyRead> {
    try {
      return await this.deps.lifecycle.readQuitPolicy();
    } catch (error) {
      // An unreadable policy is Background by contract.
      log.warn("[host-quit] policy read failed", {
        mode: "background",
        reason: "read-failed",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return { mode: "background", rev: 0 };
    }
  }

  /** Linked: the mode is the consent - if-idle, then force on a busy host. */
  private async runLinked(): Promise<void> {
    this.stopCommitted = true;
    await this.writeVerdict("stop");
    // Not idle-only: the mode is the consent to force a busy host.
    this.beginStopping(false);
    let outcome = await this.runStop("if-idle");
    if (outcome.kind === "host-busy") {
      outcome = await this.runStop("force");
    }
    this.logStopOutcome("linked", outcome);
    // The host was started in a terminal: not the service's run, so not the
    // mode's to stop - it is kept, and the supervisor must not enforce `stop`.
    if (outcome.kind === "not-service-run") {
      await this.writeVerdict("keep");
    }
    await this.commitQuit();
  }

  /**
   * Stop-if-idle: the idle stop needs no prompt. A busy host asks with the new
   * list; an outcome that says nothing about idleness asks from scratch (the
   * modal's own status query can say "can't tell"); the deadline quits with
   * the host kept - nothing is ever stopped silently.
   */
  private async runStopIfIdle(): Promise<void> {
    this.beginStopping(true);
    const outcome = await this.runStop("if-idle");
    if (this.superseded) return;
    if (this.relaunchTakeoverPending) {
      if (outcome.kind !== "deadline") {
        this.logStopOutcome("stop-if-idle", outcome);
      }
      await this.handOverAfterStop();
      return;
    }
    switch (outcome.kind) {
      case "stopped":
        this.logStopOutcome("stop-if-idle", outcome);
        await this.writeVerdict("stop");
        await this.commitQuit();
        return;
      case "host-busy":
        // The first thing this quit shows: nothing "started meanwhile".
        await this.prompt("stop-if-idle", "busy");
        return;
      case "deadline":
      case "withdrawn":
      // The running host is a terminal's `traycer host start`: the service
      // stop cannot reach it, and asking would only be refused again. It is
      // not stopped, and nothing stops it silently on the way out either.
      case "not-service-run":
        await this.writeVerdict("keep");
        this.logStopOutcome("stop-if-idle", outcome);
        await this.commitQuit();
        return;
      case "lock-busy":
      case "update-active":
      case "failed":
        this.logStopOutcome("stop-if-idle", outcome);
        await this.prompt("stop-if-idle", "initial");
        return;
    }
  }

  /**
   * The relaunch that arrived while the lane ran a stop, with Stop-if-idle's
   * automatic stop in flight, takes this quit over once ours has settled -
   * past the deadline if it must: a stop's child is running, and the
   * relaunch's `handoff` must not stand over it.
   */
  private async handOverAfterStop(): Promise<void> {
    const running = this.inFlightStop;
    if (running !== null) {
      this.logStopOutcome("stop-if-idle", await running);
    }
    this.onRelaunchTakeover();
  }

  private async prompt(
    mode: HostQuitDecisionMode,
    round: HostQuitDecisionRequest["round"],
  ): Promise<void> {
    // Only a dead host skips the question: there is nothing to keep or stop,
    // so neither the modal nor main's own dialog is shown for it.
    if (!(await this.isLocalHostRunning())) {
      if (this.superseded) return;
      log.info("[host-quit] quit", { mode, round, reason: "host-not-running" });
      await this.writeVerdict("keep");
      await this.commitQuit();
      return;
    }
    if (this.superseded) return;
    const answered = await this.ask({ mode, round });
    if (this.superseded) return;
    await this.applyDecision({ mode, promptMode: mode, round }, answered);
  }

  private async isLocalHostRunning(): Promise<boolean> {
    try {
      return await this.deps.isLocalHostRunning();
    } catch {
      return true;
    }
  }

  private async ask(prompt: HostQuitPrompt): Promise<AnsweredDecision> {
    // A prompt ends the stopping phase: it shows its own window (or dialog),
    // and the pause in the deadline budget is not stopping time. Every window
    // that showed the stop's progress hears it end, since only the most
    // recent one gets the question - or none, when main asks natively.
    const wasStopping = this.stopping;
    this.endStopping();
    if (wasStopping) {
      this.deps.publishState({ requestId: this.requestId, phase: "prompting" });
    }
    try {
      const response = await this.deps.requestDecision(prompt);
      this.announced = true;
      return {
        requestId: response.requestId,
        decision: response.decision,
        source: "renderer",
      };
    } catch {
      if (this.superseded) {
        return {
          requestId: null,
          decision: { kind: "cancel" },
          source: "native",
        };
      }
      log.info("[host-quit] asking natively", {
        mode: prompt.mode,
        round: prompt.round,
        reason: "renderer-unavailable",
      });
      const decision = await this.deps.askNatively(
        prompt,
        this.nativeDialog.signal,
      );
      return { requestId: null, decision, source: "native" };
    }
  }

  private async applyDecision(
    context: DecisionContext,
    answered: AnsweredDecision,
  ): Promise<void> {
    const { decision } = answered;
    if (answered.requestId !== null) this.requestId = answered.requestId;
    // Force on a busy round whatever the answer says: that round's list
    // disclosed the busy work, and its Stop is the force (a second if-idle
    // would only loop).
    const forced =
      decision.kind === "stop" &&
      (decision.force ||
        context.round === "busy" ||
        context.round === "busy-retry");
    log.info("[host-quit] decision", {
      mode: context.mode,
      round: context.round,
      choice: decision.kind,
      forced,
      remembered: decision.kind === "cancel" ? false : decision.remember,
      source: answered.source,
    });
    switch (decision.kind) {
      case "cancel":
        // Cancel ignores the checkbox: nothing this quit was asked is kept.
        this.pendingRemember = null;
        this.stayOpen("cancelled");
        return;
      case "keep":
        this.pendingRemember = decision.remember
          ? { mode: "background", source: answered.source }
          : null;
        await this.writeVerdict("keep");
        await this.commitQuit();
        return;
      case "stop": {
        this.pendingRemember = decision.remember
          ? { mode: "linked", source: answered.source }
          : null;
        this.stopCommitted = true;
        // Only a forced stop may leave `stop` for the supervisor: it forces
        // what it finds. An idle-only stop that does not finish - refused,
        // cut off, or still asking busy-retry when the app dies - leaves the
        // host running, as the user was told it would.
        await this.writeVerdict(forced ? "stop" : "keep");
        this.beginStopping(!forced);
        const outcome = await this.runStop(forced ? "force" : "if-idle");
        if (
          outcome.kind === "host-busy" &&
          !forced &&
          context.promptMode !== null
        ) {
          // Something started between the idle list and the stop: show the
          // new list once more; that round's Stop is the force. Its answer
          // replaces this one's "Remember", and its Cancel drops it.
          this.stopCommitted = false;
          await this.prompt(context.promptMode, "busy-retry");
          return;
        }
        this.logStopOutcome(context.mode, outcome);
        // A completed idle-only stop leaves the user's Stop as the standing
        // verdict; a forced one already wrote it. A host started in a
        // terminal is kept whatever was chosen: the stop never reached it.
        if (!forced && outcome.kind === "stopped") {
          await this.writeVerdict("stop");
        } else if (forced && outcome.kind === "not-service-run") {
          await this.writeVerdict("keep");
        }
        await this.commitQuit();
        return;
      }
    }
  }

  /**
   * "Remember my choice": Keep → Background, Stop → Linked, for the decision
   * this quit commits with - after its stop has settled, never before, so a
   * Cancel (the busy-retry round's included) leaves the mode as it was, and
   * the refresh a parking mode write queues on the exclusive lane never runs
   * ahead of the stop. The verdict is already written and the lifecycle
   * service holds it over a mode change, so the choice being remembered
   * cannot overwrite the one being made.
   *
   * The lane may still hold the stop here (the deadline cut it off), and the
   * refresh the write queues behind it never spawns once the app is gone, so
   * a parking mode also gets a detached refresh that outlives the app.
   */
  private async applyRemember(): Promise<void> {
    const pending = this.pendingRemember;
    this.pendingRemember = null;
    if (pending === null) return;
    const { mode } = pending;
    let outcome: string;
    try {
      outcome = (await this.deps.lifecycle.setMode({ mode, stop: null })).kind;
    } catch (error) {
      outcome = error instanceof Error ? error.name : "failed";
    }
    let refresh: ServiceDefinitionRefreshSpawn | "not-needed" = "not-needed";
    if (
      outcome === "applied" &&
      this.policyMode !== null &&
      refreshOnModeChange(this.policyMode, mode)
    ) {
      refresh = await this.deps.controller.spawnServiceDefinitionRefresh();
    }
    log.info("[host-quit] lifecycle mode remembered", {
      mode,
      source: pending.source === "tray" ? "tray" : "quit-modal",
      reason: outcome,
      refresh,
    });
  }

  // ---- stops ---------------------------------------------------------------

  /**
   * One stop against what is left of the deadline budget. Detached, so a
   * child admitted before the deadline completes after the app exits. At the
   * deadline the request is withdrawn: still queued, it never spawns.
   */
  private async runStop(mode: StopHostMode): Promise<StopRun> {
    if (this.remainingMs <= 0) {
      log.info("[host-quit] host stop skipped", { mode, reason: "deadline" });
      return { kind: "deadline" };
    }
    const withdrawal = new AbortController();
    this.currentStop = withdrawal;
    const startedAt = Date.now();
    const deadline = deadlineAfter(this.remainingMs);
    const stop = this.deps.controller.stopHost({
      mode,
      spawn: "detached",
      withdrawal: withdrawal.signal,
    });
    this.inFlightStop = stop;
    const settle = (): void => {
      if (this.inFlightStop === stop) this.inFlightStop = null;
    };
    void stop.then(settle, settle);
    const outcome = await Promise.race<StopRun>([stop, deadline.reached]);
    deadline.cancel();
    this.currentStop = null;
    this.remainingMs -= Date.now() - startedAt;
    if (outcome.kind === "deadline") {
      withdrawal.abort();
      log.info("[host-quit] host stop deadline reached", {
        mode,
        reason: "deadline",
      });
    }
    return outcome;
  }

  private logStopOutcome(mode: HostLifecycleMode, outcome: StopRun): void {
    log.info("[host-quit] host stop settled", {
      mode,
      reason: outcome.kind === "lock-busy" ? "cli-lock-busy" : outcome.kind,
      forced: outcome.kind === "stopped" ? outcome.forced : false,
    });
  }

  // ---- endings -------------------------------------------------------------

  private async commitQuit(): Promise<void> {
    if (this.quitting || this.ended) return;
    if (this.relaunchTakeoverPending) {
      // A relaunch arrived after the deadline gave up on Stop-if-idle's
      // stop, while its `keep` was being written: it takes over instead.
      await this.handOverAfterStop();
      return;
    }
    this.quitting = true;
    this.endStopping();
    // Permanent from here: nothing may bring the host back while the app
    // leaves.
    this.deps.controller.quiesce();
    await this.applyRemember();
    this.releaseHold();
    this.deps.publishState({ requestId: this.requestId, phase: "quitting" });
    this.deps.authorizeQuitAfterFlush();
  }

  private stayOpen(reason: string): void {
    if (this.ended || this.quitting) return;
    this.ended = true;
    log.info("[host-quit] quit abandoned", { reason });
    this.endStopping();
    this.releaseHold();
    void this.deps.lifecycle.releaseQuitVerdict().catch(() => undefined);
    if (this.announced) {
      this.deps.publishState({ requestId: this.requestId, phase: "cancelled" });
    }
    this.onEnded();
    this.deps.stayOpen();
  }

  private releaseHold(): void {
    this.hold?.release();
    this.hold = null;
  }

  /**
   * Enter the stopping phase: the renderer's progress state, the tray line,
   * and - if the stop is still running after `revealDelayMs` - a hidden
   * window shown for it. Ended by a prompt, the quit, or staying open.
   * `idleOnly`: the stop is `--if-idle` and cannot end work, so no surface
   * may say it is ending any.
   */
  private beginStopping(idleOnly: boolean): void {
    // Never after the ending: a reveal timer must not outlive the quit.
    if (this.ended || this.quitting) return;
    this.announced = true;
    this.deps.publishState({
      requestId: this.requestId,
      phase: "stopping",
      idleOnly,
    });
    if (!this.stopping) {
      this.stopping = true;
      this.deps.setStoppingIndicator(true);
    }
    if (this.revealTimer === null) {
      this.revealTimer = setTimeout(() => {
        this.revealTimer = null;
        this.deps.revealStopping();
      }, this.deps.revealDelayMs);
    }
  }

  private endStopping(): void {
    if (this.revealTimer !== null) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    if (this.stopping) {
      this.stopping = false;
      this.deps.setStoppingIndicator(false);
    }
  }

  private async writeVerdict(onExit: DesktopPresenceOnExit): Promise<void> {
    let outcome: QuitVerdictWriteOutcome;
    try {
      outcome = await this.deps.lifecycle.writeQuitVerdict(onExit);
    } catch {
      outcome = "write-failed";
    }
    log.info("[host-quit] presence verdict", {
      verdict: onExit,
      reason: outcome,
    });
  }
}

function deadlineAfter(ms: number): {
  readonly reached: Promise<{ readonly kind: "deadline" }>;
  readonly cancel: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  const reached = new Promise<{ readonly kind: "deadline" }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "deadline" });
    }, ms);
  });
  return {
    reached,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}
