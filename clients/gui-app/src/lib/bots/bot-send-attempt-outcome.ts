import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
  HostTransportFailureError,
  mayHaveReachedHost,
} from "@traycer/protocol/host-transport/remote/rpc-types";

/**
 * What a failed attempt of a bot send that carries a nonce proves (Tracy Bots
 * T249): `refused` when this attempt wrote nothing, else `uncertain`.
 *
 * Nothing was written when the host said so (`notWritten`, set only before
 * its write), when the connection's handshake was below the floor the send
 * needs, and when the transport attests the request never left. Every other
 * failure, an answered error included, may follow the host's write.
 */
export function botSendAttemptOutcome(error: unknown): "refused" | "uncertain" {
  if (error instanceof HostRpcError && error.notWritten) return "refused";
  if (error instanceof HostMethodVersionUnsatisfiedError) return "refused";
  if (
    error instanceof HostTransportFailureError &&
    !mayHaveReachedHost(error)
  ) {
    return "refused";
  }
  return "uncertain";
}
