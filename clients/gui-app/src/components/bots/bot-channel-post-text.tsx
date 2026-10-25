import type { ReactNode } from "react";
import { useStore } from "zustand";
import { postTextOf } from "@/lib/bots/reply-row";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

type ChannelPostTextProps = {
  readonly botId: string;
  readonly hostId: string;
  /** The channel the post was written in. */
  readonly conversationId: string;
  readonly messageId: string;
  /** Renders with the post's text, `null` while the channel has no row for it. */
  readonly children: (text: string | null) => ReactNode;
};

/**
 * A channel post's text, read from the channel's own row (Tracy Bots T65): a
 * thread names the post it answers by id only, so wherever a thread shows
 * its post, the text comes from the channel's session - the one the channel
 * view holds open.
 */
export function ChannelPostText(props: ChannelPostTextProps): ReactNode {
  const handle = useChatSessionHandleForContainer(
    props.botId,
    props.conversationId,
    props.hostId,
    true,
  );
  if (handle === null) return props.children(null);
  return <ChannelPostTextFromStore store={handle.store} {...props} />;
}

function ChannelPostTextFromStore(
  props: ChannelPostTextProps & {
    readonly store: ChatSessionStoreHandle["store"];
  },
): ReactNode {
  const { store, messageId } = props;
  const text = useStore(store, (s) => postTextOf(s.messages, messageId));
  return props.children(text);
}
