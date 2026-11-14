import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  BotConversationRecord,
  BotConversationSendResponse,
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotSurfaceActionState,
  BotReadCursorReadResponse,
  BotTaskEntry,
  BotThreadFollow,
} from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  answerEntries,
  type ChatBotThreadLine,
} from "@/components/chat/chat-bot-presentation-context";
import {
  BotChatTranscript,
  type BotTranscriptLanding,
  type BotTranscriptSurface,
  type QuestionAnswerSend,
  type QuestionAnswersSend,
} from "@/components/bots/bot-chat-transcript";
import { BotRoutingCard } from "@/components/bots/bot-routing-card";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import {
  channelMuted,
  followingOf,
} from "@/lib/bots/bot-notification-settings";
import { useBotNotificationLevelsQuery } from "@/hooks/bots/use-bot-notification-level";
import { useBotThreadFollows } from "@/hooks/bots/use-bot-thread-follow";
import { useBotReadCursors } from "@/hooks/bots/use-bot-read-cursor";
import {
  useAdvanceWhilePresented,
  usePresented,
} from "@/hooks/bots/use-bot-read-while-presented";
import { threadHasNewReplies } from "@/lib/bots/bot-read-cursor";
import {
  BotMemoryPanel,
  type BotMemoryNavigation,
} from "@/components/bots/bot-memory-panel";
import {
  BotMessageComposer,
  type BotComposerEdit,
  type BotComposerQuote,
} from "@/components/bots/bot-message-composer";
import type { QuoteTextSnapshot } from "@/components/chat/quote/append-quote-to-draft";
import { clearBrowserSelection } from "@/components/chat/quote/quote-snapshot-into-draft";
import {
  QuoteSinkContext,
  type QuoteSink,
} from "@/components/chat/quote/quote-sink-context";
import { useBotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { BotReplyingStrip } from "@/components/bots/bot-replying-strip";
import { useBotReplyingTurn } from "@/hooks/bots/use-bot-replying-turn";
import { BotResizablePane } from "@/components/bots/bot-resizable-pane";
import { BotExchangeLog } from "@/components/bots/bot-exchange-log";
import {
  BotExchangeLinesContext,
  type BotExchangeLines,
} from "@/components/chat/bot-exchange-lines-context";
import {
  exchangeLogOf,
  type BotExchange,
  type BotExchangeLogEntry,
} from "@/lib/bots/bot-exchanges";
import { useBotExchanges } from "@/hooks/bots/use-bot-exchanges";
import {
  BotSearchBackLink,
  BotSearchPanel,
} from "@/components/bots/bot-search-panel";
import {
  BotThreadPanel,
  type BotThreadPanelThread,
} from "@/components/bots/bot-thread-panel";
import type { HostRpcRegistry } from "@/lib/host";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useBotConversationListQuery } from "@/hooks/bots/use-bot-conversation-list-query";
import { useBotThreadListQuery } from "@/hooks/bots/use-bot-thread-list-query";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import { useBotSurfaceCards } from "@/hooks/bots/use-bot-surface-cards";
import { BotSurfaceCardsContext } from "@/components/bots/bot-surface-card-context";
import { threadParticipants } from "@/components/bots/bot-thread-participants";
import {
  anchorSendable,
  boundThreadAnchorKinds,
} from "@/components/bots/bot-thread-sendable";
import { useBotAnswerReach } from "@/hooks/bots/use-bot-send-version";
import { useBotBoxEdit } from "@/hooks/bots/use-bot-box-edit";
import { useBotFailedRequest } from "@/hooks/bots/use-bot-failed-request";
import { useBotImageReach } from "@/hooks/bots/use-bot-send-version";
import {
  failedOnRequest,
  useBotActivity,
  type BotActivity,
  type BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { usePublishPresentedBotConversation } from "@/hooks/notifications/use-publish-presented-bot-conversation";
import { indicatorHasUnread } from "@/stores/notifications/notification-indicator-state";
import {
  botMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import { useKeptBoxDraft } from "@/hooks/bots/use-kept-box-draft";
import {
  useBotOpenThreadStore,
  useBotRail,
  type BotExchangeRail,
  type BotOpenExchange,
  type BotOpenMemory,
  type BotOpenSearch,
  type BotOpenThread,
  type BotSessionOpen,
  type BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import {
  closeBotSearch,
  showBotSearchResults,
  useBotSearchStore,
} from "@/stores/bots/bot-search-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { MobileTileCount } from "@/lib/layout/mobile-layout-form";
import { cn } from "@/lib/utils";
import { useChannelBackground } from "@/hooks/bots/use-bot-appearance";
import { isTransientCloudFailure } from "@/lib/host/transient-cloud-failure";

const EMPTY_THREADS: ReadonlyArray<BotThreadSummary> = [];
const NO_EXCHANGES: ReadonlyArray<BotExchange> = [];
const NO_EPIC_IDS: ReadonlyArray<string> = [];

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
 * Where the channel lands as it opens: a message of the channel
 * (`threadId` `null`), or of the listed thread `threadId`, in that thread's
 * panel beside it.
 */
export type BotChannelLanding = BotTranscriptLanding & {
  readonly threadId: string | null;
};

/**
 * Whether a read's failure is drawn. A read that holds an answer keeps
 * showing it when a refetch fails only because the host could not reach the
 * cloud: the host's cloud-recovery doorbell asks it again
 * (`cloud-recovery-doorbell-mount.tsx`). Any other failure, or one with
 * nothing to show, is drawn.
 */
function readShowsFailure(read: {
  readonly isError: boolean;
  readonly data: unknown;
  readonly error: unknown;
}): boolean {
  return (
    read.isError &&
    (read.data === undefined || !isTransientCloudFailure(read.error))
  );
}

/**
 * The listed thread whose panel is drawn: none while the channel's own read
 * failed, loads, or found no channel, which draw no panel, or while no
 * thread is open beside it.
 */
function drawnPanelThreadId(args: {
  readonly channelReadFailed: boolean;
  readonly channel: BotConversationRecord | null;
  readonly threadOpen: boolean;
  readonly openThread: BotThreadSummary | null;
}): string | null {
  if (args.channelReadFailed || args.channel === null || !args.threadOpen) {
    return null;
  }
  return args.openThread?.threadId ?? null;
}

/**
 * The landing the open thread's panel takes, held from the channel's mount:
 * one on a message of the listed thread whose panel is drawn
 * (`drawnThreadId`). It waits through the first loads that draw no panel;
 * once handed to that thread's panel it lands there once, so the panel
 * going - another thread, the memory in its place, the panel closed, the
 * channel's read failing - spends it, and so does `spend`.
 */
function useThreadPanelLanding(
  landOn: BotChannelLanding | null,
  drawnThreadId: string | null,
): {
  readonly landing: BotTranscriptLanding | null;
  readonly spend: () => void;
} {
  const [held, setHeld] = useState(() =>
    landOn !== null && landOn.threadId !== null
      ? { landing: landOn, handed: false }
      : null,
  );
  const showing = held !== null && drawnThreadId === held.landing.threadId;
  if (held !== null && showing && !held.handed) {
    setHeld({ landing: held.landing, handed: true });
  } else if (
    held !== null &&
    !showing &&
    (held.handed || drawnThreadId !== null)
  ) {
    setHeld(null);
  }
  const spend = useCallback(() => setHeld(null), []);
  return { landing: showing ? held.landing : null, spend };
}

/**
 * A bot's channel and its open thread, side by side as Slack lays them out
 * (Tracy Bots, decision 41): members' posts and the bot's announcements at
 * the top level, "Reply in thread" among each row's hover actions and a
 * line under a post whose thread has replies, and the thread panel beside
 * the channel, as wide as the person dragged it - over it on a narrow pane.
 * The channel's box posts at the top level; the thread panel's box replies
 * in its thread. A post the bot answers in a thread opens that thread as
 * soon as the host accepts it (decision 97).
 *
 * The tab's host serves all of it, whether it runs the bot or not (T65): a
 * host that does not reads the channel from the cloud and lists the threads
 * the bot's host keeps in the environment room. Subscription revisions
 * refresh the list when its conversations change. A thread with a
 * reply the person has not read, among those they took part in, shows a dot
 * on its line; it is marked read once its panel is in front of the person,
 * which a verdict landing while they are elsewhere waits for.
 *
 * The rail beside the channel is one slot: a thread, the bot's memory, which
 * takes the thread's place and brings it back from its header, or a search,
 * whose results land the channel beside them or open a thread in their place
 * with a link back. A reply's receipt, in the channel or in the thread (Tracy Bots T86), opens
 * the turn's session in place of the channel. The trunk's routing card sits above the channel's
 * box, as the agent chat's sits above its composer.
 */
export function BotChannelView(props: {
  readonly botId: string;
  /** The host serving the tab: the channel is read and sent through it. */
  readonly hostId: string;
  /**
   * The host that runs the bot, as its snapshot names it: where a provider
   * the bot's turn found signed out is signed in again. `null` when no host
   * runs it, which leaves nothing to sign in to.
   */
  readonly boundHostId: string | null;
  /**
   * The bot's epoch on that host, as the snapshot names it: the thread
   * anchors the list names hold for this binding only.
   */
  readonly boundHostEpoch: number;
  readonly botTitle: string;
  /** What the bot does, for the top of a channel nobody has written in. */
  readonly directive: string | null;
  /**
   * The bot's channel: the app conversation `bot.create` made, as the bot
   * record names it. `null` from a host that predates the field.
   */
  readonly appConversationChatId: string | null;
  /** The bot's trunk session, which answers the channel's direct posts. */
  readonly trunkChatId: string;
  readonly resolveMember: BotMemberResolver;
  /**
   * The bot's tasks: the open thread lists the ones it set up, and a surface
   * post's card reads what each task waits on.
   */
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  /**
   * The viewer's own answers and decisions from surface cards still on
   * their way to a task, as the serving host holds them; `null` from a host
   * that predates them.
   */
  readonly surfaceActions: ReadonlyArray<BotSurfaceActionState> | null;
  /** The thread open beside the channel; `null` for none. */
  readonly openThread: BotOpenThread | null;
  readonly onOpenThread: (open: BotOpenThread | null) => void;
  /** Opens a reply's turn: its session, in place of the channel. */
  readonly onOpenTurn: BotTurnOpen;
  /** Opens one of the bot's sessions in place of the channel: the open thread's, from its panel. */
  readonly onOpenSession: BotSessionOpen;
  /** A message the channel, or the thread open beside it, lands on as it opens; `null` keeps where it opens. */
  readonly landOn: BotChannelLanding | null;
  /** The bot's memory open beside the channel in the thread's place; `null` for none. */
  readonly openMemory: BotOpenMemory | null;
  readonly onOpenMemory: (open: BotOpenMemory | null) => void;
  /** The bot's environment, whose room keeps its memory. */
  readonly environmentId: string;
  /** Another bot of the environment by its id, for a shared memory's writer. */
  readonly botNameOf: (botId: string) => string | null;
  /**
   * The bots of the bot's environment, which name the other end of the bot's
   * messages with other bots; `null` until listed.
   */
  readonly environmentBots: ReadonlyArray<BotRecord> | null;
  /** The log of the bot's messages with another bot, open in the rail; `null` for none. */
  readonly openExchange: BotOpenExchange | null;
  /** Opens a pair's log in the rail, and closes it back to what it displaced. */
  readonly exchangeRail: BotExchangeRail;
  /** A live team main bot's setup history at the top of the channel (T67b); `null` for none. */
  readonly setupHistory: ReactNode;
  /** How many tiles the installed app shows; `null` where the container decides. */
  readonly tiles: MobileTileCount | null;
}): ReactNode {
  const {
    botId,
    hostId,
    boundHostId,
    boundHostEpoch,
    botTitle,
    directive,
    appConversationChatId,
    trunkChatId,
    resolveMember,
    tasks,
    surfaceActions,
    openThread: open,
    onOpenThread,
    onOpenTurn,
    onOpenSession,
    openMemory,
    onOpenMemory,
    environmentId,
    botNameOf,
    environmentBots,
    openExchange,
    exchangeRail,
    setupHistory,
    tiles,
  } = props;
  const openThreadPostId = open?.anchorMessageId ?? null;
  const client = useTabHostClient();
  const background = useChannelBackground(botId);
  const conversations = useBotConversationListQuery(client, botId, true);
  const channel = useMemo(
    () =>
      channelConversation(
        conversations.data?.conversations ?? [],
        appConversationChatId,
      ),
    [appConversationChatId, conversations.data],
  );
  const channelId = channel?.conversationId ?? null;
  // What the channel's box holds unsent, kept under the bot by the channel's
  // conversation, so it outlives the pane when another channel is shown: the
  // one the box sends to, which a host naming no channel leaves to the list.
  const { seed: channelSeed, keptDraft: channelKeptDraft } = useKeptBoxDraft(
    botId,
    channelId,
  );

  const {
    supported: threadListSupported,
    threadList,
    threadsByPost,
    isUnread,
    unreadCountOf,
    threadAnchorKinds,
    follows,
    readCursors,
    newRepliesOf,
  } = useChannelThreads({
    client,
    botId,
    hostId,
    boundHostId,
    boundHostEpoch,
  });
  const imageReach = useBotImageReach({
    hostId,
    boundHostId,
    boundHostTakes: threadAnchorKinds,
  });
  const activity = useBotActivity(botId);
  const viewer = useAuthStore((s) => s.profile);
  // A direct reply's option, clicked, is the person's next post: offered
  // only while no earlier pick is still being sent. A pick that fails says so
  // where a failed message does.
  const {
    mutate: send,
    mutateAsync: sendAsync,
    isPending: sending,
  } = useBotConversationSendMutation(client);
  const sendFailure = useBotSendFailure();
  const { fail: failSend, clear: clearSendFailure } = sendFailure;
  const chooseOption = useCallback(
    (choice: string) => {
      if (channelId === null) return;
      clearSendFailure();
      send(
        {
          botId,
          conversationId: channelId,
          text: choice,
          threadId: null,
          announcementId: null,
          redeliver: null,
          supersedes: null,
          answer: null,
        },
        { onError: () => failSend(null) },
      );
    },
    [botId, channelId, clearSendFailure, failSend, send],
  );
  // A question card's answer or Skip, on a question the bot asked at the
  // channel's top level: the person's message goes to the bot itself and
  // opens no thread. A send that fails says so where a failed message does,
  // and the card keeps the person's draft. A host that cannot take the
  // answer gets a card without actions; where both hosts take a card's
  // answers together, one Submit sends them as one message.
  const answerReach = useBotAnswerReach({
    hostId,
    boundHostId,
    boundHostTakes: threadAnchorKinds,
  });
  const answerQuestion = useCallback<QuestionAnswerSend>(
    async (questionMessageId, given) => {
      if (channelId === null) return;
      clearSendFailure();
      await sendAsync(
        {
          botId,
          conversationId: channelId,
          text: given.text,
          threadId: null,
          announcementId: null,
          redeliver: null,
          supersedes: null,
          answer: {
            questionMessageId,
            questionIndex: given.questionIndex,
            skipped: given.skipped,
          },
        },
        { onError: () => failSend(null) },
      );
    },
    [botId, channelId, clearSendFailure, failSend, sendAsync],
  );
  const answerQuestions = useCallback<QuestionAnswersSend>(
    async (questionMessageId, given) => {
      if (channelId === null) return;
      clearSendFailure();
      await sendAsync(
        {
          botId,
          conversationId: channelId,
          text: given.text,
          threadId: null,
          announcementId: null,
          redeliver: null,
          supersedes: null,
          answer: null,
          answers: { questionMessageId, entries: answerEntries(given) },
        },
        { onError: () => failSend(null) },
      );
    },
    [botId, channelId, clearSendFailure, failSend, sendAsync],
  );

  // A post the bot failed to answer, in a thread or at the top level, is
  // retried as it is or edited in the channel's box, which posts its
  // replacement.
  const { edit, setEdit, endEdit } = useBotBoxEdit(activity, channelId);
  const failedOnChannel = useCallback(
    (requestId: string) => failedOnRequest(activity, requestId),
    [activity],
  );
  const failedRequest = useBotFailedRequest({
    client,
    hostId,
    boundHostId,
    botId,
    conversationId: channelId,
    threadId: null,
    failedOn: failedOnChannel,
    onEdit: setEdit,
    failure: sendFailure,
  });
  const editPostFromThread = useCallback(
    (postEdit: BotComposerEdit) => {
      onOpenThread(null);
      setEdit(postEdit);
    },
    [onOpenThread, setEdit],
  );

  // A direct post or a row of the bot with no thread yet shows a box whose
  // first reply opens it, rather than waiting for a thread nobody has
  // started.
  const openAnnouncementThread = useCallback(
    (announcementId: string, anchorKind: string | null) =>
      onOpenThread({
        anchorMessageId: announcementId,
        announcement: true,
        anchorKind,
        sent: null,
      }),
    [onOpenThread],
  );
  // A member whose answer someone else's overtook takes it to the question's
  // thread: the thread opens with their draft in its box, unsent, kept under
  // the bot until it is sent. A host without the thread list has no thread
  // to discuss in.
  const seedThreadBox = useBotDraftsStore((state) => state.seedThreadBox);
  const discussQuestion = useMemo(
    () =>
      threadListSupported
        ? (questionMessageId: string, draft: string) => {
            seedThreadBox(botId, questionMessageId, draft);
            openAnnouncementThread(questionMessageId, null);
          }
        : null,
    [botId, openAnnouncementThread, seedThreadBox, threadListSupported],
  );

  // A post whose answer lands in a thread (reply mode `threaded`) opens that
  // thread as the send is accepted, in place of any thread open now, and the
  // thread's panel says the send's delivery; one the bot answers in the
  // channel opens nothing, and the channel's box says it.
  const openPostedThread = useCallback(
    (
      response: BotConversationSendResponse,
      text: string,
      content: JsonContent,
    ): boolean => {
      if (response.threadId === null || !threadListSupported) return false;
      onOpenThread({
        anchorMessageId: response.messageId,
        announcement: false,
        anchorKind: null,
        sent: {
          threadId: response.threadId,
          requestId: response.requestId,
          text,
          content,
          senderUserId: viewer?.userId ?? null,
          sentAt: Date.now(),
          delivery: response.delivery,
        },
      });
      return true;
    },
    [onOpenThread, threadListSupported, viewer],
  );

  // A memory's link to the post it was learned from shows the channel there,
  // each follow a new visit, so the same link followed again lands again. The
  // channel opens where the tab asked it to: it mounts afresh each time a
  // session shown in its place closes.
  const [landing, setLanding] = useState<BotTranscriptLanding | null>(() =>
    props.landOn !== null && props.landOn.threadId === null
      ? props.landOn
      : null,
  );
  const memoryNavigation = useMemo(
    (): BotMemoryNavigation => ({
      openThread: (anchorMessageId) =>
        onOpenThread({
          anchorMessageId,
          announcement: false,
          anchorKind: null,
          sent: null,
        }),
      showInChannel: (messageId) => {
        onOpenMemory(null);
        if (messageId === null) return;
        setLanding((previous) => ({
          messageId,
          sendPostId: null,
          visit: (previous?.visit ?? 0) + 1,
        }));
      },
    }),
    [onOpenMemory, onOpenThread],
  );
  const surface = useMemo<BotTranscriptSurface>(
    () => ({
      kind: "channel",
      threadLine: (postMessageId): ChatBotThreadLine | null => {
        const thread = threadsByPost.get(postMessageId);
        if (thread === undefined) return null;
        return {
          participants: threadParticipants(thread, viewer, resolveMember),
          replyCount: thread.replyCount,
          lastReplyAt: thread.lastReplyAt,
          unread: isUnread(thread.threadId),
          unreadCount: unreadCountOf(thread.threadId),
          // An open thread says it in its own panel, not under its post.
          replying:
            postMessageId !== openThreadPostId &&
            activity?.threads[thread.threadId]?.state === "replying",
          followedUnwritten: followedUnwritten(follows, thread.threadId),
          newReplies: newRepliesOf(thread),
        };
      },
      // A host without the thread list has no thread to open.
      openThread: threadListSupported
        ? (postMessageId) =>
            onOpenThread({
              anchorMessageId: postMessageId,
              announcement: false,
              anchorKind: null,
              sent: null,
            })
        : null,
      openAnnouncementThread: threadListSupported
        ? openAnnouncementThread
        : null,
      threadAnchorKinds,
      chooseOption: sending ? null : chooseOption,
      answerQuestion: answerReach === "none" ? null : answerQuestion,
      answerQuestions: answerReach === "together" ? answerQuestions : null,
      discussQuestion,
      failedRequest,
      openTurn: onOpenTurn,
      sessionChatId: trunkChatId,
      intro: { botTitle, directive },
      history: setupHistory,
    }),
    [
      answerQuestion,
      answerQuestions,
      answerReach,
      botTitle,
      activity?.threads,
      chooseOption,
      directive,
      discussQuestion,
      failedRequest,
      follows,
      isUnread,
      newRepliesOf,
      unreadCountOf,
      onOpenThread,
      openAnnouncementThread,
      openThreadPostId,
      onOpenTurn,
      resolveMember,
      sending,
      setupHistory,
      threadListSupported,
      threadAnchorKinds,
      threadsByPost,
      trunkChatId,
      viewer,
    ],
  );

  const surfaceCards = useBotSurfaceCards({
    client,
    hostId,
    botId,
    viewer,
    resolveMember,
    tasks,
    surfaceActions,
  });

  const trunkReply = channelTrunkReply(activity);
  const trunkReplyTurn = useBotReplyingTurn({
    client,
    hostId,
    botId,
    activity: trunkReply,
    onOpenTurn,
  });

  const [channelSection, setChannelSection] = useState<HTMLElement | null>(
    null,
  );
  // The rail holds one of a thread, the memory, a pair's log or a search's results: either
  // of the last two leaves no thread open (`open` is `null`).
  const railThreadPostId = threadListSupported ? openThreadPostId : null;
  const threadOpen = railThreadPostId !== null;
  const search = useChannelSearch({
    botId,
    tiles,
    section: channelSection,
    threadListSupported,
    threadList,
    railHeld: railHolds(threadOpen, openMemory, openExchange),
    setLanding,
  });
  const { railOpen } = search;

  const openThread =
    openThreadPostId === null
      ? null
      : (threadsByPost.get(openThreadPostId) ?? null);
  const { quoteIntoChannelBox, quoteIntoThreadBox, quoteFor } =
    useBoxQuotes(railThreadPostId);
  // The bot's messages with other bots: lines between the channel's rows and
  // the open thread's, and a pair's log in the rail.
  const exchangeLines = useExchangeLines({
    botId,
    hostId,
    boundHostId,
    trunkChatId,
    environmentBots,
    botTitle,
    openPair: exchangeRail.open,
    openThread,
  });
  const threadLanding = useThreadPanelLanding(
    props.landOn,
    drawnPanelThreadId({
      channelReadFailed: readShowsFailure(conversations),
      channel,
      threadOpen,
      openThread,
    }),
  );
  const { refetch: refetchThreads } = threadList;
  const threadListShowsFailure = readShowsFailure(threadList);
  // The row the open thread hangs off, as the channel's session has it: the
  // panel's own read of it fetches it when cold. Read beside the panel, not
  // around it, so the panel keeps its place while the session comes and goes.
  const anchorRow = useChannelRow({
    botId,
    hostId,
    conversationId: channel?.conversationId ?? null,
    messageId: railThreadPostId,
  });
  const panelThread = useMemo((): BotThreadPanelThread => {
    const sendable = anchorSendable({
      open,
      listed: openThread,
      post: anchorRow,
      threadAnchorKinds,
    });
    const retry = threadListShowsFailure ? () => void refetchThreads() : null;
    // A listed thread, one its post opened and a box that starts one keep
    // what the list last said, the box and its draft through a failed read.
    if (openThread !== null) {
      return { kind: "listed", thread: openThread, retry, sendable };
    }
    if (open !== null && open.sent !== null) {
      return { kind: "posted", threadId: open.sent.threadId, retry, sendable };
    }
    if (open?.announcement === true) {
      return { kind: "unopened", retry, sendable };
    }
    // No thread to show: any failure of the list is drawn.
    if (threadList.isError) {
      return { kind: "failed", retry: () => void refetchThreads() };
    }
    return { kind: "pending" };
  }, [
    anchorRow,
    open,
    openThread,
    refetchThreads,
    threadAnchorKinds,
    threadList.isError,
    threadListShowsFailure,
  ]);
  const presentedThreadId = useReadThreadWhilePresented({
    client,
    botId,
    thread: openThread,
    readCursors,
    shown: threadOpen,
  });
  const presentedChannelId = useReadChannelWhilePresented({
    client,
    botId,
    channelId,
    readCursors,
    threadOpen: railOpen,
    section: channelSection,
  });
  usePublishPresentedBotConversation(
    botId,
    presentedThreadId,
    presentedChannelId,
  );

  const anchorSenderLabel = useCallback(
    (senderUserId: string | null): string =>
      senderUserId === null
        ? "Member"
        : botMemberName(senderUserId, viewer, resolveMember),
    [resolveMember, viewer],
  );

  if (readShowsFailure(conversations)) {
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
    <BotSurfaceCardsContext.Provider value={surfaceCards}>
      <QuoteSinkContext value={quoteIntoChannelBox}>
        <div className="@container flex min-h-0 flex-1">
          <div className="flex min-h-0 w-full">
            <section
              ref={setChannelSection}
              aria-label={botTitle}
              data-testid="bot-channel"
              data-conversation-id={channel.conversationId}
              className={cn(
                "min-h-0 min-w-0 flex-1 flex-col",
                railOpen ? channelBesideRailClass(tiles) : "flex",
              )}
            >
              {/* The message area: where a chosen background tints the
                  channel. The dock below it (the replying strip, the
                  routing card and the box) keeps the page's own. */}
              <div
                data-testid="bot-channel-messages"
                data-channel-background={background.index}
                style={{ "--channel-tint": background.color } as CSSProperties}
                className={cn(
                  "flex min-h-0 flex-1 flex-col",
                  background.className,
                )}
              >
                <ChannelSearchBack
                  botId={botId}
                  shown={search.showing}
                  on="channel"
                />
                <BotExchangeLinesContext value={exchangeLines.channel}>
                  <BotChatTranscript
                    botId={botId}
                    chatId={channel.conversationId}
                    hostId={hostId}
                    title={botTitle}
                    instanceId={`bot-channel:${botId}`}
                    surface={surface}
                    resolveMember={resolveMember}
                    showConnecting
                    header={null}
                    landOn={landing}
                    flow={null}
                  />
                </BotExchangeLinesContext>
              </div>
              <BotReplyingStrip
                botTitle={botTitle}
                activity={trunkReply}
                turn={trunkReplyTurn}
                testId="bot-channel-replying"
              />
              <BotRoutingCard
                botId={botId}
                hostId={hostId}
                sessionChatId={trunkChatId}
              />
              <BotMessageComposer
                // Its draft is the conversation's, kept by it (`channelKeptDraft`).
                key={channel.conversationId}
                botId={botId}
                botTitle={botTitle}
                conversationId={channel.conversationId}
                threadId={null}
                announcementId={null}
                sendable
                imageReach={imageReach}
                placeholder={`Message ${botTitle}`}
                label={`Message ${botTitle}`}
                testId="bot-channel-composer"
                failure={sendFailure}
                edit={edit}
                onEditEnd={endEdit}
                onEditResume={setEdit}
                seed={channelSeed}
                keptDraft={channelKeptDraft}
                quote={quoteFor(null)}
                onSent={openPostedThread}
              />
            </section>
            <ChannelMemoryPane
              tiles={tiles}
              memory={openMemory}
              render={(memory) => (
                <BotMemoryPanel
                  botId={botId}
                  hostId={hostId}
                  environmentId={environmentId}
                  botTitle={botTitle}
                  channelId={channel.conversationId}
                  trunkChatId={trunkChatId}
                  threads={threadList.data?.threads ?? null}
                  botNameOf={botNameOf}
                  back={memory.back}
                  onBack={
                    memory.back === null
                      ? null
                      : () => onOpenThread(memory.back)
                  }
                  onClose={() => onOpenMemory(null)}
                  navigation={memoryNavigation}
                />
              )}
            />
            <ChannelSearchPane
              tiles={tiles}
              open={search.showing === "results"}
              render={() => (
                <BotSearchPanel
                  botId={botId}
                  botTitle={botTitle}
                  hostId={hostId}
                  environmentId={environmentId}
                  onClose={() => closeBotSearch(botId)}
                />
              )}
            />
            <ChannelThreadPane
              tiles={tiles}
              postId={railThreadPostId}
              searchBack={
                <ChannelSearchBack
                  botId={botId}
                  shown={search.showing}
                  on="thread"
                />
              }
              render={(postId) => (
                <BotExchangeLinesContext value={exchangeLines.thread}>
                  <QuoteSinkContext value={quoteIntoThreadBox}>
                    <BotThreadPanel
                      key={postId}
                      botId={botId}
                      hostId={hostId}
                      boundHostId={boundHostId}
                      botTitle={botTitle}
                      imageReach={imageReach}
                      answerReach={answerReach}
                      conversationId={channel.conversationId}
                      originMessageId={postId}
                      sent={open?.sent ?? null}
                      thread={panelThread}
                      tasks={tasks}
                      anchorSenderLabel={anchorSenderLabel}
                      resolveMember={resolveMember}
                      landOn={
                        threadLanding.landing ?? search.threadLandingOn(postId)
                      }
                      onClose={() => {
                        threadLanding.spend();
                        onOpenThread(null);
                      }}
                      onEditPost={editPostFromThread}
                      onOpenTurn={onOpenTurn}
                      onOpenSession={onOpenSession}
                      quote={quoteFor(postId)}
                    />
                  </QuoteSinkContext>
                </BotExchangeLinesContext>
              )}
            />
            <ChannelExchangePane
              tiles={tiles}
              exchange={openExchange}
              render={(exchange) => (
                <BotExchangeLog
                  key={exchange.peerBotId}
                  botId={botId}
                  botTitle={botTitle}
                  peerBotId={exchange.peerBotId}
                  peerName={exchangeLines.peerName(exchange.peerBotId)}
                  entries={exchangeLines.logOf(exchange.peerBotId)}
                  loading={exchangeLines.loading}
                  onClose={exchangeRail.close}
                />
              )}
            />
          </div>
        </div>
      </QuoteSinkContext>
    </BotSurfaceCardsContext.Provider>
  );
}

/**
 * The channel while the rail is open: the rail takes its place on one tile, and
 * sits beside it on two. Either way it stays mounted, so its scroll and its draft
 * are there when the rail closes.
 */
function channelBesideRailClass(tiles: MobileTileCount | null): string {
  if (tiles === null) return "hidden @3xl:flex";
  return tiles === 2 ? "flex" : "hidden";
}

/**
 * The rail's pane. Off the installed app the tab's container places it and the
 * person drags its width; in the installed app the width rule places it, and two
 * tiles split the row equally with nothing to drag.
 */
function railPanePlacement(tiles: MobileTileCount | null): {
  readonly className: string;
  readonly handleClassName: string;
} {
  if (tiles === null) {
    return {
      className:
        "flex min-h-0 min-w-0 flex-1 flex-col @3xl:w-(--bot-pane-width) @3xl:max-w-[60%] @3xl:flex-none @3xl:border-l @3xl:border-border/60",
      handleClassName: "hidden @3xl:block",
    };
  }
  return {
    className: cn(
      "flex min-h-0 min-w-0 flex-1 flex-col",
      tiles === 2 && "border-l border-border/60",
    ),
    handleClassName: "hidden",
  };
}

/** The bot's memory open in the rail; nothing for none (`null`). */
function ChannelMemoryPane(props: {
  readonly tiles: MobileTileCount | null;
  readonly memory: BotOpenMemory | null;
  readonly render: (memory: BotOpenMemory) => ReactNode;
}): ReactNode {
  const { tiles, memory, render } = props;
  if (memory === null) return null;
  return (
    <BotResizablePane
      pane="thread"
      edge="left"
      label="Resize panel"
      {...railPanePlacement(tiles)}
      testId="bot-memory-pane"
    >
      {render(memory)}
    </BotResizablePane>
  );
}

/** A search's results open in the rail; nothing while they are not (`open`). */
function ChannelSearchPane(props: {
  readonly tiles: MobileTileCount | null;
  readonly open: boolean;
  readonly render: () => ReactNode;
}): ReactNode {
  const { tiles, open, render } = props;
  if (!open) return null;
  return (
    <BotResizablePane
      pane="thread"
      edge="left"
      label="Resize search"
      {...railPanePlacement(tiles)}
      testId="bot-search-pane"
    >
      {render()}
    </BotResizablePane>
  );
}

/** The way back to a search's results, while it stands where it is drawn. */
function ChannelSearchBack(props: {
  readonly botId: string;
  readonly shown: BotOpenSearch["showing"]["kind"] | null;
  readonly on: BotOpenSearch["showing"]["kind"];
}): ReactNode {
  const { botId, shown, on } = props;
  if (shown !== on) return null;
  return <BotSearchBackLink onBack={() => showBotSearchResults(botId)} />;
}

/** Whether the rail beside the channel holds a thread, the memory or a pair's log. */
function railHolds(
  threadOpen: boolean,
  memory: BotOpenMemory | null,
  exchange: BotOpenExchange | null,
): boolean {
  return threadOpen || memory !== null || exchange !== null;
}

/** A pair's log open in the rail; nothing for none (`null`). */
function ChannelExchangePane(props: {
  readonly tiles: MobileTileCount | null;
  readonly exchange: BotOpenExchange | null;
  readonly render: (exchange: BotOpenExchange) => ReactNode;
}): ReactNode {
  const { tiles, exchange, render } = props;
  if (exchange === null) return null;
  return (
    <BotResizablePane
      pane="thread"
      edge="left"
      label="Resize panel"
      {...railPanePlacement(tiles)}
      testId="bot-exchange-pane"
    >
      {render(exchange)}
    </BotResizablePane>
  );
}

/**
 * What the channel and its open thread draw of the bot's messages with other
 * bots, and what a pair's log reads: no lines while the feed or the
 * environment's bots are not read yet, so the lines appear once both are.
 */
function useExchangeLines(input: {
  readonly botId: string;
  readonly hostId: string;
  readonly boundHostId: string | null;
  readonly trunkChatId: string;
  readonly environmentBots: ReadonlyArray<BotRecord> | null;
  readonly botTitle: string;
  readonly openPair: (peerBotId: string) => void;
  /** The listed thread open in the rail; `null` for none. */
  readonly openThread: BotThreadSummary | null;
}): {
  readonly channel: BotExchangeLines | null;
  readonly thread: BotExchangeLines | null;
  /** The pair's log: every message between the bot and `peerBotId`, oldest first. */
  readonly logOf: (peerBotId: string) => ReadonlyArray<BotExchangeLogEntry>;
  /** The bot's feed has not handed over its history yet. */
  readonly loading: boolean;
  readonly peerName: (peerBotId: string) => string | null;
} {
  const { environmentBots, botTitle, openPair } = input;
  const openThreadSession = input.openThread?.sessionChatId ?? null;
  const { all, channel, ofSession } = useBotExchanges({
    botId: input.botId,
    hostId: input.hostId,
    boundHostId: input.boundHostId,
    trunkChatId: input.trunkChatId,
  });
  const peerName = useCallback(
    (peerBotId: string): string | null =>
      environmentBots?.find((bot) => bot.botId === peerBotId)?.title ?? null,
    [environmentBots],
  );
  const listed = environmentBots !== null;
  const linesOf = useCallback(
    (exchanges: ReadonlyArray<BotExchange> | null): BotExchangeLines | null =>
      exchanges === null || !listed
        ? null
        : { exchanges, botTitle, peerName, openPair },
    [botTitle, listed, openPair, peerName],
  );
  const channelLines = useMemo(() => linesOf(channel), [channel, linesOf]);
  const threadLines = useMemo(
    () =>
      openThreadSession === null ? null : linesOf(ofSession(openThreadSession)),
    [linesOf, ofSession, openThreadSession],
  );
  const logOf = useCallback(
    (peerBotId: string) => exchangeLogOf(all ?? NO_EXCHANGES, peerBotId),
    [all],
  );
  return {
    channel: channelLines,
    thread: threadLines,
    logOf,
    loading: all === null,
    peerName,
  };
}

/**
 * The thread open in the rail, by its post's id; nothing for none (`null`).
 * `searchBack` is drawn above it.
 */
function ChannelThreadPane(props: {
  readonly tiles: MobileTileCount | null;
  readonly postId: string | null;
  readonly searchBack: ReactNode;
  readonly render: (postId: string) => ReactNode;
}): ReactNode {
  const { tiles, postId, searchBack, render } = props;
  if (postId === null) return null;
  return (
    <BotResizablePane
      pane="thread"
      edge="left"
      label="Resize thread"
      {...railPanePlacement(tiles)}
      testId="bot-thread-pane"
    >
      {searchBack}
      {render(postId)}
    </BotResizablePane>
  );
}

/**
 * Whether the rail takes the channel's place in this pane: a result landed
 * in the channel then needs the channel in front of it.
 */
function channelHiddenBesideRail(
  section: HTMLElement,
  tiles: MobileTileCount | null,
): boolean {
  if (tiles !== null) return tiles === 1;
  return window.getComputedStyle(section).display === "none";
}

/**
 * The search this channel's rail holds, and the result on its way here: one
 * of the channel lands it where it is, and one of a thread opens the thread
 * in the results' place once the list says which post it hangs off, however
 * the channel came to show (a result in another bot switches to it first). A
 * thread no list names cannot open, and its row says so.
 */
function useChannelSearch(args: {
  readonly botId: string;
  readonly tiles: MobileTileCount | null;
  /** The channel's section; `null` until it is drawn. */
  readonly section: HTMLElement | null;
  /** The rail already holds a thread, the memory or a pair's log. */
  readonly railHeld: boolean;
  readonly threadListSupported: boolean;
  readonly threadList: {
    readonly data:
      | { readonly threads: ReadonlyArray<BotThreadSummary> }
      | undefined;
    readonly isError: boolean;
  };
  readonly setLanding: (
    land: (previous: BotTranscriptLanding | null) => BotTranscriptLanding,
  ) => void;
}): {
  /** The rail holds a thread, the memory or a pair's log, or these results. */
  readonly railOpen: boolean;
  /** What of the search is in front, `null` for no search. */
  readonly showing: BotOpenSearch["showing"]["kind"] | null;
  /** The landing a result asked of the thread hanging off `postId`, or `null`. */
  readonly threadLandingOn: (postId: string) => BotTranscriptLanding | null;
} {
  const { botId, tiles, section, threadListSupported, setLanding } = args;
  // `null` while the list is read; a host without threads lists none.
  const threads = threadListSupported
    ? (args.threadList.data?.threads ?? null)
    : EMPTY_THREADS;
  const threadsFailed = args.threadList.isError;
  const rail = useBotRail(botId);
  const open = rail?.kind === "search" ? rail : null;
  const jump = useBotSearchStore((state) =>
    state.jump?.botId === botId ? state.jump : null,
  );
  const threadLanding = useBotSearchStore((state) =>
    state.threadLanding?.botId === botId ? state.threadLanding : null,
  );
  useEffect(() => {
    if (jump === null || open === null) return;
    const { messageId } = jump;
    const search = useBotSearchStore.getState();
    const { setRail } = useBotOpenThreadStore.getState();
    if (jump.threadId === null) {
      if (section === null) return;
      search.spendJump();
      setLanding((previous) => ({
        messageId,
        sendPostId: null,
        visit: (previous?.visit ?? 0) + 1,
      }));
      if (channelHiddenBesideRail(section, tiles)) {
        setRail(botId, {
          kind: "search",
          back: open.back,
          showing: { kind: "channel" },
        });
      }
      return;
    }
    if (threads === null && !threadsFailed) return;
    const listed = threads?.find((thread) => thread.threadId === jump.threadId);
    const anchor = listed?.anchor ?? null;
    if (anchor === null) {
      search.missThread();
      return;
    }
    search.landThread(anchor.messageId, jump);
    setRail(botId, {
      kind: "search",
      back: open.back,
      showing: {
        kind: "thread",
        thread: {
          anchorMessageId: anchor.messageId,
          announcement: false,
          anchorKind: null,
          sent: null,
        },
      },
    });
  }, [botId, jump, open, section, setLanding, threads, threadsFailed, tiles]);
  const showing = open?.showing.kind ?? null;
  return {
    railOpen: args.railHeld || showing === "results",
    showing,
    // A result's landing belongs to the search that opened its thread: once
    // anything else holds the rail (a step back or forward, the memory, a
    // thread opened by hand), the same thread shown again opens where it opens.
    threadLandingOn: (postId) =>
      showing === "thread" && threadLanding?.postId === postId
        ? threadLanding.landing
        : null,
  };
}

/**
 * The trunk answers a direct post at the channel's top level: its running
 * turn is the channel's typing line only while it answers one, so its other
 * work (a routine, a check-in) and a turn whose post is answered draw none.
 */
function channelTrunkReply(
  activity: BotActivity | null,
): BotSessionActivity | null {
  const session = activity?.trunk ?? null;
  return session !== null && session.requestId !== null ? session : null;
}

/**
 * The channel's threads, as the bound host lists them. A thread's unread
 * state and count are the notifications its participants get on each
 * verdict, keyed by the bot and the thread; whoever never wrote in the thread
 * has no such notification and so no count.
 */
function useChannelThreads(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly botId: string;
  readonly hostId: string;
  readonly boundHostId: string | null;
  readonly boundHostEpoch: number;
}): {
  readonly supported: boolean;
  readonly threadList: UseQueryResult<BotThreadListResponse, HostRpcError>;
  readonly threadsByPost: ReadonlyMap<string, BotThreadSummary>;
  readonly isUnread: (threadId: string) => boolean;
  /** `null` where the host does not count. */
  readonly unreadCountOf: (threadId: string) => number | null;
  /** The rows of the bot its host opens their own thread under. */
  readonly threadAnchorKinds: readonly string[];
  /** The person's follows of the threads; `undefined` until read, or where the host keeps none. */
  readonly follows: Readonly<Record<string, BotThreadFollow>> | undefined;
  /** The person's read cursors on the bot; `undefined` until read, or where the host keeps none. */
  readonly readCursors: BotReadCursorReadResponse | undefined;
  /** A thread line's `newReplies`: `null` where the host keeps no read cursors. */
  readonly newRepliesOf: (thread: BotThreadSummary) => boolean | null;
} {
  const { client, botId, hostId, boundHostId, boundHostEpoch } = args;
  const supported = useHostMethodSupport(hostId, "bot.thread.list") === true;
  const threadList = useBotThreadListQuery(client, botId, {
    enabled: supported,
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
    (threadId: string): boolean =>
      Object.hasOwn(indicators.chats, threadId) &&
      indicatorHasUnread(indicators.chats[threadId]),
    [indicators.chats],
  );
  const unreadCountOf = useCallback(
    (threadId: string): number | null =>
      Object.hasOwn(indicators.chats, threadId)
        ? indicators.chats[threadId].unreadCount
        : 0,
    [indicators.chats],
  );
  // Said by the bot's own host, which takes the replies, for the binding it
  // said it under: a host that predates it says nothing, and a list read
  // under an earlier binding - cached, or answered after the bot moved -
  // says nothing for this one until it is read again. A direct reply then
  // opens its post's thread, and any other row of the bot none.
  const anchors = threadList.data?.threadAnchors ?? null;
  const threadAnchorKinds = useMemo(
    () =>
      supported
        ? boundThreadAnchorKinds(anchors, boundHostId, boundHostEpoch)
        : [],
    [anchors, boundHostEpoch, boundHostId, supported],
  );
  const follows = useBotThreadFollows(botId, hostId)?.data?.follows;
  const readCursorQuery = useBotReadCursors(botId, hostId);
  const cursorsKept = readCursorQuery !== null;
  const readCursors = readCursorQuery?.data;
  const levels = useBotNotificationLevelsQuery(
    client,
    botId,
    useHostMethodSupport(hostId, "bot.notificationLevel.read") === true,
  ).data?.levels;
  // A followed thread of a muted channel never has new replies to show
  // (decision 138).
  const newRepliesOf = useCallback(
    (thread: BotThreadSummary): boolean | null =>
      cursorsKept
        ? threadHasNewReplies(
            readCursors,
            thread.threadId,
            followingOf(follows, thread.threadId) !== null &&
              !channelMuted(levels, thread.conversationId),
          )
        : null,
    [cursorsKept, follows, levels, readCursors],
  );
  return {
    supported,
    threadList,
    threadsByPost,
    isUnread,
    unreadCountOf,
    threadAnchorKinds,
    follows,
    readCursors,
    newRepliesOf,
  };
}

/**
 * Whether the person follows a thread without having written in it: they
 * were mentioned in it, or chose to follow it.
 */
function followedUnwritten(
  follows: Readonly<Record<string, BotThreadFollow>> | undefined,
  threadId: string,
): boolean {
  const follow = followingOf(follows, threadId);
  return follow !== null && follow.reason !== "participated";
}

/**
 * Channel row `messageId` as the channel's session holds it; `null` while
 * it holds none, or there is no session or row to read.
 */
function useChannelRow(input: {
  readonly botId: string;
  readonly hostId: string;
  readonly conversationId: string | null;
  readonly messageId: string | null;
}): OpenMessage | null {
  const { conversationId, messageId } = input;
  const handle = useChatSessionHandleForContainer(
    input.botId,
    conversationId ?? "",
    input.hostId,
    conversationId !== null,
  );
  const store = handle?.store ?? null;
  const subscribe = useCallback(
    (onChange: () => void) =>
      store === null ? () => undefined : store.subscribe(onChange),
    [store],
  );
  return useSyncExternalStore(subscribe, () =>
    store === null || messageId === null
      ? null
      : (store
          .getState()
          .messages.find((message) => message.messageId === messageId) ?? null),
  );
}

/**
 * Whether `element` takes up room in the layout, as its size reports;
 * `false` until it has been measured, and where nothing can measure it.
 */
function useDisplayed(element: HTMLElement | null): boolean {
  const [displayed, setDisplayed] = useState(false);
  useEffect(() => {
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) setDisplayed(entry.contentRect.width > 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return element !== null && displayed;
}

/**
 * Advances the channel's read cursor while the person can see it: the channel
 * transcript presented in the pane on screen, in a window they are in, has been
 * read. The channel it presents, or `null`.
 */
function useReadChannelWhilePresented(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly botId: string;
  readonly channelId: string | null;
  readonly readCursors: BotReadCursorReadResponse | undefined;
  readonly threadOpen: boolean;
  /** The channel's section: beside an open thread a container query hides it on a narrow pane, which only its size tells. */
  readonly section: HTMLElement | null;
}): string | null {
  const { client, botId, channelId, threadOpen, section } = args;
  const displayed = useDisplayed(section);
  const presented = usePresented(!threadOpen || displayed);
  useAdvanceWhilePresented({
    client,
    botId,
    conversationId: channelId,
    readCursors: args.readCursors,
    presented,
  });
  return presented ? channelId : null;
}

/**
 * Advances the open thread's read cursor while the person can see it: its panel
 * is shown in the pane on screen, in a window they are in. The thread it
 * presents, or `null`.
 */
function useReadThreadWhilePresented(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly botId: string;
  readonly thread: BotThreadSummary | null;
  readonly readCursors: BotReadCursorReadResponse | undefined;
  /** The thread panel is rendered. */
  readonly shown: boolean;
}): string | null {
  const { client, botId, thread, shown } = args;
  const presented = usePresented(shown);
  const threadId = thread?.threadId ?? null;
  useAdvanceWhilePresented({
    client,
    botId,
    conversationId: threadId,
    readCursors: args.readCursors,
    presented,
  });
  return presented ? threadId : null;
}

/** Quotes waiting for their box, by the thread's post; `null` for the channel's. */
type PendingQuotes = ReadonlyMap<string | null, BotComposerQuote>;

/**
 * A quote goes into the box of the conversation it was selected in: the
 * channel's for a selection of the channel, the thread's for a selection of
 * the thread beside it, whichever box holds the caret. The box adds it after
 * what it shows and hands it back once it has.
 */
function useBoxQuotes(openPostId: string | null): {
  readonly quoteIntoChannelBox: QuoteSink;
  /** The sink of the open thread's transcript, drawn only while one is open. */
  readonly quoteIntoThreadBox: QuoteSink;
  /** The quotes waiting for the box of the thread `postId`; `null` for the channel's. */
  readonly quoteFor: (postId: string | null) => BotComposerQuote | null;
} {
  const quoteCount = useRef(0);
  const [pendingQuotes, setPendingQuotes] = useState<PendingQuotes>(
    () => new Map(),
  );
  const quoteInto = useCallback(
    (postId: string | null, snapshot: QuoteTextSnapshot): void => {
      quoteCount.current += 1;
      const id = quoteCount.current;
      const taken = (): void =>
        setPendingQuotes((current) => {
          if (current.get(postId)?.id !== id) return current;
          const next = new Map(current);
          next.delete(postId);
          return next;
        });
      setPendingQuotes((current) => {
        const earlier = current.get(postId)?.snapshots ?? [];
        return new Map(current).set(postId, {
          id,
          snapshots: [...earlier, snapshot],
          taken,
        });
      });
      clearBrowserSelection();
    },
    [],
  );
  const quoteIntoChannelBox = useCallback<QuoteSink>(
    (_chatId, snapshot) => quoteInto(null, snapshot),
    [quoteInto],
  );
  const quoteIntoThreadBox = useCallback<QuoteSink>(
    (_chatId, snapshot) => quoteInto(openPostId, snapshot),
    [quoteInto, openPostId],
  );
  return {
    quoteIntoChannelBox,
    quoteIntoThreadBox,
    quoteFor: (postId) => pendingQuotes.get(postId) ?? null,
  };
}
