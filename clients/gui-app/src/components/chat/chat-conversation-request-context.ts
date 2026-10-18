import { createContext } from "react";

/**
 * How a user row's resolved request reaches the reply that resolved it
 * (Tracy Bots). A bot conversation's transcript provides a scroller keyed by
 * message id; every other transcript leaves it `null`, and the row then shows
 * the request's state without a link - the state is a fact about the row, the
 * jump is a capability of the surface.
 */
export type ChatConversationRequestScroller = (messageId: string) => void;

export const ChatConversationRequestContext =
  createContext<ChatConversationRequestScroller | null>(null);
