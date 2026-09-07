import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";

/** Why a worktree-bindings read failed, reduced to the only distinction a surface can act on. */
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
