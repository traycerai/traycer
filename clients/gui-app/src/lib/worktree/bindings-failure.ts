import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * Why a worktree-bindings read failed, reduced to the only distinction a
 * surface can act on.
 *
 * `unreachable` is the machine not answering. Everything else is the host
 * answering with a refusal - unauthorized, unsupported method, an internal
 * failure on the far side - and the two are NOT interchangeable: one is fixed
 * by re-dialing or moving off a pin, the other only by reading what the host
 * said. Presenting an answered refusal as an offline machine names a remedy on
 * the wrong box and hides the one fact that could point at a cause, which is
 * the defect the panels' empty states were rewritten to stop making.
 *
 * It lives here rather than in either panel because BOTH the git-diff panel
 * and the file-tree panel read the same bindings call, and two surfaces that
 * disagreed about what "unreachable" means would show a user two different
 * stories about one host.
 */
export type BindingsFailure =
  | { readonly kind: "unreachable" }
  | { readonly kind: "answered"; readonly message: string };

export function classifyBindingsFailure(
  error: HostRpcError | null,
): BindingsFailure | null {
  if (error === null) return null;
  // `HostTransportFailureError` extends `HostRpcError`, so this order matters:
  // it is the ONLY error that means the host did not answer.
  if (error instanceof HostTransportFailureError)
    return { kind: "unreachable" };
  const message = error.message.trim();
  return {
    kind: "answered",
    message: message.length > 0 ? message : "The host refused the request.",
  };
}
