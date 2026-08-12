import {
  use,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import {
  postLatchSurfaceFor,
  type DefaultHostReadinessPresentation,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import {
  hostStatusProbeQueryKey,
  isPendingHostProbeError,
} from "@/lib/host/compatibility-state";
import { useHostBinding } from "@/lib/host/runtime";

/**
 * The four states of the one host status strip (D3). `switching` and
 * `degraded` share the amber treatment; `error` is the red variant carrying
 * the recovery action that used to live on the full-screen card.
 */
export type HostStatusStripState =
  "switching" | "degraded" | "error" | "hidden";

/**
 * Precedence is `switching > error > degraded`, and that ordering is the
 * anti-flash rule, not a stylistic preference.
 *
 * A switch to a remote host produces, in order: a `host-bound` change, a
 * still-dialing compat probe, then a verdict. If a transient dial failure
 * could paint the red variant, every remote switch would blink
 * amber -> red -> hidden. Two things prevent that: a still-dialing probe now
 * reports `checking` rather than `failed` (see `isPendingHostProbeError`), and
 * `switching` wins outright while it is live. `error` renders only once the
 * switch signal has cleared - i.e. the probe settled - and what it settled on
 * is bad.
 *
 * Reads the compat facts off the READINESS PRESENTATION rather than the
 * compat context, so the state and the strip's copy can never disagree: they
 * are the same projection of the same probe (the controller memoizes it from
 * the context value). The context is still what decides whether the strip
 * mounts at all.
 */
export function deriveHostStatusStripState(args: {
  /** A host-bound switch whose new host has not settled a verdict yet. */
  readonly switching: boolean;
  readonly readinessKind: SurfaceReadiness["kind"];
  readonly compatibility: DefaultHostReadinessPresentation["compatibility"];
}): HostStatusStripState {
  const surface = postLatchSurfaceFor(args.readinessKind);
  if (args.switching || surface === "switching") return "switching";
  // No answer for this host YET (the probe is in flight, or still dialing
  // under D5.1's pending-class classification). For a remote target readiness
  // is already `ready` - the relay attach is lazy and per-request - so this is
  // the only signal that the app is not actually talking to the host it is
  // pointed at.
  if (args.compatibility.status === "checking") return "switching";
  if (surface === "error") return "error";
  if (
    args.compatibility.status === "failed" ||
    args.compatibility.status === "incompatible"
  ) {
    return "error";
  }
  // Whatever is left is a `compatible` verdict; `degraded` means it is being
  // HELD through a failed refetch (traycer#860) rather than freshly answered.
  if (args.compatibility.degraded) return "degraded";
  return "hidden";
}

export interface HostSwitchTarget {
  readonly hostId: string;
  readonly label: string;
}

/**
 * The switch half of the strip's composite trigger.
 *
 * Readiness kinds alone can never announce a local -> remote switch:
 * `projectDefaultHostReadiness` passes non-local targets through, and raw
 * readiness is `ready` the moment the entry is dialable (relay attach is
 * per-request and lazy). So the transition is taken from the binding itself -
 * `HostClient.emitChange` with `reason: "host-bound"` - and held until the
 * host we switched TO has settled a verdict.
 *
 * "Settled" is read from that host's own probe cache slot rather than from
 * `useHostCompatibility()`, which answers for whichever host is active at
 * render time: one render after the bind that value can still be the PREVIOUS
 * host's `compatible`, which would clear the signal before the strip ever
 * appeared. A verdict already held for the target (D2's session-lived cache)
 * settles it in the same render - which is exactly what makes A -> B -> A
 * silent instead of flashing a strip nobody needed.
 */
export function useHostSwitchTarget(): HostSwitchTarget | null {
  const binding = useHostBinding();
  const hostClient = binding === null ? null : binding.hostClient;
  // Read through the context rather than `useQueryClient()`, which THROWS
  // without a provider. The banner this strip absorbed rendered fine in
  // harnesses that mount `AppShell` with no query client, and quietly making
  // the app shell un-mountable without one is not a change this ticket is
  // entitled to make. No client simply means the probe cache is unobservable
  // here: the switch trigger stays silent, and the readiness/compat-driven
  // states still work.
  const queryClient = use(QueryClientContext);
  // The last host we were switched TO. Written only from the binding's own
  // change callback: set on `host-bound`, cleared on `host-unbound`. Whether
  // a set target is still SWITCHING is not stored - it is derived below from
  // that host's probe - so there is no second piece of state to keep in sync
  // (and no `setState` in an effect body).
  const [lastBound, setLastBound] = useState<HostSwitchTarget | null>(null);
  useEffect(() => {
    if (hostClient === null) return;
    return hostClient.onChange((event) => {
      // An unbind ENDS any switch in progress. Without this the strip latched
      // forever on a host that went away mid-switch (bind B, B's row is then
      // removed or explicitly cleared before its probe settles): `lastBound`
      // stayed set, `settled` stayed false, and `switching` precedence then
      // suppressed the very error the user needed to see.
      if (event.reason === "host-unbound" || event.currentHostId === null) {
        setLastBound(null);
        return;
      }
      // Only a genuine host swap. `host-updated` (same host, new endpoint),
      // `auth-changed` and `availability-recovered` are not switches.
      if (event.reason !== "host-bound") return;
      const entry = hostClient.getActiveHost();
      if (entry === null) return;
      setLastBound({ hostId: event.currentHostId, label: entry.label });
    });
  }, [hostClient]);

  // Subscribed to the query cache ONLY while a switch is outstanding: with no
  // pending target this hook must not re-render the strip on every cache
  // event in the app.
  const subscribeToProbe = useCallback(
    (onStoreChange: () => void) => {
      if (lastBound === null || queryClient === undefined) {
        return () => undefined;
      }
      return queryClient.getQueryCache().subscribe(onStoreChange);
    },
    [lastBound, queryClient],
  );
  const readSettled = useCallback(() => {
    if (lastBound === null || queryClient === undefined) return true;
    return hasSettledHostStatusProbe(queryClient, lastBound.hostId);
  }, [lastBound, queryClient]);
  const settled = useSyncExternalStore(
    subscribeToProbe,
    readSettled,
    readSettled,
  );

  if (lastBound === null || settled || hostClient === null) return null;
  // Defensive second gate on the SAME question the unbind branch answers, for
  // any path that moves the binding without an event this hook saw (a
  // subscription that attached late, a rebind during teardown). Announcing a
  // switch to a host the client is no longer pointed at is worse than
  // announcing nothing. Either guard alone clears the unbind case; both are
  // kept because they fail differently - one is event-driven, one is a live
  // read of the binding.
  if (hostClient.getActiveHostId() !== lastBound.hostId) return null;
  return lastBound;
}

/** The active host's own label, re-read on every binding change. */
export function useActiveHostLabel(): string | null {
  const binding = useHostBinding();
  const hostClient = binding === null ? null : binding.hostClient;
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (hostClient === null) return () => undefined;
      return hostClient.onChange(onStoreChange);
    },
    [hostClient],
  );
  const getSnapshot = useCallback(() => {
    if (hostClient === null) return null;
    const entry = hostClient.getActiveHost();
    return entry === null ? null : entry.label;
  }, [hostClient]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether this host's compat probe has produced an ANSWER - a verdict (fresh
 * or held) or a settled failure. A pending-class transport error is not an
 * answer: the session is still dialing, and treating it as one is what turned
 * a mid-dial remote switch into a red card.
 */
function hasSettledHostStatusProbe(
  queryClient: QueryClient,
  hostId: string,
): boolean {
  const state = queryClient.getQueryState(hostStatusProbeQueryKey(hostId));
  if (state === undefined) return false;
  if (state.data !== undefined) return true;
  return state.status === "error" && !isPendingHostProbeError(state.error);
}
