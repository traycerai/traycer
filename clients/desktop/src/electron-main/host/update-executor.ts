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

// `complete`, `recover` and a recovery-provenance `supersede` are executor-only intents, reachable only by an actor that gathered evidence under its own inner lock, and the CLI's.
// Desktop's re-entry after bootout is therefore to DISPATCH that claim and consume its outcome, never to regain record-write authority for the terminal states itself.

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
   * Registration failed in a way the CLI takeover can recover - and that recovery MUST run OUTSIDE the actuator lock.
   * Returning a thunk instead of performing the recovery inline is what makes that ordering structural: the segment cannot run it without having left the span, because it does not.
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
       * The identity of the record as recovery PARKED it, when the report named one; `null` when it did not.
       * The caller re-reads the record and resumes from what is on disk.
       */
      readonly parked: HostUpdateAttemptIdentity | null;
    }
  /** Dispatch itself could not be completed; the record stands as it is. */
  | { readonly kind: "indeterminate"; readonly reason: string };

export interface DesktopActivationRequest {
  readonly targetVersion: string;
  readonly trigger: HostUpdateTrigger;
  /**
   * Keeping it unrepresentable means a Force-restart caller cannot spend update-force authorization on activation.
   * `start` is excluded because this executor CANNOT legally run one, and the core is right about that.
   */
  readonly action: Extract<AttemptClaimAction, "activate">;
  readonly expected: HostUpdateAttemptIdentity;
  readonly newAttemptId: string;
  readonly overrideDrain: boolean;
}

export interface DesktopActivationDeps {
  readonly layout: HostFsLayout;
  readonly substrate: HostServiceSubstrate;
  readonly contender: Omit<WithDesktopUpdateSegmentOptions, "admission">;
  readonly nowIso: () => string;
  readonly drain: () => Promise<DesktopDrainVerdict>;
  /** Takes an INTENT, never a next record. */
  readonly commit: (
    capability: UpdateMutationCapability,
    intent: PublicAttemptMutationIntent,
  ) => Promise<AttemptCommitOutcome>;
  readonly publishTombstone: (
    capability: UpdateMutationCapability,
  ) => Promise<RestartTombstoneOutcome>;
  /** Acquisition happens BEFORE the `restarting` commit, and that ordering is the point: a lock acquisition is a deferrable gate, so it must sit ahead of the point of no return. */
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

/** Two parks are reachable, and both sit BEFORE the point of no return. */
export type DesktopParkReason = "drain-busy" | "actuator-lock-busy";

/** These are terminal because the record cannot walk back out of `restarting`, and terminal is also the honest answer: the segment failed. */
export type DesktopActivationFailure =
  /** §4: without it the host cannot tell the teardown from death and every other client fails over on a seconds-long outage. */
  | "tombstone-not-published"
  /** The SMAppService cycle declined or failed after the tombstone was published. */
  | "activation-not-performed";

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
 * The ordering between the drain and the bootout is the whole contract, so it is worth stating plainly: `restarting` is committed BEFORE the tombstone, the tombstone is flushed.
 * Once the record promising a return is on disk, the return must actually happen.
 */
export async function runDesktopActivationSegment(
  request: DesktopActivationRequest,
  deps: DesktopActivationDeps,
): Promise<DesktopActivationOutcome> {
  // It must not strand one already adopted - Ticket 07 plan §7 Finding 2, ruled.
  // If the cohort is disabled while it sits there (kill switch, or a rollback), the old shape rejected here.
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

  const span = await deps.withActuatorLock(capability, async () => {
    const restarting = await advance(capability, identity, deps, {
      phase: "restarting",
      continuation: "activate",
    });
    if (restarting.kind !== "advanced") {
      return { step: "rejected" as const, reason: restarting.reason };
    }
    identity = restarting.identity;
    await deps.faults.hit("after-restarting-before-tombstone");

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
    // Still `preparing`: nothing was promised, so a park is both legal and honest.
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
