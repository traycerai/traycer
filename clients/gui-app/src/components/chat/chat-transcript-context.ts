import { createContext, use } from "react";

/**
 * Which chat a rendered transcript belongs to, for the segments inside it that
 * need to ask that chat's own live session something - today, whether the
 * shell a card points at still exists.
 *
 * A segment deep in the feed has the epic (session context) and the tab's host
 * (`TabHostContext`) in scope, but not the chat id: the transcript is rendered
 * from a message list, and the list does not name its chat. This carries the
 * pair the chat session registry keys on, so a segment can look up THIS
 * chat's session rather than scanning for whichever one happens to be live.
 *
 * `null` where a transcript renders with no bound host - a surface that
 * cannot have a live session, so there is nothing authoritative to ask.
 */
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
