import { createPortal } from "react-dom";
import { TracyPlaybackSlot } from "@/components/bots/tracy-playback-slot";
import { isEditableEventTarget } from "@/lib/keybindings/editable-target";
import { BotChannelTitle } from "@/components/bots/bot-channel-level2";
import { useMobileBotHeaderSlot } from "@/components/layout/header/mobile-bot-header-context";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import { BotUnreadBanner } from "@/components/bots/bot-unread-banner";
import { refusingDropTarget } from "@/components/bots/bot-box-drops";
import { DROP_AFTER_POST_GONE } from "@/components/bots/bot-drop-lines";
import {
  useComposerDropScope,
  useComposerDropScopeTarget,
} from "@/components/chat/composer/composer-drop-scope";
import { useBotMarkRepresentedRead } from "@/hooks/bots/use-bot-mark-represented-read";
import { NamedBotAvatar } from "@/components/bots/bot-avatars";
import { ChannelPost } from "@/components/bots/bot-channel-post";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import {
  BotMayChangeContext,
  readerMayChangeBot,
} from "@/hooks/bots/use-reader-may-change-bot";
import { BotMentionsContext } from "@/components/bots/bot-mentions-context";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { BotSurfaceCardsContext } from "@/components/bots/bot-surface-card-context";
import {
  BotUnreadPageNavigationContext,
  useBotUnreadBoundary,
  type BotTranscriptUnread,
} from "@/components/bots/bot-unread-boundary";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
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
import {
  useBotAnswerReach,
  useBotImageReach,
  useBotReplyReach,
} from "@/hooks/bots/use-bot-send-version";
import { useBotSubscriptionForHost } from "@/hooks/bots/use-bot-subscription";
import { useBotSurfaceCards } from "@/hooks/bots/use-bot-surface-cards";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentMemberDirectory } from "@/hooks/bots/use-environment-members-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useOpenBotChannel } from "@/hooks/bots/use-open-bot-channel";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import {
  botMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { useBotLifetime } from "@/lib/bots/bot-lifetime";
import { firstLineOf } from "@/lib/bots/bot-trunk-model";
import { postTextOf } from "@/lib/bots/reply-row";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import { useRelativeTimestamp } from "@/lib/relative-time";
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

function stayOnThreads(): void {}

/**
 * Threads, in place of a bot's channel (Tracy Bots, decisions 149 and 184):
 * every thread the person follows across the bots the column lists, newest
 * reply first, each a card that shows the thread in full - the line naming
 * its channel and who is in it, the post it hangs off, its replies and a box
 * that replies in it (T137) - as Slack's Threads view does. The page is the
 * one scroller; a card grows to its thread.
 *
 * The banner counts unread threads and goes to the next of them: to the
 * divider above its first reply new to the person, which stays while the
 * page does, or to the card's top where it draws none.
 * Reading advances only through a contiguous range of hydrated replies
 * whose full extent has stayed in view for the shared read-after policy.
 *
 * Where the tab draws no column, whose channel row is the way back, the header
 * goes back to the tab's channel itself: as the installed app's form says, and
 * elsewhere as the tab's own container does.
 */
export function BotThreadsView(props: {
  readonly hostId: string;
  readonly channelId: string | null;
  /** The tab's channel, which the back control names. */
  readonly channelTitle: string;
  readonly onBack: () => void;
  /** The installed app's form; `null` where the container decides. */
  readonly level2: MobileLevel2Form | null;
}): ReactNode {
  const { level2 } = props;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [bannerSlot, setBannerSlot] = useState<HTMLDivElement | null>(null);
  const mobilePicker = level2 === "menu" || level2 === "bar";
  const botHeaderSlot = useMobileBotHeaderSlot();
  const titleTarget = mobilePicker ? (botHeaderSlot?.target ?? null) : null;
  const threadsTitle = (
    <div className="flex min-w-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-touch"
        aria-label={`Back to ${props.channelTitle}`}
        data-testid="bot-threads-back"
        onClick={props.onBack}
      >
        <ArrowLeft aria-hidden="true" />
      </Button>
      <BotChannelTitle
        level2={level2}
        title="Threads"
        activeBotId={props.channelId}
        hostId={props.hostId}
        threadsView={{
          shown: true,
          onShow: stayOnThreads,
          onLeave: props.onBack,
        }}
      />
    </div>
  );
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="bot-threads-view"
    >
      {mobilePicker && titleTarget === null ? (
        <header className="flex shrink-0 items-center px-4 py-2">
          {threadsTitle}
        </header>
      ) : null}
      {mobilePicker && titleTarget !== null
        ? createPortal(threadsTitle, titleTarget)
        : null}
      {!mobilePicker ? (
        <header className="flex shrink-0 flex-col gap-0.5 px-4 pt-3 pb-2">
          {level2 !== null && typeof level2 === "object" ? null : (
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
          )}
          {/* As tall as a channel's title row, whose buttons set its height,
              so the playback controls change nothing here by arriving. */}
          <div className="@container/title-strip flex min-h-7 min-w-0 items-center gap-2">
            <h1 className="min-w-0 truncate text-ui-md font-bold text-foreground">
              Threads
            </h1>
            <TracyPlaybackSlot />
          </div>
          <p className="text-ui-xs text-muted-foreground">
            Threads you follow, across every bot.
          </p>
        </header>
      ) : null}
      <div ref={setBannerSlot} />
      <div
        ref={setScroller}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4"
        data-testid="bot-threads-scroll"
      >
        <BotThreadsBody
          hostId={props.hostId}
          scroller={scroller}
          bannerSlot={bannerSlot}
        />
      </div>
    </div>
  );
}

function BotThreadsBody(props: {
  readonly bannerSlot: HTMLElement | null;
  readonly hostId: string;
  readonly scroller: HTMLElement | null;
}): ReactNode {
  const { hostId, scroller, bannerSlot } = props;
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
        bannerSlot={bannerSlot}
        hostId={hostId}
        threads={followed.threads}
        scroller={scroller}
      />
    </div>
  );
}

function ThreadCards(props: {
  readonly bannerSlot: HTMLElement | null;
  readonly hostId: string;
  readonly threads: ReadonlyArray<BotFollowedThread>;
  readonly scroller: HTMLElement | null;
}): ReactNode {
  const { hostId, threads, scroller, bannerSlot } = props;
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
  const markRead = useBotMarkRepresentedRead(
    unread.flatMap((entry) =>
      entry.readTarget === null
        ? []
        : [
            {
              botId: entry.bot.botId,
              conversationId: entry.thread.threadId,
              ...entry.readTarget,
            },
          ],
    ),
  );
  const unfold = useBotThreadFoldStore((state) => state.unfold);
  const paneVisible = usePaneVisible();
  const pendingVisit = useRef<number | null>(null);
  const cancelLanding = useCallback(() => {
    pendingVisit.current = null;
  }, []);
  useEffect(() => {
    if (!paneVisible) cancelLanding();
  }, [cancelLanding, paneVisible]);
  const pageNavigation = useMemo(
    () => ({
      cancel: cancelLanding,
      isPending: (visit: number) =>
        paneVisible && pendingVisit.current === visit,
    }),
    [cancelLanding, paneVisible],
  );
  useThreadsScrollIntent(scroller, cancelLanding);
  const visitCounter = useRef(0);
  const [landing, setLanding] = useState<{
    readonly threadId: string;
    readonly visit: number;
  } | null>(null);
  const goToNextUnread = (): void => {
    if (scroller === null) return;
    const card = nextUnreadCard(
      scroller,
      unread.map((entry) => entry.thread.threadId),
    );
    if (card === null) return;
    const threadId = card.dataset.threadId;
    if (threadId === undefined) return;
    unfold(threadId);
    visitCounter.current += 1;
    pendingVisit.current = visitCounter.current;
    setLanding({ threadId, visit: visitCounter.current });
    // The card's rows land on their divider once it is drawn; a card that
    // draws none is shown from its top.
    if (card.querySelector("[data-unread-divider]") === null) {
      card.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  };
  return (
    <BotUnreadPageNavigationContext value={pageNavigation}>
      {bannerSlot === null || (unread.length === 0 && !markRead.failed)
        ? null
        : createPortal(
            <BotUnreadBanner
              label={
                unread.length === 1
                  ? "1 unread thread"
                  : `${unread.length} unread threads`
              }
              navigateTestId="bot-threads-unread-pill"
              onNavigate={goToNextUnread}
              onMarkRead={markRead.markRead}
              pending={markRead.pending}
              failed={markRead.failed}
            />,
            bannerSlot,
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
              unreadVisit={landing?.threadId === threadId ? landing.visit : 0}
              unreadCount={
                Object.hasOwn(indicators.chats, threadId)
                  ? (indicators.chats[threadId].unreadCount ?? 0)
                  : 0
              }
            />
          );
        })}
      </ul>
    </BotUnreadPageNavigationContext>
  );
}

/** Programmatic scrolling is not a new destination; only the person's input retires it. */
function useThreadsScrollIntent(
  scroller: HTMLElement | null,
  cancel: () => void,
): void {
  useEffect(() => {
    if (scroller === null) return undefined;
    const keydown = (event: KeyboardEvent) => {
      if (isThreadsScrollKey(event)) cancel();
    };
    scroller.addEventListener("wheel", cancel, { passive: true });
    scroller.addEventListener("touchmove", cancel, { passive: true });
    scroller.addEventListener("keydown", keydown);
    scroller.addEventListener("pointerdown", cancel);
    return () => {
      scroller.removeEventListener("wheel", cancel);
      scroller.removeEventListener("touchmove", cancel);
      scroller.removeEventListener("keydown", keydown);
      scroller.removeEventListener("pointerdown", cancel);
    };
  }, [cancel, scroller]);
}

function isThreadsScrollKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || isEditableEventTarget(event.target))
    return false;
  const { key } = event;
  let owner: string;
  switch (key) {
    case "PageUp":
    case "PageDown":
      owner = 'select, [role="listbox"], [role="slider"], [role="grid"]';
      break;
    case "ArrowUp":
    case "ArrowDown":
    case "Home":
    case "End":
      owner =
        'select, [role="listbox"], [role="menu"], [role="slider"], [role="tree"], [role="grid"]';
      break;
    case " ":
      // Links activate on Enter; Space still scrolls their containing page.
      owner =
        'button, select, [role="button"], [role="listbox"], [role="menu"], [role="tree"], [role="grid"]';
      break;
    default:
      return false;
  }
  return (
    !(event.target instanceof Element) || event.target.closest(owner) === null
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
  /** Counts the pill's jumps to this card's new replies; zero for none. */
  readonly unreadVisit: number;
  /** The thread's unread notifications. */
  readonly unreadCount: number;
}): ReactNode {
  const { hostId, entry, scroller, unreadVisit, unreadCount } = props;
  const { bot, thread } = entry;
  const lifetime = useBotLifetime();
  const viewerId = useCloudChatViewerId();
  const paneVisible = usePaneVisible();
  // Held here, above the thread drawn only once near, so the place where
  // the new replies began is caught before reading moves the cursor.
  const boundary = useBotUnreadBoundary({
    identity: `${lifetime}:${viewerId}:${bot.botId}:${thread.threadId}`,
    active: paneVisible,
    read: entry.read,
    conversationId: thread.threadId,
  });
  const afterMessageId = boundary?.afterMessageId ?? null;
  const latched = boundary !== null;
  const unread = useMemo(
    (): BotTranscriptUnread | null =>
      latched ? { afterMessageId, visit: unreadVisit } : null,
    [afterMessageId, latched, unreadVisit],
  );
  const directory = useEnvironmentMemberDirectory(bot.environmentId, true);
  const [card, setCard] = useState<HTMLElement | null>(null);
  const near = useCardNear(card, scroller);
  const anchor = thread.anchor;
  const { showPost, openThread } = useCardLinks(
    bot.botId,
    thread.threadId,
    anchor?.messageId ?? null,
  );
  // The card is one drop zone for its box once it draws in full. Until
  // then nothing claims it, so a file dropped there is refused; a card whose
  // post is gone never gets a box, and says why.
  const drop = useComposerDropScope();
  return (
    <li
      ref={setCard}
      className="relative flex min-w-0 flex-col rounded-lg border border-border/60 bg-card pb-1"
      data-testid="bot-thread-card"
      data-thread-card=""
      data-thread-id={thread.threadId}
      data-bot-id={bot.botId}
      data-full={near && openThread !== null ? "true" : "false"}
      {...drop.zoneProps}
    >
      {drop.provide(
        <>
          {anchor === null ? (
            <PostGoneDropClaim threadId={thread.threadId} />
          ) : null}
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
              unread={unread}
              onShowPost={showPost}
            />
          ) : (
            <ThreadSummary hostId={hostId} entry={entry} />
          )}
        </>,
      )}
      {drop.overlay}
    </li>
  );
}

/**
 * Claims a card's zone where its post is gone from the channel: such a card
 * never gets a box, so a file dropped on it is refused, with that said, and a
 * dragged file shows no overlay.
 */
function PostGoneDropClaim(props: { readonly threadId: string }): ReactNode {
  const { threadId } = props;
  const target = useMemo(
    () =>
      refusingDropTarget(
        DROP_AFTER_POST_GONE,
        `bot-drop:post-gone:${threadId}`,
      ),
    [threadId],
  );
  useComposerDropScopeTarget(target);
  return null;
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
 * phone in the channel line for a thread a call opened) and when its latest
 * reply landed. The post is read from what the bot's channel has loaded; an
 * older one is named "Thread". How many replies it has is told to assistive
 * technology alone, as on the card in full.
 */
function ThreadSummary(props: {
  readonly hostId: string;
  readonly entry: BotFollowedThread;
}): ReactNode {
  const { hostId, entry } = props;
  const { bot, thread } = entry;
  const anchor = thread.anchor;
  if (anchor === null) {
    return <ThreadSummaryBody thread={thread} title="Thread" />;
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
        />
      )}
    </ChannelPost>
  );
}

function ThreadSummaryBody(props: {
  readonly thread: BotThreadSummary;
  readonly title: string;
}): ReactNode {
  const { thread, title } = props;
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
      {thread.replyCount === 0 ? null : (
        <span className="sr-only" data-testid="bot-thread-reply-count-sr">
          {replies}
        </span>
      )}
      {thread.lastReplyAt === null ? null : (
        <ReplyTime at={thread.lastReplyAt} />
      )}
    </div>
  );
}

/** When the thread's latest reply landed, on the shared minute clock. */
function ReplyTime(props: { readonly at: number }): ReactNode {
  const label = useRelativeTimestamp(props.at);
  return (
    <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
      {label}
    </span>
  );
}

/**
 * The thread in full, under the card's channel line: the thread panel's own
 * body (`BotThreadCardBody`) - its post, its replies and its box - in the
 * bot's scope, folded in the middle while long and not yet shown in full.
 * The transcript qualifies reading from its hydrated, observed rows, as the panel does.
 * A divider sits where the replies new to the person began (`unread`).
 */
function FullThread(props: {
  readonly hostId: string;
  readonly entry: BotFollowedThread;
  readonly originMessageId: string;
  readonly members: ReadonlyArray<EnvironmentMember> | null;
  readonly resolveMember: BotMemberResolver;
  readonly unread: BotTranscriptUnread | null;
  readonly onShowPost: () => void;
}): ReactNode {
  const {
    hostId,
    entry,
    originMessageId,
    members,
    resolveMember,
    unread,
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
  const replyReach = useBotReplyReach({
    hostId,
    boundHostId,
    boundHostTakes: threadAnchorKinds,
  });
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
      unread,
    }),
    [onShowPost, threadId, unfold, unfolded, unread],
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
            replyReach={replyReach}
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
  const environments = useEnvironmentListQuery(true);
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
        <BotMayChangeContext
          value={readerMayChangeBot(environments.data, bot.environmentId)}
        >
          <BotSurfaceCardsContext.Provider value={surfaceCards}>
            {props.children}
          </BotSurfaceCardsContext.Provider>
        </BotMayChangeContext>
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
