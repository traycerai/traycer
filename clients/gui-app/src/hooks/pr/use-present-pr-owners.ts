import { useMemo } from "react";
import type { PrOwnerRef } from "@traycer/protocol/host/pr-schemas";
import { useEpicAgentNodeIds } from "@/lib/epic-selectors";

/** Drop owners whose node is gone. */
export function usePresentPrOwners(
  owners: readonly PrOwnerRef[],
): readonly PrOwnerRef[] {
  const presentIds = useEpicAgentNodeIds();
  return useMemo(() => {
    const present = new Set(presentIds);
    const resolvable = owners.filter((owner) => present.has(owner.ownerId));
    // Identity-stable when nothing was dropped - the common case, and the one where a fresh array would re-render every chip on every projection tick.
    return resolvable.length === owners.length ? owners : resolvable;
  }, [owners, presentIds]);
}
