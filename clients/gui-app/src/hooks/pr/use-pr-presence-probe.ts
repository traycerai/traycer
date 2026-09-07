import { useEffect } from "react";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import { usePrListSubscription } from "@/hooks/pr/use-pr-list-subscription";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
import { usePrPresenceStore } from "@/stores/epics/pr-presence-store";

/** `items === null` is "no frame yet", which is NOT the same as "no PRs": writing `false` there would blank the presence signal on every subscribe before the first frame lands, exactly the flicker the persisted store exists to prevent. */
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

/** Foreground PR-list subscribe to bootstrap presence. Keep enabled tied to a user-opened surface; do not probe on epic open. */
export function usePrPresenceProbe(args: {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly enabled: boolean;
}): void {
  // The cost of being wrong is one subscribe message that the host rejects, and the manifest that rejects it is what corrects the state.
  const methodSupport = useStreamMethodSupport("pr.subscribeListForEpic");
  const subscription = usePrListSubscription({
    hostId: args.hostId,
    epicId: args.epicId,
    mode: "foreground",
    enabled: args.enabled && methodSupport !== "unsupported",
  });
  useRecordPrPresence(
    args.hostId,
    args.epicId,
    subscription.data?.items ?? null,
  );
}
