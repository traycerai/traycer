import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  BotConversationRecord,
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { ChatBotThreadLine } from "@/components/chat/chat-bot-presentation-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import {
  BotChatTranscript,
  type BotTranscriptSurface,
} from "@/components/bots/bot-chat-transcript";
import { BotMessageComposer } from "@/components/bots/bot-message-composer";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import {
  BotThreadPanel,
  type BotThreadPanelThread,
} from "@/components/bots/bot-thread-panel";
import { BotTranscriptPaused } from "@/components/bots/bot-transcript-paused";
import type { HostRpcRegistry } from "@/lib/host";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useBotConversationListQuery } from "@/hooks/bots/use-bot-conversation-list-query";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { useNotificationMarkEntityRead } from "@/hooks/notifications/use-notification-mark-entity-read-mutation";
import {
  botMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";
import { isDocumentFocused } from "@/lib/notifications/notification-presence";
import { useAuthStore } from "@/stores/auth/auth-store";
import { cn } from "@/lib/utils";

const EMPTY_THREADS: ReadonlyArray<BotThreadSummary> = [];
const NO_EPIC_IDS: ReadonlyArray<string> = [];

/**
 * Whether the person is in this window: it is on screen and has focus, the
 * same foreground the notification plane reads for a focused chat.
 */
function readWindowForeground(): boolean {
  return isDocumentVisible() && isDocumentFocused();
}

function subscribeWindowForeground(listener: () => void): () => void {
  const stopVisibility = subscribeDocumentVisibility(listener);
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  return () => {
    stopVisibility();
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
  };
}

/**
 * The bot's channel among its conversations: the one the bot record names.
 * A host can file other conversations under the bot with any timestamp, so
 * none of their order says which is the channel. Only a host that names none
 * (it predates the field) leaves the earliest conversation as the channel.
 */
function channelConversation(
  rows: readonly BotConversationRecord[],
  appConversationChatId: string | null,
): BotConversationRecord | null {
  if (appConversationChatId !== null) {
    return (
      rows.find((row) => row.conversationId === appConversationChatId) ?? null
    );
  }
  let first: BotConversationRecord | null = null;
  for (const row of rows) {
    if (first === null || row.createdAt < first.createdAt) first = row;
  }
  return first;
}

/**
 * A bot's channel and its open thread, side by side as Slack lays them out
 * (Tracy Bots, decision 41): members' posts and the bot's announcements at
 * the top level, a line under each post that opens its thread, and the
 * thread panel beside the channel - over it on a narrow pane. The box under
 * the channel posts at the top level, which opens a thread the bot answers
 * in; the thread panel's box replies in that thread.
 *
 * Threads live on the bot's bound host, so they are listed only while this
 * tab is bound there (not paused). The list is polled while the channel is
 * on screen, so a reply count moves as the person watches. A thread with a
 * reply the person has not read, among those they took part in, shows a dot
 * on its line; it is marked read once its panel is in front of the person,
 * which a verdict landing while they are elsewhere waits for.
 */
export function BotChannelView(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
  /**
   * The bot's channel: the app conversation `bot.create` made, as the bot
   * record names it. `null` from a host that predates the field.
   */
  readonly appConversationChatId: string | null;
  /**
   * The tab is not on the host that runs the bot and cannot reach it: the
   * channel's transcript and threads are that host's to serve, so a
   * placeholder stands in, while the box keeps posting through this tab's
   * host - a post is accepted and delivered when the bot can be reached.
   */
  readonly paused: boolean;
  readonly resolveMember: BotMemberResolver;
  /** The post whose thread is open, by its message id; `null` for none. */
  readonly openThreadPostId: string | null;
  readonly onOpenThread: (postMessageId: string | null) => void;
  readonly onOpenUnderTheHood: (sessionChatId: string) => void;
}): ReactNode {
  const {
    botId,
    hostId,
    botTitle,
    appConversationChatId,
    paused,
    resolveMember,
    openThreadPostId,
    onOpenThread,
    onOpenUnderTheHood,
  } = props;
  const client = useTabHostClient();
  const conversations = useBotConversationListQuery(client, botId, true);
  const channel = useMemo(
    () =>
      channelConversation(
        conversations.data?.conversations ?? [],
        appConversationChatId,
      ),
    [appConversationChatId, conversations.data],
  );

  const {
    supported: threadListSupported,
    threadList,
    threadsByPost,
    isUnread,
  } = useChannelThreads({ client, botId, hostId, paused });

  const surface = useMemo<BotTranscriptSurface>(
    () => ({
      kind: "channel",
      threadLine: (postMessageId): ChatBotThreadLine | null => {
        const thread = threadsByPost.get(postMessageId);
        if (thread === undefined) return null;
        return {
          replyCount: thread.replyCount,
          lastReplyAt: thread.lastReplyAt,
          unread: isUnread(thread.threadId),
        };
      },
      // A host without the thread list has no thread to open.
      openThread: threadListSupported
        ? (postMessageId) => onOpenThread(postMessageId)
        : null,
    }),
    [isUnread, onOpenThread, threadListSupported, threadsByPost],
  );

  const threadOpen =
    openThreadPostId !== null && !paused && threadListSupported;
  const openThread =
    openThreadPostId === null
      ? null
      : (threadsByPost.get(openThreadPostId) ?? null);
  const { refetch: refetchThreads } = threadList;
  const panelThread = useMemo<BotThreadPanelThread>(() => {
    if (openThread !== null) return { kind: "listed", thread: openThread };
    if (threadList.isError) {
      return { kind: "failed", retry: () => void refetchThreads() };
    }
    return { kind: "pending" };
  }, [openThread, refetchThreads, threadList.isError]);
  useReadThreadWhilePresented({
    client,
    botId,
    thread: openThread,
    isUnread,
    shown: threadOpen,
  });

  const viewer = useAuthStore((s) => s.profile);
  const anchorSenderLabel = useCallback(
    (senderUserId: string | null): string =>
      senderUserId === null
        ? "Member"
        : botMemberName(senderUserId, viewer, resolveMember),
    [resolveMember, viewer],
  );

  if (conversations.isError) {
    return (
      <div className="p-4">
        <BotReadFailure
          message="Couldn't load this bot's channel."
          onRetry={() => void conversations.refetch()}
          testId="bot-channel-error"
        />
      </div>
    );
  }
  if (conversations.data === undefined) {
    return (
      <div
        className="flex flex-1 items-center justify-center py-10 text-muted-foreground"
        aria-busy="true"
        data-testid="bot-channel-loading"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  if (channel === null) {
    // `bot.create` opens the bot's channel, so an answered list is never
    // empty for a live bot; this is the host disagreeing, and it is said
    // rather than spun on.
    return (
      <p
        role="status"
        data-testid="bot-channel-empty"
        className="m-4 text-ui-sm text-muted-foreground"
      >
        This bot has no channel yet.
      </p>
    );
  }
  return (
    <div className="@container flex min-h-0 flex-1">
      <div className="flex min-h-0 w-full">
        <section
          aria-label={`# ${botTitle}`}
          data-testid="bot-channel"
          data-conversation-id={channel.conversationId}
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col",
            threadOpen ? "hidden @3xl:flex" : "flex",
          )}
        >
          {paused ? (
            <BotTranscriptPaused />
          ) : (
            <BotChatTranscript
              botId={botId}
              chatId={channel.conversationId}
              hostId={hostId}
              title={botTitle}
              instanceId={`bot-channel:${botId}`}
              surface={surface}
              resolveMember={resolveMember}
            />
          )}
          <BotMessageComposer
            botId={botId}
            conversationId={channel.conversationId}
            threadId={null}
            placeholder={`Message #${botTitle}`}
            label={`Message #${botTitle}`}
            testId="bot-channel-composer"
          />
        </section>
        {threadOpen ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col @3xl:max-w-xl @3xl:border-l @3xl:border-border/60">
            <BotThreadPanel
              key={openThreadPostId}
              botId={botId}
              hostId={hostId}
              botTitle={botTitle}
              thread={panelThread}
              anchorSenderLabel={anchorSenderLabel}
              resolveMember={resolveMember}
              onClose={() => onOpenThread(null)}
              onOpenUnderTheHood={onOpenUnderTheHood}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The channel's threads, as the bound host lists them. A thread's unread
 * state is the notification its participants get on the verdict, keyed by
 * the bot and the thread; whoever never wrote in the thread has no such
 * notification and so no dot.
 */
function useChannelThreads(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly botId: string;
  readonly hostId: string;
  readonly paused: boolean;
}): {
  readonly supported: boolean;
  readonly threadList: UseQueryResult<BotThreadListResponse, HostRpcError>;
  readonly threadsByPost: ReadonlyMap<string, BotThreadSummary>;
  readonly isUnread: (threadId: string) => boolean;
} {
  const { client, botId, hostId, paused } = args;
  const supported = useHostMethodSupport(hostId, "bot.thread.list") === true;
  // Polled only while the channel is on screen.
  const paneVisible = usePaneVisible();
  const threadList = useBotThreadListQuery(client, botId, {
    enabled: !paused && supported,
    poll: paneVisible,
  });
  const threads = threadList.data?.threads ?? EMPTY_THREADS;
  const threadsByPost = useMemo(() => {
    const byPost = new Map<string, BotThreadSummary>();
    for (const thread of threads) {
      if (thread.anchor !== null) byPost.set(thread.anchor.messageId, thread);
    }
    return byPost;
  }, [threads]);
  const threadIds = useMemo(
    () => threads.map((thread) => thread.threadId),
    [threads],
  );
  const chatEpicIds = useMemo(
    () => Object.fromEntries(threadIds.map((threadId) => [threadId, botId])),
    [botId, threadIds],
  );
  const indicators = useNotificationIndicators({
    hostId,
    epicIds: NO_EPIC_IDS,
    chatIds: threadIds,
    chatEpicIds,
    enabled: threadIds.length > 0,
  });
  const isUnread = useCallback(
    (threadId: string): boolean => {
      if (!Object.hasOwn(indicators.chats, threadId)) return false;
      const state = indicators.chats[threadId];
      return state.unreadDone || state.unreadFailure;
    },
    [indicators.chats],
  );
  return { supported, threadList, threadsByPost, isUnread };
}

/**
 * Marks the open thread read while the person can see it: its panel is shown
 * in the pane on screen, in a window they are in. An unread thread kept open
 * elsewhere stays unread until they come back to it.
 */
function useReadThreadWhilePresented(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly botId: string;
  readonly thread: BotThreadSummary | null;
  readonly isUnread: (threadId: string) => boolean;
  /** The thread panel is rendered. */
  readonly shown: boolean;
}): void {
  const { client, botId, thread, isUnread, shown } = args;
  const paneVisible = usePaneVisible();
  const windowForeground = useSyncExternalStore(
    subscribeWindowForeground,
    readWindowForeground,
  );
  const presented = shown && paneVisible && windowForeground;
  const threadId = thread?.threadId ?? null;
  const unread = threadId !== null && isUnread(threadId);
  const { mutate: markRead } = useNotificationMarkEntityRead(client);
  useEffect(() => {
    if (!presented || threadId === null || !unread) return;
    markRead({ epicId: botId, chatId: threadId });
  }, [botId, markRead, presented, threadId, unread]);
}
