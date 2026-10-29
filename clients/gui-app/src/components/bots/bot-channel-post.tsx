import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { TranscriptRowLocator } from "@traycer/protocol/persistence/chat-transcript/locate-row";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import { useChatLocateRowAnswer } from "@/hooks/chats/use-chat-locate-row";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";

type ChannelPostProps = {
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
  /**
   * Renders with the post's row, `null` while the channel has none for it;
   * `missing` once a cold fetch has ended without it (the host has no such
   * row, or could not be asked), after which nothing more arrives.
   */
  readonly children: (post: OpenMessage | null, missing: boolean) => ReactNode;
};

/**
 * A channel post, read from the channel's own row (Tracy Bots T65): a thread
 * names the post it answers by id only, so wherever a thread shows its post,
 * the row comes from the channel's session - the one the channel view holds
 * open.
 */
export function ChannelPost(props: ChannelPostProps): ReactNode {
  const handle = useChatSessionHandleForContainer(
    props.botId,
    props.conversationId,
    props.hostId,
    true,
  );
  if (handle === null) return props.children(null, false);
  return <ChannelPostFromStore store={handle.store} {...props} />;
}

function ChannelPostFromStore(
  props: ChannelPostProps & {
    readonly store: ChatSessionStoreHandle["store"];
  },
): ReactNode {
  const { store, botId, conversationId, messageId, fetchCold } = props;
  const post = useStore(
    store,
    (s) =>
      s.messages.find((message) => message.messageId === messageId) ?? null,
  );
  const epoch = useStore(store, (s) => s.transcriptWindow.epoch);
  const holdTranscriptOrdinal = useStore(store, (s) => s.holdTranscriptOrdinal);
  const client = useTabHostClient();
  // Latched once the row was missing: the row the hold brings in must stay
  // held, or the next hydration plan lets it go and the text flickers out.
  const [cold, setCold] = useState(false);
  if (fetchCold && post === null && !cold) setCold(true);
  const target = useMemo<TranscriptRowLocator | null>(
    () => (cold ? { kind: "message", messageId } : null),
    [cold, messageId],
  );
  const answer = useChatLocateRowAnswer({
    client,
    epicId: botId,
    chatId: conversationId,
    target,
    epoch,
  });
  const located = answer.status === "found" ? answer.ordinal : null;
  useEffect(() => {
    if (located === null) return undefined;
    return holdTranscriptOrdinal(located);
  }, [holdTranscriptOrdinal, located]);
  return props.children(post, post === null && answer.status === "missing");
}
