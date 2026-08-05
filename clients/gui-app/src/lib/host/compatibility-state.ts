import { createContext, use } from "react";
import {
  HostTransportFailureError,
  RetryableTransportError,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host/runtime";

const HOST_STATUS_PROBE = {};

/**
 * What the host's `host.status` answer said about itself, held alongside the
 * `compatible` verdict. A busy host that was up and serving turns
 * (traycer#860) used to be indistinguishable from one that never started,
 * because the probe read only success/failure and discarded this payload.
 */
export interface HostStatusSnapshot {
  readonly busy: boolean;
  readonly busySessionCount: number;
  readonly hostVersion: string;
}

export type HostCompatibility =
  | {
      readonly status: "checking";
      readonly retry: () => void;
    }
  | {
      readonly status: "compatible";
      readonly retry: () => void;
      /**
       * The verdict is held from an earlier successful probe whose latest
       * refetch failed - the host answered `host.status` for this host id at
       * least once, and the connection has since degraded. Surfaces are
       * expected to stay mounted and say the connection is degraded; they must
       * not treat this as a startup failure.
       */
      readonly degraded: boolean;
      /** The answer that produced (or last refreshed) this verdict. */
      readonly hostStatus: HostStatusSnapshot;
    }
  | {
      readonly status: "failed";
      readonly retry: () => void;
      readonly retrying: boolean;
      readonly error: HostRpcError;
      /**
       * The probe never reached the host (no bound client, dial/frame timeout,
       * dropped socket, or a fatal the host itself marked retryable). The
       * failure says nothing about protocol compatibility, so the surface must
       * describe the connection instead of implying a version mismatch.
       */
      readonly unreachable: boolean;
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
  // A terminal verdict is checked FIRST so a genuine incompatibility still
  // wins over a held verdict below: the only way `host.status` answers
  // INCOMPATIBLE under an unchanged query key is a host that was replaced or
  // updated underneath us, and that answer must not be suppressed.
  if (probe.error !== null && isTerminalHostCompatibilityError(probe.error)) {
    return {
      status: "incompatible",
      retry: () => void probe.refetch(),
      error: probe.error,
    };
  }
  // A present answer IS the compatible verdict, fresh or held. The fresh case
  // (`isSuccess`) and the held case below used to be separate branches that
  // differed only in `degraded`; `isSuccess` implies `isError` is false, so
  // one data-presence check covers both without changing either answer.
  //
  // Holding a verdict this host has already given: `staleTime: Infinity` keeps
  // a success cached, but a host-scoped invalidation (every stream
  // availability recovery issues one) refetches anyway - and a refetch that
  // FAILS used to drop `isSuccess` and tear the whole workspace down
  // mid-session, reporting a running host as a startup failure (traycer#860).
  // TanStack keeps the last successful `data` alongside the error, which is
  // exactly the evidence that this host answered the handshake: compatibility
  // cannot change without the host changing, and a host swap re-keys this
  // query (it is host-id scoped), so holding here can never mask a real
  // verdict.
  if (probe.data !== undefined) {
    return {
      status: "compatible",
      retry: () => void probe.refetch(),
      degraded: probe.isError,
      hostStatus: {
        busy: probe.data.busy,
        busySessionCount: probe.data.busySessionCount,
        hostVersion: probe.data.hostVersion,
      },
    };
  }
  if (probe.isError) {
    return {
      status: "failed",
      retry: () => void probe.refetch(),
      retrying: probe.isFetching,
      error: probe.error,
      unreachable: isHostUnreachableError(probe.error),
    };
  }
  return { status: "checking", retry: () => void probe.refetch() };
}

/**
 * True when the compat probe failed without the host answering it: the
 * transport never got a reply (no bound client, dial/handshake/frame timeout,
 * dropped socket), or the host closed the connection with a fatal it marked
 * retryable - a host that is up but cannot verify the session right now, e.g.
 * because it cannot reach the sign-in service (traycer#858).
 *
 * Both arrive as `HostTransportFailureError` subclasses, which is the one
 * signal that separates "we could not talk to the host" from "the host
 * evaluated this handshake and rejected it".
 */
function isHostUnreachableError(error: HostRpcError): boolean {
  return error instanceof HostTransportFailureError;
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
