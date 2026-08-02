import { useMemo } from "react";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import { useEpicAgentNodeIds } from "@/lib/epic-selectors";

/**
 * The owners this epic can still resolve, dropping any whose node is gone.
 *
 * A PR's owner set is host-side state that can OUTLIVE its nodes: it is
 * projected from persisted worktree-binding rows, and whether a given host
 * cascades those rows on every node delete is a host-version fact this renderer
 * cannot assume - so a PR may keep naming chats the user removed months ago.
 * Those used to render as bare "Removed chat" text wedged between pills - a row
 * that reads as broken, for an entry with no title, no tile, and nothing to
 * click. Tightening the producer does not retire this filter: the rows a host
 * already wrote are still on disk.
 *
 * Filtered HERE rather than by having each chip render null, so everything
 * derived from the list stays true: the visible chips are real ones, `+N`
 * counts what the popover will actually list, the collection noun is decided by
 * owners that exist, and a CONTAINER can gate on the same set - the detail
 * card's headed "Chats" section would otherwise stand over empty space for
 * exactly the all-deleted case this filtering exists to clean up.
 *
 * Reads the epic projection, so every caller needs a session handle in scope
 * (`EpicSessionGate`) - see `PrOwnerBadges`.
 */
export function usePresentPrOwners(
  owners: readonly PrOwnerRef[],
): readonly PrOwnerRef[] {
  const presentIds = useEpicAgentNodeIds();
  return useMemo(() => {
    const present = new Set(presentIds);
    const resolvable = owners.filter((owner) => present.has(owner.ownerId));
    // Identity-stable when nothing was dropped - the common case, and the one
    // where a fresh array would re-render every chip on every projection tick.
    // It is also what makes the detail card's second pass over an already
    // filtered list free.
    return resolvable.length === owners.length ? owners : resolvable;
  }, [owners, presentIds]);
}
