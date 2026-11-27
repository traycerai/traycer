import type { CommandSendFailure } from "@traycer-clients/shared/replica-runtime";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostWriteFailureOutcome } from "@/lib/host/host-write-outcome";
import { classifyEpicWriteCommandFailure as classifyCoreFailure } from "./epic-write-command-core";

export {
  EpicWriteCommandTransportUnavailableError,
  readWriteCommandIntent,
  RelayedWriteCommandFailureError,
  type EpicWriteCommandIntent,
  type EpicWriteCommandSender,
} from "./epic-write-command-core";

/** Main classifies transport errors before it sends the cloned result to the worker. */
export function classifyEpicWriteCommandFailure(
  error: unknown,
): CommandSendFailure {
  const failure = classifyCoreFailure(error);
  if (
    failure.kind !== "queued" &&
    error instanceof HostRpcError &&
    hostWriteFailureOutcome(error, null) === "not-sent"
  ) {
    return { ...failure, mayHaveReachedHost: false };
  }
  return failure;
}
