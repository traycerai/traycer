import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { ChatBotThreadLine } from "@/components/chat/chat-bot-presentation-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import {
  BotChatTranscript,
  type BotTranscriptSurface,
} from "@/components/bots/bot-chat-transcript";
import { BotMessageComposer } from "@/components/bots/bot-message-composer";
import { BotThreadPanel } from "@/components/bots/bot-thread-panel";
import { BotTranscriptPaused } from "@/components/bots/bot-transcript-paused";
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
import { useAuthStore } from "@/stores/auth/auth-store";
import { cn } from "@/lib/utils";

const EMPTY_THREADS: ReadonlyArray<BotThreadSummary> = [];
const NO_EPIC_IDS: ReadonlyArray<string> = [];

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
 * on its line; opening it marks it read.
 */
export function BotChannelView(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly botTitle: string;
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
    paused,
    resolveMember,
    openThreadPostId,
    onOpenThread,
    onOpenUnderTheHood,
  } = props;
  const client = useTabHostClient();
  const conversations = useBotConversationListQuery(client, botId, true);
  // The channel is the bot's first conversation; later ones (A2A, other
  // surfaces) are listed after it by creation time.
  const channel = useMemo(() => {
    const rows = conversations.data?.conversations ?? [];
    let first = null;
    for (const row of rows) {
      if (first === null || row.createdAt < first.createdAt) first = row;
    }
    return first;
  }, [conversations.data]);

  const threadListSupported =
    useHostMethodSupport(hostId, "bot.thread.list") === true;
  const paneVisible = usePaneVisible();
  const threadList = useBotThreadListQuery(client, botId, {
    enabled: !paused && threadListSupported,
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
  // A thread's unread state is the notification its participants get on the
  // verdict, keyed by the bot and the thread; whoever never wrote in the
  // thread has no such notification and so no dot.
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
      openThread: (postMessageId) => onOpenThread(postMessageId),
    }),
    [isUnread, onOpenThread, threadsByPost],
  );

  const openThread =
    openThreadPostId === null
      ? null
      : (threadsByPost.get(openThreadPostId) ?? null);
  const openThreadId = openThread?.threadId ?? null;
  const openThreadUnread = openThreadId !== null && isUnread(openThreadId);
  const { mutate: markRead } = useNotificationMarkEntityRead(client);
  useEffect(() => {
    if (openThreadId === null || !openThreadUnread) return;
    markRead({ epicId: botId, chatId: openThreadId });
  }, [botId, markRead, openThreadId, openThreadUnread]);

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
      <div
        role="status"
        data-testid="bot-channel-error"
        className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-ui-sm text-destructive"
      >
        <span>Couldn&apos;t load this bot&apos;s channel.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void conversations.refetch()}
        >
          Retry
        </Button>
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
  const threadOpen = openThreadPostId !== null && !paused;
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
              thread={openThread}
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
