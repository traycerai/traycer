import { useEffect, useState } from "react";
import type { AgentActivityCloudSyncStatus } from "@traycer/protocol/host/agent/activity";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import { useAgentActivityStore } from "@/stores/agent-activity-store";

/** Grace before the pill may say stream-down or cloud-down. Align cloud-down with CLOUD_LINK_GRACE_MS. */
const PRESENCE_DEGRADED_GRACE_MS: Record<
  AgentActivityPresenceDegradedReason,
  number
> = {
  "stream-down": 2_000,
  "cloud-down": 15_000,
};

/** `cloudSyncStatus === null` is not degraded: silence is no claim, not "blind". */
export type AgentActivityPresenceDegradedReason = "stream-down" | "cloud-down";

/**
 * Warning, never blocking. `stream-down` wins over `cloud-down`. Grace is keyed on the reason so a flip restarts it rather than inheriting the other.
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
    }, PRESENCE_DEGRADED_GRACE_MS[reason]);
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
