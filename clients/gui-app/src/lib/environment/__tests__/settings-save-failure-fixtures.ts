import {
  HostRequestAbortedError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";

export const ABANDONED_SAVE_MESSAGE =
  "The account changed before the save was sent";

export function abandonedSaveError(method: string): HostRequestAbortedError {
  return new HostRequestAbortedError({
    message: ABANDONED_SAVE_MESSAGE,
    requestId: "settings-save-abandoned",
    method,
    mayHaveDispatched: false,
  });
}

export function saveTransportFailure(
  method: string,
): HostTransportFailureError {
  return new HostTransportFailureError({
    code: "RPC_ERROR",
    message: "The host connection closed before the save answered",
    requestId: "settings-save-transport-failure",
    method,
    fatalDetails: null,
  });
}
