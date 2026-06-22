import type { ReactNode } from "react";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useGitCapabilitiesQuery } from "@/hooks/git/use-git-capabilities-query";
import { DiffLoadingSkeleton } from "./diff-loading-skeleton";
import { HostUnsupported } from "./empty-states/host-unsupported";

/**
 * Detects RPC_ERROR for a method that doesn't exist on the host.
 * When a host doesn't support a method (too old), it returns RPC_ERROR with
 * a message containing "method" or similar. We inspect both the error code and
 * message to identify this case.
 */
function isMethodNotFoundError(error: unknown): boolean {
  if (error instanceof Error && "code" in error) {
    const rpcError = error as HostRpcError;
    // Heuristic: RPC_ERROR code + message containing "method" suggests an unknown method
    if (
      rpcError.code === "RPC_ERROR" &&
      rpcError.message.toLowerCase().includes("method")
    ) {
      return true;
    }
  }
  return false;
}

export function CapabilityGate(props: {
  readonly hostId: string | null;
  readonly runningDir: string;
  readonly children: ReactNode;
}) {
  const cap = useGitCapabilitiesQuery({
    hostId: props.hostId,
    runningDir: props.runningDir,
    enabled: true,
  });

  if (cap.isPending) {
    return <DiffLoadingSkeleton variant="capability" />;
  }

  const isMethodNotFound =
    cap.error !== null && isMethodNotFoundError(cap.error);
  const hasError = cap.error !== null;
  const isUnsupported =
    (cap.data !== undefined && !cap.data.available) ||
    isMethodNotFound ||
    hasError;

  if (isUnsupported) {
    let reason: string;
    if (isMethodNotFound) {
      reason = "host too old (no git.* methods)";
    } else if (hasError) {
      reason = cap.error.message;
    } else {
      reason = cap.data.reason ?? "git unavailable";
    }
    return <HostUnsupported reason={reason} />;
  }

  return <>{props.children}</>;
}
