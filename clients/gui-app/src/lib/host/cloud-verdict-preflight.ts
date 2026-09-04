import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * The refusal a cloud-capability read raises at DISPATCH when the session no
 * longer holds a verdict. Not a transport failure: `isTransientHostRpcFailure`
 * does not retry it, which is what ends a retry episode already running when
 * the session was demoted.
 */
export function cloudReadRefusedWithoutVerdict(method: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message:
      "This session no longer holds a cloud verdict, so the cloud read was not sent.",
    requestId: "client-pre-flight",
    method,
    fatalDetails: null,
  });
}

/**
 * A `preflight` for `useHostQuery` / `useHostQueries` that re-reads the live
 * verdict immediately before each dispatch.
 *
 * `enabled: authorizesCloudCapability(...)` stops the NEXT fetch. It does not
 * stop a `refetch()` override, and it does not stop the transient-retry
 * episode already running when the session is demoted - and a same-user
 * demotion retains the host credential those retries would ride. Every
 * cloud-gated read takes this at dispatch so the gate holds at both edges.
 */
export function cloudVerdictPreflight(method: string): () => void {
  return () => {
    if (!authorizesCloudCapability(useAuthStore.getState().status)) {
      throw cloudReadRefusedWithoutVerdict(method);
    }
  };
}
