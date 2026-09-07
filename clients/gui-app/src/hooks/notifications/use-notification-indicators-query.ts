import { useMemo } from "react";
import { useNotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostNotificationIndicators } from "@/hooks/notifications/use-host-notification-indicators-query";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  EMPTY_INDICATOR_STATE_RESPONSE,
  mergeHostPendingForkIntoCloudIndicators,
  selectCloudNotificationIndicatorProjection,
  type SurfaceNotificationIndicators,
} from "@/stores/notifications/notification-indicator-state";

/** Multi-host chat ids cannot use this hook. */
export interface UseNotificationIndicatorsArgs {
  /** Host that owns these ids; null for the app-wide active host. */
  readonly hostId: string | null;
  readonly epicIds: ReadonlyArray<string>;
  readonly chatIds: ReadonlyArray<string>;
  readonly enabled: boolean;
}

export function useNotificationIndicators(
  args: UseNotificationIndicatorsArgs,
): SurfaceNotificationIndicators {
  const feedMode = useNotificationFeedMode();
  const isCloud = feedMode === "cloud";
  const activeHostId = useAddressableHostId();
  const hostIndicators = useHostNotificationIndicators({
    hostId: args.hostId,
    epicIds: args.epicIds,
    chatIds: args.chatIds,
    enabled: args.enabled,
  });
  const cloudRows = useCloudNotificationsStore((state) => state.rows);
  const cloudIndicators = useMemo<SurfaceNotificationIndicators>(() => {
    if (!isCloud || !args.enabled) return EMPTY_INDICATOR_STATE_RESPONSE;
    const projection = selectCloudNotificationIndicatorProjection(
      cloudRows,
      args.epicIds,
      args.chatIds,
    );
    return {
      ...projection.aggregate,
      byOriginHostId: projection.byOriginHostId,
    };
  }, [isCloud, args.enabled, cloudRows, args.epicIds, args.chatIds]);
  // The origin these host rows are filed under is the host the RPC actually
  // read - the caller-named owner when present, the active host otherwise.
  const readHostId = args.hostId ?? activeHostId;
  return isCloud
    ? mergeHostPendingForkIntoCloudIndicators(
        cloudIndicators,
        hostIndicators.data,
        readHostId,
      )
    : scopeIndicatorsToOrigin(hostIndicators.data, readHostId);
}

function scopeIndicatorsToOrigin(
  indicators: SurfaceNotificationIndicators,
  originHostId: string | null,
): SurfaceNotificationIndicators {
  if (originHostId === null) return indicators;
  return {
    ...indicators,
    byOriginHostId: { [originHostId]: indicators },
  };
}
