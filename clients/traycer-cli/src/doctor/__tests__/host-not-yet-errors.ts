import {
  HostRpcError,
  HostTransportFailureError,
  RetryableTransportError,
} from "../../../../shared/host-transport/host-messenger";

/**
 * The errors a host's answer to doctor's calls becomes, built as the transport
 * builds them. A "not yet" is the host's own retryable answer, with its code in
 * `fatalDetails`; a host that did not answer leaves `fatalDetails` null.
 */
export interface HostNotYetErrors {
  /** A retryable error answered on an admitted session. */
  readonly notYetOnRequest: (method: string) => Error;
  /** A retryable refusal at the open, before any request. */
  readonly notYetAtOpen: (method: string) => Error;
  /** Nothing answered. */
  readonly silent: (method: string) => Error;
  /** A final refusal: not retryable. */
  readonly unauthorized: (method: string) => Error;
}

export const hostNotYetErrors: HostNotYetErrors = {
  notYetOnRequest: (method) =>
    new RetryableTransportError({
      code: "RPC_ERROR",
      message: "the team's host is reconnecting",
      requestId: "not-yet-request",
      method,
      fatalDetails: {
        code: "TEAM_HOST_RECONNECTING",
        reason: "waiting for the team's host to reconnect",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: true,
      },
      replaySafetyFromKey: false,
    }),
  notYetAtOpen: (method) =>
    new RetryableTransportError({
      code: "RPC_ERROR",
      message: "the host has not admitted this session yet",
      requestId: "not-yet-open",
      method,
      fatalDetails: {
        code: "UNAUTHORIZED",
        reason: "host has not admitted this session yet",
        incompatibleMethods: null,
        upgradeGuidance: null,
        doorReason: "not_admitted",
        retryable: true,
      },
      replaySafetyFromKey: false,
    }),
  silent: (method) =>
    new HostTransportFailureError({
      code: "RPC_ERROR",
      message: "frame timeout",
      requestId: "silent",
      method,
      fatalDetails: null,
    }),
  unauthorized: (method) =>
    new HostRpcError({
      code: "UNAUTHORIZED",
      message: "rejected",
      requestId: "final-refusal",
      method,
      fatalDetails: {
        code: "UNAUTHORIZED",
        reason: "rejected",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    }),
};
