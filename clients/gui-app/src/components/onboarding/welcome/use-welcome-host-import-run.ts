import { useEffect } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { SessionImportStatusResponse } from "@traycer/protocol/host/session-import/contracts";
import { attachSessionImportRun } from "@/components/session-import/session-import-run-handle";
import { useSessionImportCheckStatus } from "@/hooks/session-import/use-session-import-check-status-query";
import type { StreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { useSessionImportRun } from "@/stores/session-import/session-import-run-store";

export interface WelcomeHostImportRun {
  /** A run is in flight here, or the host reports one: watch, never resubmit. */
  readonly alreadyRunning: boolean;
  readonly canSubmit: boolean;
  readonly checkingStatus: boolean;
  /** The host probe itself, for the page's "could not check" retry row. */
  readonly statusQuery: UseQueryResult<
    SessionImportStatusResponse,
    HostRpcError
  >;
}

/**
 * Whether an import can be started on the modal's host right now. "In
 * flight", not "idle": a FINISHED run the store still summarises (the modal
 * re-shown from Settings after an earlier import) must not hold the status
 * probe closed, or Import could never enable again. The wizard retires such
 * a run on mount instead; the welcome modal has no summary to make way for,
 * so it leaves the store alone and asks the host. A run found on the host
 * is watched, never re-submitted: attaching gives the progress toast
 * something to show once the modal finishes.
 *
 * Owned by the MODAL rather than page 2, because the header's copy depends
 * on the same answer (the "untick" hint has nothing to point at over the
 * already-running notice) and the probe is keyed per hook instance, so two
 * callers would be two RPCs. `active` is page 2 on a ready host: the probe
 * fires when the page that acts on it is on screen, as it did when the page
 * owned the hook, not from the moment the modal opens.
 */
export function useWelcomeHostImportRun(
  streamBinding: StreamRuntimeBinding | null,
  active: boolean,
): WelcomeHostImportRun {
  const hostId = streamBinding?.hostId ?? null;
  const runStatus = useSessionImportRun(hostId).status;
  const runInFlight = runStatus === "starting" || runStatus === "running";
  const statusQuery = useSessionImportCheckStatus(
    streamBinding,
    active && !runInFlight,
  );
  const activeRun = statusQuery.isSuccess ? statusQuery.data.active : null;
  const canSubmit = sessionImportHostIsIdle(statusQuery);
  useEffect(() => {
    if (runInFlight || !statusQuery.isSuccess || statusQuery.isFetching) return;
    if (activeRun !== null) attachSessionImportRun(streamBinding, activeRun);
  }, [
    activeRun,
    runInFlight,
    statusQuery.isFetching,
    statusQuery.isSuccess,
    streamBinding,
  ]);
  return {
    alreadyRunning: runInFlight || activeRun !== null,
    canSubmit,
    checkingStatus: !statusQuery.isError && !canSubmit,
    statusQuery,
  };
}

/** A pending, failed, or refetching status cannot authorize a new import. */
function sessionImportHostIsIdle(
  query: UseQueryResult<SessionImportStatusResponse, HostRpcError>,
): boolean {
  return query.isSuccess && !query.isFetching && query.data.active === null;
}
