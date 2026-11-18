import { FileText } from "lucide-react";
import { makeTraycerReference } from "./make-traycer-reference";

/**
 * Migrated `<traycer-spec>` tag - opens the spec artifact by its embedded id.
 * Same-epic opens a preview tile; cross-epic navigates and focuses the artifact.
 */
export const TraycerSpecReference = makeTraycerReference({
  icon: <FileText className="size-3.5" aria-hidden />,
  idAttr: "data-spec-id",
  refKind: "spec",
  requiresNode: true,
});
