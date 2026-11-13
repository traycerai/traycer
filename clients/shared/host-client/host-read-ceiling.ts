import {
  ATTACH_ACK_TIMEOUT_MS,
  NOISE_HANDSHAKE_TIMEOUT_MS,
  RECONNECT_MAX_BACKOFF_MS,
  RELAY_DIAL_TIMEOUT_MS,
  SESSION_OPEN_ACK_TIMEOUT_MS,
  UNARY_RESPONSE_TIMEOUT_MS,
} from "../host-transport/remote/config";
import { HostTransportFailureError } from "../host-transport/host-messenger";
import { DEFAULT_TRANSPORT_RETRY_POLICY } from "../host-transport/retrying-messenger";

/**
 * Margin over the budgeted phases, for the waits no constant bounds: the relay
 * grant fetch and an event loop stalled on either end. A reattach was measured
 * waiting 33.3 s against the 30 s backoff cap.
 */
const UNBUDGETED_WAIT_MARGIN = 1.5;

/**
 * How long a read may stay in flight before it can only be stranded.
 *
 * Every phase an honest read passes through is bounded: each transport
 * attempt can sit out one full reconnect backoff, then dial, attach, handshake
 * and open the session, then wait its response budget, and the transport
 * retries a failed attempt a bounded number of times. A pre-ready park has no
 * timer of its own, but the attach attempt it rides settles it, so it is
 * inside the same sum. A read past the whole of it, with margin, is waiting on
 * something nothing will ever settle.
 *
 * `responseBudgetMs` is the method's declared wait (its policy's
 * `joinResponseTimeoutMs`), or null for the transport's default.
 */
export function hostReadCeilingMs(responseBudgetMs: number | null): number {
  const { maxRetries, maxDelayMs } = DEFAULT_TRANSPORT_RETRY_POLICY;
  const attemptMs =
    RECONNECT_MAX_BACKOFF_MS +
    RELAY_DIAL_TIMEOUT_MS +
    ATTACH_ACK_TIMEOUT_MS +
    NOISE_HANDSHAKE_TIMEOUT_MS +
    SESSION_OPEN_ACK_TIMEOUT_MS +
    Math.max(UNARY_RESPONSE_TIMEOUT_MS, responseBudgetMs ?? 0);
  return Math.ceil(
    UNBUDGETED_WAIT_MARGIN *
      ((maxRetries + 1) * attemptMs + maxRetries * maxDelayMs),
  );
}

/**
 * A read that outlived {@link hostReadCeilingMs}. A transport failure, because
 * the transport is what never answered, and already past every transport
 * retry the ceiling budgets for.
 */
export class HostReadStrandedError extends HostTransportFailureError {
  constructor(method: string, ceilingMs: number) {
    super({
      code: "RPC_ERROR",
      message: `${method} did not answer within ${String(Math.round(ceilingMs / 1000))}s`,
      requestId: "client-read-ceiling",
      method,
      fatalDetails: null,
    });
    this.name = "HostReadStrandedError";
  }
}
