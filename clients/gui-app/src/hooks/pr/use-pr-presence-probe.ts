import { useEffect } from "react";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import { usePrPresenceStore } from "@/stores/epics/pr-presence-store";

/**
 * Record what a PR list frame says about this epic's PR presence.
 *
 * `items === null` is "no frame yet", which is NOT the same as "no PRs":
 * writing `false` there would blank the presence signal on every subscribe
 * before the first frame lands, exactly the flicker the persisted store exists
 * to prevent. Every surface that holds a live PR list feeds the store through
 * here so that distinction is made in one place.
 */
export function useRecordPrPresence(
  hostId: string | null,
  epicId: string,
  items: readonly PrLightItem[] | null,
): void {
  const recordPrPresence = usePrPresenceStore((s) => s.recordPrPresence);
  useEffect(() => {
    if (hostId === null || items === null) return;
    recordPrPresence(hostId, epicId, items.length > 0);
  }, [hostId, items, epicId, recordPrPresence]);
}
