import { useEffect, useState } from "react";
import type { AgentActivityCloudSyncStatus } from "@traycer/protocol/host/agent/activity";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { useAgentActivityStore } from "@/stores/agent-activity-store";
import { useNotificationsServingHostId } from "@/hooks/host/use-notifications-serving-host-entry";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";

/**
 * How long a degraded reading may hold before the pill is allowed to say so,
 * per reason.
 *
 * `stream-down`: the stream opens a beat after the Epic's own host link on a
 * cold start and is re-dialled by its own lane after a close. Neither is worth
 * an amber flash. Past this the user is looking at spinners that may no longer
 * be true.
 *
 * `cloud-down`: the host's collab socket is re-dialled 1 s after a close and a
 * fresh backend instance answers auth and sync a few seconds later, so a
 * routine drop is over well inside this window - and the two seconds the
 * stream grace allows were shorter than one such reconnect, which is how a
 * backend incident painted "Remote agent status unavailable" several times a
 * minute over agents that never stopped. Aligned with the artifact leg's
 * `CLOUD_LINK_GRACE_MS` so the two planes stop naming the same drop at
 * different moments. What the grace hides is only the FRESHNESS of a remote
 * spinner; agents on this device stay live throughout.
 */
const PRESENCE_DEGRADED_GRACE_MS: Record<
  AgentActivityPresenceDegradedReason,
  number
> = {
  "stream-down": 2_000,
  "cloud-down": 15_000,
};

/**
 * Why agent status on this Epic may be stale or unknown, or `null` when the
 * presence plane is healthy (or silent - see below).
 *
 * - `stream-down`: `agent.activity.subscribe` is not open. Nothing is being
 *   delivered; whatever the store last painted (it clears on close) is gone.
 * - `cloud-down`: the stream is open and the host stamped the latest union
 *   with a cloud link that is `reconnecting` / `disconnected`. The union was
 *   built while the host could not see other hosts' agents - hocuspocus drops
 *   every remote awareness entry the instant the socket closes - so agents on
 *   other devices may read idle. Agents on THIS device stay live: the local
 *   entry is never removed on close.
 *
 * `cloudSyncStatus === null` is deliberately NOT degraded: it is no claim (a
 * local-plane frame, a `1.0` host that predates the field, or no frame yet),
 * and inventing "blind" out of silence is the lie this field exists to end.
 */
export type AgentActivityPresenceDegradedReason = "stream-down" | "cloud-down";

/**
 * Amber = presence unavailable: the reading behind every working/turn spinner
 * cannot be trusted for this Epic, while the canvas, chats and terminals all
 * keep working - which is why it is a warning on the Epic pill and never a
 * blocking state.
 *
 * `stream-down` wins when both hold: once the stream is gone the stamped cloud
 * status is as stale as the union it came with.
 *
 * Bootstrap, brief reopen windows and socket flaps are held back by
 * {@link PRESENCE_DEGRADED_GRACE_MS}, keyed on the REASON so a flip between the
 * two restarts the grace rather than inheriting the other's.
 */
export function useAgentActivityPresenceDegraded(): AgentActivityPresenceDegradedReason | null {
  // Resolved HERE rather than taken from the caller, and the distinction is
  // the whole design of this hook.
  //
  // Callers want one fact - "may this Epic's agent status be stale?" - and the
  // answer belongs to the stream CARRYING that activity. On a local-capable
  // shell that is the durable local host identity, not the live serving entry:
  // a restart temporarily removes that entry while the provider retains and
  // marks its activity slice reconnecting. Relay-only shells have no such
  // identity, so their bound serving host remains the right fallback.
  //
  // The single-stream assumption is load-bearing and DORMANT, not gone: the
  // store stays host-keyed (a bare union read would let an idle host's dead
  // stream amber a healthy Epic), and exactly one slice is populated today. If
  // anything ever opens a second activity stream - the local-served gap in
  // `renderer-unserved-plane-assertions` proposes precisely that - this hook
  // needs a caller-supplied stream identity again, and the keying it reads
  // through is deliberately still here for that day.
  // BOTH read unconditionally, and the fallback chosen afterwards. Written as
  // `localHostId ?? useNotificationsServingHostId()` this is a conditional hook
  // call: `??` short-circuits, so the moment a booting local host publishes its
  // id the second hook stops being called and the hook order changes mid-mount
  // - which React answers by throwing, on the exact edge (local host arrives)
  // this hook exists to survive. The `??` below is a choice between two values
  // already in hand.
  //
  // The ID half rather than `useNotificationsServingHostEntry()?.hostId`: that
  // one resolves the relay fallback through `useHostDirectoryEntry`, which
  // reads `useHostDirectory()` and THROWS outside a `<HostRuntimeProvider>` -
  // and subscribes this hook to a directory row it never looks at. The two
  // agree on the id in every state, including the window before a bound host's
  // row lands: the entry hook answers `null` there, and so does this one,
  // because `fallbackHostId` comes from `useAddressableHostId`, which is itself
  // `null` until that row exists. Their shared suite asserts that agreement.
  const localHostId = useReactiveLocalHostId();
  const relayServingHostId = useNotificationsServingHostId();
  const servingHostId = localHostId ?? relayServingHostId;
  const reason = useAgentActivityStore((state) =>
    servingHostId === null
      ? null
      : selectPresenceDegradedReason(
          state.byHost.get(servingHostId) ?? null,
          // Whether ANY host has a stream slice at all. See the absent-slice
          // arm below for why the distinction is the whole of this argument.
          state.byHost.size > 0,
        ),
  );
  const [sustained, setSustained] =
    useState<AgentActivityPresenceDegradedReason | null>(null);
  // Render-phase adjustment rather than an effect: React re-runs the render
  // before committing, so a recovery never paints one frame of stale amber.
  if (sustained !== null && sustained !== reason) {
    setSustained(null);
  }
  useEffect(() => {
    if (reason === null) return undefined;
    const timer = window.setTimeout(() => {
      setSustained(reason);
    }, PRESENCE_DEGRADED_GRACE_MS[reason]);
    return () => {
      window.clearTimeout(timer);
    };
  }, [reason]);
  return reason !== null && sustained === reason ? reason : null;
}

function selectPresenceDegradedReason(
  host: {
    readonly connectionStatus: StreamConnectionStatus;
    readonly cloudSyncStatus: AgentActivityCloudSyncStatus | null;
  } | null,
  /**
   * Whether the store holds a slice for ANY host - i.e. whether an activity
   * stream has been opened at all in this app.
   */
  someHostHasAStream: boolean,
): AgentActivityPresenceDegradedReason | null {
  if (host === null) {
    // AN ABSENT SLICE IS TWO DIFFERENT FACTS, and reading both as `stream-down`
    // was this hook asserting a down stream that was not down.
    //
    // A slice is CREATED the instant `openAgentActivityStream` runs - it opens
    // with `connecting` before the socket does anything - so absence never
    // means "this host's stream is unhealthy". It means no stream was opened
    // FOR this host, and the two reasons that can be true are:
    //
    //  - some OTHER host's slice exists, so a stream IS running and this host
    //    is simply not the one it was opened against. Nothing here is degraded
    //    and this hook has NO CLAIM to make: the Epic's activity arrives on
    //    whatever stream is serving, and its health is that slice's story.
    //  - no slice exists anywhere: nothing has opened a stream, pre-boot or
    //    otherwise. `stream-down` is the honest reading then - live agent
    //    activity really is unavailable - and the grace above covers the
    //    cold-start window where it is merely early.
    return someHostHasAStream ? null : "stream-down";
  }
  if (host.connectionStatus !== "open") return "stream-down";
  if (
    host.cloudSyncStatus === "reconnecting" ||
    host.cloudSyncStatus === "disconnected"
  ) {
    return "cloud-down";
  }
  return null;
}
