import {
  HostMethodVersionUnsatisfiedError,
  HostRequestAbortedError,
  HostTransportFailureError,
  RetryableTransportError,
  mayHaveReachedHost,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { HostBelowMinimumError } from "@/lib/host/host-below-minimum-error";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";

const localRefusalIds = new Set(["client-preflight", "client-unavailable"]);

/** Whether a failed write was sent and can still have changed the addressed peer. */
export function hostWriteFailureOutcome(
  error: HostRpcError,
  hostId: string | null,
): "not-sent" | "refused" | "unknown" {
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
  if (error instanceof RetryableTransportError) {
    return error.fatalDetails === null ? "not-sent" : "refused";
  }
  if (error instanceof HostTransportFailureError) return "refused";
  // A generic peer error can arrive after that peer forwarded the write.
  if (error.message === "No collaboration thread provider for this artifact")
    return "refused";
  return (hostId === POOL_HOST_ID && error.code === "RPC_ERROR") ||
    error.code === "E_IDEMPOTENCY_OUTCOME_UNKNOWN"
    ? "unknown"
    : "refused";
}
