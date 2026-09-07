import { MessageSquare } from "lucide-react";
import { makeTraycerReference } from "./make-traycer-reference";

/** Same-epic: chat preview tile. Cross-epic: navigate with focusArtifactId, not focusChatId. */
export const TraycerChatReference = makeTraycerReference({
  icon: <MessageSquare className="size-3.5" aria-hidden />,
  idAttr: "data-chat-id",
  refKind: "chat",
  requiresNode: true,
});
