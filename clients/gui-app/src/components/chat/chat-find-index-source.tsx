import { memo } from "react";
import {
  useChatFindIndexFeed,
  type ChatFindIndexFeedArgs,
} from "@/hooks/chats/use-chat-find-index-feed";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";

/**
 * The chat tile's find index query, mounted beside the transcript only on the
 * windowed line and only with a bound host - a tab's host, for life, like
 * every other RPC the tile makes.
 *
 * A component rather than a hook in `ChatMessages` because resolving a host
 * client needs the host runtime, which a transcript rendered without a host
 * does not have. Memoized: the transcript re-renders per streaming token, and
 * none of these props move with it.
 */
export const ChatFindIndexSource = memo(function ChatFindIndexSource(
  props: Omit<ChatFindIndexFeedArgs, "client" | "hostId"> & {
    readonly hostId: string;
  },
) {
  const client = useHostClientForHostId(props.hostId);
  useChatFindIndexFeed({ ...props, client });
  return null;
});
