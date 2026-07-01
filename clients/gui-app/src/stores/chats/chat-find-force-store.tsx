import { useState, type ReactNode } from "react";
import {
  ChatFindForceStoreContext,
  ChatFindForceTileInstanceIdContext,
  createChatFindForceStore,
} from "./chat-find-force-store-context";

interface ChatFindForceStoreProviderProps {
  readonly children: ReactNode;
  readonly tileInstanceId: string;
}

export function ChatFindForceStoreProvider(
  props: ChatFindForceStoreProviderProps,
) {
  const [store] = useState(createChatFindForceStore);
  return (
    <ChatFindForceTileInstanceIdContext.Provider value={props.tileInstanceId}>
      <ChatFindForceStoreContext.Provider value={store}>
        {props.children}
      </ChatFindForceStoreContext.Provider>
    </ChatFindForceTileInstanceIdContext.Provider>
  );
}
