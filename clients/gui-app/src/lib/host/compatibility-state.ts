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
 * The session id each host's compat probe was riding WHEN IT RESOLVED, in two
 * slots - one written by a success, one by a rejection.
 *
 * ## Why capture at resolution rather than look up at report time
 *
 * The verdict below is reported from an effect, one or more renders after the
 * probe actually ran, and it is deliberately SERVED FROM HELD DATA across a
 * failed refetch (`staleTime: Infinity` plus TanStack's last-successful
 * `data`). A lookup at report time would therefore stamp whatever session is
 * live NOW onto a verdict produced on an earlier one - the flip window - and
 * that over-claim is worse than no anchor at all: the authority ranks compat
 * verdicts by session recency (`rankForCompatAnchor`), so a held verdict
 * wearing the current session's name outranks the fresh probe that should
 * have superseded it. Binding at resolution makes a held verdict carry its
 * TRUE ORIGIN, which is exactly what that ranking is built to order correctly.
 *
 * ## Why TWO slots
 *
 * The two arms of this probe resolve through different channels and must not
 * share one. A `compatible` verdict rides `probe.data`, which SURVIVES a
 * failed refetch; an `incompatible` verdict rides `probe.error`, which is
 * replaced by every new failure. One slot would let a failed refetch's
 * rejection re-stamp the held success with the live session id - re-anchoring
 * a held verdict to a session it never ran on, which is the precise defect
 * capture-at-resolution exists to prevent.
 *
 * So: the success slot is written only from inside the queryFn (a failed
 * refetch never touches it, which is what preserves a held verdict's origin),
 * and the failure slot only at rejection (fresh every time, which is correct -
 * that IS when the failing probe ran).
 *
 * ## Why the incompatible arm must be anchored at all
 *
 * Anchoring only the success arm would INVERT a safety property. The
 * authority drops a verdict whose rank is below the one it holds, and a
 * null-anchored verdict ranks below every session-anchored one - so a fresh
 * `incompatible` at the null floor would be silently discarded behind a held
 * `compatible` at a real rank, and a genuinely incompatible host would keep a
 * `compatible` lease. Both arms carry an anchor, or neither may.
 *
 * Module-scoped, matching `transportEvidenceRelay`'s own scope: one window is
 * one renderer is one probe.
 */
const compatAnchorAtSuccess = new Map<string, string | null>();
const compatAnchorAtFailure = new Map<string, string | null>();

/**
 * The cache slot the compat probe below owns for one host.
 *
 * Exported so a reader that must observe the probe for a SPECIFIC host id
 * reads the same slot the probe writes instead of re-deriving the key.
 * `useHostCompatibility()` answers only for whichever host is active at render
 * time, which cannot distinguish "the new host's verdict" from "the old host's
 * verdict, one render before the query re-keys".
 *
 * Its last such reader was the status strip's switch trigger, deleted with the
 * strip (D11). It has one again - {@link useHostStatusReprobeOnRepoint}, which
 * names the INCOMING host by definition and so cannot ask through
 * `useHostCompatibility()` - and the rule it reads through this export for is
 * unchanged: a per-host reader must not re-derive this key.
 */
export function hostStatusProbeQueryKey(hostId: string): readonly unknown[] {
  return queryKeys.hostMethod<HostRpcRegistry, "host.status">(
    hostId,
    "host.status",
    HOST_STATUS_PROBE,
  );
}

/**
 * Re-probes the INCOMING host when the app-wide pointer moves to it.
 *
 * The probe caches at `staleTime: Infinity` / `gcTime: Infinity`, so a host
 * the window has already met answers from a verdict that may be arbitrarily
 * old. That was survivable while `HostClient.bind()` force-refetched the whole
 * incoming scope on every switch; P4.2 deleted the slot and that sweep with
 * it, leaving a re-point served entirely from held data.
 *
 * INVALIDATE, never `reset`/`remove`, and the distinction is the whole
 * behaviour. Invalidation refetches in the background while TanStack keeps the
 * held `data`, so the verdict below still renders from `probe.data` and the
 * user sees no transition. Dropping the entry instead would put the app behind
 * a "checking" splash carrying local-bootstrap copy for a host that has been
 * running the entire time - which is traycer#860 exactly, reintroduced by the
 * mechanism meant to keep the answer fresh.
 *
 * Triggered by the SELECTION STORE moving, not by a `HostClient` change event:
 * post-P4.2 a host becoming effective emits no event at all - it is a fact the
 * selection layer publishes.
 *
 * Two deliberate abstentions:
 *
 *  - The OPENING derivation (`null` -> A). There is nothing stale to sweep at
 *    startup, and invalidating an entry whose first fetch is still in flight
 *    would double-probe every launch.
 *  - A move to ∅ (`A` -> `null`). There is no incoming host to re-probe, and
 *    the outgoing one is deliberately left alone: its held verdict is what
 *    makes coming back to it render in the same frame.
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
    // `exact` so the sweep is structurally one entry: this host's probe slot,
    // never the outgoing host's and never the surrounding host scope. The
    // narrowness is the invariant, so it is expressed in the call rather than
    // left to the key's prefix shape.
    void queryClient.invalidateQueries({
      queryKey: hostStatusProbeQueryKey(effectiveHostId),
      exact: true,
    });
  }, [queryClient, effectiveHostId]);
}

/**
 * What the host's `host.status` answer said about itself, held alongside the
 * `compatible` verdict. A busy host that was up and serving turns
 * (traycer#860) used to be indistinguishable from one that never started,
 * because the probe read only success/failure and discarded this payload.
 */
export interface HostStatusSnapshot {
  readonly busy: boolean;
  /**
   * `null` when the peer did not report a count — an older host answering
   * `host.status@1.0`, which the upgrade path no longer papers over with a
   * fabricated `0`. Nothing here renders it as a number today; it exists so a
   * consumer that starts to cannot mistake "did not say" for "said none".
   */
  readonly busySessionCount: number | null;
  /**
   * Typed split of {@link busySessionCount}, or `null` when the peer did not
   * say how the total splits (`host.status@1.1` and older). A real zero
   * object is idle-by-kind; `null` is unknown.
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
    | HostCompatibilityContextValue
    | undefined;
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

/**
 * ⚠ THE RETURNED OBJECT IS FRESH ON EVERY RENDER OF THE PROVIDER. Read fields
 * off it; never depend on the object itself.
 *
 * `useHostCompatibilityProbeForClient` builds its answer as an object literal
 * on each of its four arms, with `retry` as a fresh closure, so there is no
 * arm on which the identity survives a render. `HostCompatibilityProvider`
 * then passes it straight to `<HostCompatibilityContext.Provider value={…}>`
 * and re-renders on every `leasesChanged` (it reads `useHostLeases()` for the
 * incompatible-host recovery probes), and context propagation deliberately
 * pierces the `props.children` bailout - so every consumer of this hook is
 * re-entered on every lease delivery in the app.
 *
 * That costs nothing TODAY, and only because all three consumers happen to
 * read the primitive: `harness-catalog-prefetcher.tsx` and
 * `epic-tab-existence-reconciler.tsx` both narrow to `compatibility.status`,
 * and `host-readiness-controller.tsx` feeds the object into a `useMemo` whose
 * body is a pure derivation, in a component that re-renders on every lease
 * delivery anyway. Put this object in a `useEffect` dep array and that changes
 * from a defeated memo into a side effect firing on every lease change to any
 * host - the hazard is latent, not absent, and nothing but this note stands
 * between a reader and it.
 *
 * ⚠ A `useMemo` on the provider's `recoveryHosts` is NOT the remedy, though it
 * is the one a perf audit (2026-08-17) proposed. That array is consumed as a
 * keyed list, so React reconciles it by `key` and fresh elements change
 * nothing; the CONTEXT VALUE is the only identity that propagates. Memoizing
 * the list would close the finding while leaving every consequence in place.
 * The real remedy is memoizing the verdict at its source - which means a
 * `useCallback` on `retry` and a `useMemo` over all four arms of
 * `useHostCompatibilityProbeForClient`, whose arm ORDER is load-bearing
 * (terminal verdict before held data, see its body). Judged not worth that
 * risk for a cost measured at nil above; recorded so the next reader inherits
 * the measurement instead of the row.
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
  // The same host id the query key is built from, read the same way
  // `useHostQuery` reads it, so the anchor can never be recorded against a
  // different host than the one whose cache slot the answer lands in.
  const probedHostId = useReactiveHostReadiness(client).hostId;
  return useHostCompatibilityProbeForClient(client, probedHostId);
}

/**
 * The `…ForClient` variant of the probe (the composer-RPC idiom): identical
 * machinery, caller-supplied client and host. The recovery path mounts one
 * per `dead("incompatible")` host, because that host can never re-earn a
 * compatible verdict through the app-wide probe - it is not effective, and it
 * cannot BECOME effective until this very probe clears it. Without this, an
 * updated host stayed permanently ineligible until a renderer restart.
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
    // THE CAPTURE POINT for a successful probe, and the reason this hook uses
    // the response-map form at all rather than plain `useHostQuery`:
    // `mapResponse` runs INSIDE the queryFn, in the same microtask the
    // transport call resolves in. That is the only moment at which "the
    // session this verdict was produced on" is a fact rather than a guess.
    // The response itself is passed through untouched - the cached shape is
    // deliberately unchanged, so every other reader of this slot is
    // unaffected.
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
      // Retry a transient failure a couple of times so a momentary blip never
      // reads as incompatible, but fail fast on a terminal compat verdict
      // (retrying an INCOMPATIBLE handshake cannot change the answer) and on a
      // `RetryableTransportError`, which the transport layer has already retried
      // to exhaustion - retrying here would stack dial-timeout costs and block
      // the gate far longer.
      retry: (failureCount, error) => {
        // THE CAPTURE POINT for a failed probe - a DELIBERATE side effect in a
        // predicate, and the justification is that this is the only hook
        // TanStack exposes at rejection time that this file owns. The queryFn
        // and its error boundary both live in `use-host-query.ts`, and the
        // `incompatible` verdict rides `probe.error`, so without a capture
        // here that arm could carry no anchor at all - which would invert the
        // safety property described on `compatAnchorAtFailure`.
        //
        // Runs on every failure including the intermediate retries below.
        // That is harmless and correct: each writes the session the attempt it
        // describes actually ran on, and the last one to write is the one
        // whose error becomes `probe.error`.
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
      // render from the held verdict in the same render.
      //
      // WHAT BACKS THE HELD ANSWER, in three eras, because the middle one is
      // the reason this block is worth reading at all.
      //
      // Originally the held verdict was a bridge across the switch rather than
      // a substitute for a fresh probe: `bind()`'s `refetchActive: true` sweep
      // force-refetched the incoming host's whole scope on every switch,
      // overriding `staleTime: Infinity` (which otherwise means no background
      // refetch at all). P4.2 deleted the active slot and that sweep with it,
      // and for one phase a host becoming effective swept nothing - returning
      // to A re-rendered a held verdict with no re-probe behind it.
      //
      // It is backed again, by `useHostStatusReprobeOnRepoint`: a re-point
      // INVALIDATES this host's probe entry, which refetches in the background
      // while the held `data` keeps rendering. So the contract now is "answer
      // instantly from what this host last said, and go ask again" - never
      // "answer instantly and never ask". The narrower sweep is deliberate:
      // one entry, this host's, rather than the whole scope the old bind()
      // path took with it.
      //
      // Safety is unchanged and never rested on any of this: a terminal
      // INCOMPATIBLE answer is checked before held data below.
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
        busyBreakdown: probe.data.busyBreakdown,
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
 * Feeds the compat probe's verdict to the selection authority (redesign
 * P1.3), which is what makes D13/C4 real: a host whose probe reports a
 * blocking version mismatch is `dead("incompatible")` for SELECTION - never a
 * failover candidate, refused by Activate, and given the ∅ modal's
 * "update host" variant - even though its socket is alive and Settings can
 * still drive `host.update.install` over it.
 *
 * An EFFECT, not a report from the state machine above, which is a render
 * function: reporting from render is a side effect React is free to run twice
 * (StrictMode does), and the double report would be indistinguishable from two
 * genuine probes. Keyed on the identity of the verdict rather than on mount
 * count, so a re-render, a remount, or a second StrictMode pass with the same
 * (host, verdict) reports once.
 *
 * `probedOnSessionId` NAMES THE SESSION THE VERDICT WAS PRODUCED ON, captured
 * as the probe resolved (see `compatAnchorAtSuccess`) rather than looked up
 * here. This closed the named interim that shipped with P1.3: while every
 * verdict was null-anchored the authority's session-generation freshness rule
 * (mechanism 6) degraded to latest-received-wins, so a slow probe on an old
 * session reporting AFTER a probe on the current one won purely by arrival
 * order. With real anchors that pair orders by session recency instead, which
 * is the downgrade and same-version-restart correctness the rule exists for.
 *
 * It stays `null` only when the relay has no name to give - a local transport
 * that never announces a session, or a probe that resolved before any session
 * did. Null-anchored verdicts keep exactly their old behaviour (rank floor,
 * latest-received among themselves), so nothing regresses where no session
 * identity exists to thread.
 *
 * THE ANCHOR IS PART OF THE DEDUP KEY, deliberately. Keyed on the verdict
 * alone, a re-probe that reached the same conclusion on a NEWER session would
 * be suppressed as a duplicate - and suppressing it would withhold the very
 * fact the anchor exists to carry, leaving the authority ranking a stale
 * session's verdict forever. Same verdict on a new session IS new information.
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
      // `checking`/`failed` are not verdicts about COMPATIBILITY: an
      // unreachable host says nothing about its protocol, and reporting a
      // transport failure here would launder it into a `dead("incompatible")`
      // lease that no reconnection could clear. Liveness is the transports'
      // job (invariant 5); this producer only ever speaks to compatibility.
      return;
    }
    // Read from the slot THIS arm's resolution wrote, never from whichever was
    // touched most recently - see `compatAnchorAtSuccess` for why the two are
    // separate.
    const probedOnSessionId =
      (verdict.anchoredAt === "success"
        ? compatAnchorAtSuccess.get(hostId)
        : compatAnchorAtFailure.get(hostId)) ?? null;
    // JSON, not a delimiter join. Every segment below is either
    // host-controlled (`code`, `hostVersion`, and the requirement's
    // `observedClientKind` / `observedClientAppVersion` - all peer-asserted
    // text the host merely normalizes) or nullable. A delimiter join gets both
    // wrong: `null` and `""` collapse to the same segment, and a separator
    // character inside a value shifts every field boundary after it, so two
    // materially different verdicts can produce one key. Where that lands is
    // `reportedRef` below silently dropping the newer one, leaving the
    // authority on stale client-compatibility data for the rest of the
    // session.
    //
    // `JSON.stringify` over a fixed-length ARRAY is what makes it
    // unambiguous: positions are fixed so no field can absorb another's
    // value, `null` serializes as `null` and `""` as `""`, and any character
    // inside a string is escaped rather than read as structure. An object
    // literal would work too, but only because V8 happens to preserve
    // insertion order - an array does not rely on that.
    const key = JSON.stringify([
      hostId,
      verdict.code,
      verdict.hostVersion,
      probedOnSessionId,
      // THE REQUIREMENT IS PART OF THE IDENTITY, not decoration. On the epoch
      // path `hostVersion` is always null and the code is a bare
      // `INCOMPATIBLE`, so without this the first four segments are constant
      // for a given host+session and a materially different verdict - a raised
      // floor, a requirement that previously failed to parse and dropped to
      // null - reads as a duplicate and is never reported to the authority.
      //
      // The session anchor already covers the common case (a host that updates
      // gets a new session, hence a new key), which is why this layer is the
      // second line rather than the first; `leaseEquals` is the one that
      // actually gates delivery. It is included anyway because the two cases
      // the anchor does NOT cover are both real: a null-anchored local
      // transport, and a re-parse that recovers a requirement within one
      // session.
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
 * Re-probes ONE host when its directory row's `version` changes - the signal
 * that an update landed. The repoint hook above covers the EFFECTIVE host;
 * this covers a host parked on `dead("incompatible")`, whose row version
 * moving is the only observable trace of the update that could clear it.
 * Same exact-entry narrowness as the repoint sweep, same held-data contract:
 * the invalidation refetches in the background and the fresh verdict replaces
 * the stored one through the same report seam.
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

/**
 * The identifying members of a structured epoch requirement, as one nested
 * key segment.
 *
 * Every member is included rather than just the epoch, and the list must stay
 * in lockstep with `clientCompatibilityEquals` in
 * `selection-authority-contract.ts` - the two are the same identity judgment
 * made by two dedupe layers, and a member present in one and absent from the
 * other lets a materially different requirement read as a duplicate at
 * whichever layer runs first. `hostReleaseChannel` is the member that made
 * this bite: it routes recovery (RC opt-in vs manual), so dropping a verdict
 * whose only change is the channel leaves the dialog offering the wrong
 * route. `minimumKnownClientAppVersion` and `upgradeChannel` are deprecated
 * and currently `null` on the wire, but they remain schema members, so they
 * stay here too rather than becoming a silent divergence from the equality
 * check.
 *
 * A FIXED-LENGTH ARRAY, and `null` is preserved rather than coalesced. Two of
 * these members - `observedClientKind` and `observedClientAppVersion` - are
 * the host's normalization of text the PEER supplied, so they can legitimately
 * be `null`, be empty, or contain any character at all. Under the previous
 * `??  ""` + delimiter join, `null` and `""` produced identical keys and a
 * value containing the separator shifted every field after it; either way two
 * different requirements could collide, and a collision here means the newer
 * verdict is dropped and the authority keeps the stale one.
 *
 * Returned as a nested array rather than a pre-joined string so the outer
 * `JSON.stringify` does the escaping once, at one level, with no separator
 * anywhere in the scheme.
 */
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
    // `?? null` because this member is OPTIONAL on the wire, not nullable: a
    // host predating the field omits the key entirely, so the value here is
    // `string | undefined` while every other segment is `string | number |
    // null`. Mapping absent to `null` keeps the array's fixed-length,
    // no-coalescing-to-empty-string property intact - `null` and `""` still
    // serialize differently, which is what stops two materially different
    // requirements from colliding onto one key.
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
 * The two probe states that ARE compat verdicts, flattened to what the
 * authority takes. `code: null` means compatible. Everything else answers
 * `null` - see the caller.
 */
function describeCompatVerdictForAuthority(compatibility: HostCompatibility): {
  readonly code: string | null;
  readonly hostVersion: string | null;
  readonly minSupportedVersion: string | null;
  /**
   * The host's structured epoch rejection, carried through intact. `null` on
   * every other arm - a compatible verdict has nothing to require, and a
   * manifest disagreement is a different failure with a different remedy.
   */
  readonly clientCompatibility: ClientCompatibilityRequirement | null;
  /**
   * Which capture slot holds THIS verdict's anchor. Carried on the verdict
   * rather than re-derived at the read, so the arm that produced the answer
   * and the slot that was written when it resolved cannot drift apart.
   */
  readonly anchoredAt: "success" | "failure";
} | null {
  if (compatibility.status === "incompatible") {
    const blocking =
      compatibility.error.fatalDetails?.incompatibleMethods?.[0]?.blocking ??
      null;
    return {
      // The fatal's own code, refined by WHY the handshake broke when the
      // frame said. This is the machine code the ∅ modal's update-host variant
      // and Settings render from.
      code:
        blocking === null
          ? compatibility.error.code
          : `${compatibility.error.code}:${blocking}`,
      // Deliberately null. A fatal error frame carries method CANONICALS
      // ({major, minor} per method), not host version strings, and the
      // contract is explicit that these two fields are descriptive only and
      // never an ordering key - so inventing a version from a canonical would
      // put a number in front of the user that names nothing they can act on.
      hostVersion: null,
      minSupportedVersion: null,
      // THE ONE FIELD THAT SURVIVES THE FATAL INTACT. Everything else on this
      // arm is deliberately flattened or nulled, because a fatal frame's
      // method canonicals are not version strings - but this member IS the
      // host's own structured statement of what it needs, and re-deriving any
      // part of it here would be inventing.
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
      // Rides `probe.data` - fresh OR held - so its anchor is whatever the
      // last SUCCESSFUL resolution captured. A failed refetch in between
      // leaves this slot alone, which is what makes a held verdict keep the
      // session it was really produced on.
      anchoredAt: "success",
    };
  }
  return null;
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
 * Accepts `unknown` rather than a narrowed error type so a cache-level reader,
 * which only ever holds a `QueryState.error`, can share this one
 * classification instead of writing a second one.
 */
function isPendingHostProbeError(error: unknown): boolean {
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
