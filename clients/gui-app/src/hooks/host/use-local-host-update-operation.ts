import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useActiveUpdatePollAccelerator } from "@/hooks/host/use-active-update-poll-accelerator";
import { useRunnerHostControllerStatusQuery } from "@/hooks/runner/use-runner-host-controller-status-query";
import { observationFromCanonicalRead } from "@/lib/host/fleet-update/canonical-status-observation";
import { recordObservationFromLocalAttempt } from "@/lib/host/fleet-update/record-attempt-observation";
import {
  preferLiveOverRecord,
  projectFleetUpdateView,
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";
import type { HostRpcRegistry } from "@/lib/host";

const EMPTY_PARAMS = {} as const;

export interface LocalHostUpdateOperation {
  /** `null` before this client knows which host is local. */
  readonly hostId: string | null;
  readonly view: FleetUpdateView;
}

/**
 * What a caller with NO mounted host runtime gets: knowing nothing.
 *
 * Exported because {@link useLocalHostUpdateOperation} may only be called
 * beneath `<HostRuntimeProvider>` — `useHostClient()` throws without one, by
 * design — so a surface that can render on either side of that boundary has to
 * branch on the binding and use this for the unbound arm. `HostUpdateBanner`
 * does exactly that, mirroring `LocalHostRestartFlow`'s split.
 *
 * `unknown`/`qualified` rather than `idle`: an unbound client has not looked,
 * and "we did not look" must never render as "there is no update".
 */
export const UNBOUND_LOCAL_UPDATE_OPERATION: LocalHostUpdateOperation = {
  hostId: null,
  // The shared constant, not a hand-written copy of it. This literal used to be
  // spelled out here, which meant a new field on `FleetUpdateView` broke this
  // file for a reason that has nothing to do with unbound clients — and the
  // obvious local fix (paste the field) would have left two definitions of
  // "we know nothing" free to drift.
  view: UNKNOWN_FLEET_UPDATE_VIEW,
};

/**
 * The LOCAL host's update operation, as the landing banner renders it.
 *
 * ⚠ REQUIRES a mounted `<HostRuntimeProvider>` — it resolves a host client, and
 * `useHostClient()` throws without one rather than returning null. A caller
 * that can render outside the provider must branch on `useHostBinding()` and
 * fall back to {@link UNBOUND_LOCAL_UPDATE_OPERATION}, which is what the
 * landing banner does. Hooks cannot be called conditionally, so that branch has
 * to be a component split, not an `if` inside this function.
 *
 * Local only, by construction rather than by convention: the host id comes from
 * {@link useReactiveLocalHostId} and nothing here accepts one. The landing
 * banner never summarizes remote hosts (experience doc, Scope), and a hook that
 * took a `hostId` would make that a caller's discipline instead of a property.
 *
 * Reads the SAME `host.status` query key every other consumer reads, rather than
 * opening a private one. Two surfaces reading one key is what keeps landing and
 * the local Settings row showing the same attempt (Flow C) — a second query
 * would give them two answers with two refresh schedules and no reason to agree.
 */
export function useLocalHostUpdateOperation(): LocalHostUpdateOperation {
  const hostId = useReactiveLocalHostId();
  const client = useHostClientForHostId(hostId);
  const readiness = useReactiveHostReadiness(client);
  // The durable-record leg's source. Event-sourced and already shared by the
  // host gate, update banner and Settings, so this adds no poll.
  const controllerStatusQuery = useRunnerHostControllerStatusQuery();
  const statusQuery = useHostQuery<HostRpcRegistry, "host.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.status",
    params: EMPTY_PARAMS,
    // The table owns the baseline cadence (fixed 10s). `staleTime` exceeds it
    // for the same reason the Overview's does: a healthy poll keeps the data
    // fresh, and ageing past the window is what demotes an unhealthy read.
    options: { enabled: hostId !== null, staleTime: 30_000, poll: true },
  });

  // Stamped from `dataUpdatedAt` — when THIS data arrived — and demoted by the
  // query's own read health, both inside `observationFromCanonicalRead` so the
  // landing banner, the selected Overview and the fleet's coalesced reads share
  // one staleness rule instead of three.
  //
  // This used to pin `nowMs` to the observation whenever a fetch was in flight,
  // to stop the banner blinking to `unknown` for the length of a round trip.
  // That is the same class of defect the Overview shipped one file away: a
  // reading held current by a condition that does not expire. `fetchStatus`
  // stays `"fetching"` for as long as a request hangs, so an offline client
  // with a stalled poll would have presented a `downloading` phase as live
  // indefinitely. The round-trip flicker is real and is solved instead by
  // treating an in-flight fetch as live INSIDE the health rule — bounded,
  // because a fetch that gives up flips to `paused` or `error`.
  const observation =
    statusQuery.data === undefined || hostId === null
      ? null
      : observationFromCanonicalRead({
          hostId,
          status: statusQuery.data,
          dataUpdatedAt: statusQuery.dataUpdatedAt,
          health: {
            isError: statusQuery.isError,
            fetchStatus: statusQuery.fetchStatus,
            isStale: statusQuery.isStale,
            hasLiveSource: readiness.isReady,
          },
          source: "local",
        });

  // `dataUpdatedAt`, not a clock — and on this leg that is the CORRECT input,
  // not a workaround for `react-hooks/purity`.
  //
  // Which mechanism demotes a reading is the thing to keep straight. On the
  // BORROWED leg the deadline does it: the observation is the cached value
  // itself, nothing else knows how old it is, so the projection has to compare
  // it against a real clock. On a CANONICAL leg the query knows its own health
  // — errored, paused, aged past `staleTime` with no fetch replacing it — and
  // `observationFromCanonicalRead` has already folded that verdict into the
  // deadline, stamping an unhealthy read as expired outright. So `nowMs` needs
  // only to be a finite instant at or after the observation for that verdict to
  // apply, and `dataUpdatedAt` is precisely that.
  //
  // It is also the reactive one. A render-time clock advances only when
  // something else re-renders this component, so a query that stops polling
  // would keep projecting whatever it last computed; the health signals change
  // the query's own state and therefore notify. Reaching for a clock here would
  // add impurity and subtract reliability.
  // Ticket 07 §5.2.7 — the host-down window.
  //
  // Desktop re-reads `update-attempt.json` and publishes the facts on the
  // controller status for exactly this moment: the host is unreachable, so the
  // wire observation above has gone stale, but a durable attempt is still on
  // this machine's disk and the banner can still say what it was doing.
  //
  // Precedence is NOT decided here. `preferLiveOverRecord` already encodes it
  // (a FRESH wire read wins; the record fills the window only once that read is
  // stale or absent) and it is deliberately freshness-based rather than
  // recency-based — the record is re-read every tick, so "newest wins" would
  // let it outrank a healthy live read and permanently suppress real progress.
  // Re-deriving that rule here would be a second copy of it.
  // Both inputs come from the CONTROLLER query, and that pairing is the point:
  // `observedAtMs` describes when THIS record was read, so it must be stamped
  // by the query that read it. Borrowing `statusQuery.dataUpdatedAt` here — the
  // live `host.status` leg — is wrong in exactly the situation the arm exists
  // for: in the host-down window that query has never succeeded, so its
  // `dataUpdatedAt` is `0`, and a record freshly read from local disk would be
  // reported as observed at the Unix epoch. After an older successful live
  // read it is subtler and no better: an unrelated read's time.
  const recordObservation =
    hostId === null
      ? null
      : recordObservationFromLocalAttempt({
          hostId,
          localAttempt: controllerStatusQuery.data?.localAttempt ?? null,
          observedAtMs: controllerStatusQuery.dataUpdatedAt,
        });
  const view = projectFleetUpdateView({
    observation: preferLiveOverRecord(
      observation,
      recordObservation,
      statusQuery.dataUpdatedAt,
    ),
    nowMs: statusQuery.dataUpdatedAt,
    connected: readiness.isReady,
  });

  useActiveUpdatePollAccelerator({ hostId, view });

  return { hostId, view };
}
