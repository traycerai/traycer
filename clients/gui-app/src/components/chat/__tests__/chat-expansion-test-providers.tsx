import type { ReactNode } from "react";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { SubagentOpenStoreProvider } from "@/stores/chats/subagent-open-store";

interface ChatExpansionTestProvidersProps {
  readonly children: ReactNode;
  readonly tileInstanceId: string;
}

export function ChatExpansionTestProviders(
  props: ChatExpansionTestProvidersProps,
) {
  return (
    <ActivityGroupOpenStoreProvider>
      <SubagentOpenStoreProvider>
        <A2AOpenStoreProvider>
          <ChatFindForceStoreProvider tileInstanceId={props.tileInstanceId}>
            {props.children}
          </ChatFindForceStoreProvider>
        </A2AOpenStoreProvider>
      </SubagentOpenStoreProvider>
    </ActivityGroupOpenStoreProvider>
  );
}
