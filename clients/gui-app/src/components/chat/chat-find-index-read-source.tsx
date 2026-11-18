import { memo } from "react";
import {
  useChatFindIndexRead,
  type ChatFindIndexReadArgs,
} from "@/hooks/chats/use-chat-find-index-read";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";

/**
 * The chat tile's find index READ - the row an index hit names, hydrated so the
 * client scan can confirm the hit - mounted beside `ChatFindIndexSource` under
 * the same condition: the windowed line, with a bound host.
 *
 * A component rather than a hook in `ChatMessages` for the reason that one is:
 * resolving a host client needs the host runtime. Memoized: the transcript
 * re-renders per streaming token, and only a hydration moves these props.
 */
export const ChatFindIndexReadSource = memo(function ChatFindIndexReadSource(
  props: Omit<ChatFindIndexReadArgs, "client"> & {
    readonly hostId: string;
  },
) {
  const client = useHostClientForHostId(props.hostId);
  useChatFindIndexRead({ ...props, client });
  return null;
});
