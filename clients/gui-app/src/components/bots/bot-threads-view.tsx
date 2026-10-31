import { useMemo, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { NamedBotAvatar } from "@/components/bots/bot-avatars";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { BotThreadRowMenu } from "@/components/bots/bot-thread-follow";
import { UnreadCountBadge } from "@/components/notifications/unread-count-badge";
import {
  useBotFollowedThreads,
  type BotFollowedThread,
} from "@/hooks/bots/use-bot-followed-threads";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { firstLineOf } from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";

const EMPTY_BOTS: ReadonlyArray<BotRecord> = [];
const NO_EPIC_IDS: ReadonlyArray<string> = [];

/**
 * Threads, in place of a bot's channel (Tracy Bots T103, decision 149): every
 * thread the person follows across the bots the column lists, newest reply
 * first, each named by its bot and the post it hangs off, with its replies,
 * whether some are new, and how many of its notifications are unread.
 * Choosing one opens it beside its channel in its bot's tab, as a tapped push
 * does (the tab's landing); its menu unfollows it, which drops it here.
 *
 * Where the tab is too narrow for the column, whose channel row is the way
 * back, the header goes back to the tab's channel itself.
 */
export function BotThreadsView(props: {
  readonly hostId: string;
  /** The tab's channel, which the back control names. */
  readonly channelTitle: string;
  readonly onBack: () => void;
}): ReactNode {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="bot-threads-view"
    >
      <header className="flex shrink-0 flex-col gap-0.5 px-4 pt-3 pb-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start @3xl:hidden"
          data-testid="bot-threads-back"
          onClick={props.onBack}
        >
          <ArrowLeft aria-hidden="true" />
          {`Back to ${props.channelTitle}`}
        </Button>
        <h1 className="text-ui-md font-bold text-foreground">Threads</h1>
        <p className="text-ui-xs text-muted-foreground">
          Threads you follow, across every bot.
        </p>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
        <BotThreadsBody hostId={props.hostId} />
      </div>
    </div>
  );
}

function BotThreadsBody(props: { readonly hostId: string }): ReactNode {
  const { hostId } = props;
  const client = useTabHostClient();
  const botList = useBotListQuery(client, true);
  const followed = useBotFollowedThreads(
    client,
    hostId,
    botList.data?.bots ?? EMPTY_BOTS,
  );
  if (followed.kind === "unsupported") {
    return <EmptyLine text="This host can't list your threads." />;
  }
  // Until the bots are listed, there is nothing to say of their threads.
  if (botList.data === undefined) {
    return botList.isError ? (
      <BotReadFailure
        message="Couldn't load your threads."
        onRetry={() => void botList.refetch()}
        testId="bot-threads-error"
      />
    ) : (
      <ThreadsLoading />
    );
  }
  const failure =
    followed.retry === null ? null : (
      <BotReadFailure
        message="Couldn't load your threads."
        onRetry={followed.retry}
        testId="bot-threads-error"
      />
    );
  if (followed.threads.length === 0) {
    if (failure !== null) return failure;
    if (followed.pending) return <ThreadsLoading />;
    return <EmptyLine text="Threads you take part in appear here." />;
  }
  return (
    <div className="flex flex-col gap-3">
      {failure}
      <ThreadList hostId={hostId} threads={followed.threads} />
    </div>
  );
}

function ThreadList(props: {
  readonly hostId: string;
  readonly threads: ReadonlyArray<BotFollowedThread>;
}): ReactNode {
  const { hostId, threads } = props;
  const threadIds = useMemo(
    () => threads.map((entry) => entry.thread.threadId),
    [threads],
  );
  const chatEpicIds = useMemo(
    () =>
      Object.fromEntries(
        threads.map((entry) => [entry.thread.threadId, entry.bot.botId]),
      ),
    [threads],
  );
  const indicators = useNotificationIndicators({
    hostId,
    epicIds: NO_EPIC_IDS,
    chatIds: threadIds,
    chatEpicIds,
    enabled: threadIds.length > 0,
  });
  const openChannel = useOpenBotChannel(hostId);
  const open = (entry: BotFollowedThread): void => {
    useBotTabLandingStore.getState().request(entry.bot.botId, {
      kind: "thread",
      threadId: entry.thread.threadId,
      messageId: null,
    });
    openChannel(entry.bot);
  };
  return (
    <ul className="flex flex-col gap-1">
      {threads.map((entry) => {
        const { threadId } = entry.thread;
        return (
          <li
            key={threadId}
            className="flex min-w-0 items-center gap-1"
            data-testid="bot-thread-list-item"
            data-thread-id={threadId}
            data-bot-id={entry.bot.botId}
          >
            <div className="min-w-0 flex-1">
              <ThreadRow
                hostId={hostId}
                entry={entry}
                onOpen={() => open(entry)}
              />
            </div>
            <UnreadCountBadge
              count={
                Object.hasOwn(indicators.chats, threadId)
                  ? (indicators.chats[threadId].unreadCount ?? 0)
                  : 0
              }
              size="xs"
              testId="bot-thread-row-unread-count"
            />
            <BotThreadRowMenu
              botId={entry.bot.botId}
              threadId={threadId}
              following
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One thread: its bot, the first line of its post and its replies. The post
 * is read from what the bot's channel has loaded; an older one is named
 * "Thread". A thread whose post is gone from the channel cannot be opened.
 */
function ThreadRow(props: {
  readonly hostId: string;
  readonly entry: BotFollowedThread;
  readonly onOpen: () => void;
}): ReactNode {
  const { hostId, entry, onOpen } = props;
  const { bot, thread } = entry;
  const anchor = thread.anchor;
  if (anchor === null) {
    return <ThreadRowBody entry={entry} title="Thread" onOpen={null} />;
  }
  return (
    <ChannelPost
      botId={bot.botId}
      hostId={hostId}
      conversationId={thread.conversationId}
      messageId={anchor.messageId}
      fetchCold={false}
    >
      {(row) => (
        <ThreadRowBody
          entry={entry}
          title={
            row === null ? "Thread" : (firstLineOf(postTextOf(row)) ?? "Thread")
          }
          onOpen={onOpen}
        />
      )}
    </ChannelPost>
  );
}

function ThreadRowBody(props: {
  readonly entry: BotFollowedThread;
  readonly title: string;
  readonly onOpen: (() => void) | null;
}): ReactNode {
  const { bot, thread, newReplies } = props.entry;
  const replies =
    thread.replyCount === 1 ? "1 reply" : `${thread.replyCount} replies`;
  return (
    <button
      type="button"
      data-testid="bot-thread-row"
      disabled={props.onOpen === null}
      onClick={props.onOpen ?? undefined}
      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 disabled:hover:bg-transparent"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
        <NamedBotAvatar botId={bot.botId} size="xs" />
        <span
          className="min-w-0 truncate font-medium text-foreground"
          data-testid="bot-thread-row-bot"
        >
          {bot.title}
        </span>
        {thread.lastReplyAt === null ? null : (
          <ReplyTime at={thread.lastReplyAt} />
        )}
      </span>
      <span className="min-w-0 truncate text-ui-sm text-foreground">
        {props.title}
      </span>
      <span className="flex items-center gap-2 text-ui-xs text-muted-foreground">
        {replies}
        {newReplies ? (
          <span
            className="font-semibold text-foreground"
            data-testid="bot-thread-row-new-replies"
          >
            new replies
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** When the thread's latest reply landed, on the shared minute clock. */
function ReplyTime(props: { readonly at: number }): ReactNode {
  const label = useRelativeTimestamp(props.at);
  return <span className="ml-auto shrink-0">{label}</span>;
}

function ThreadsLoading(): ReactNode {
  return (
    <div
      className="py-1 text-muted-foreground"
      aria-busy="true"
      data-testid="bot-threads-loading"
    >
      <AgentSpinningDots
        className={undefined}
        testId={undefined}
        variant={undefined}
      />
    </div>
  );
}

function EmptyLine(props: { readonly text: string }): ReactNode {
  return <p className="py-1 text-ui-xs text-muted-foreground">{props.text}</p>;
}
