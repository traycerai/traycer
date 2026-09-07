import { createContext, use } from "react";

/** A segment deep in the feed has the epic (session context) and the tab's host (`TabHostContext`) in scope, but not the chat id: the transcript is rendered from a message list, and the list does not name its chat. `null` where a transcript renders with no bound host - a surface that cannot have a live session, so there is nothing authoritative to ask. */
export interface ChatTranscriptIdentity {
  readonly chatId: string;
  readonly hostId: string;
}

export const ChatTranscriptContext =
  createContext<ChatTranscriptIdentity | null>(null);

export const ChatTranscriptProvider = ChatTranscriptContext.Provider;

export function useMaybeChatTranscript(): ChatTranscriptIdentity | null {
  return use(ChatTranscriptContext);
}
