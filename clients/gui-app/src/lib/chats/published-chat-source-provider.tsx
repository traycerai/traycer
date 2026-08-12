import type { ReactNode } from "react";
import {
  PublishedChatSourceContext,
  type PublishedChatSource,
} from "@/lib/chats/published-chat-source";

/**
 * Marks a subtree as rendering a PUBLISHED copy, so the segments inside it
 * read their heavy content from the cloud instead of the local store.
 *
 * Its own module purely so `published-chat-source.tsx` exports no components:
 * a file that exports both components and non-components breaks fast refresh
 * for everything importing it, and that file is all hooks and helpers. The
 * context itself stays there, next to the hooks that read it.
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
