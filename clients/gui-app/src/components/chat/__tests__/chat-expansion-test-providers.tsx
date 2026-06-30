import type { ReactNode } from "react";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";

interface ChatExpansionTestProvidersProps {
  readonly children: ReactNode;
  readonly tileInstanceId: string;
}

export function ChatExpansionTestProviders(
  props: ChatExpansionTestProvidersProps,
) {
  // Subagent + tool open state live in module-global stores namespaced by the
  // scope string (the tile instance id); activity-group uses a per-provider
  // fallback store; a2a + find-force are per-tile providers.
  return (
    <ChatOpenStoreScopeProvider value={props.tileInstanceId}>
      <ActivityGroupOpenStoreProvider store={null}>
        <A2AOpenStoreProvider>
          <ChatFindForceStoreProvider tileInstanceId={props.tileInstanceId}>
            {props.children}
          </ChatFindForceStoreProvider>
        </A2AOpenStoreProvider>
      </ActivityGroupOpenStoreProvider>
    </ChatOpenStoreScopeProvider>
  );
}
