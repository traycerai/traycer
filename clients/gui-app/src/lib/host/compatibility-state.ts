import { createContext, use, useEffect, useRef, type Context } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  HostRequestAbortedError,
  HostTransportFailureError,
  RetryableTransportError,
  type HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { ClientCompatibilityRequirement } from "@traycer/protocol/framework/index";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostClient } from "@/lib/host/runtime";
import { queryKeys } from "@/lib/query-keys";
import { transportEvidenceRelay } from "@/lib/host/transport-evidence";

const HOST_STATUS_PROBE = {};

/**
 * Session id each host's compat probe was riding when it resolved, in two slots (success vs rejection).
 * Bind at resolution, not report time; both arms must be anchored or a held compatible outranks a fresh incompatible.
 */
const compatAnchorAtSuccess = new Map<string, string | null>();
const compatAnchorAtFailure = new Map<string, string | null>();

/** The cache slot the compat probe below owns for one host. */
export function hostStatusProbeQueryKey(hostId: string): readonly unknown[] {
  return queryKeys.hostMethod<HostRpcRegistry, "host.status">(
    hostId,
    "host.status",
    HOST_STATUS_PROBE,
  );
}

/**
 * Invalidate (do not reset) the incoming host's probe when the selection store moves.
 * Skip the opening `null -> A` derivation and a move to empty.
 */
export function useHostStatusReprobeOnRepoint(
  effectiveHostId: string | null,
): void {
  const queryClient = useQueryClient();
  const previousHostId = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousHostId.current;
    previousHostId.current = effectiveHostId;
    if (
      previous === null ||
      effectiveHostId === null ||
      previous === effectiveHostId
    ) {
      return;
    }
    // `exact` so the sweep is structurally one entry: this host's probe slot, never the outgoing host's and never the surrounding host scope.
    // The narrowness is the invariant, so it is expressed in the call rather than left to the key's prefix shape.
    void queryClient.invalidateQueries({
      queryKey: hostStatusProbeQueryKey(effectiveHostId),
      exact: true,
    });
  }, [queryClient, effectiveHostId]);
}

/**
 * What the host's `host.status` answer said about itself, held alongside the `compatible` verdict.
 * A busy host that was up and serving turns (traycer#860) used to be indistinguishable from one that never started, because the probe read only success/failure and discarded this payload.
 */
export interface HostStatusSnapshot {
  readonly busy: boolean;
  /**
   * `null` when the peer did not report a count - an older host answering `host.status@1.0`, which the upgrade path no longer papers over with a fabricated `0`.
   * Nothing here renders it as a number today; it exists so a consumer that starts to cannot mistake "did not say" for "said none".
   */
  readonly busySessionCount: number | null;
  /**
   * Typed split of {@link busySessionCount}, or `null` when the peer did not say how the total splits (`host.status@1.1` and older).
   * A real zero object is idle-by-kind; `null` is unknown.
   */
  readonly busyBreakdown: HostBusyBreakdown | null;
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
       * The verdict is held from an earlier successful probe whose latest refetch failed - the host answered `host.status` for this host id at least once, and the connection has since degraded.
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
       * The probe never reached the host (no bound client, dial/frame timeout, dropped socket, or a fatal the host itself marked retryable).
       * The failure says nothing about protocol compatibility, so the surface must describe the connection instead of implying a version mismatch.
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
    | HostCompatibilityContextValue
    | undefined;
}

function createStableHostCompatibilityContext(): HostCompatibilityContextValue {
  // Fast Refresh can retain a provider from the previous module generation while consumers have already switched to the next one.
  // Reuse the context object only in Vite's hot runtime so both generations keep addressing the same provider.
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

/**
 * The returned object is fresh on every provider render. Read fields off it; never put it in a `useEffect` dep array.
 */
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
  // The same host id the query key is built from, read the same way `useHostQuery` reads it, so the anchor can never be recorded against a different host than the one whose cache slot the answer lands in.
  const probedHostId = useReactiveHostReadiness(client).hostId;
  return useHostCompatibilityProbeForClient(client, probedHostId);
}

/**
 * The `…ForClient` variant of the probe (the composer-RPC idiom): identical machinery, caller-supplied client and host.
 * The recovery path mounts one per `dead("incompatible")` host, because that host can never re-earn a compatible verdict through the app-wide probe - it is not effective, and it cannot BECOME effective until this very probe clears it.
 */
export function useHostCompatibilityProbeForClient(
  client: HostRequester<HostRpcRegistry> | null,
  probedHostId: string | null,
): HostCompatibility {
  const probe = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "host.status",
    ResponseOfMethod<HostRpcRegistry, "host.status">
  >({
    cacheKeyIdentity: undefined,
    client,
    method: "host.status",
    params: HOST_STATUS_PROBE,
    // THE CAPTURE POINT for a successful probe, and the reason this hook uses the response-map form at all rather than plain `useHostQuery`: `mapResponse` runs INSIDE the queryFn, in the same microtask the transport call resolves in.
    mapResponse: (args) => {
      if (probedHostId !== null) {
        compatAnchorAtSuccess.set(
          probedHostId,
          transportEvidenceRelay.currentSessionIdFor(probedHostId),
        );
      }
      return args.response;
    },
    options: {
      // Retry a transient failure a couple of times so a momentary blip never reads as incompatible, but fail fast on a terminal compat verdict (retrying an INCOMPATIBLE handshake cannot change the answer) and on a `RetryableTransportError`, which the transport.
      retry: (failureCount, error) => {
        // THE CAPTURE POINT for a failed probe - a DELIBERATE side effect in a predicate, and the justification is that this is the only hook TanStack exposes at rejection time that this file owns.
        if (probedHostId !== null) {
          compatAnchorAtFailure.set(
            probedHostId,
            transportEvidenceRelay.currentSessionIdFor(probedHostId),
          );
        }
        return (
          !isTerminalHostCompatibilityError(error) &&
          !(error instanceof RetryableTransportError) &&
          failureCount < 2
        );
      },
      retryDelay: 0,
      // A compatible verdict must not bounce back to "checking": Infinity keeps the success cached with no background refetch, so children stay mounted even if the host connection later churns.
      staleTime: Infinity,
      // Hold the probe for the session so A -> B -> A does not GC the slot and flash a checking splash.
      // Re-point invalidates in the background; a terminal incompatible answer is still checked before held data.
      gcTime: Infinity,
    },
  });
  // A terminal verdict is checked FIRST so a genuine incompatibility still wins over a held verdict below: the only way `host.status` answers INCOMPATIBLE under an unchanged query key is a host that was replaced or updated underneath us, and that answer must.
  if (probe.error !== null && isTerminalHostCompatibilityError(probe.error)) {
    return {
      status: "incompatible",
      retry: () => void probe.refetch(),
      error: probe.error,
    };
  }
  // A present answer IS the compatible verdict, fresh or held.
  // The fresh case (`isSuccess`) and the held case below used to be separate branches that differed only in `degraded`; `isSuccess` implies `isError` is false, so one data-presence check covers both without changing either answer.
  if (probe.data !== undefined) {
    return {
      status: "compatible",
      retry: () => void probe.refetch(),
      degraded: probe.isError,
      hostStatus: {
        busy: probe.data.busy,
        busySessionCount: probe.data.busySessionCount,
        busyBreakdown: probe.data.busyBreakdown,
        hostVersion: probe.data.hostVersion,
      },
    };
  }
  if (probe.isError) {
    // An errored probe with NO held answer is not automatically a verdict.
    // A pending-class transport error says the request never got a chance: the session is still dialing, or the call was cancelled as the binding moved.
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
 * Report the compat probe from an effect keyed on (host, verdict, session), not from render.
 * The session anchor is part of the dedup key: same verdict on a newer session is new information.
 */
export function useHostCompatibilityAuthorityReport(
  compatibility: HostCompatibility,
  hostId: string | null,
): void {
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (hostId === null) {
      return;
    }
    const verdict = describeCompatVerdictForAuthority(compatibility);
    if (verdict === null) {
      // `checking`/`failed` are not verdicts about COMPATIBILITY: an unreachable host says nothing about its protocol, and reporting a transport failure here would launder it into a `dead("incompatible")` lease that no reconnection could clear.
      return;
    }
    // Read from the slot THIS arm's resolution wrote, never from whichever was touched most recently - see `compatAnchorAtSuccess` for why the two are separate.
    const probedOnSessionId =
      (verdict.anchoredAt === "success"
        ? compatAnchorAtSuccess.get(hostId)
        : compatAnchorAtFailure.get(hostId)) ?? null;
    // JSON, not a delimiter join.
    // Every segment below is either host-controlled (`code`, `hostVersion`, and the requirement's `observedClientKind` / `observedClientAppVersion` - all peer-asserted text the host merely normalizes) or nullable.
    const key = JSON.stringify([
      hostId,
      verdict.code,
      verdict.hostVersion,
      probedOnSessionId,
      // THE REQUIREMENT IS PART OF THE IDENTITY, not decoration.
      // On the epoch path `hostVersion` is always null and the code is a bare `INCOMPATIBLE`, so without this the first four segments are constant for a given host+session and a materially different verdict - a raised floor, a requirement that previously failed to.
      clientCompatibilityKey(verdict.clientCompatibility),
    ]);
    if (reportedRef.current === key) {
      return;
    }
    reportedRef.current = key;
    transportEvidenceRelay.reportCompatVerdict({
      hostId,
      probedOnSessionId,
      hostVersion: verdict.hostVersion,
      incompatibility:
        verdict.code === null
          ? null
          : {
              code: verdict.code,
              hostVersion: verdict.hostVersion,
              minSupportedVersion: verdict.minSupportedVersion,
              clientCompatibility: verdict.clientCompatibility,
            },
    });
  }, [compatibility, hostId]);
}

/**
 * Re-probes ONE host when its directory row's `version` changes - the signal that an update landed.
 * The repoint hook above covers the EFFECTIVE host; this covers a host parked on `dead("incompatible")`, whose row version moving is the only observable trace of the update that could clear it.
 */
export function useHostStatusReprobeOnRowVersionChange(
  hostId: string,
  version: string | null,
): void {
  const queryClient = useQueryClient();
  const previousVersion = useRef<string | null>(version);
  useEffect(() => {
    const previous = previousVersion.current;
    previousVersion.current = version;
    if (previous === null || version === null || previous === version) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: hostStatusProbeQueryKey(hostId),
      exact: true,
    });
  }, [queryClient, hostId, version]);
}

/** The identifying members of a structured epoch requirement, as one nested key segment. */
function clientCompatibilityKey(
  requirement: ClientCompatibilityRequirement | null,
): readonly (string | number | null)[] | null {
  if (requirement === null) return null;
  const legacyRemedy = legacyRemedySegments(requirement);
  return [
    requirement.minimumCompatibilityEpoch,
    requirement.observedCompatibilityEpoch,
    requirement.failure,
    requirement.observedClientKind,
    requirement.observedClientAppVersion,
    requirement.observedClientAppVersionStatus,
    ...legacyRemedy,
    // `?? null` because this member is OPTIONAL on the wire, not nullable: a host predating the field omits the key entirely, so the value here is `string | undefined` while every other segment is `string | number | null`.
    requirement.hostReleaseChannel ?? null,
  ];
}

interface LegacyRemedySegmentsSource {
  readonly minimumKnownClientAppVersion: string | null;
  readonly upgradeChannel: "stable" | "rc" | null;
}

function legacyRemedySegments(
  requirement: LegacyRemedySegmentsSource,
): readonly [string | null, string | null] {
  return [requirement.minimumKnownClientAppVersion, requirement.upgradeChannel];
}

/**
 * The two probe states that ARE compat verdicts, flattened to what the authority takes.
 * `code: null` means compatible.
 */
function describeCompatVerdictForAuthority(compatibility: HostCompatibility): {
  readonly code: string | null;
  readonly hostVersion: string | null;
  readonly minSupportedVersion: string | null;
  /**
   * The host's structured epoch rejection, carried through intact.
   * `null` on every other arm - a compatible verdict has nothing to require, and a manifest disagreement is a different failure with a different remedy.
   */
  readonly clientCompatibility: ClientCompatibilityRequirement | null;
  /**
   * Which capture slot holds THIS verdict's anchor.
   * Carried on the verdict rather than re-derived at the read, so the arm that produced the answer and the slot that was written when it resolved cannot drift apart.
   */
  readonly anchoredAt: "success" | "failure";
} | null {
  if (compatibility.status === "incompatible") {
    const blocking =
      compatibility.error.fatalDetails?.incompatibleMethods?.[0]?.blocking ??
      null;
    return {
      // The fatal's own code, refined by WHY the handshake broke when the frame said.
      // This is the machine code the ∅ modal's update-host variant and Settings render from.
      code:
        blocking === null
          ? compatibility.error.code
          : `${compatibility.error.code}:${blocking}`,
      // Deliberately null.
      // A fatal error frame carries method CANONICALS ({major, minor} per method), not host version strings, and the contract is explicit that these two fields are descriptive only and never an ordering key - so inventing a version from a canonical would put a.
      hostVersion: null,
      minSupportedVersion: null,
      // THE ONE FIELD THAT SURVIVES THE FATAL INTACT.
      // Everything else on this arm is deliberately flattened or nulled, because a fatal frame's method canonicals are not version strings - but this member IS the host's own structured statement of what it needs, and re-deriving any part of it here would be.
      clientCompatibility:
        compatibility.error.fatalDetails?.clientCompatibilityRequirement ??
        null,
      // Rides `probe.error`, so its anchor was captured at rejection.
      anchoredAt: "failure",
    };
  }
  if (compatibility.status === "compatible") {
    return {
      code: null,
      hostVersion: compatibility.hostStatus.hostVersion,
      minSupportedVersion: null,
      clientCompatibility: null,
      // Rides `probe.data` - fresh OR held - so its anchor is whatever the last SUCCESSFUL resolution captured.
      // A failed refetch in between leaves this slot alone, which is what makes a held verdict keep the session it was really produced on.
      anchoredAt: "success",
    };
  }
  return null;
}

/**
 * True for a probe failure that has NOT settled anything about the host: the transport can still reach a different outcome without anyone asking.
 */
function isPendingHostProbeError(error: unknown): boolean {
  return (
    error instanceof RetryableTransportError ||
    error instanceof HostRequestAbortedError
  );
}

/**
 * True when the compat probe failed without the host answering it: the transport never got a reply (no bound client, dial/handshake/frame timeout, dropped socket), or the host closed the connection with a fatal it marked retryable - a host that is up but.
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
