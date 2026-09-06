import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useActiveUpdatePollAccelerator } from "@/hooks/host/use-active-update-poll-accelerator";
import { useLocalAttemptRecordObservation } from "@/hooks/host/use-local-attempt-record-observation";
import { useNowMs } from "@/components/settings/panels/host-settings-panel-hooks";
import { observationFromCanonicalRead } from "@/lib/host/fleet-update/canonical-status-observation";
import { projectLocalUpdate } from "@/lib/host/fleet-update/local-update-projection";
import {
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";
import type { HostRpcRegistry } from "@/lib/host";

const EMPTY_PARAMS = {} as const;

/**
 * How often this hook re-reads the wall clock — one second, and it is a
 * DEADLINE clock. See `projectLocalUpdate` for why the record leg's proof
 * cannot be aged against any query's `dataUpdatedAt`.
 */
const LOCAL_RECORD_TICK_MS = 1_000;

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
          // The landing banner already has a debt arm of its own, read off
          // the desktop controller status (`activation: pendingActivation`),
          // and it does not read `host.getInstallationInfo`. Deriving a
          // second debt fact here would put two readers with two rules on one
          // surface; the Overview is the leg that derives.
          legacyFacts: null,
        });

  // Ticket 07 §5.2.7 — the host-down window.
  //
  // Desktop re-reads `update-attempt.json` and publishes the facts on the
  // controller status for exactly this moment: the host is unreachable, so the
  // wire observation above has gone stale, but a durable attempt is still on
  // this machine's disk and the banner can still say what it was doing. The
  // read (and the `observedAtMs` stamp that must come from the query that
  // performed it) lives in `useLocalAttemptRecordObservation`, shared with the
  // selected-host Overview.
  const recordObservation = useLocalAttemptRecordObservation(hostId);
  // ⚠ A TICKING CLOCK, replacing `statusQuery.dataUpdatedAt`.
  //
  // The WIRE leg keeps the frozen instant, and the argument for it was always
  // sound: `observationFromCanonicalRead` folds the query's own health into the
  // deadline and stamps an unhealthy read as already expired, so measuring that
  // deadline against the instant it was derived from is the statement that a
  // HEALTHY read is fresh until health says otherwise — never a race against
  // how long the round trip took. It is also the reactive choice, since the
  // health signals move the query's state and notify while a render-time clock
  // does not. Feeding it the tick instead cost a dropped lifecycle gate and a
  // disengaged poll accelerator once per slow round trip; see
  // `projectLocalUpdate`.
  //
  // The record leg is the one that breaks the premise, because its evidence
  // expires on its own
  // and nothing re-renders when it does. Desktop's probe verdict is proof for
  // five seconds (`LOCAL_LIVENESS_PROOF_MS`), and both candidate timestamps
  // stop advancing exactly when that matters: `statusQuery.dataUpdatedAt`
  // because the host is down (which is the whole situation), and the controller
  // query's own because Desktop's broadcaster keeps its idle loop running
  // through a failing `publish()` — the loop continues, nothing new lands in a
  // query with `staleTime: Infinity`, and the payload saying `liveness: "live"`
  // sits there indefinitely. A deadline measured against either would never
  // arrive, so the proof would hold the lifecycle gate for as long as this hook
  // stayed mounted.
  //
  // Precedence is still not decided here — `projectLocalUpdate` owns it, and
  // owns it jointly with the Overview so the two surfaces cannot disagree about
  // one host in the one window this arm exists for.
  //
  // THE COST, owned here rather than left implicit: this tick re-renders the
  // landing banner once a second for as long as it is mounted, whether or not
  // any update is running, and it is unconditional because the record it ages
  // can appear without anything else changing. Accepted — the banner is cheap
  // and the record leg cannot be correct without a clock nobody refreshes. It
  // buys nothing on the wire leg, which no longer reads it at all.
  const nowMs = useNowMs(LOCAL_RECORD_TICK_MS);
  const { view } = projectLocalUpdate({
    wire: observation,
    record: recordObservation,
    clock: { wireNowMs: statusQuery.dataUpdatedAt, recordNowMs: nowMs },
    connected: readiness.isReady,
  });

  useActiveUpdatePollAccelerator({ hostId, view });

  return { hostId, view };
}
