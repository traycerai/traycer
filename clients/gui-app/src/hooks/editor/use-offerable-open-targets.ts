import { useMemo } from "react";
import { useFinderOpenAvailability } from "@/hooks/editor/use-finder-open-availability";
import { useOfferableEditors } from "@/hooks/editor/use-offerable-editors";
import {
  withFinderTarget,
  type OpenTargetEntry,
} from "@/lib/editor/editor-menu-catalog";

/**
 * Everything `hostId` may be offered as an open target - its offerable editors
 * plus Finder when that host passes the Finder gate.
 *
 * The one place the two catalogs are joined, so a surface cannot list Finder
 * on a host that would reject it, or resolve a stored Finder default on one.
 */
export function useOfferableOpenTargets(
  hostId: string | null,
): ReadonlyArray<OpenTargetEntry> {
  const editors = useOfferableEditors(hostId);
  const finderAvailable = useFinderOpenAvailability(hostId);
  return useMemo(
    () => withFinderTarget(editors, finderAvailable),
    [editors, finderAvailable],
  );
}
