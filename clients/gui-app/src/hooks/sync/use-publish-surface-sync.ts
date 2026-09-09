import { useEffect } from "react";
import {
  useSurfaceSyncStore,
  type SurfaceSyncEntry,
} from "@/stores/sync/surface-sync-store";

/**
 * Reports this surface's stream state to the one indicator that renders it.
 *
 * Call it unconditionally, wherever the surface is mounted. A surface that
 * stopped publishing while another one held the indicator would be forgotten
 * at the hand-off, and the indicator would disappear while its stream was
 * still away.
 *
 * The withdrawal on unmount is what keeps a closed surface from holding the
 * indicator open: a chat tile swiped away is no longer a claim about anything.
 *
 * `key` must identify the SURFACE, not the component - an epic id, a chat id.
 * Two components describing one stream would otherwise each hold a slot, and
 * whichever unmounted last would decide when the report ended.
 */
export function usePublishSurfaceSync(
  key: string,
  entry: SurfaceSyncEntry,
): void {
  const publish = useSurfaceSyncStore((state) => state.publish);
  const withdraw = useSurfaceSyncStore((state) => state.withdraw);
  const { rank, label, wake } = entry;
  const { syncing, escalated } = entry.spell;

  useEffect(() => {
    publish(key, { rank, label, wake, spell: { syncing, escalated } });
    // Deliberately spread across the primitive fields rather than keyed on
    // `entry`: callers build that object inline every render, so an identity
    // dependency would re-publish on every render of every surface.
  }, [publish, key, rank, label, wake, syncing, escalated]);

  useEffect(() => {
    return () => {
      withdraw(key);
    };
  }, [withdraw, key]);
}
