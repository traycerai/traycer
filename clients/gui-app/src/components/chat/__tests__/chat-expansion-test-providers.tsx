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
  // scope string (the tile instance id); activity-group and a2a can be either
  // a fresh per-provider fallback store (`store={null}`, used here so fixed
  // `tileInstanceId`s reused across unrelated `it()` blocks in the same file
  // never leak into each other) or the ticket-5 registry-backed store keyed
  // by tile instance id (production - see `chat-messages.tsx`); find-force is
  // a per-tile provider.
  return (
    <ChatOpenStoreScopeProvider value={props.tileInstanceId}>
      <ActivityGroupOpenStoreProvider store={null}>
        <A2AOpenStoreProvider store={null}>
          <ChatFindForceStoreProvider tileInstanceId={props.tileInstanceId}>
            {props.children}
          </ChatFindForceStoreProvider>
        </A2AOpenStoreProvider>
      </ActivityGroupOpenStoreProvider>
    </ChatOpenStoreScopeProvider>
  );
}
