import { Layers } from "lucide-react";
import { makeTraycerReference } from "./make-traycer-reference";

/**
 * No node id: navigate to the epic and focus it without opening a tile.
 */
export const TraycerEpicReference = makeTraycerReference({
  icon: <Layers className="size-3.5" aria-hidden />,
  idAttr: null,
  refKind: "epic",
  requiresNode: false,
});
