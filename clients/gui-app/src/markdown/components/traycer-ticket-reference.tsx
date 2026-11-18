import { Ticket } from "lucide-react";
import { makeTraycerReference } from "./make-traycer-reference";

/**
 * Migrated `<traycer-ticket>` tag - opens the ticket artifact by its embedded
 * id. Same-epic opens a preview tile; cross-epic navigates and focuses the
 * artifact.
 */
export const TraycerTicketReference = makeTraycerReference({
  icon: <Ticket className="size-3.5" aria-hidden />,
  idAttr: "data-ticket-id",
  refKind: "ticket",
  requiresNode: true,
});
