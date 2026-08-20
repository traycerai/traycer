import {
  classifyHostRequestFailure,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { CreateChatRequestV11 } from "@traycer/protocol/host/epic/unary-schemas";

/**
 * The two client-visible ways a LATEST-checkpoint fork request can fail
 * without ending the operation that sent it.
 *
 * `"no-checkpoint"` names the SOURCE - it has no assistant turn yet, so there
 * is no checkpoint to fork through, and the host refuses with a typed
 * `E_FORK_CHECKPOINT_UNAVAILABLE` rather than failing the whole create.
 * `"host-too-old"` names the TARGET - `epic.createChat@1.1`'s
 * `boundary: "latest"` variant carries no `assistantMessageId`, so the
 * transport's same-major minor downgrade cannot re-parse the request against a
 * `@1.0` host's schema and rejects it client-side as `DOWNGRADE_UNSUPPORTED`,
 * before a frame is sent.
 *
 * Both mean the same thing to the caller - "this attempt cannot carry history"
 * - and get the same recovery: retry once without `forkSource`.
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
 * Whether this create failure is a step INSIDE an operation that recovers from
 * it, rather than the end of one - the question the shared `epic.createChat`
 * error toast has to answer before it says anything.
 *
 * `cloneChatOnHostSwitch` is the only producer of `boundary: "latest"` in this
 * app, and it treats exactly {@link classifyRecoverableForkFailure}'s two arms
 * as recoverable: it narrates the history downgrade itself
 * (`onHistoryUnavailable`) and retries without `forkSource`, so the clone still
 * lands. A toast from the shared handler is therefore describing an attempt,
 * not an outcome - and since `epic.createChat`'s toast now forwards the host's
 * own text, it reads as a specific, terminal failure moments before the
 * operation succeeds. That is the opposite of what the detail was added for.
 *
 * Keyed on the REQUEST as well as the error, which is what keeps this from
 * silencing a real failure: the manual fork dialog names a precise
 * `boundary: "assistantMessage"`, has no retry, and reaches
 * `E_FORK_CHECKPOINT_UNAVAILABLE` as a genuinely terminal refusal that must
 * still be reported. Only the variant whose sender is standing by to retry is
 * suppressed.
 *
 * This predicate and the clone flow's own recovery branch read the SAME
 * classifier deliberately. They are one decision expressed at two seams, and
 * the failure mode of duplicating it is silent: a clone flow that stopped
 * recovering from one arm would leave this suppression swallowing a failure
 * nobody reports.
 */
export function isRecoverableLatestForkRefusal(
  error: HostRpcError,
  request: CreateChatRequestV11,
): boolean {
  if (request.forkSource?.boundary !== "latest") return false;
  return classifyRecoverableForkFailure(error) !== null;
}
