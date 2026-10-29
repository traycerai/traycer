import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useState } from "react";
import { useHostOverviewStatusQuery } from "@/components/settings/panels/host-overview-rpc";
import { liveBusySessionCount } from "@/components/settings/panels/my-hosts-model";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import {
  useSandboxOperation,
  type SandboxRowOperation,
} from "@/hooks/sandboxes/use-sandbox-operation";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  sandboxPublicState,
  sandboxSessionKinds,
  type SandboxSessionReport,
} from "@/lib/sandboxes/sandbox-row-lines";

interface SandboxSessionObservation {
  readonly report: SandboxSessionReport;
  /** The status read failed while the control plane says awake. */
  readonly failed: boolean;
  /** A host answer exists in this query's lifecycle, even without sessions. */
  readonly hasReported: boolean;
}

interface ObservedResume {
  readonly sandboxId: string;
  readonly userId: string | null;
  readonly identity: readonly ["sandbox-wake", "mutation" | "list", number];
  readonly operationAt: number | null;
  /** A sent Resume can precede the list's observation of its operation. */
  readonly awaitingOperation: boolean;
  /** Once a reply arrived, evicting its query must not rearm the Resume. */
  readonly hasReported: boolean;
}

/** Only a Resume this client saw start waits for its first host answer. */
export function useSandboxRowSessionReport(summary: SandboxSummary): {
  readonly report: SandboxSessionReport;
  readonly failed: boolean;
  readonly resumePending: boolean;
} {
  const operation = useSandboxOperation(summary.id);
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const [observed, setObserved] = useState<ObservedResume | null>(null);
  const current =
    observed?.sandboxId === summary.id && observed.userId === userId
      ? observed
      : null;
  let resume = observeResume(summary, operation, userId, current);
  const awake = sandboxPublicState(summary) === "awake";
  const observation = useSessionObservation(
    summary.hostId,
    awake,
    resume?.identity,
  );
  if (resume !== null && !resume.hasReported && observation.hasReported) {
    resume = { ...resume, hasReported: true };
  }
  if (resume !== observed) setObserved(resume);
  return {
    report: observation.report,
    failed: observation.failed,
    resumePending:
      resume !== null &&
      awake &&
      summary.guestConfigured !== false &&
      (summary.state === "resuming" || !resume.hasReported),
  };
}

function observeResume(
  summary: SandboxSummary,
  operation: SandboxRowOperation | null,
  userId: string | null,
  observed: ObservedResume | null,
): ObservedResume | null {
  if (summary.kind === "automation" || summary.frozen) return null;
  if (operation?.kind === "pending") {
    if (operation.verb !== "resume") return null;
    if (
      observed?.identity[1] !== "mutation" ||
      observed.identity[2] !== operation.submittedAt
    ) {
      return {
        sandboxId: summary.id,
        userId,
        identity: ["sandbox-wake", "mutation", operation.submittedAt],
        operationAt: summary.operation?.at ?? null,
        awaitingOperation: true,
        hasReported: false,
      };
    }
  }
  if (
    observed?.identity[1] === "mutation" &&
    operation?.kind === "failed" &&
    operation.verb === "resume"
  )
    return null;
  return observeListedResume(summary, userId, observed);
}

function observeListedResume(
  summary: SandboxSummary,
  userId: string | null,
  observed: ObservedResume | null,
): ObservedResume | null {
  const operationAt = summary.operation?.at ?? null;
  if (summary.state === "resuming") {
    return observeResumingRow(summary, userId, observed);
  }
  if (observed === null) return null;
  if (operationAt !== null && observed.operationAt !== operationAt) {
    const operation = summary.operation;
    if (
      observed.awaitingOperation &&
      operation?.cause === "wake" &&
      operation.fromState === "suspended" &&
      operation.outcomeCause !== "failure"
    )
      return { ...observed, operationAt, awaitingOperation: false };
    return null;
  }
  if (
    summary.state !== "awake" &&
    (!observed.awaitingOperation || observed.hasReported)
  )
    return null;
  return observed;
}

/** A listed resuming state starts a wake, or acknowledges the Resume we sent. */
function observeResumingRow(
  summary: SandboxSummary,
  userId: string | null,
  observed: ObservedResume | null,
): ObservedResume {
  const at = summary.operation?.at ?? summary.lastTransitionAt;
  if (observed?.awaitingOperation) {
    return { ...observed, operationAt: at, awaitingOperation: false };
  }
  if (observed === null || observed.operationAt !== at) {
    return {
      sandboxId: summary.id,
      userId,
      identity: ["sandbox-wake", "list", at],
      operationAt: at,
      awaitingOperation: false,
      hasReported: false,
    };
  }
  return observed;
}

/**
 * What a sandbox host last reported about its running sessions, for the
 * Sandboxes row and the confirmations. Settings is not in a task, so the
 * task-scoped agent and terminal lists do not answer it: the host-wide fact
 * is `host.status`'s `sessions`, every running agent and open terminal (idle
 * ones included, which `busySessionCount` leaves out: that count is what an
 * update drain waits for), read as the Overview reads it. A live read is the
 * list; an answer that is no longer live is its count `as of` its age; no
 * list at all, from a host below @1.9, is unknown, never a zero.
 *
 * `enabled` is false on a resting row: a read never wakes a sandbox, and a
 * resting one has no sessions to report.
 */
export function useSandboxSessionReport(
  hostId: string,
  enabled: boolean,
): SandboxSessionObservation {
  return useSessionObservation(hostId, enabled, undefined);
}

function useSessionObservation(
  hostId: string,
  enabled: boolean,
  cacheKeyIdentity: ReadonlyArray<unknown> | undefined,
): SandboxSessionObservation {
  const client = useHostClientForHostId(hostId);
  const status = useHostOverviewStatusQuery({
    client,
    enabled: enabled && client !== null,
    hostId,
    cacheKeyIdentity,
  });
  const data = status.data ?? null;
  const hasReported = data !== null && !status.isPlaceholderData;
  const sessions = data?.sessions ?? null;
  const kinds = sandboxSessionKinds(sessions);
  const count = kinds === null ? null : kinds.agents + kinds.terminals;
  const live = liveBusySessionCount({
    reportedCount: count,
    isError: status.isError,
    fetchStatus: status.fetchStatus,
    isStale: status.isStale,
    hasLiveSource: enabled && client !== null,
  });
  if (data !== null && sessions !== null && kinds !== null && live !== null) {
    return {
      report: { kind: "live", count: live, busy: data.busy, kinds, sessions },
      failed: false,
      hasReported,
    };
  }
  // A read that never answered has no time; its count is not "as of" one.
  if (count !== null && status.dataUpdatedAt > 0) {
    return {
      report: { kind: "stale", count, at: status.dataUpdatedAt },
      failed: status.isError,
      hasReported,
    };
  }
  return { report: { kind: "unknown" }, failed: status.isError, hasReported };
}
