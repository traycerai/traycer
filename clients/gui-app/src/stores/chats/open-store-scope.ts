import { createContext, useContext } from "react";

const DEFAULT_CHAT_OPEN_SCOPE = "default";

const ChatOpenStoreScopeContext = createContext<string>(
  DEFAULT_CHAT_OPEN_SCOPE,
);

export const ChatOpenStoreScopeProvider = ChatOpenStoreScopeContext.Provider;

export function useChatOpenStoreScope(): string {
  return useContext(ChatOpenStoreScopeContext);
}

export function scopedChatOpenId(scope: string, blockId: string): string {
  return `${scope}\0${blockId}`;
}
