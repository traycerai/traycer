import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { TranscriptRowLocator } from "@traycer/protocol/persistence/chat-transcript/locate-row";
import { useChatLocateRow } from "@/hooks/chats/use-chat-locate-row";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { postTextOf } from "@/lib/bots/reply-row";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

type ChannelPostTextProps = {
  readonly botId: string;
  readonly hostId: string;
  /** The channel the post was written in. */
  readonly conversationId: string;
  readonly messageId: string;
  /**
   * Fetch the row when the channel has not loaded it (an old thread's post):
   * located by the host and held hydrated while this shows. `false` reads
   * only what the channel has loaded, for a list that would hold a row per
   * entry.
   */
  readonly fetchCold: boolean;
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
  const { store, botId, conversationId, messageId, fetchCold } = props;
  const text = useStore(store, (s) => postTextOf(s.messages, messageId));
  const epoch = useStore(store, (s) => s.transcriptWindow.epoch);
  const holdTranscriptOrdinal = useStore(store, (s) => s.holdTranscriptOrdinal);
  const client = useTabHostClient();
  // Latched once the row was missing: the row the hold brings in must stay
  // held, or the next hydration plan lets it go and the text flickers out.
  const [cold, setCold] = useState(false);
  if (fetchCold && text === null && !cold) setCold(true);
  const target = useMemo<TranscriptRowLocator | null>(
    () => (cold ? { kind: "message", messageId } : null),
    [cold, messageId],
  );
  const located = useChatLocateRow({
    client,
    epicId: botId,
    chatId: conversationId,
    target,
    epoch,
  });
  useEffect(() => {
    if (located === null) return undefined;
    return holdTranscriptOrdinal(located);
  }, [holdTranscriptOrdinal, located]);
  return props.children(text);
}
