import type { ReactNode } from "react";
import {
  PublishedChatSourceContext,
  type PublishedChatSource,
} from "@/lib/chats/published-chat-source";

/**
 * Marks a subtree as rendering a PUBLISHED copy, so the segments inside it read their heavy content from the cloud instead of the local store.
 */
export function PublishedChatSourceProvider(props: {
  readonly source: PublishedChatSource;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <PublishedChatSourceContext.Provider value={props.source}>
      {props.children}
    </PublishedChatSourceContext.Provider>
  );
}
