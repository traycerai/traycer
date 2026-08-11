import { createContext, use, type Context } from "react";
import {
  HostRequestAbortedError,
  HostTransportFailureError,
  RetryableTransportError,
  type HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient } from "@/lib/host/runtime";
import { queryKeys } from "@/lib/query-keys";

const HOST_STATUS_PROBE = {};

/**
 * The cache slot the compat probe below owns for one host.
 *
 * Exported so surfaces that must observe the probe for a SPECIFIC host id -
 * the host status strip, which holds its "switching" state until the host it
 * just switched TO has settled - read the same slot the probe writes instead
 * of re-deriving the key. `useHostCompatibility()` answers only for whichever
 * host is active at render time, which cannot distinguish "the new host's
 * verdict" from "the old host's verdict, one render before the query re-keys".
 */
export function hostStatusProbeQueryKey(hostId: string): readonly unknown[] {
  return queryKeys.hostMethod<HostRpcRegistry, "host.status">(
    hostId,
    "host.status",
    HOST_STATUS_PROBE,
  );
}

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

type HostCompatibilityContextValue = Context<HostCompatibility | null>;

interface HostCompatibilityDevGlobals {
  __TRAYCER_HOST_COMPATIBILITY_CONTEXT__:
    HostCompatibilityContextValue | undefined;
}

function createStableHostCompatibilityContext(): HostCompatibilityContextValue {
  // Fast Refresh can retain a provider from the previous module generation
  // while consumers have already switched to the next one. Reuse the context
  // object only in Vite's hot runtime so both generations keep addressing the
  // same provider. A production build has no import.meta.hot and gets a normal
  // page-local context.
  if (import.meta.hot === undefined) {
    return createContext<HostCompatibility | null>(null);
  }

  const devGlobals = globalThis as typeof globalThis &
    HostCompatibilityDevGlobals;
  const existing = devGlobals.__TRAYCER_HOST_COMPATIBILITY_CONTEXT__;
  if (existing !== undefined) {
    return existing;
  }

  const context = createContext<HostCompatibility | null>(null);
  devGlobals.__TRAYCER_HOST_COMPATIBILITY_CONTEXT__ = context;
  return context;
}

export const HostCompatibilityContext = createStableHostCompatibilityContext();

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
      // The verdict must also survive being RE-KEYED away. This probe has
      // exactly one observer, so switching hosts leaves the previous host's
      // entry observer-less and the default 5-minute garbage collector starts
      // running: coming back to that host later found an empty slot and put
      // the whole app behind a "checking" splash carrying local-bootstrap copy
      // ("Starting local Traycer Host…") for a host that had been running the
      // entire time. Holding the entry for the session makes A -> B -> A
      // render from the held verdict in the same render, while `bind()`'s
      // `refetchActive: true` sweep still re-probes in the background - so the
      // held answer is a bridge across the switch, never a substitute for a
      // fresh one. Safety is unchanged: a terminal INCOMPATIBLE answer is
      // checked before held data below.
      gcTime: Infinity,
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
    // An errored probe with NO held answer is not automatically a verdict.
    // A pending-class transport error says the request never got a chance:
    // the session is still dialing, or the call was cancelled as the binding
    // moved. Settling `failed` there is what put a full-screen
    // "Traycer Host is not responding" in front of a remote host that was
    // seconds away from ready - and the gate latched it, because the recovery
    // wiring needs a readiness this very state prevents. Report it as the
    // still-in-progress state it is; the strip shows amber and the query's
    // own lifecycle (transport retry, availability recovery, an explicit
    // Retry) settles it one way or the other.
    if (isPendingHostProbeError(probe.error)) {
      return { status: "checking", retry: () => void probe.refetch() };
    }
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
 * True for a probe failure that has NOT settled anything about the host: the
 * transport can still reach a different outcome without anyone asking.
 *
 *  - `RetryableTransportError` carries the pre-send no-dispatch guarantee -
 *    the request frame never went out, typically because the session is mid
 *    dial/handshake.
 *  - `HostRequestAbortedError` is a binding/context change cancelling the
 *    call. The answer for the host we are NOW pointed at is simply not in
 *    yet, and an abort on the active key must never settle a failed verdict
 *    for the host that just became active.
 *
 * A plain `HostTransportFailureError` (session closed, host down) and any
 * host-originated error are settled answers and fall through to `failed`.
 * Accepts `unknown` so cache-level readers (the status strip inspects the
 * probe's `QueryState.error`) can share this one classification.
 */
export function isPendingHostProbeError(error: unknown): boolean {
  return (
    error instanceof RetryableTransportError ||
    error instanceof HostRequestAbortedError
  );
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
 *
 * This drives COPY and report telemetry only - never whether the surface
 * opens. That decision belongs to the state machine above, which now filters
 * the pending-class subclasses out before this is ever consulted; what
 * reaches it is a settled transport failure, so "unreachable" here means the
 * host was genuinely not talking, not "the dial had not finished".
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
