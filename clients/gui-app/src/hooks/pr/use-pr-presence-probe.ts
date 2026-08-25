import { useEffect } from "react";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import { usePrListSubscription } from "@/hooks/pr/use-pr-list-subscription";
import { useStreamMethodSupport } from "@/lib/host/stream-runtime-context";
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

/**
 * Subscribe an epic's PR list for the sole purpose of answering "does this epic
 * have any PRs", and write the answer to the presence store. Renders nothing
 * and reads nothing back.
 *
 * This exists because presence is otherwise written ONLY by the open PR panel
 * body, which makes the signal self-referential on any surface that also gates
 * the panel's own reachability on it: no presence means no entry point, and no
 * entry point means the body never mounts to record presence. The desktop rail
 * breaks that cycle with a user affordance - its context menu can force the
 * panel visible ("No PRs yet") - so a surface without an equivalent escape
 * hatch has to bootstrap presence itself.
 *
 * Subscribed in `foreground` mode deliberately: the panel body and its actions
 * use the same mode, and sessions are keyed by (client, host, epic, mode), so a
 * probe running alongside an open panel collapses into that one session rather
 * than opening a second. Callers must keep `enabled` tied to a surface the user
 * deliberately opened - this is PR traffic, and the presence store's whole
 * design is that merely opening an epic costs none.
 */
export function usePrPresenceProbe(args: {
  readonly hostId: string | null;
  readonly epicId: string;
  readonly enabled: boolean;
}): void {
  // Only a definite `unsupported` blocks the dial - `unknown` (and the `null` of
  // a client not yet built) still subscribes, exactly as the panel body and its
  // actions do. That is deliberate: support is client-wide evidence taken from
  // any session's handshake manifest and is cleared on every reconnect, so
  // waiting for certainty would skip the probe through a window that recurs
  // routinely. The cost of being wrong is one subscribe message that the host
  // rejects, and the manifest that rejects it is what corrects the state.
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
