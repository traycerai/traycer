import { MessageSquare } from "lucide-react";
import { makeTraycerReference } from "./make-traycer-reference";

/**
 * Migrated `<traycer-chat>` tag - opens the chat by its embedded id. Same-epic
 * opens a chat preview tile; cross-epic navigates and focuses the chat via
 * `focusArtifactId` (D1 - no `focusChatId`).
 */
export const TraycerChatReference = makeTraycerReference({
  icon: <MessageSquare className="size-3.5" aria-hidden />,
  idAttr: "data-chat-id",
  refKind: "chat",
  requiresNode: true,
});
