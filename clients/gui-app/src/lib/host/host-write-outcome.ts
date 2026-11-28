import {
  HostMethodVersionUnsatisfiedError,
  HostRequestAbortedError,
  mayHaveReachedHost,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  isTargetAnswer,
  wasRequestNotSent,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import { HostBelowMinimumError } from "@/lib/host/host-below-minimum-error";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";

const localRefusalIds = new Set(["client-preflight", "client-unavailable"]);

/** Whether a failed write was sent and can still have changed the addressed peer. */
export function hostWriteFailureOutcome(
  error: HostRpcError,
  hostId: string | null,
): "not-sent" | "refused" | "unknown" {
  if (wasRequestNotSent(error)) return "not-sent";
  // A retry can reuse the last refusal's request ID after an earlier send.
  if (mayHaveReachedHost(error)) return "unknown";
  if (
    localRefusalIds.has(error.requestId) ||
    error instanceof HostBelowMinimumError ||
    error instanceof HostMethodVersionUnsatisfiedError
  ) {
    return "not-sent";
  }
  if (error instanceof HostRequestAbortedError) return "not-sent";
  if (!isTargetAnswer(error)) return "unknown";
  // A generic peer error can arrive after that peer forwarded the write.
  if (error.message === "No collaboration thread provider for this artifact")
    return "refused";
  return (hostId === POOL_HOST_ID && error.code === "RPC_ERROR") ||
    error.code === "E_IDEMPOTENCY_OUTCOME_UNKNOWN"
    ? "unknown"
    : "refused";
}
