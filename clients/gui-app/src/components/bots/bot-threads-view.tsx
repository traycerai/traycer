import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, Phone } from "lucide-react";
import type { BotThreadSummary } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotRecord,
  BotSurfaceActionState,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentMember } from "@traycer/protocol/host/environment/contracts";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { NamedBotAvatar } from "@/components/bots/bot-avatars";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import { BotMentionsContext } from "@/components/bots/bot-mentions-context";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { BotSurfaceCardsContext } from "@/components/bots/bot-surface-card-context";
import type { BotTranscriptMark } from "@/components/bots/bot-chat-transcript";
import { BotThreadRowMenu } from "@/components/bots/bot-thread-follow";
import {
  BotThreadCardBody,
  type BotThreadLayout,
} from "@/components/bots/bot-thread-panel";
import { threadParticipants } from "@/components/bots/bot-thread-participants";
import {
  anchorSendable,
  boundThreadAnchorKinds,
} from "@/components/bots/bot-thread-sendable";
import {
  useBotMentionDirectory,
  useBotOwner,
} from "@/components/bots/use-bot-surface-scope";
import { UnreadCountBadge } from "@/components/notifications/unread-count-badge";
import {
  useBotFollowedThreads,
  type BotFollowedThread,
} from "@/hooks/bots/use-bot-followed-threads";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useBotReadCursors } from "@/hooks/bots/use-bot-read-cursor";
import {
  useAdvanceWhilePresented,
  usePresented,
} from "@/hooks/bots/use-bot-read-while-presented";
import {
  useBotAnswerReach,
  useBotImageReach,
} from "@/hooks/bots/use-bot-send-version";
import { useBotSubscriptionForHost } from "@/hooks/bots/use-bot-subscription";
import { useBotSurfaceCards } from "@/hooks/bots/use-bot-surface-cards";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentMemberDirectory } from "@/hooks/bots/use-environment-members-query";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import {
  botMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { advanceTarget } from "@/lib/bots/bot-read-cursor";
import { firstLineOf } from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { useAuthStore, type AuthProfile } from "@/stores/auth/auth-store";
import type { BotTurnOpen } from "@/stores/bots/bot-open-thread-store";
import { useBotThreadFoldStore } from "@/stores/bots/bot-thread-fold-store";

const EMPTY_BOTS: ReadonlyArray<BotRecord> = [];
const NO_EPIC_IDS: ReadonlyArray<string> = [];
const NO_TASKS: ReadonlyArray<BotTaskEntry> = [];

/** The most messages, the post included, a card shows before it folds. */
const MESSAGES_IN_FULL = 6;
/** The replies a folded card shows under its fold: the newest. */
const FOLDED_TAIL = 2;

/**
 * Threads, in place of a bot's channel (Tracy Bots, decisions 149 and 184):
 * every thread the person follows across the bots the column lists, newest
 * reply first, each a card that shows the thread in full - the line naming
 * its channel and who is in it, the post it hangs off, its replies and a box
 * that replies in it (T137) - as Slack's Threads view does. The page is the
 * one scroller; a card grows to its thread.
 *
 * While any followed thread has new replies, a pill at the top says how many
 * and goes to the first of them. Once a card's newest reply has stayed in
 * the person's view, its new replies are read, as the thread's panel reads
 * them.
 *
 * Where the tab draws no column, whose channel row is the way back, the header
 * goes back to the tab's channel itself: as the installed app's form says, and
 * elsewhere as the tab's own container does.
 */
export function BotThreadsView(props: {
  readonly hostId: string;
  /** The tab's channel, which the back control names. */
  readonly channelTitle: string;
  readonly onBack: () => void;
  /** The installed app's form; `null` where the container decides. */
  readonly level2: MobileLevel2Form | null;
}): ReactNode {
  const { level2 } = props;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="bot-threads-view"
    >
      <header className="flex shrink-0 flex-col gap-0.5 px-4 pt-3 pb-2">
        {level2 !== null && typeof level2 === "object" ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("self-start", level2 === null && "@3xl:hidden")}
            data-testid="bot-threads-back"
            onClick={props.onBack}
          >
            <ArrowLeft aria-hidden="true" />
            {`Back to ${props.channelTitle}`}
          </Button>
        )}
        <h1 className="text-ui-md font-bold text-foreground">Threads</h1>
        <p className="text-ui-xs text-muted-foreground">
          Threads you follow, across every bot.
        </p>
      </header>
      <div
        ref={setScroller}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4"
        data-testid="bot-threads-scroll"
      >
        <BotThreadsBody hostId={props.hostId} scroller={scroller} />
      </div>
    </div>
  );
}

function BotThreadsBody(props: {
  readonly hostId: string;
  readonly scroller: HTMLElement | null;
}): ReactNode {
  const { hostId, scroller } = props;
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
    return <EmptyLine text="No threads yet." />;
  }
  return (
    <div className="flex flex-col gap-3">
      {failure}
      <ThreadCards
        hostId={hostId}
        threads={followed.threads}
        scroller={scroller}
      />
    </div>
  );
}

function ThreadCards(props: {
  readonly hostId: string;
  readonly threads: ReadonlyArray<BotFollowedThread>;
  readonly scroller: HTMLElement | null;
}): ReactNode {
  const { hostId, threads, scroller } = props;
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
  const unread = threads.filter((entry) => entry.newReplies);
  const goToNextUnread = (): void => {
    if (scroller === null) return;
    const card = nextUnreadCard(
      scroller,
      unread.map((entry) => entry.thread.threadId),
    );
    card?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <>
      {unread.length === 0 ? null : (
        <UnreadThreadsPill count={unread.length} onClick={goToNextUnread} />
      )}
      <ul className="flex flex-col gap-3">
        {threads.map((entry) => {
          const { threadId } = entry.thread;
          return (
            <ThreadCard
              key={threadId}
              hostId={hostId}
              entry={entry}
              scroller={scroller}
              unreadCount={
                Object.hasOwn(indicators.chats, threadId)
                  ? (indicators.chats[threadId].unreadCount ?? 0)
                  : 0
              }
            />
          );
        })}
      </ul>
    </>
  );
}

/**
 * The card a jump to the next unread thread lands on: the first card, in the
 * page's order, of a thread with new replies that starts below the top of
 * the page's view; the first of them all once every one starts above it.
 */
function nextUnreadCard(
  scroller: HTMLElement,
  unreadThreadIds: ReadonlyArray<string>,
): HTMLElement | null {
  const unread = new Set(unreadThreadIds);
  const cards = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-thread-card]"),
  ).filter((card) => unread.has(card.dataset.threadId ?? ""));
  const top = scroller.getBoundingClientRect().top;
  return (
    cards.find((card) => card.getBoundingClientRect().top - top > 1) ??
    cards.at(0) ??
    null
  );
}

/**
 * Floats over the top of the page while any followed thread has new replies,
 * and goes to the next of them.
 */
function UnreadThreadsPill(props: {
  readonly count: number;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <div className="pointer-events-none sticky top-0 z-10 flex h-0 justify-center">
      <button
        type="button"
        data-testid="bot-threads-unread-pill"
        onClick={props.onClick}
        className="pointer-events-auto mt-2 flex h-8 items-center rounded-full bg-popover/95 px-3 text-ui-sm font-medium whitespace-nowrap text-popover-foreground shadow-md ring-1 ring-foreground/10 transition-[background-color,box-shadow] outline-none hover:bg-popover hover:shadow-lg focus-visible:ring-2 focus-visible:ring-ring/70"
      >
        {props.count === 1
          ? "1 unread thread"
          : `${props.count} unread threads`}
      </button>
    </div>
  );
}

/**
 * One followed thread as a card: the line naming its bot and who is in it,
 * then the thread in full once the card has come within a screen of the
 * page's view, and from then on; until then the post's first line and its
 * replies. A thread whose post is gone from the channel shows only that, and
 * opens nowhere.
 */
function ThreadCard(props: {
  readonly hostId: string;
  readonly entry: BotFollowedThread;
  readonly scroller: HTMLElement | null;
  /** The thread's unread notifications. */
  readonly unreadCount: number;
}): ReactNode {
  const { hostId, entry, scroller, unreadCount } = props;
  const { bot, thread } = entry;
  const client = useTabHostClient();
  const membersSupported =
    useHostMethodSupport(hostId, "environment.members") === true;
  const directory = useEnvironmentMemberDirectory(
    client,
    bot.environmentId,
    membersSupported,
  );
  const [card, setCard] = useState<HTMLElement | null>(null);
  const near = useCardNear(card, scroller);
  const anchor = thread.anchor;
  const { showPost, openThread } = useCardLinks(
    bot.botId,
    thread.threadId,
    anchor?.messageId ?? null,
  );
  return (
    <li
      ref={setCard}
      className="flex min-w-0 flex-col rounded-lg border border-border/60 bg-card pb-1"
      data-testid="bot-thread-card"
      data-thread-card=""
      data-thread-id={thread.threadId}
      data-bot-id={bot.botId}
      data-full={near && openThread !== null ? "true" : "false"}
    >
      <ThreadChannelLine
        entry={entry}
        resolveMember={directory.resolve}
        unreadCount={unreadCount}
        onShowPost={showPost}
        onOpenThread={openThread}
      />
      {near && anchor !== null && openThread !== null ? (
        <FullThread
          hostId={hostId}
          entry={entry}
          originMessageId={anchor.messageId}
          members={directory.members}
          resolveMember={directory.resolve}
          scroller={scroller}
          onShowPost={showPost}
        />
      ) : (
        <ThreadSummary
          hostId={hostId}
          entry={entry}
          onOpenThread={openThread}
        />
      )}
    </li>
  );
}

/**
 * Where a card's links go: the bot's channel landed on the thread's post with
 * nothing beside it (`showPost`; the channel as it opens where the post is
 * gone), and the channel with the thread beside it (`openThread`; `null`
 * where the post is gone, since the thread opens by its post).
 */
function useCardLinks(
  botId: string,
  threadId: string,
  postMessageId: string | null,
): {
  readonly showPost: () => void;
  readonly openThread: (() => void) | null;
} {
  const openChannel = useOpenBotChannel();
  const showPost = useCallback(
    () =>
      openChannel(
        botId,
        postMessageId === null
          ? null
          : { kind: "thread", threadId: null, messageId: postMessageId },
      ),
    [botId, openChannel, postMessageId],
  );
  const openPostThread = useCallback(
    () => openChannel(botId, { kind: "thread", threadId, messageId: null }),
    [botId, openChannel, threadId],
  );
  return {
    showPost,
    openThread: postMessageId === null ? null : openPostThread,
  };
}

/**
 * Whether a card has come within a screen of the page's view, once and for
 * good. Where nothing can observe, every card is near.
 */
function useCardNear(
  card: HTMLElement | null,
  scroller: HTMLElement | null,
): boolean {
  const observable = typeof IntersectionObserver !== "undefined";
  const [near, setNear] = useState(!observable);
  useEffect(() => {
    if (card === null || scroller === null || near || !observable) return;
    // A margin's percentage takes the scroller's height above and below.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root: scroller, rootMargin: "100% 0px" },
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, [card, near, observable, scroller]);
  return near;
}

/**
 * A card's reading, as the panel reads: the reply its read cursor would
 * advance to is marked under that reply's row once the row is drawn (`null`
 * while there is nothing to read), and the cursor advances once that mark
 * has stayed in the page's view. A mark seen for any other reply
 * acknowledges nothing.
 */
function useCardRead(input: {
  readonly botId: string;
  readonly hostId: string;
  readonly threadId: string;
  readonly scroller: HTMLElement | null;
}): BotTranscriptMark | null {
  const { botId, hostId, threadId, scroller } = input;
  const client = useTabHostClient();
  const readCursors = useBotReadCursors(botId, hostId)?.data;
  const targetId =
    readCursors === undefined
      ? null
      : (advanceTarget(readCursors, threadId)?.messageId ?? null);
  const [drawn, setDrawn] = useState<{
    readonly node: HTMLElement;
    readonly messageId: string;
  } | null>(null);
  const ref = useCallback(
    (node: HTMLElement | null) =>
      setDrawn(
        node === null || targetId === null
          ? null
          : { node, messageId: targetId },
      ),
    [targetId],
  );
  const seen = useMarkSeen(drawn?.node ?? null, scroller);
  useAdvanceWhilePresented({
    client,
    botId,
    conversationId: threadId,
    readCursors,
    presented: usePresented(seen && drawn?.messageId === targetId),
  });
  return useMemo(
    () => (targetId === null ? null : { messageId: targetId, ref }),
    [ref, targetId],
  );
}

/** How long a card's marked reply stays in view before it is read. */
const READ_AFTER_MS = 1_000;

/**
 * Whether `mark`, under the reply a card's reading would acknowledge, has
 * been in the page's view for `READ_AFTER_MS` and still is: a card's channel
 * line or post in view reads nothing, and neither does a glance while the
 * cards above it are still growing or a scroll past. Each reply's mark is a
 * node of its own, so each is held anew. Where nothing can observe, a mark
 * is seen once drawn.
 */
function useMarkSeen(
  mark: HTMLElement | null,
  scroller: HTMLElement | null,
): boolean {
  const observable = typeof IntersectionObserver !== "undefined";
  const [seenMark, setSeenMark] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (mark === null || scroller === null || !observable) return;
    let timer: number | null = null;
    const stop = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry === undefined) return;
        if (entry.isIntersecting) {
          if (timer === null) {
            timer = window.setTimeout(() => setSeenMark(mark), READ_AFTER_MS);
          }
          return;
        }
        stop();
        setSeenMark(null);
      },
      { root: scroller },
    );
    observer.observe(mark);
    return () => {
      stop();
      observer.disconnect();
    };
  }, [mark, observable, scroller]);
  if (!observable) return mark !== null;
  return mark !== null && seenMark === mark;
}

/**
 * The top of a card: the bot's picture and name, then who is in the thread.
 * The name shows the bot's channel landed on the thread's post, with nothing
 * beside it. Whether the thread has new replies, its unread notifications and
 * its menu sit at the end.
 */
function ThreadChannelLine(props: {
  readonly entry: BotFollowedThread;
  readonly resolveMember: BotMemberResolver;
  readonly unreadCount: number;
  readonly onShowPost: () => void;
  readonly onOpenThread: (() => void) | null;
}): ReactNode {
  const { entry, resolveMember, unreadCount, onShowPost, onOpenThread } = props;
  const { bot, thread, newReplies } = entry;
  const viewer = useAuthStore((s) => s.profile);
  const who = whoIsInThread(thread, bot, viewer, resolveMember);
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-3 text-ui-xs text-muted-foreground"
      data-testid="bot-thread-card-channel"
    >
      <NamedBotAvatar botId={bot.botId} size="xs" />
      <Button
        type="button"
        variant="link"
        size="inline-xs"
        className="min-w-0 shrink"
        data-testid="bot-thread-card-channel-link"
        onClick={onShowPost}
      >
        <span className="truncate">{bot.title}</span>
      </Button>
      {who === null ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span
            className="min-w-0 truncate"
            data-testid="bot-thread-card-participants"
          >
            {who}
          </span>
        </>
      )}
      {/* A thread a call opened (Call Tracy, P12): its rows were spoken. */}
      {thread.kind === "call" ? (
        <Phone
          role="img"
          aria-label="Call"
          data-testid="bot-thread-row-call"
          className="size-3.5 shrink-0"
        />
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {newReplies ? (
          <span
            className="font-semibold text-foreground"
            data-testid="bot-thread-row-new-replies"
          >
            new replies
          </span>
        ) : null}
        <UnreadCountBadge
          count={unreadCount}
          size="xs"
          testId="bot-thread-row-unread-count"
          corner={null}
          noun="unread"
        />
        <BotThreadRowMenu
          botId={bot.botId}
          threadId={thread.threadId}
          following
          onOpenThread={onOpenThread}
        />
      </span>
    </div>
  );
}

/**
 * Who is in a thread, as its channel line names them: whoever wrote its post
 * and whoever replied, by name, the bot by its title; "Just you" when the
 * viewer alone has written in it. `null` while nobody is known: an older
 * host names no reply's author, and a thread whose post is gone names no
 * writer.
 */
function whoIsInThread(
  thread: BotThreadSummary,
  bot: BotRecord,
  viewer: AuthProfile | null,
  resolveMember: BotMemberResolver,
): string | null {
  const writers = threadWriters(thread, bot, viewer, resolveMember);
  if (writers.length === 0) return null;
  // Replies an older host names no author for may be anyone's.
  const repliesKnown =
    thread.replyParticipants !== undefined || thread.replyCount === 0;
  if (repliesKnown && writers.every((writer) => writer.viewer)) {
    return "Just you";
  }
  const names = new Map<string, string>();
  for (const writer of writers) {
    if (!names.has(writer.key)) names.set(writer.key, writer.name);
  }
  return [...names.values()].join(", ");
}

/** Whoever wrote a thread's post, then each author of its replies. */
function threadWriters(
  thread: BotThreadSummary,
  bot: BotRecord,
  viewer: AuthProfile | null,
  resolveMember: BotMemberResolver,
): ReadonlyArray<{
  readonly key: string;
  readonly name: string;
  readonly viewer: boolean;
}> {
  const botWriter = { key: "bot", name: bot.title, viewer: false };
  const person = (userId: string, name: string) => ({
    key: `person:${userId}`,
    name,
    viewer: userId === viewer?.userId,
  });
  const writers = [];
  const anchor = thread.anchor;
  if (anchor !== null) {
    writers.push(
      anchor.senderUserId === null
        ? botWriter
        : person(
            anchor.senderUserId,
            botMemberName(anchor.senderUserId, viewer, resolveMember),
          ),
    );
  }
  for (const participant of threadParticipants(thread, viewer, resolveMember)) {
    writers.push(
      participant.kind === "bot"
        ? botWriter
        : person(participant.userId ?? participant.name, participant.name),
    );
  }
  return writers;
}

/**
 * A card before it has come near the view: its post's first line (with a
 * phone in the channel line for a thread a call opened) and its replies, as
 * the list's row was. The post is read from what the bot's channel has
 * loaded; an older one is named "Thread". The replies open the thread beside
 * its channel.
 */
function ThreadSummary(props: {
  readonly hostId: string;
  readonly entry: BotFollowedThread;
  readonly onOpenThread: (() => void) | null;
}): ReactNode {
  const { hostId, entry, onOpenThread } = props;
  const { bot, thread } = entry;
  const anchor = thread.anchor;
  if (anchor === null) {
    return (
      <ThreadSummaryBody
        thread={thread}
        title="Thread"
        onOpenThread={onOpenThread}
      />
    );
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
        <ThreadSummaryBody
          thread={thread}
          title={
            row === null ? "Thread" : (firstLineOf(postTextOf(row)) ?? "Thread")
          }
          onOpenThread={onOpenThread}
        />
      )}
    </ChannelPost>
  );
}

function ThreadSummaryBody(props: {
  readonly thread: BotThreadSummary;
  readonly title: string;
  readonly onOpenThread: (() => void) | null;
}): ReactNode {
  const { thread, title, onOpenThread } = props;
  const replies =
    thread.replyCount === 1 ? "1 reply" : `${thread.replyCount} replies`;
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 px-3 pb-1.5"
      data-testid="bot-thread-card-summary"
    >
      <span className="min-w-0 truncate text-ui-sm text-foreground">
        {title}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
        {onOpenThread === null ? (
          <span>{replies}</span>
        ) : (
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            data-testid="bot-thread-card-summary-replies"
            onClick={onOpenThread}
          >
            {replies}
          </Button>
        )}
        {thread.lastReplyAt === null ? null : (
          <ReplyTime at={thread.lastReplyAt} />
        )}
      </span>
    </div>
  );
}

/** When the thread's latest reply landed, on the shared minute clock. */
function ReplyTime(props: { readonly at: number }): ReactNode {
  const label = useRelativeTimestamp(props.at);
  return <span className="shrink-0">{`· ${label}`}</span>;
}

/**
 * The thread in full, under the card's channel line: the thread panel's own
 * body (`BotThreadCardBody`) - its post, its replies and its box - in the
 * bot's scope, folded in the middle while long and not yet shown in full.
 * Once the newest reply its read cursor names is drawn and has stayed in the
 * page's view (`scroller`), its replies are read, as the panel reads them.
 */
function FullThread(props: {
  readonly hostId: string;
  readonly entry: BotFollowedThread;
  readonly originMessageId: string;
  readonly members: ReadonlyArray<EnvironmentMember> | null;
  readonly resolveMember: BotMemberResolver;
  readonly scroller: HTMLElement | null;
  readonly onShowPost: () => void;
}): ReactNode {
  const {
    hostId,
    entry,
    originMessageId,
    members,
    resolveMember,
    scroller,
    onShowPost,
  } = props;
  const { bot, thread } = entry;
  const { botId } = bot;
  const { threadId } = thread;
  const client = useTabHostClient();
  const subscription = useBotSubscriptionForHost({
    botId,
    hostId,
    enabled: true,
  });
  const snapshot = subscription.snapshot;
  const boundHostId = snapshot?.boundHost.hostId ?? bot.boundHostId;
  const boundHostEpoch = snapshot?.boundHost.epoch ?? bot.hostEpoch;
  const threadList = useBotThreadListQuery(client, botId, { enabled: true });
  const threadAnchorKinds = boundThreadAnchorKinds(
    threadList.data?.threadAnchors ?? null,
    boundHostId,
    boundHostEpoch,
  );
  const imageReach = useBotImageReach({
    hostId,
    boundHostId,
    boundHostTakes: threadAnchorKinds,
  });
  const answerReach = useBotAnswerReach({
    hostId,
    boundHostId,
    boundHostTakes: threadAnchorKinds,
  });
  const readMark = useCardRead({ botId, hostId, threadId, scroller });
  const unfolded = useBotThreadFoldStore((state) =>
    Object.hasOwn(state.unfolded, threadId),
  );
  const unfold = useBotThreadFoldStore((state) => state.unfold);
  const layout = useMemo(
    (): BotThreadLayout => ({
      kind: "card",
      fold: unfolded
        ? null
        : {
            maxRows: MESSAGES_IN_FULL - 1,
            tail: FOLDED_TAIL,
            onUnfold: () => unfold(threadId),
          },
      onShowPost,
      readMark,
    }),
    [onShowPost, readMark, threadId, unfold, unfolded],
  );
  const viewer = useAuthStore((s) => s.profile);
  const anchorSenderLabel = useCallback(
    (senderUserId: string | null): string =>
      senderUserId === null
        ? "Member"
        : botMemberName(senderUserId, viewer, resolveMember),
    [resolveMember, viewer],
  );
  const openChannel = useOpenBotChannel();
  // A receipt opens its turn's session in the bot's channel, where sessions
  // show, landed as the panel's receipt lands it.
  const openTurn = useCallback<BotTurnOpen>(
    (ref, sendPostId) =>
      openChannel(botId, {
        kind: "chat",
        chatId: ref.chatId,
        messageId: ref.userMessageId,
        sendPostId,
      }),
    [botId, openChannel],
  );
  return (
    <ThreadCardScope
      bot={bot}
      hostId={hostId}
      tasks={snapshot?.tasks ?? NO_TASKS}
      surfaceActions={snapshot?.surfaceActions ?? null}
      members={members}
      resolveMember={resolveMember}
    >
      <ChannelPost
        botId={botId}
        hostId={hostId}
        conversationId={thread.conversationId}
        messageId={originMessageId}
        fetchCold={false}
      >
        {(post) => (
          <BotThreadCardBody
            botId={botId}
            hostId={hostId}
            boundHostId={boundHostId}
            imageReach={imageReach}
            answerReach={answerReach}
            botTitle={bot.title}
            conversationId={thread.conversationId}
            originMessageId={originMessageId}
            sent={null}
            thread={{
              kind: "listed",
              thread,
              retry: null,
              sendable: anchorSendable({
                open: null,
                listed: thread,
                post,
                threadAnchorKinds,
              }),
            }}
            anchorSenderLabel={anchorSenderLabel}
            resolveMember={resolveMember}
            // The post's replacement is a new post in the channel: Edit shows
            // the post there, where its own Edit puts it in the channel's box.
            onEditPost={onShowPost}
            onOpenTurn={openTurn}
            landOn={null}
            quote={null}
            layout={layout}
          />
        )}
      </ChannelPost>
    </ThreadCardScope>
  );
}

/**
 * What the bot's rows and box read of the bot, as its own channel provides
 * them: its picture and owner, what its text can name, and its posts' task
 * cards.
 */
function ThreadCardScope(props: {
  readonly bot: BotRecord;
  readonly hostId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly surfaceActions: ReadonlyArray<BotSurfaceActionState> | null;
  readonly members: ReadonlyArray<EnvironmentMember> | null;
  readonly resolveMember: BotMemberResolver;
  readonly children: ReactNode;
}): ReactNode {
  const { bot, hostId, tasks, surfaceActions, members, resolveMember } = props;
  const client = useTabHostClient();
  const environments = useEnvironmentListQuery(client, true);
  const environment =
    environments.data?.environments.find(
      (candidate) => candidate.environmentId === bot.environmentId,
    ) ?? null;
  const owner = useBotOwner(environment, members);
  const identity = useMemo(
    () => ({ botId: bot.botId, title: bot.title, owner }),
    [bot.botId, bot.title, owner],
  );
  const mentioned = useBotMentionDirectory({
    environmentId: bot.environmentId,
    tasks,
    environmentsRead: environments.data !== undefined,
    environment,
    resolveMember,
  });
  const viewer = useAuthStore((s) => s.profile);
  const surfaceCards = useBotSurfaceCards({
    client,
    hostId,
    botId: bot.botId,
    viewer,
    resolveMember,
    tasks,
    surfaceActions,
  });
  return (
    <BotMentionsContext value={mentioned}>
      <BotIdentityContext value={identity}>
        <BotSurfaceCardsContext.Provider value={surfaceCards}>
          {props.children}
        </BotSurfaceCardsContext.Provider>
      </BotIdentityContext>
    </BotMentionsContext>
  );
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
