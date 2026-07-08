import { createContext, use } from "react";
import {
  RetryableTransportError,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host/runtime";

const HOST_STATUS_PROBE = {};

export type HostCompatibility =
  | {
      readonly status: "checking" | "compatible";
      readonly retry: () => void;
    }
  | {
      readonly status: "failed";
      readonly retry: () => void;
      readonly retrying: boolean;
      readonly error: HostRpcError;
    }
  | {
      readonly status: "incompatible";
      readonly retry: () => void;
      readonly error: HostRpcError;
    };

export const HostCompatibilityContext = createContext<HostCompatibility | null>(
  null,
);

export function useHostCompatibility(): HostCompatibility {
  const compatibility = use(HostCompatibilityContext);
  if (compatibility === null) {
    throw new Error(
      "Host compatibility hooks must be used inside a <HostCompatibilityProvider>.",
    );
  }
  return compatibility;
}

export function useHostCompatibilityProbe(): HostCompatibility {
  const client = useHostClient();
  const probe = useHostQuery<HostRpcRegistry, "host.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.status",
    params: HOST_STATUS_PROBE,
    options: {
      // Retry a transient failure a couple of times so a momentary blip never
      // reads as incompatible, but fail fast on a terminal compat verdict
      // (retrying an INCOMPATIBLE handshake cannot change the answer) and on a
      // `RetryableTransportError`, which the transport layer has already retried
      // to exhaustion - retrying here would stack dial-timeout costs and block
      // the gate far longer.
      retry: (failureCount, error) =>
        !isTerminalHostCompatibilityError(error) &&
        !(error instanceof RetryableTransportError) &&
        failureCount < 2,
      retryDelay: 0,
      // A compatible verdict must not bounce back to "checking": Infinity keeps
      // the success cached with no background refetch, so children stay mounted
      // even if the host connection later churns. The query key is host-id
      // scoped, so a genuine host swap still re-probes.
      staleTime: Infinity,
    },
  });
  if (probe.isSuccess) {
    return { status: "compatible", retry: () => void probe.refetch() };
  }
  if (probe.error !== null && isTerminalHostCompatibilityError(probe.error)) {
    return {
      status: "incompatible",
      retry: () => void probe.refetch(),
      error: probe.error,
    };
  }
  if (probe.isError) {
    return {
      status: "failed",
      retry: () => void probe.refetch(),
      retrying: probe.isFetching,
      error: probe.error,
    };
  }
  return { status: "checking", retry: () => void probe.refetch() };
}

export function isTerminalHostCompatibilityError(error: HostRpcError): boolean {
  return (
    error.code === "INCOMPATIBLE" || error.code === "DOWNGRADE_UNSUPPORTED"
  );
}

export function describeHostCompatibilityError(error: HostRpcError): string {
  const reason = error.fatalDetails?.reason ?? error.message;
  return reason.trim().length > 0
    ? reason
    : "The host RPC protocol is incompatible with this app.";
}
