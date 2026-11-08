import { useMemo, type ReactNode } from "react";
import {
  ChatAttachmentScopeContext,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";

/**
 * Where a row's images are read from: the bot's attachment store, under the bot
 * id, on the host serving the tab.
 */
export function BotTranscriptImageScope(props: {
  readonly botId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly children: ReactNode;
}): ReactNode {
  const { botId, chatId, hostId, children } = props;
  const client = useTabHostClient();
  const hostVersion = useHostDirectoryEntry(hostId)?.version ?? null;
  const scope = useMemo<ChatAttachmentScopeValue>(
    () => ({ epicId: botId, chatId, hostId, hostVersion, client }),
    [botId, chatId, client, hostId, hostVersion],
  );
  return (
    <ChatAttachmentScopeContext value={scope}>
      {children}
    </ChatAttachmentScopeContext>
  );
}
