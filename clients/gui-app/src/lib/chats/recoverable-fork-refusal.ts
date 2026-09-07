import {
  classifyHostRequestFailure,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { CreateChatRequestV11 } from "@traycer/protocol/host/epic/unary-schemas";

/**
 * The two client-visible ways a LATEST-checkpoint fork request can fail without ending the operation that sent it.
 */
export type RecoverableForkFailure = "no-checkpoint" | "host-too-old";

export function classifyRecoverableForkFailure(
  error: HostRpcError,
): RecoverableForkFailure | null {
  if (error.code === "E_FORK_CHECKPOINT_UNAVAILABLE") return "no-checkpoint";
  if (classifyHostRequestFailure(error).kind === "downgrade-unsupported") {
    return "host-too-old";
  }
  return null;
}

/**
 * Whether this create failure is a step INSIDE an operation that recovers from it, rather than the end of one - the question the shared `epic.createChat` error toast has to answer before it says anything.
 */
export function isRecoverableLatestForkRefusal(
  error: HostRpcError,
  request: CreateChatRequestV11,
): boolean {
  if (request.forkSource?.boundary !== "latest") return false;
  return classifyRecoverableForkFailure(error) !== null;
}
