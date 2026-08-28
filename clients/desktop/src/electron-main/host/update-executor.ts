import {
  attemptIdentityOf,
  decideAttemptClaim,
  isTerminalPhase,
  readUpdateAttemptRecord,
  type AttemptClaimAction,
  type AttemptClaimRequest,
  type AttemptCommitOutcome,
  type HostUpdateAttemptIdentity,
  type HostUpdateTrigger,
  type PublicAttemptMutationIntent,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";
import type { HostServiceSubstrate } from "./host-owner";
import type { HostFsLayout } from "./host-paths";
import {
  withDesktopAttemptExecutor,
  type DesktopUpdateContenderOutcome,
  type WithDesktopUpdateSegmentOptions,
} from "./update-contender";
import { decideDesktopUpdateExecutorCohort } from "./update-executor-cohort";
import type { RestartTombstoneOutcome } from "./update-mutation";

// The packaged-macOS activation executor (technical plan §3.2 trace, §4
// restart ordering).
//
// ## What this owns, and what it deliberately does not
//
// It owns the segment from claim through bootout: claim -> private
// acknowledgement -> final drain -> `restarting` -> tombstone publish+flush ->
// SMAppService bootout/activate -> release.
//
// It does NOT own the terminal states. `complete`, `recover` and a
// recovery-provenance `supersede` are executor-only intents, reachable only by
// an actor that gathered evidence under its own inner lock, and the CLI's
// `update-executor.ts` is that actor. This is not a limitation worked around:
// a `restarting` segment ends BY DESIGN - the host it was serving is gone -
// so the record it leaves behind is exactly the orphaned-but-active shape the
// recovery arm exists to reconcile. Desktop's re-entry after bootout is
// therefore to DISPATCH that claim and consume its outcome, never to regain
// record-write authority for the terminal states itself.
//
// Every boundary is injected so the crash matrix is deterministic without a
// real SMAppService, mirroring the CLI executor's fault hooks.

export type DesktopExecutorFaultPoint =
  | "before-claim-write"
  | "after-claim-write-before-ack"
  | "after-private-ack-before-drain"
  | "after-drain-before-restarting"
  | "after-restarting-before-tombstone"
  | "after-tombstone-before-bootout"
  | "after-bootout-before-release"
  | "after-release-before-verification";

export interface DesktopExecutorFaults {
  hit(point: DesktopExecutorFaultPoint): Promise<void>;
}

export const NO_DESKTOP_EXECUTOR_FAULTS: DesktopExecutorFaults = {
  async hit(): Promise<void> {},
};

/** What the final drain concluded about live work. */
export type DesktopDrainVerdict = "idle" | "busy" | "no-host";

/** The SMAppService cycle's result, as the controller reports it. */
export type DesktopActivationCycleOutcome =
  | { readonly kind: "activated" }
  | { readonly kind: "deferred"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }
  /**
   * Registration failed in a way the CLI takeover can recover - and that
   * recovery MUST run OUTSIDE the actuator lock.
   *
   * `withUpdateContenderAdoption` waives the **attempt** lock only. The
   * cli-lock is always the child's own: `withCliUpdateContender` wraps its
   * adoption-aware segment in `withCliAttemptMutation`, which takes
   * `withCliLock` whether or not a proof was presented. So a parent still
   * holding the inner lock would block its own takeover child - the same
   * self-contention class as the activation deadlock, one level down.
   *
   * Returning a thunk instead of performing the recovery inline is what makes
   * that ordering structural: the segment cannot run it without having left
   * the span, because it does not receive it until the span has returned.
   */
  | {
      readonly kind: "needs-takeover";
      readonly recoverOutsideLock: () => Promise<DesktopActivationCycleOutcome>;
    };

/** Outcome of running a callback under the short inner actuator lock. */
export type DesktopActuatorSpan<T> =
  | { readonly kind: "ran"; readonly value: T }
  /** The inner lock was held elsewhere. Nothing in the span ran. */
  | { readonly kind: "busy"; readonly message: string };

/**
 * The post-restart verification claim, dispatched to the bundled CLI.
 *
 * Injected rather than called directly because it is a different authority
 * model: the CLI claims the orphaned record itself, with its own lock and its
 * own lock-scoped evidence. Desktop supplies no capability, no adoption proof,
 * and no evidence - it is a dispatcher here, not a parent.
 */
export type DesktopVerificationDispatch = (
  identity: HostUpdateAttemptIdentity,
) => Promise<DesktopVerificationOutcome>;

export type DesktopVerificationOutcome =
  | { readonly kind: "complete" }
  | { readonly kind: "failed"; readonly reason: string }
  | {
      readonly kind: "resumed";
      readonly continuation: "activate";
      /**
       * The identity of the record as recovery PARKED it, when the report
       * named one; `null` when it did not.
       *
       * Corroboration, not authority. The caller re-reads the record and
       * resumes from what is on disk - a report is testimonial, and this epic
       * has already ruled once that a caller-supplied identity is the
       * forgeable shape. What this is FOR is disagreement: if the record on
       * disk names a different attempt than the claimant says it parked,
       * something else moved it and proceeding would act on a state nobody
       * verified.
       */
      readonly parked: HostUpdateAttemptIdentity | null;
    }
  /** Dispatch itself could not be completed; the record stands as it is. */
  | { readonly kind: "indeterminate"; readonly reason: string };

export interface DesktopActivationRequest {
  readonly targetVersion: string;
  readonly trigger: HostUpdateTrigger;
  /**
   * `activate` and nothing else, and both exclusions are load-bearing.
   *
   * `force` authorizes resuming a pre-commit `waiting-for-work` park - a
   * different segment with different bytes at stake - and the core refuses it
   * for an `activate` continuation anyway. Keeping it unrepresentable means a
   * Force-restart caller cannot spend update-force authorization on activation.
   *
   * `start` is excluded because this executor CANNOT legally run one, and the
   * core is right about that. A fresh `create` lands with `continuation: null`
   * (`createdRecord`), while every advance here carries `activate`; the active
   * -target rule requires them equal, so a `start` claim would write a real
   * record and then fail its very next advance, leaving an orphaned active
   * record behind. The deeper reason is that `waiting-to-activate` may only be
   * BORN from an `applying` write - byte placement is a different segment
   * shape, which this activation-only executor does not perform.
   */
  readonly action: Extract<AttemptClaimAction, "activate">;
  /**
   * Non-null by construction. An identity-bound request is resolved before any
   * create path in `decideAttemptClaim`, so `create` is unreachable from here
   * and every claim resolves to `resume` - which lands in `preparing` carrying
   * `activate`, exactly what the advances below require.
   */
  readonly expected: HostUpdateAttemptIdentity;
  readonly newAttemptId: string;
  /**
   * A user-confirmed Force restart overrides the final drain, and nothing else
   * does. It is not update-force authorization - see `action` above.
   */
  readonly overrideDrain: boolean;
}

export interface DesktopActivationDeps {
  readonly layout: HostFsLayout;
  readonly substrate: HostServiceSubstrate;
  readonly contender: Omit<WithDesktopUpdateSegmentOptions, "admission">;
  readonly nowIso: () => string;
  readonly drain: () => Promise<DesktopDrainVerdict>;
  /**
   * Takes an INTENT, never a next record. The core re-reads canonical bytes
   * under its own lease and recomputes the record from the intent, so an
   * A -> B replacement, a counter jump, or a trigger/target rewrite is
   * unrepresentable at the persistence boundary. Handing it a record we built
   * here would hand that guarantee back.
   */
  readonly commit: (
    capability: UpdateMutationCapability,
    intent: PublicAttemptMutationIntent,
  ) => Promise<AttemptCommitOutcome>;
  readonly publishTombstone: (
    capability: UpdateMutationCapability,
  ) => Promise<RestartTombstoneOutcome>;
  /**
   * Run the write-ahead + actuator span under the short inner cli-lock.
   *
   * Acquisition happens BEFORE the `restarting` commit, and that ordering is
   * the point: a lock acquisition is a deferrable gate, so it must sit ahead
   * of the point of no return. It used to live inside the actuator, i.e.
   * AFTER `restarting` and the tombstone - where the phase graph offers no
   * path back to a park, so a merely-busy lock had to terminalize `failed`
   * and discard a perfectly good staged activation.
   *
   * What this protects: the `restarting` commit, the tombstone, and the
   * SMAppService registration - the window in which Desktop mutates
   * registration state a mixed-version CLI could otherwise mutate underneath
   * it. What it deliberately does NOT protect: the takeover child's own
   * mutation, which is serialized by that child's own cli-lock acquisition.
   */
  readonly withActuatorLock: <T>(
    capability: UpdateMutationCapability,
    run: () => Promise<T>,
  ) => Promise<DesktopActuatorSpan<T>>;
  /** The SMAppService registration itself. Runs INSIDE the span; spawns no CLI child. */
  readonly registerActuator: (
    capability: UpdateMutationCapability,
  ) => Promise<DesktopActivationCycleOutcome>;
  /** Withdraw a published tombstone whose bootout did not happen. */
  readonly clearTombstone: (
    capability: UpdateMutationCapability,
  ) => Promise<void>;
  readonly acknowledge: (identity: HostUpdateAttemptIdentity) => Promise<void>;
  readonly dispatchVerification: DesktopVerificationDispatch;
  readonly faults: DesktopExecutorFaults;
}

export type DesktopActivationOutcome =
  | {
      readonly kind: "verified";
      readonly identity: HostUpdateAttemptIdentity;
      readonly verification: DesktopVerificationOutcome;
    }
  /** Bytes stayed put and the record is truthfully re-parked. */
  | { readonly kind: "parked"; readonly reason: DesktopParkReason }
  /** A restart was promised and could not be delivered; terminalized. */
  | {
      readonly kind: "failed";
      readonly reason: DesktopActivationFailure;
      readonly cause: string;
    }
  | { readonly kind: "rejected"; readonly reason: string }
  | {
      readonly kind: "refused";
      readonly outcome: Exclude<
        DesktopUpdateContenderOutcome<never>,
        { readonly kind: "acquired" }
      >;
    };

/**
 * Two parks are reachable, and both sit BEFORE the point of no return.
 *
 * (This comment previously asserted only one was reachable. That was true
 * while the inner lock was acquired inside the actuator - i.e. after
 * `restarting` - where a busy lock could only terminalize. Moving the
 * acquisition ahead of the write-ahead is what made the second park both
 * possible and correct; see the review note in the ticket design.)
 */
export type DesktopParkReason = "drain-busy" | "actuator-lock-busy";

/**
 * Why a segment that had already promised a restart could not deliver one.
 *
 * These are terminal because the record cannot walk back out of `restarting`,
 * and terminal is also the honest answer: the segment failed. The bytes stay
 * placed, so the next contender reconciles installed-equals-target and offers
 * the activation continuation again - the user retries and it works.
 */
export type DesktopActivationFailure =
  /**
   * The tombstone did not durably land, so the bootout did not happen. §4:
   * without it the host cannot tell the teardown from death and every other
   * client fails over on a seconds-long outage.
   */
  | "tombstone-not-published"
  /** The SMAppService cycle declined or failed after the tombstone was published. */
  | "activation-not-performed";

/**
 * Is there a durable activation continuation this executor already owns?
 *
 * Consumes the canonical `isTerminalPhase` rather than testing phase names
 * locally. A second copy of that classification is what round 2 of Ticket 05
 * called out: the copy that disagrees is a bug with a plausible comment
 * attached, and a new terminal phase upstream must not silently reclassify
 * retained records as live here.
 *
 * An unreadable or absent record answers `false`, which routes to the cohort
 * gate - the fail-closed direction. Nothing is adopted, so nothing can be
 * stranded by refusing.
 */
async function hasAdoptedActivationContinuation(
  deps: DesktopActivationDeps,
): Promise<boolean> {
  const record = await readUpdateAttemptRecord(deps.layout.rootDir);
  return (
    record.kind === "valid" &&
    record.value.continuation === "activate" &&
    !isTerminalPhase(record.value.phase)
  );
}

/**
 * Run one packaged-macOS activation segment.
 *
 * The ordering between the drain and the bootout is the whole contract, so it
 * is worth stating plainly: `restarting` is committed BEFORE the tombstone,
 * the tombstone is flushed BEFORE the bootout, and there is no gate of any
 * kind between the flush and the bootout. Once the record promising a return
 * is on disk, the return must actually happen - a deferrable check there would
 * leave clients holding an expected-restart episode for a restart nobody
 * performed.
 */
export async function runDesktopActivationSegment(
  request: DesktopActivationRequest,
  deps: DesktopActivationDeps,
): Promise<DesktopActivationOutcome> {
  // The cohort gate stops NEW attempts. It must not strand one already
  // adopted - Ticket 07 plan §7 Finding 2, ruled.
  //
  // ## The stranding this closes
  //
  // An attempt parked at `preparing/activate` has bytes placed and the target
  // host NOT running. If the cohort is disabled while it sits there (kill
  // switch, or a rollback), the old shape rejected here; the Force-restart
  // route has no arm for `rejected`, so it fell through to the generic
  // restart; that restart carries `--defer-if-parked`, and the CLI correctly
  // classifies `preparing/activate` as `stop-only` and REFUSES without
  // stopping. Every step correct, and the machine ends up with a down host
  // nothing can bring back.
  //
  // "Stops admitting new attempts; does not abandon an adopted one" therefore
  // has to be read as a property of the RECORD, not of the entry point.
  //
  // ## Why the pre-lock read is legitimate here, and is not the round-2 bug
  //
  // Ticket 05's round 2 rejected a pre-lock record read that AUTHORIZED an
  // action which then ran without revalidation. This read only ever *skips a
  // policy gate*: the claim itself is still resolved by `decideAttemptClaim`
  // under the canonical lock, and refuses if the record is not what was read.
  // A stale read here can cause us to consult one fewer policy gate before a
  // claim that fails anyway - it can never authorize a mutation. That is the
  // distinction between a check that grants permission and one that declines
  // to withhold it.
  //
  // Deliberately reads the RECORD rather than trusting `request.expected`
  // (non-null by construction): an intent is caller-supplied, a record is not.
  if (!(await hasAdoptedActivationContinuation(deps))) {
    if (decideDesktopUpdateExecutorCohort(deps.substrate).kind !== "eligible") {
      return { kind: "rejected", reason: "cohort-disabled" };
    }
  }

  const segment = await withDesktopAttemptExecutor(
    deps.contender,
    async (capability): Promise<DesktopSegmentResult> =>
      runClaimedActivation(capability, request, deps),
  );

  if (segment.kind !== "acquired") {
    return { kind: "refused", outcome: segment };
  }
  const result = segment.result;
  if (result.kind !== "booted-out") return result.outcome;

  // The segment's lock is released by now, which is required rather than
  // incidental: the CLI verification claim must acquire the canonical lock
  // itself, and it cannot do that while this process still holds it.
  await deps.faults.hit("after-release-before-verification");
  return {
    kind: "verified",
    identity: result.identity,
    verification: await deps.dispatchVerification(result.identity),
  };
}

type DesktopSegmentResult =
  | {
      readonly kind: "booted-out";
      readonly identity: HostUpdateAttemptIdentity;
    }
  | { readonly kind: "settled"; readonly outcome: DesktopActivationOutcome };

async function runClaimedActivation(
  capability: UpdateMutationCapability,
  request: DesktopActivationRequest,
  deps: DesktopActivationDeps,
): Promise<DesktopSegmentResult> {
  const claimed = await claim(capability, request, deps);
  if (claimed.kind === "rejected") {
    return { kind: "settled", outcome: claimed.outcome };
  }
  let identity = claimed.identity;

  // The private positive acknowledgement. A dispatcher reports "accepted" only
  // after this, so a caller can never treat a spawn as an accepted claim.
  await deps.acknowledge(identity);
  await deps.faults.hit("after-private-ack-before-drain");

  // ---- Final drain. This is the LAST deferrable gate in the segment.
  const verdict = await deps.drain();
  if (verdict === "busy" && !request.overrideDrain) {
    const reparked = await advance(capability, identity, deps, {
      phase: "waiting-to-activate",
      continuation: "activate",
    });
    return {
      kind: "settled",
      outcome:
        reparked.kind === "advanced"
          ? { kind: "parked", reason: "drain-busy" }
          : { kind: "rejected", reason: reparked.reason },
    };
  }
  await deps.faults.hit("after-drain-before-restarting");

  // ---- The actuator span: acquire the inner cli-lock BEFORE anything
  // irreversible, and hold it across the write-ahead and the registration.
  //
  // Acquisition is a deferrable gate, so it belongs on this side of the point
  // of no return. Inside the span nothing spawns a CLI child, which is what
  // makes holding the lock here safe (see `needs-takeover`).
  const span = await deps.withActuatorLock(capability, async () => {
    // ---- Write-ahead: the promise of a return, before anything that tears down.
    const restarting = await advance(capability, identity, deps, {
      phase: "restarting",
      continuation: "activate",
    });
    if (restarting.kind !== "advanced") {
      return { step: "rejected" as const, reason: restarting.reason };
    }
    identity = restarting.identity;
    await deps.faults.hit("after-restarting-before-tombstone");

    // ---- Tombstone, then bootout, with nothing between them.
    const tombstone = await deps.publishTombstone(capability);
    if (tombstone.kind !== "published") {
      return { step: "tombstone-failed" as const, cause: tombstone.cause };
    }
    await deps.faults.hit("after-tombstone-before-bootout");
    return {
      step: "registered" as const,
      activation: await deps.registerActuator(capability),
    };
  });

  if (span.kind === "busy") {
    // Still `preparing`: nothing was promised, so a park is both legal and
    // honest. This is the arm that could not exist while the lock was taken
    // after `restarting` - there it had to terminalize `failed` and throw away
    // a staged activation that a park preserves.
    const reparked = await advance(capability, identity, deps, {
      phase: "waiting-to-activate",
      continuation: "activate",
    });
    return {
      kind: "settled",
      outcome:
        reparked.kind === "advanced"
          ? { kind: "parked", reason: "actuator-lock-busy" }
          : { kind: "rejected", reason: reparked.reason },
    };
  }
  if (span.value.step === "rejected") {
    return {
      kind: "settled",
      outcome: { kind: "rejected", reason: span.value.reason },
    };
  }
  if (span.value.step === "tombstone-failed") {
    // No bootout. The record already says `restarting`, and the phase graph
    // offers no way back to a park from there - so the honest close is
    // terminal-with-diagnostics, not a park this segment cannot write.
    return {
      kind: "settled",
      outcome: await terminalize(
        capability,
        identity,
        deps,
        "tombstone-not-published",
        span.value.cause,
      ),
    };
  }

  // ---- Outside the span. The takeover child acquires the cli-lock itself, so
  // this MUST NOT run while we hold it.
  let activation = span.value.activation;
  if (activation.kind === "needs-takeover") {
    activation = await activation.recoverOutsideLock();
  }
  if (activation.kind !== "activated") {
    // A tombstone is on disk promising a bootout that did not happen. Withdraw
    // it FIRST: leaving it makes every connected client hold an expected-restart
    // episode for a restart nobody performed, which is the failure mode the
    // tombstone exists to prevent, inverted.
    await deps.clearTombstone(capability);
    return {
      kind: "settled",
      outcome: await terminalize(
        capability,
        identity,
        deps,
        "activation-not-performed",
        activation.kind === "needs-takeover"
          ? "takeover recovery did not resolve"
          : activation.message,
      ),
    };
  }
  await deps.faults.hit("after-bootout-before-release");
  return { kind: "booted-out", identity };
}

type ClaimResult =
  | { readonly kind: "claimed"; readonly identity: HostUpdateAttemptIdentity }
  | { readonly kind: "rejected"; readonly outcome: DesktopActivationOutcome };

async function claim(
  capability: UpdateMutationCapability,
  request: DesktopActivationRequest,
  deps: DesktopActivationDeps,
): Promise<ClaimResult> {
  const current = await readUpdateAttemptRecord(deps.layout.rootDir);
  const claimRequest: AttemptClaimRequest = {
    targetVersion: request.targetVersion,
    trigger: request.trigger,
    action: request.action,
    expected: request.expected,
    newAttemptId: request.newAttemptId,
    // Both legal entries land here: a resumed park returns to `preparing` so
    // the drain runs before `restarting`, and a fresh attempt starts there
    // because this executor never downloads.
    initialPhase: "preparing",
    nowIso: deps.nowIso(),
  };
  const decision = decideAttemptClaim({
    current,
    request: claimRequest,
    holder: { kind: "held-by-self" },
  });

  if (decision.kind === "create" || decision.kind === "resume") {
    await deps.faults.hit("before-claim-write");
    // `decision.record` is deliberately discarded: it was the pure algebra's
    // preview, and the core will derive the authoritative one from this same
    // request under the lock. Passing the preview through would make the
    // decision and the write two independent computations that can disagree.
    const committed = await deps.commit(capability, {
      kind: decision.kind,
      request: claimRequest,
    });
    if (committed.kind !== "committed") {
      return {
        kind: "rejected",
        outcome: {
          kind: "rejected",
          reason:
            committed.kind === "rejected" ? committed.reason : committed.kind,
        },
      };
    }
    await deps.faults.hit("after-claim-write-before-ack");
    return { kind: "claimed", identity: committed.identity };
  }

  // Everything else belongs to somebody else. `requires-recovery` in
  // particular is NOT Desktop's to answer: reconciling an orphaned active
  // record needs the executor-only `recover` intent and evidence gathered
  // under an inner lock, which is the CLI claimant's job. Returning it as a
  // rejection - rather than quietly creating a fresh attempt over the top -
  // is what keeps a died-mid-apply record from being replaced without ever
  // reconciling `install.json` against the bytes on disk.
  return {
    kind: "rejected",
    outcome: {
      kind: "rejected",
      reason: decision.kind === "refuse" ? decision.reason : decision.kind,
    },
  };
}

type AdvanceResult =
  | { readonly kind: "advanced"; readonly identity: HostUpdateAttemptIdentity }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * The only legal close for a segment that has already committed `restarting`.
 *
 * `failed` (with `superseded`) is what the phase graph leaves once that promise
 * is on disk. The diagnostic travels on the record rather than only in a log,
 * because the next contender reconciles from durable evidence and "why did the
 * last activation stop" is part of that evidence.
 */
async function terminalize(
  capability: UpdateMutationCapability,
  held: HostUpdateAttemptIdentity,
  deps: DesktopActivationDeps,
  reason: DesktopActivationFailure,
  cause: string,
): Promise<DesktopActivationOutcome> {
  const committed = await deps.commit(capability, {
    kind: "advance",
    held,
    advance: {
      phase: "failed",
      // A terminal phase carries no continuation - the attempt is over and
      // there is nothing left to continue.
      continuation: null,
      progress: null,
      error: { code: reason, message: cause, phase: "restarting" },
      nowIso: deps.nowIso(),
    },
  });
  return committed.kind === "committed"
    ? { kind: "failed", reason, cause }
    : {
        kind: "rejected",
        reason:
          committed.kind === "rejected" ? committed.reason : committed.kind,
      };
}

async function advance(
  capability: UpdateMutationCapability,
  held: HostUpdateAttemptIdentity,
  deps: DesktopActivationDeps,
  to: {
    readonly phase: "restarting" | "waiting-to-activate";
    readonly continuation: "activate";
  },
): Promise<AdvanceResult> {
  // No canonical re-read here: the core performs it under the handle lease,
  // and a read taken out here would only be a staler copy of what it will
  // read anyway - with a window in between for exactly the late-write race
  // `held` exists to reject.
  const committed = await deps.commit(capability, {
    kind: "advance",
    held,
    advance: {
      phase: to.phase,
      continuation: to.continuation,
      progress: null,
      error: null,
      nowIso: deps.nowIso(),
    },
  });
  if (committed.kind !== "committed") {
    return {
      kind: "rejected",
      reason: committed.kind === "rejected" ? committed.reason : committed.kind,
    };
  }
  return { kind: "advanced", identity: attemptIdentityOf(committed.record) };
}
