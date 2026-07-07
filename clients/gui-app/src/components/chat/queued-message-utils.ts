import { useMemo } from "react";
import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";

export function queueItemSteerLocked(item: ChatQueuedItem): boolean {
  return item.status === "steer_requested" || item.status === "steering";
}

export function queueItemCanPauseFromQueueHeader(
  item: ChatQueuedItem,
): boolean {
  if (item.sender.type !== "user") return false;
  if (item.status === "paused") return false;
  if (item.status === "steering" || item.status === "injected") return false;
  if (
    item.status === "steer_requested" &&
    item.steerRequest?.mode !== "safe_point"
  ) {
    return false;
  }
  return true;
}

export function useQueuePauseState(items: readonly ChatQueuedItem[]) {
  return useMemo(
    () => ({
      hasPausableHumanItems: items.some(queueItemCanPauseFromQueueHeader),
      hasPausedItems: items.some((item) => item.status === "paused"),
    }),
    [items],
  );
}
