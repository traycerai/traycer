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

// Post-restart verification for a Desktop-owned packaged-macOS activation. Fail closed on an unreadable record.

export interface HostUpdateVerifyArgs {
  readonly attemptId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly targetVersion: string;
}

/** The wire shape Desktop maps onto `DesktopVerificationOutcome`. `indeterminate` is the load-bearing arm. */
export type HostUpdateVerifyReport =
  | { readonly outcome: "complete" }
  | { readonly outcome: "failed"; readonly reason: string }
  | {
      readonly outcome: "resumed";
      readonly continuation: "activate";
      /** The identity of the record as it is PARKED, after recovery handed the continuation back (Ticket 07 orphan-recovery ruling). Load-bearing, and the reason the arm carries an identity at all: the caller resumes this exact parked attempt with an ordinary claim. */
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
        // The recovery arm carries the original trigger through; this value is only consulted if the request were to mint a new attempt, which an identity-bound request cannot do.
        trigger: "manual",
        // The same authorization the activation segment held.
        // Recovery never upgrades an action: `activate` can adopt only the activation continuation, so this claim cannot turn into an apply.
        action: "activate",
        expected: {
          attemptId: args.attemptId,
          generation: args.generation,
          sequence: args.sequence,
        },
        // Unreachable for an identity-bound request - `decideAttemptClaim`
        // resolves those before any create path - but required by the shape.
        newAttemptId: randomUUID(),
        initialPhase: "preparing",
      },
      nowIso: () => new Date().toISOString(),
      faults: NO_UPDATE_EXECUTOR_FAULTS,
    },
    // No dispatch parent is waiting on a private acknowledgement: Desktop reads
    // the report instead.
    async () => undefined,
    // The claim IS the work.
    // A resumed activation is reported back so Desktop can decide whether to run another activation segment; performing one here would put activation in two places.
    async () => undefined,
  );
  return reportFor(segment);
}

function reportFor(
  segment: ExecutorSegmentOutcome<undefined>,
): HostUpdateVerifyReport {
  if (segment.kind === "executed") {
    // The claim resolved to a live continuation rather than a terminal state: bytes are placed but the host is not yet running them.
    // The identity reported is the PARKED one.
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
  // Every refusal - cohort disabled, evidence unreadable, a flapped observation, a stale expectation - is indeterminate rather than terminal.
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
