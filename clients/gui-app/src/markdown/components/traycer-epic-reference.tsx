import { Layers } from "lucide-react";
import { makeTraycerReference } from "./make-traycer-reference";

/**
 * Migrated `<traycer-epic>` tag - focuses the target epic by its embedded id
 * (no artifact). Carries no node id, so the open handler navigates to the epic
 * and focuses it without opening any tile.
 */
export const TraycerEpicReference = makeTraycerReference({
  icon: <Layers className="size-3.5" aria-hidden />,
  idAttr: null,
  refKind: "epic",
  requiresNode: false,
});
