import { useEffect, useId } from "react";
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
 * `entry.key` names the SURFACE and must be host-scoped, because every id that
 * goes into it is host-minted. The slot this writes to is separate from it -
 * see the token below - so two components describing one surface coexist
 * instead of deleting each other.
 */
export function usePublishSurfaceSync(entry: SurfaceSyncEntry): void {
  const publish = useSurfaceSyncStore((state) => state.publish);
  const withdraw = useSurfaceSyncStore((state) => state.withdraw);
  // This publisher's own slot. Two components may describe the SAME surface -
  // one Epic open in two tabs, a keep-alive pane beside the visible one - and
  // a slot keyed by the surface let whichever unmounted first delete the
  // other's entry, taking the indicator down while a stream was still away.
  const token = useId();
  const { key, rank, label, wake } = entry;
  const { syncing, escalated } = entry.spell;

  useEffect(() => {
    publish(token, { key, rank, label, wake, spell: { syncing, escalated } });
    // Deliberately spread across the primitive fields rather than keyed on
    // `entry`: callers build that object inline every render, so an identity
    // dependency would re-publish on every render of every surface.
  }, [publish, token, key, rank, label, wake, syncing, escalated]);

  useEffect(() => {
    return () => {
      withdraw(token);
    };
  }, [withdraw, token]);
}
