import { randomUUID } from "node:crypto";
// The canonical resolver, exported precisely so callers do not duplicate this
// mapping and drift from it.
import { currentInstallPlatform } from "../installer/install";
import type { Environment } from "../runner/environment";
import {
  runLocalAttemptExecutorSegment,
  NO_UPDATE_EXECUTOR_FAULTS,
  type ExecutorSegmentOutcome,
} from "./update-executor";

// The post-restart verification claim for a Desktop-owned packaged-macOS
// activation (Ticket 05).
//
// ## Why it lives in `host/` and not in `commands/`
//
// Ticket 03 ships a structural fence: the executor's only production consumers
// are `host/*.ts` callers, never a command path — the released legacy update
// command must not be able to reach the shadow executor. Keeping this logic
// here and the command file thin satisfies that fence by construction, rather
// than by adding an allowlist entry to it. Every other command in this tree is
// already shaped this way.
//
// ## Why this is a claim and not a Desktop function
//
// Desktop's activation segment ends at the bootout: the host it was serving is
// gone, and a `restarting` segment "ends by design and does not come back". The
// record it leaves is orphaned-but-active — exactly the shape Ticket 03's
// recovery arm exists to reconcile. Reconciling it needs the executor-only
// `recover` intent plus evidence gathered under an inner CLI lock, both
// deliberately private to the CLI executor, so the terminal states belong to a
// first-class CLI claimant.
//
// ## This is NOT an adoption path, and the reason is concrete
//
// Adoption validates that a named parent still holds the lock. Here there is no
// live holder at all — that is the definition of the state being reconciled —
// so an adoption proof could not validate even in principle. Desktop passes no
// capability, no proof and no evidence; it is a dispatcher.
//
// ## No new decision logic
//
// All of this is the existing claim path. The record is `restarting`, active
// and unheld, so `decideAttemptClaim` refuses `requires-recovery` and the
// recovery arm decides from lock-scoped install/stage/running evidence: exact
// installed + exact running target terminalizes `complete`; installed but not
// running resumes the `activate` continuation; contradiction terminalizes
// `failed`; anything unreadable refuses. This adds a report shape and nothing
// else.

export interface HostUpdateVerifyArgs {
  readonly attemptId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly targetVersion: string;
}

/**
 * The wire shape Desktop maps onto `DesktopVerificationOutcome`.
 *
 * `indeterminate` is the load-bearing arm. A dispatch that could not complete
 * leaves the record exactly as it stands, and the caller must not infer a
 * terminal state from a failed dispatch — it has no evidence, and inventing one
 * is how a `verifying` record becomes a false `complete`.
 */
export type HostUpdateVerifyReport =
  | { readonly outcome: "complete" }
  | { readonly outcome: "failed"; readonly reason: string }
  | {
      readonly outcome: "resumed";
      readonly continuation: "activate";
      /**
       * The identity of the record as it is PARKED, after recovery handed the
       * continuation back (Ticket 07 orphan-recovery ruling).
       *
       * Load-bearing, and the reason the arm carries an identity at all: the
       * caller resumes this exact parked attempt with an ordinary claim. It is
       * NOT the identity this call was invoked with - recovery bumps the
       * generation - so a caller that reused its own `expected` would present a
       * stale expectation and be refused.
       */
      readonly attemptId: string;
      readonly generation: number;
      readonly sequence: number;
    }
  | { readonly outcome: "indeterminate"; readonly reason: string };

export async function verifyHostUpdateAttempt(
  environment: Environment,
  args: HostUpdateVerifyArgs,
): Promise<HostUpdateVerifyReport> {
  const segment = await runLocalAttemptExecutorSegment(
    {
      platform: currentInstallPlatform(),
      contender: {
        environment,
        reason: "host-update-verify",
        waitMs: 30_000,
        pollIntervalMs: 100,
      },
      request: {
        targetVersion: args.targetVersion,
        // Provenance of the attempt being verified, not of this invocation.
        // The recovery arm carries the original trigger through; this value is
        // only consulted if the request were to mint a new attempt, which an
        // identity-bound request cannot do.
        trigger: "manual",
        // The same authorization the activation segment held. Recovery never
        // upgrades an action: `activate` can adopt only the activation
        // continuation, so this claim cannot turn into an apply.
        action: "activate",
        expected: {
          attemptId: args.attemptId,
          generation: args.generation,
          sequence: args.sequence,
        },
        // Unreachable for an identity-bound request — `decideAttemptClaim`
        // resolves those before any create path — but required by the shape.
        newAttemptId: randomUUID(),
        initialPhase: "preparing",
      },
      nowIso: () => new Date().toISOString(),
      faults: NO_UPDATE_EXECUTOR_FAULTS,
    },
    // No dispatch parent is waiting on a private acknowledgement: Desktop reads
    // the report instead.
    async () => undefined,
    // The claim IS the work. A resumed activation is reported back so Desktop
    // can decide whether to run another activation segment; performing one here
    // would put activation in two places.
    async () => undefined,
  );
  return reportFor(segment);
}

function reportFor(
  segment: ExecutorSegmentOutcome<undefined>,
): HostUpdateVerifyReport {
  if (segment.kind === "executed") {
    // The claim resolved to a live continuation rather than a terminal state:
    // bytes are placed but the host is not yet running them.
    //
    // The identity reported is the PARKED one. Recovery resumed the orphan and
    // then re-parked it before releasing, so this names a record an ordinary
    // claim can resume - which is the whole point of the handoff. Reporting
    // the pre-recovery identity instead would hand the caller a stale
    // expectation, and reporting none at all is what made the previous shape a
    // stranding loop.
    return {
      outcome: "resumed",
      continuation: "activate",
      attemptId: segment.claim.identity.attemptId,
      generation: segment.claim.identity.generation,
      sequence: segment.claim.identity.sequence,
    };
  }
  if (segment.kind === "terminalized") {
    return segment.outcome === "complete"
      ? { outcome: "complete" }
      : { outcome: "failed", reason: segment.record.error?.code ?? "failed" };
  }
  // Every refusal — cohort disabled, evidence unreadable, a flapped
  // observation, a stale expectation — is indeterminate rather than terminal.
  // None of them is evidence about the update's fate.
  return { outcome: "indeterminate", reason: segment.reason };
}

export function humanForVerifyReport(report: HostUpdateVerifyReport): string {
  switch (report.outcome) {
    case "complete":
      return "verified the restarted host is running the exact target version";
    case "failed":
      return `verification failed (${report.reason})`;
    case "resumed":
      return "bytes are placed but not yet running; activation continues";
    case "indeterminate":
      return `verification could not be completed (${report.reason}); the attempt record is unchanged`;
  }
}
