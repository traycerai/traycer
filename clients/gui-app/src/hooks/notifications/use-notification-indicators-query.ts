import { useMemo } from "react";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import { useNotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import {
  useHostNotificationIndicators,
  type UseHostNotificationIndicatorsArgs,
} from "@/hooks/notifications/use-host-notification-indicators-query";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  EMPTY_INDICATOR_STATE_RESPONSE,
  selectCloudNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";

/**
 * Per-entity indicator flags for one surface, from whichever feed is
 * authoritative - mirroring how the notification center itself is mode-aware.
 *
 * In cloud mode the flags come from the cloud snapshot this client already
 * holds. That is the only derivation that can be correct across hosts: an
 * entry produced on host B never enters host A's SQLite, so the host's v1
 * `indicatorState` (computed over ONE host's rows and its own `read_at`)
 * cannot light a tab bound to host A, and its read state only clears once a
 * marker has round-tripped back down to that specific host. Deriving from the
 * store the popover renders also makes the icon and the row it represents
 * incapable of disagreeing, including while the cloud is degraded.
 *
 * In local mode this is exactly today's host path: old/methodless hosts and
 * the local-only product keep the v1 RPC, which is not issued at all in cloud
 * mode.
 *
 * App-local failure rows contribute in BOTH modes - they are client-side
 * state, neither host nor cloud state - and are folded in downstream by
 * `selectNotificationIndicatorState`, not here.
 */
export function useNotificationIndicators(
  args: UseHostNotificationIndicatorsArgs,
): HostNotificationsIndicatorStateResponse {
  const feedMode = useNotificationFeedMode();
  const isCloud = feedMode === "cloud";
  const hostIndicators = useHostNotificationIndicators({
    epicIds: args.epicIds,
    chatIds: args.chatIds,
    enabled: args.enabled && !isCloud,
  });
  const cloudRows = useCloudNotificationsStore((state) => state.rows);
  const cloudIndicators = useMemo(
    () =>
      isCloud && args.enabled
        ? selectCloudNotificationIndicators(
            cloudRows,
            args.epicIds,
            args.chatIds,
          )
        : EMPTY_INDICATOR_STATE_RESPONSE,
    [isCloud, args.enabled, cloudRows, args.epicIds, args.chatIds],
  );
  return isCloud ? cloudIndicators : hostIndicators.data;
}
