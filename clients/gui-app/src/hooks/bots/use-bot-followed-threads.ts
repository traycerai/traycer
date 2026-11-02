import { useMemo } from "react";
import type {
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotNotificationLevelReadResponse,
  BotReadCursorReadResponse,
  BotRecord,
  BotThreadFollowReadResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useBotThreadFollowSupported } from "@/hooks/bots/use-bot-thread-follow";
import { useBotReadCursorSupported } from "@/hooks/bots/use-bot-read-cursor";
import {
  channelMuted,
  followingOf,
} from "@/lib/bots/bot-notification-settings";
import { threadHasNewReplies } from "@/lib/bots/bot-read-cursor";

/** A thread the person follows, with the bot whose channel it hangs off. */
export type BotFollowedThread = {
  readonly bot: BotRecord;
  readonly thread: BotThreadSummary;
  /** A reply has landed past the person's read cursor (decision 139). */
  readonly newReplies: boolean;
};

export type BotFollowedThreads =
  /** The tab's host cannot list threads or read the person's follows. */
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "listed";
      /** Newest reply first; a thread with no reply yet last. */
      readonly threads: ReadonlyArray<BotFollowedThread>;
      /** How many of them have new replies. */
      readonly newReplyCount: number;
      /** A bot's threads or follows have not answered yet. */
      readonly pending: boolean;
      /** Reads every read that failed; `null` when none did. */
      readonly retry: (() => void) | null;
    };

/**
 * Every thread the person follows across `bots` (decision 149): taking part
 * follows a thread (decision 137), so these are the threads they are in.
 * Read through the tab's host, one thread list, follow read, read-cursor
 * read and level read per bot, each keyed as that bot's own read is, so the
 * bot's own tab, its rows' menus and this list share one read and an
 * Unfollow anywhere drops the thread here at once. A thread of a channel set
 * to Nothing never has new replies (decision 138).
 */
export function useBotFollowedThreads(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string,
  bots: ReadonlyArray<BotRecord>,
): BotFollowedThreads {
  const listSupported =
    useHostMethodSupport(hostId, "bot.thread.list") === true;
  const followSupported = useBotThreadFollowSupported(hostId);
  const cursorsSupported = useBotReadCursorSupported(hostId);
  const levelsSupported =
    useHostMethodSupport(hostId, "bot.notificationLevel.read") === true;
  const supported = listSupported && followSupported;
  const viewerUserId = useCloudChatViewerId();
  const viewerKnown = viewerUserId.length > 0;
  const byBot = useMemo(
    () => bots.map((bot) => ({ botId: bot.botId })),
    [bots],
  );
  const lists = useHostQueries<HostRpcRegistry, "bot.thread.list">({
    client,
    requests: useMemo(
      () => byBot.map((params) => ({ method: "bot.thread.list", params })),
      [byBot],
    ),
    cacheKeyIdentity: undefined,
    // Only the tab's own bot is read again as its rows land; another bot's
    // list is read again when the window comes back.
    options: { enabled: supported, refetchOnWindowFocus: true },
  });
  const follows = useHostQueries<HostRpcRegistry, "bot.threadFollow.read">({
    client,
    requests: useMemo(
      () =>
        byBot.map((params) => ({ method: "bot.threadFollow.read", params })),
      [byBot],
    ),
    cacheKeyIdentity: viewerUserId,
    options: {
      enabled: supported && viewerKnown,
      refetchOnWindowFocus: true,
    },
  });
  const cursors = useHostQueries<HostRpcRegistry, "bot.readCursor.read">({
    client,
    requests: useMemo(
      () => byBot.map((params) => ({ method: "bot.readCursor.read", params })),
      [byBot],
    ),
    cacheKeyIdentity: viewerUserId,
    options: {
      enabled: supported && cursorsSupported && viewerKnown,
      poll: true,
      refetchOnWindowFocus: true,
    },
  });
  const levels = useHostQueries<HostRpcRegistry, "bot.notificationLevel.read">({
    client,
    requests: useMemo(
      () =>
        byBot.map((params) => ({
          method: "bot.notificationLevel.read",
          params,
        })),
      [byBot],
    ),
    cacheKeyIdentity: viewerUserId,
    options: {
      enabled: supported && levelsSupported && viewerKnown,
      refetchOnWindowFocus: true,
    },
  });
  if (!supported) return { kind: "unsupported" };
  const threads = followedThreadsOf(
    bots.map((bot, index) => ({
      bot,
      list: lists[index]?.data,
      follows: follows[index]?.data,
      cursors: cursors[index]?.data,
      levels: levels[index]?.data,
    })),
  );
  const reads = [...lists, ...follows];
  const failed = reads.filter(
    (read) => read.isError && read.data === undefined,
  );
  return {
    kind: "listed",
    threads,
    newReplyCount: threads.filter((entry) => entry.newReplies).length,
    pending: reads.some((read) => read.isPending && !read.isError),
    retry:
      failed.length === 0
        ? null
        : () => {
            for (const read of failed) void read.refetch();
          },
  };
}

/**
 * The followed threads of each bot whose list and follows have answered,
 * newest reply first and a thread with no reply yet last.
 */
function followedThreadsOf(
  answers: ReadonlyArray<{
    readonly bot: BotRecord;
    readonly list: BotThreadListResponse | undefined;
    readonly follows: BotThreadFollowReadResponse | undefined;
    readonly cursors: BotReadCursorReadResponse | undefined;
    readonly levels: BotNotificationLevelReadResponse | undefined;
  }>,
): BotFollowedThread[] {
  const threads: BotFollowedThread[] = [];
  for (const { bot, list, follows, cursors, levels } of answers) {
    if (list === undefined || follows === undefined) continue;
    for (const thread of list.threads) {
      if (followingOf(follows.follows, thread.threadId) === null) continue;
      threads.push({
        bot,
        thread,
        newReplies: threadHasNewReplies(
          cursors,
          thread.threadId,
          thread.lastReplyAt,
          !channelMuted(levels?.levels, thread.conversationId),
        ),
      });
    }
  }
  return threads.sort(
    (a, b) =>
      (b.thread.lastReplyAt ?? Number.NEGATIVE_INFINITY) -
      (a.thread.lastReplyAt ?? Number.NEGATIVE_INFINITY),
  );
}
