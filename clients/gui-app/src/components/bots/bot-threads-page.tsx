import {
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotThreadFollowReadResponse } from "@traycer/protocol/host/bot/schemas";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { BotThreadRowMenu } from "@/components/bots/bot-thread-follow";
import { useBotThreadFollows } from "@/hooks/bots/use-bot-thread-follow";
import { useBotReadCursors } from "@/hooks/bots/use-bot-read-cursor";
import { UnreadCountBadge } from "@/components/notifications/unread-count-badge";
import {
  SettingsSegmentedControl,
  type SettingsSegmentedOption,
} from "@/components/settings/controls/settings-segmented-control";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import {
  channelMuted,
  followingOf,
} from "@/lib/bots/bot-notification-settings";
import { useBotNotificationLevelsQuery } from "@/hooks/bots/use-bot-notification-level";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { threadHasNewReplies } from "@/lib/bots/bot-read-cursor";
import { firstLineOf, threadOpenOf } from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";
import type { BotOpenThread } from "@/stores/bots/bot-open-thread-store";

/**
 * A bot's Threads tab (Tracy Bots T86, decision 115): its threads, most
 * recent first, each named by the post it hangs off with its replies.
 * Choosing one opens it beside the channel, in Messages.
 *
 * Where the host reads the person's follows (decision 137), a filter at the
 * top shows the threads they follow, the default, each with its unread
 * count, or all of them, so a thread nobody wrote in (an automation's) can
 * still be found and followed. Each row's menu follows or unfollows it.
 */
export function BotThreadsPage(props: {
  readonly botId: string;
  readonly hostId: string;
  /** `null` on a host without the list. */
  readonly threadList: UseQueryResult<
    BotThreadListResponse,
    HostRpcError
  > | null;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4"
      data-testid="bot-threads-page"
    >
      <BotThreadsBody {...props} />
    </div>
  );
}

function BotThreadsBody(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly threadList: UseQueryResult<
    BotThreadListResponse,
    HostRpcError
  > | null;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  const { botId, hostId, threadList, onOpenPost } = props;
  const follows = useBotThreadFollows(botId, hostId);
  const [filter, setFilter] = useState<ThreadsFilter>("following");
  if (threadList === null) {
    return <EmptyLine text="This bot's host can't list its threads." />;
  }
  const threads = threadList.data?.threads;
  if (threads === undefined) {
    if (threadList.isError) {
      return (
        <BotReadFailure
          message="Couldn't load the threads."
          onRetry={() => void threadList.refetch()}
          testId="bot-threads-error"
        />
      );
    }
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
  if (follows === null) {
    return (
      <ThreadList
        botId={botId}
        hostId={hostId}
        threads={threads}
        renderTrailing={null}
        onOpenPost={onOpenPost}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <SettingsSegmentedControl
        value={filter}
        options={THREADS_FILTER_OPTIONS}
        ariaLabel="Show threads"
        disabled={false}
        onChange={setFilter}
      />
      {filter === "following" ? (
        <FollowedThreads
          botId={botId}
          hostId={hostId}
          threads={threads}
          follows={follows}
          onOpenPost={onOpenPost}
        />
      ) : (
        <ThreadList
          botId={botId}
          hostId={hostId}
          threads={threads}
          renderTrailing={(thread) => (
            <BotThreadRowMenu
              botId={botId}
              threadId={thread.threadId}
              following={
                followingOf(follows.data?.follows, thread.threadId) !== null
              }
            />
          )}
          onOpenPost={onOpenPost}
        />
      )}
    </div>
  );
}

type ThreadsFilter = "following" | "all";

const THREADS_FILTER_OPTIONS: ReadonlyArray<
  SettingsSegmentedOption<ThreadsFilter>
> = [
  { value: "following", label: "Following" },
  { value: "all", label: "All" },
];

const NO_EPIC_IDS: ReadonlyArray<string> = [];

/**
 * The threads the person follows, in the list's order (most recent activity
 * first), each with how many of its notifications they have not read and
 * Unfollow in its menu.
 */
function FollowedThreads(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly threads: ReadonlyArray<BotThreadSummary>;
  readonly follows: UseQueryResult<BotThreadFollowReadResponse, HostRpcError>;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  const { botId, hostId, threads, follows, onOpenPost } = props;
  const readCursors = useBotReadCursors(botId, hostId)?.data;
  const levels = useBotNotificationLevelsQuery(
    useTabHostClient(),
    botId,
    useHostMethodSupport(hostId, "bot.notificationLevel.read") === true,
  ).data?.levels;
  // Threads with new replies first (decision 139), each group by last
  // activity, as the list comes. A muted channel's threads never have new
  // replies to show (decision 138).
  const followed = useMemo(() => {
    const newReplies = new Set<string>();
    const listed = threads.filter((thread) => {
      if (followingOf(follows.data?.follows, thread.threadId) === null) {
        return false;
      }
      if (
        threadHasNewReplies(
          readCursors,
          thread.threadId,
          thread.lastReplyAt,
          !channelMuted(levels, thread.conversationId),
        )
      ) {
        newReplies.add(thread.threadId);
      }
      return true;
    });
    return {
      threads: [
        ...listed.filter((thread) => newReplies.has(thread.threadId)),
        ...listed.filter((thread) => !newReplies.has(thread.threadId)),
      ],
      newReplies,
    };
  }, [follows.data, levels, readCursors, threads]);
  const threadIds = useMemo(
    () => followed.threads.map((thread) => thread.threadId),
    [followed],
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
  if (follows.data === undefined) {
    if (follows.isError) {
      return (
        <BotReadFailure
          message="Couldn't load the threads you follow."
          onRetry={() => void follows.refetch()}
          testId="bot-threads-follows-error"
        />
      );
    }
    return (
      <div
        className="py-1 text-muted-foreground"
        aria-busy="true"
        data-testid="bot-threads-follows-loading"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  if (followed.threads.length === 0) {
    return <EmptyLine text="You don't follow any threads here yet." />;
  }
  return (
    <ThreadList
      botId={botId}
      hostId={hostId}
      threads={followed.threads}
      renderTrailing={(thread) => (
        <>
          {followed.newReplies.has(thread.threadId) ? (
            <span
              className="shrink-0 text-ui-xs font-semibold text-foreground"
              data-testid="bot-thread-row-new-replies"
            >
              new replies
            </span>
          ) : null}
          <UnreadCountBadge
            count={
              Object.hasOwn(indicators.chats, thread.threadId)
                ? (indicators.chats[thread.threadId].unreadCount ?? 0)
                : 0
            }
            size="xs"
            testId="bot-thread-row-unread-count"
          />
          <BotThreadRowMenu
            botId={botId}
            threadId={thread.threadId}
            following
          />
        </>
      )}
      onOpenPost={onOpenPost}
    />
  );
}

function ThreadList(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly threads: ReadonlyArray<BotThreadSummary>;
  /** What a row carries beside it: its count and menu; `null` for nothing. */
  readonly renderTrailing: ((thread: BotThreadSummary) => ReactNode) | null;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  const { botId, hostId, threads, renderTrailing, onOpenPost } = props;
  if (threads.length === 0) return <EmptyLine text="No threads yet." />;
  return (
    <ul className="flex flex-col gap-1">
      {threads.map((thread) => (
        <li
          key={thread.threadId}
          className="flex min-w-0 items-center gap-1"
          data-testid="bot-thread-list-item"
          data-thread-id={thread.threadId}
        >
          <div className="min-w-0 flex-1">
            <ThreadRow
              botId={botId}
              hostId={hostId}
              thread={thread}
              onOpenPost={onOpenPost}
            />
          </div>
          {renderTrailing === null ? null : renderTrailing(thread)}
        </li>
      ))}
    </ul>
  );
}

function EmptyLine(props: { readonly text: string }): ReactNode {
  return <p className="py-1 text-ui-xs text-muted-foreground">{props.text}</p>;
}

/**
 * One thread: the first line of its post and its replies, opening the thread
 * as the post's own row does. The list reads only the posts the channel has
 * loaded; a thread whose post is older is named "Thread" until chosen, when
 * this row alone locates its post, holds it while it shows, and opens the
 * thread once it is read (the one reader that fetched it owns the hold, as a
 * task row's does). A lookup that ends without the post says so, with Retry,
 * which asks again.
 */
function ThreadRow(props: {
  readonly botId: string;
  readonly hostId: string;
  readonly thread: BotThreadSummary;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  const { botId, hostId, thread, onOpenPost } = props;
  const [wanted, setWanted] = useState(false);
  // Each Retry is a fresh reader, which asks the host again.
  const [attempt, setAttempt] = useState(0);
  const replies =
    thread.replyCount === 1 ? "1 reply" : `${thread.replyCount} replies`;
  const anchor = thread.anchor;
  if (anchor === null) {
    return (
      <ThreadRowBody
        title="Thread"
        replies={replies}
        onOpen={null}
        pending={false}
      />
    );
  }
  return (
    <ChannelPost
      key={attempt}
      botId={botId}
      hostId={hostId}
      conversationId={thread.conversationId}
      messageId={anchor.messageId}
      fetchCold={wanted}
    >
      {(row, missing) => (
        <ThreadRowFromPost
          row={row}
          missing={missing}
          anchorMessageId={anchor.messageId}
          replies={replies}
          wanted={wanted}
          onWant={() => setWanted(true)}
          onRetry={() => setAttempt((count) => count + 1)}
          onOpenPost={onOpenPost}
        />
      )}
    </ChannelPost>
  );
}

function ThreadRowFromPost(props: {
  readonly row: OpenMessage | null;
  /** The lookup of a chosen row's post ended without it. */
  readonly missing: boolean;
  readonly anchorMessageId: string;
  readonly replies: string;
  /** Chosen before its post was read: it opens once the post is. */
  readonly wanted: boolean;
  readonly onWant: () => void;
  readonly onRetry: () => void;
  readonly onOpenPost: (open: BotOpenThread) => void;
}): ReactNode {
  const { row, missing, anchorMessageId, replies, wanted, onWant } = props;
  const { onRetry, onOpenPost } = props;
  const open = row === null ? null : threadOpenOf(row);
  const openThread = (): void => {
    if (open === null) return;
    onOpenPost({
      anchorMessageId,
      announcement: open.announcement,
      anchorKind: open.anchorKind,
      sent: null,
    });
  };
  const openOnRead = useEffectEvent(openThread);
  const readAfterChosen = wanted && open !== null;
  useEffect(() => {
    if (readAfterChosen) openOnRead();
  }, [readAfterChosen]);
  if (row === null && missing) {
    return (
      <div className="flex flex-col gap-1">
        <ThreadRowBody
          title="Thread"
          replies={replies}
          onOpen={null}
          pending={false}
        />
        <BotReadFailure
          message="Couldn't load this thread."
          onRetry={onRetry}
          testId="bot-thread-row-error"
        />
      </div>
    );
  }
  if (row === null) {
    return (
      <ThreadRowBody
        title="Thread"
        replies={replies}
        onOpen={wanted ? null : onWant}
        pending={wanted}
      />
    );
  }
  return (
    <ThreadRowBody
      title={firstLineOf(postTextOf(row)) ?? "Thread"}
      replies={replies}
      onOpen={open === null ? null : openThread}
      pending={false}
    />
  );
}

function ThreadRowBody(props: {
  readonly title: string;
  readonly replies: string;
  readonly onOpen: (() => void) | null;
  /** Its post is being read, to open it. */
  readonly pending: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid="bot-thread-row"
      disabled={props.onOpen === null}
      aria-busy={props.pending}
      onClick={props.onOpen ?? undefined}
      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/6 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2 disabled:hover:bg-transparent"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-ui-sm text-foreground">
          {props.title}
        </span>
        {props.pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </span>
      <span className="text-ui-xs text-muted-foreground">{props.replies}</span>
    </button>
  );
}
