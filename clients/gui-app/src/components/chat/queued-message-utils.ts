import { useMemo } from "react";
import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  queueItemCanPauseFromQueueHeader,
  queueItemSteerLocked,
} from "@/lib/chat/queue-item-predicates";

// The row predicates live in `lib/chat/queue-item-predicates.ts` so the
// settlement code in `stores/chats` can share them without depending on a
// component module; re-exported here for the header's existing imports.
export { queueItemCanPauseFromQueueHeader, queueItemSteerLocked };

export function useQueuePauseState(items: readonly ChatQueuedItem[]) {
  return useMemo(
    () => ({
      hasPausableHumanItems: items.some(queueItemCanPauseFromQueueHeader),
      hasPausedItems: items.some((item) => item.status === "paused"),
    }),
    [items],
  );
}
