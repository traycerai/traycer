import { useMemo } from "react";
import { useNotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostNotificationIndicators } from "@/hooks/notifications/use-host-notification-indicators-query";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
import {
  EMPTY_INDICATOR_STATE_RESPONSE,
  mergeHostPendingForkIntoCloudIndicators,
  selectCloudNotificationIndicatorProjection,
  type SurfaceNotificationIndicators,
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
 * Fork pending state is the exception: it is authoritative on the connected
 * host's fork notice board rather than in any feed row. The host RPC therefore
 * runs in both modes; cloud mode imports only `pendingFork` from it and keeps
 * every feed-derived bit attached to the cloud snapshot.
 *
 * App-local failure rows contribute in BOTH modes - they are client-side
 * state, neither host nor cloud state - and are folded in downstream by
 * `selectNotificationIndicatorState`, not here.
 *
 * ## `hostId` is the caller's to name
 *
 * This hook used to reach for the app-wide active client, which is right for a
 * surface listing TASKS and wrong for every surface listing chats. A chat is
 * bound to a host for life; the host RPC answers only about its own rows; and
 * `chatId` is host-minted, so two hosts can legitimately mint the same one. An
 * active-host read therefore both missed a retained tab's `pendingFork` and
 * could light it from an unrelated chat of the same name on the connected
 * machine.
 *
 * `null` still means the app-wide active host, and it is the right answer for
 * exactly one shape of caller: one whose ids are EPIC ids, which are shared
 * cloud entities rather than host-owned ones. Callers whose chat ids span
 * several hosts cannot use this hook at all - one hook call is one host - and
 * reach for `ChatIndicatorHostScopes` instead.
 */
export interface UseNotificationIndicatorsArgs {
  /** The host that OWNS these ids; `null` for the app-wide active host. */
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
  const activeHostId = useReactiveActiveHostId();
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
