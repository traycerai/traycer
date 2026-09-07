import { Ticket } from "lucide-react";
import { makeTraycerReference } from "./make-traycer-reference";

/**
 * Same-epic: preview tile. Cross-epic: navigate and focus the artifact.
 */
export const TraycerTicketReference = makeTraycerReference({
  icon: <Ticket className="size-3.5" aria-hidden />,
  idAttr: "data-ticket-id",
  refKind: "ticket",
  requiresNode: true,
});
