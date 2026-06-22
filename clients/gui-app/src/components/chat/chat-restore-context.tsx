import type { ReactNode } from "react";
import {
  ChatRestoreContext,
  type ChatRestoreContextValue,
} from "@/components/chat/chat-restore-context-core";

export function ChatRestoreProvider(props: {
  readonly value: ChatRestoreContextValue;
  readonly children: ReactNode;
}) {
  return (
    <ChatRestoreContext.Provider value={props.value}>
      {props.children}
    </ChatRestoreContext.Provider>
  );
}
