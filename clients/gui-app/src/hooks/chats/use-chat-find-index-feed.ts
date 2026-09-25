import { useLayoutEffect, useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ChatFindIndexAnswer,
  ChatFindIndexDemandSource,
} from "@/components/chat/chat-find-index";
import { useChatFindIndexHits } from "@/hooks/chats/use-chat-find-index-hits";
import type { HostRpcRegistry } from "@/lib/host";

export interface ChatFindIndexFeedArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly epicId: string;
  readonly chatId: string;
  /** What the adapter last asked; see {@link ChatFindIndexDemandSource}. */
  readonly demandSource: ChatFindIndexDemandSource;
  /**
   * Whether any row is unhydrated. With none, the client scan saw everything
   * and the index is not asked.
   */
  readonly hasUnhydratedRows: boolean;
  readonly onAnswer: (answer: ChatFindIndexAnswer) => void;
}

/**
 * Runs the index query for whatever the find adapter is asking and hands each
 * answer back to it. Split from `ChatFindIndexSource` so the query and its
 * hand-off can be driven with a scripted host client.
 */
export function useChatFindIndexFeed(args: ChatFindIndexFeedArgs): void {
  const { demandSource, onAnswer } = args;
  const demand = useSyncExternalStore(
    demandSource.subscribe,
    demandSource.getSnapshot,
  );
  const answer = useChatFindIndexHits({
    client: args.client,
    hostId: args.hostId,
    epicId: args.epicId,
    chatId: args.chatId,
    demand: args.hasUnhydratedRows ? demand : null,
  });
  // Layout, so an answer and the transcript it is read against land in the
  // same commit's find pass.
  useLayoutEffect(() => {
    onAnswer(answer);
  }, [answer, onAnswer]);
}
