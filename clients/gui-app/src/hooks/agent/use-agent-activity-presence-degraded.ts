import { useEffect, useState } from "react";
import type { AgentActivityCloudSyncStatus } from "@traycer/protocol/host/agent/activity";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { useAgentActivityStore } from "@/stores/agent-activity-store";

/**
 * How long a degraded reading may hold before the pill is allowed to say so.
 *
 * The stream opens a beat after the Epic's own host link on a cold start and
 * is re-dialled by its own lane after a close; the host's room lifecycle treats
 * `reconnecting` as a blip it rides out before rebuilding. Neither is worth an
 * amber flash. Past this the user is looking at spinners that may no longer be
 * true.
 */
const PRESENCE_DEGRADED_GRACE_MS = 2_000;

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
  const reason = useAgentActivityStore(selectPresenceDegradedReason);
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
    }, PRESENCE_DEGRADED_GRACE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [reason]);
  return reason !== null && sustained === reason ? reason : null;
}

function selectPresenceDegradedReason(state: {
  readonly connectionStatus: StreamConnectionStatus;
  readonly cloudSyncStatus: AgentActivityCloudSyncStatus | null;
}): AgentActivityPresenceDegradedReason | null {
  if (state.connectionStatus !== "open") return "stream-down";
  if (
    state.cloudSyncStatus === "reconnecting" ||
    state.cloudSyncStatus === "disconnected"
  ) {
    return "cloud-down";
  }
  return null;
}
