import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  BotConversationRecord,
  BotConversationSendResponse,
  BotThreadListResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotSurfaceActionState,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { OpenMessage } from "@traycer/protocol/persistence/epic/open-harness-records";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { ChatBotThreadLine } from "@/components/chat/chat-bot-presentation-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import {
  BotChatTranscript,
  type BotTranscriptLanding,
  type BotTranscriptSurface,
  type QuestionAnswerSend,
} from "@/components/bots/bot-chat-transcript";
import { BotRoutingCard } from "@/components/bots/bot-routing-card";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import { threadOpenOf } from "@/lib/bots/bot-trunk-model";
import {
  BotMemoryPanel,
  type BotMemoryNavigation,
} from "@/components/bots/bot-memory-panel";
import {
  BotMessageComposer,
  type BotComposerEdit,
} from "@/components/bots/bot-message-composer";
import { useBotSendFailure } from "@/hooks/bots/use-bot-send-failure";
import { BotReadFailure } from "@/components/bots/bot-read-failure";
import { BotReplyingStrip } from "@/components/bots/bot-replying-strip";
import { BotResizablePane } from "@/components/bots/bot-resizable-pane";
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
import { useBotSurfaceActMutation } from "@/hooks/bots/use-bot-surface-act";
import {
  BotSurfaceCardsContext,
  type BotSurfaceCards,
} from "@/components/bots/bot-surface-card-context";
import { useBotSendTakesAnswers } from "@/hooks/bots/use-bot-send-version";
import { useBotFailedRequest } from "@/hooks/bots/use-bot-failed-request";
import {
  failedOnRequest,
  useBotActivity,
  type BotActivity,
  type BotSessionActivity,
} from "@/hooks/bots/use-bot-activity";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { useNotificationMarkEntityRead } from "@/hooks/notifications/use-notification-mark-entity-read-mutation";
import { indicatorHasUnread } from "@/stores/notifications/notification-indicator-state";
import {
  botMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";
import { isDocumentFocused } from "@/lib/notifications/notification-presence";
import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import type {
  BotOpenMemory,
  BotOpenThread,
  BotSessionOpen,
  BotTurnOpen,
} from "@/stores/bots/bot-open-thread-store";
import { useAuthStore, type AuthProfile } from "@/stores/auth/auth-store";
import type { StackedIdentity } from "@/components/bots/bot-avatars";
import { cn } from "@/lib/utils";

const EMPTY_THREADS: ReadonlyArray<BotThreadSummary> = [];
const NO_EPIC_IDS: ReadonlyArray<string> = [];
const NO_CHAT_IDS: ReadonlyArray<string> = [];

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
 * Where the channel lands as it opens: a message of the channel
 * (`threadId` `null`), or of the listed thread `threadId`, in that thread's
 * panel beside it.
 */
export type BotChannelLanding = BotTranscriptLanding & {
  readonly threadId: string | null;
};

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
 * The rail beside the channel is one slot: a thread, or the bot's memory,
 * which takes the thread's place and brings it back from its header. A
 * reply's receipt, in the channel or in the thread (Tracy Bots T86), opens
 * the turn's session in place of the channel (T93). The trunk's routing card sits above the channel's
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
  /** Opens the bot's Activity tab, from the open thread's header. */
  readonly onOpenActivity: () => void;
  /** A live team main bot's setup history at the top of the channel (T67b); `null` for none. */
  readonly setupHistory: ReactNode;
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
    onOpenActivity,
    setupHistory,
  } = props;
  const openThreadPostId = open?.anchorMessageId ?? null;
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
    unreadCountOf,
    threadAnchorKinds,
  } = useChannelThreads({
    client,
    botId,
    hostId,
    boundHostId,
    boundHostEpoch,
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
  const channelId = channel?.conversationId ?? null;
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
        { onError: failSend },
      );
    },
    [botId, channelId, clearSendFailure, failSend, send],
  );
  // A question card's answer or Skip, on a question the bot asked at the
  // channel's top level: the person's message goes to the bot itself and
  // opens no thread. A send that fails says so where a failed message does,
  // and the card keeps the person's draft. A host that cannot take the
  // answer gets a card without actions.
  const answersTaken = useBotSendTakesAnswers(hostId);
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
        { onError: failSend },
      );
    },
    [botId, channelId, clearSendFailure, failSend, sendAsync],
  );

  // A post the bot failed to answer, in a thread or at the top level, is
  // retried as it is or edited in the channel's box, which posts its
  // replacement.
  const [edit, setEdit] = useState<BotComposerEdit | null>(null);
  const endEdit = useCallback(() => setEdit(null), []);
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
    [onOpenThread],
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
    (response: BotConversationSendResponse, text: string): boolean => {
      if (response.threadId === null || !threadListSupported) return false;
      onOpenThread({
        anchorMessageId: response.messageId,
        announcement: false,
        anchorKind: null,
        sent: {
          threadId: response.threadId,
          requestId: response.requestId,
          text,
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
      answerQuestion: answersTaken ? answerQuestion : null,
      discussQuestion,
      failedRequest,
      openTurn: onOpenTurn,
      sessionChatId: trunkChatId,
      intro: { botTitle, directive },
      history: setupHistory,
    }),
    [
      answerQuestion,
      answersTaken,
      botTitle,
      activity?.threads,
      chooseOption,
      directive,
      discussQuestion,
      failedRequest,
      isUnread,
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

  const surfaceCards = useSurfaceCards({
    client,
    hostId,
    botId,
    viewer,
    resolveMember,
    tasks,
    surfaceActions,
  });

  const trunkReply = channelTrunkReply(activity);

  // The rail holds one of a thread or the memory: the memory open leaves no
  // thread open (`open` is `null`).
  const railThreadPostId = threadListSupported ? openThreadPostId : null;
  const threadOpen = railThreadPostId !== null;
  const railOpen = threadOpen || openMemory !== null;
  const openThread =
    openThreadPostId === null
      ? null
      : (threadsByPost.get(openThreadPostId) ?? null);
  const threadLanding = useThreadPanelLanding(
    props.landOn,
    drawnPanelThreadId({
      channelReadFailed: conversations.isError,
      channel,
      threadOpen,
      openThread,
    }),
  );
  const { refetch: refetchThreads } = threadList;
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
    const retry = threadList.isError ? () => void refetchThreads() : null;
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
    if (retry !== null) return { kind: "failed", retry };
    return { kind: "pending" };
  }, [
    anchorRow,
    open,
    openThread,
    refetchThreads,
    threadAnchorKinds,
    threadList.isError,
  ]);
  useReadThreadWhilePresented({
    client,
    botId,
    thread: openThread,
    isUnread,
    shown: threadOpen,
  });
  const [channelSection, setChannelSection] = useState<HTMLElement | null>(
    null,
  );
  useReadChannelWhilePresented({
    client,
    hostId,
    botId,
    channelId,
    threadOpen: railOpen,
    section: channelSection,
  });

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
    <BotSurfaceCardsContext.Provider value={surfaceCards}>
      <div className="@container flex min-h-0 flex-1">
        <div className="flex min-h-0 w-full">
          <section
            ref={setChannelSection}
            aria-label={botTitle}
            data-testid="bot-channel"
            data-conversation-id={channel.conversationId}
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col",
              railOpen ? "hidden @3xl:flex" : "flex",
            )}
          >
            <BotChatTranscript
              botId={botId}
              chatId={channel.conversationId}
              hostId={hostId}
              title={botTitle}
              instanceId={`bot-channel:${botId}`}
              surface={surface}
              resolveMember={resolveMember}
              showConnecting
              landOn={landing}
            />
            <BotReplyingStrip
              botTitle={botTitle}
              activity={trunkReply}
              testId="bot-channel-replying"
            />
            <BotRoutingCard
              botId={botId}
              hostId={hostId}
              sessionChatId={trunkChatId}
            />
            <BotMessageComposer
              botId={botId}
              conversationId={channel.conversationId}
              threadId={null}
              announcementId={null}
              sendable
              placeholder={`Message ${botTitle}`}
              label={`Message ${botTitle}`}
              testId="bot-channel-composer"
              failure={sendFailure}
              edit={edit}
              onEditEnd={endEdit}
              seed={null}
              keptDraft={null}
              onSent={openPostedThread}
            />
          </section>
          <ChannelMemoryPane
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
                  memory.back === null ? null : () => onOpenThread(memory.back)
                }
                onClose={() => onOpenMemory(null)}
                navigation={memoryNavigation}
              />
            )}
          />
          <ChannelThreadPane
            postId={railThreadPostId}
            render={(postId) => (
              <BotThreadPanel
                key={postId}
                botId={botId}
                hostId={hostId}
                boundHostId={boundHostId}
                botTitle={botTitle}
                conversationId={channel.conversationId}
                originMessageId={postId}
                sent={open?.sent ?? null}
                thread={panelThread}
                tasks={tasks}
                anchorSenderLabel={anchorSenderLabel}
                resolveMember={resolveMember}
                landOn={threadLanding.landing}
                onClose={() => {
                  threadLanding.spend();
                  onOpenThread(null);
                }}
                onOpenActivity={onOpenActivity}
                onEditPost={editPostFromThread}
                onOpenTurn={onOpenTurn}
                onOpenSession={onOpenSession}
              />
            )}
          />
        </div>
      </div>
    </BotSurfaceCardsContext.Provider>
  );
}

/**
 * What a surface post's card reads and sends (T89): each task's open
 * surfaces and the viewer's forwarded actions from the bot's subscription,
 * and the send through the tab's host, which offers it only where that host
 * takes it.
 */
function useSurfaceCards(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly botId: string;
  readonly viewer: AuthProfile | null;
  readonly resolveMember: BotMemberResolver;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly surfaceActions: ReadonlyArray<BotSurfaceActionState> | null;
}): BotSurfaceCards {
  const {
    client,
    hostId,
    botId,
    viewer,
    resolveMember,
    tasks,
    surfaceActions,
  } = args;
  const actSupported = useHostMethodSupport(hostId, "bot.surface.act") === true;
  const { mutateAsync: actAsync } = useBotSurfaceActMutation(client);
  return useMemo<BotSurfaceCards>(
    () => ({
      botId,
      viewerUserId: viewer?.userId ?? null,
      memberName: (userId) => botMemberName(userId, viewer, resolveMember),
      openSurfaces: (taskId) =>
        tasks.find((task) => task.taskId === taskId)?.inputNeeded ?? null,
      hostAction: (actionId) =>
        surfaceActions?.find((action) => action.actionId === actionId) ?? null,
      postActions: (messageId) =>
        surfaceActions?.filter((action) => action.messageId === messageId) ??
        [],
      act: actSupported && client !== null ? actAsync : null,
    }),
    [
      actAsync,
      actSupported,
      botId,
      client,
      resolveMember,
      surfaceActions,
      tasks,
      viewer,
    ],
  );
}

/** The bot's memory open in the rail; nothing for none (`null`). */
function ChannelMemoryPane(props: {
  readonly memory: BotOpenMemory | null;
  readonly render: (memory: BotOpenMemory) => ReactNode;
}): ReactNode {
  const { memory, render } = props;
  if (memory === null) return null;
  return (
    <BotResizablePane
      pane="thread"
      edge="left"
      label="Resize panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col @3xl:w-(--bot-pane-width) @3xl:max-w-[60%] @3xl:flex-none @3xl:border-l @3xl:border-border/60"
      handleClassName="hidden @3xl:block"
      testId="bot-memory-pane"
    >
      {render(memory)}
    </BotResizablePane>
  );
}

/** The thread open in the rail, by its post's id; nothing for none (`null`). */
function ChannelThreadPane(props: {
  readonly postId: string | null;
  readonly render: (postId: string) => ReactNode;
}): ReactNode {
  const { postId, render } = props;
  if (postId === null) return null;
  return (
    <BotResizablePane
      pane="thread"
      edge="left"
      label="Resize thread"
      className="flex min-h-0 min-w-0 flex-1 flex-col @3xl:w-(--bot-pane-width) @3xl:max-w-[60%] @3xl:flex-none @3xl:border-l @3xl:border-border/60"
      handleClassName="hidden @3xl:block"
      testId="bot-thread-pane"
    >
      {render(postId)}
    </BotResizablePane>
  );
}

/**
 * Who is in a thread, as its line under the post stacks them: the post's
 * writer, and the bot once the thread has a reply.
 */
function threadParticipants(
  thread: BotThreadSummary,
  viewer: AuthProfile | null,
  resolveMember: BotMemberResolver,
): ReadonlyArray<StackedIdentity> {
  const writerId = thread.anchor?.senderUserId ?? null;
  const writer: ReadonlyArray<StackedIdentity> =
    writerId === null
      ? []
      : [
          {
            kind: "person",
            userId: writerId,
            name: botMemberName(writerId, viewer, resolveMember),
            avatarUrl: resolveMember(writerId)?.avatarUrl ?? null,
          },
        ];
  return thread.replyCount > 0 ? [...writer, { kind: "bot" }] : writer;
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
      supported &&
      anchors !== null &&
      anchors.hostId === boundHostId &&
      anchors.epoch === boundHostEpoch
        ? anchors.kinds
        : [],
    [anchors, boundHostEpoch, boundHostId, supported],
  );
  return {
    supported,
    threadList,
    threadsByPost,
    isUnread,
    unreadCountOf,
    threadAnchorKinds,
  };
}

/**
 * Whether the open thread's box takes a send. The anchor's row says which
 * row the thread hangs off once the channel has it, whatever opened the
 * thread (a memory's link and a session's "Open thread" name the anchor
 * only): a row of the bot takes a send only while the bot's binding names
 * it among the rows a thread roots on. An open that names its kind, or was
 * made from its row (a box under a question, a proposal or a direct post),
 * and a post being sent go by what they say. A thread opened by its anchor
 * alone takes none until the channel's row or the thread list says a
 * member wrote the anchor.
 */
function anchorSendable(input: {
  readonly open: BotOpenThread | null;
  readonly listed: BotThreadSummary | null;
  readonly post: OpenMessage | null;
  readonly threadAnchorKinds: readonly string[];
}): boolean {
  const { open, post } = input;
  const kind =
    post === null ? (open?.anchorKind ?? null) : threadOpenOf(post).anchorKind;
  if (kind !== null) return input.threadAnchorKinds.includes(kind);
  if (post !== null) return true;
  if (open !== null && (open.sent !== null || open.announcement)) return true;
  const anchor = input.listed?.anchor ?? null;
  return anchor !== null && anchor.senderUserId !== null;
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
 * Whether the person can see a surface that is `shown`: it is in the pane on
 * screen, in a window they are in.
 */
function usePresented(shown: boolean): boolean {
  const paneVisible = usePaneVisible();
  const windowForeground = useSyncExternalStore(
    subscribeWindowForeground,
    readWindowForeground,
  );
  return shown && paneVisible && windowForeground;
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
 * Marks the channel read while the person can see it: a direct reply that
 * answered their post lights the channel's unread mark, as a verdict lights
 * its thread's (T52), and the channel transcript presented in the pane on
 * screen, in a window they are in, has been read.
 */
function useReadChannelWhilePresented(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly botId: string;
  readonly channelId: string | null;
  readonly threadOpen: boolean;
  /** The channel's section: beside an open thread a container query hides it on a narrow pane, which only its size tells. */
  readonly section: HTMLElement | null;
}): void {
  const { client, hostId, botId, channelId, threadOpen, section } = args;
  const displayed = useDisplayed(section);
  const chatIds = useMemo(
    () => (channelId === null ? NO_CHAT_IDS : [channelId]),
    [channelId],
  );
  const chatEpicIds = useMemo(
    () => (channelId === null ? {} : { [channelId]: botId }),
    [botId, channelId],
  );
  const indicators = useNotificationIndicators({
    hostId,
    epicIds: NO_EPIC_IDS,
    chatIds,
    chatEpicIds,
    enabled: channelId !== null,
  });
  const presented = usePresented(!threadOpen || displayed);
  const state =
    channelId !== null && Object.hasOwn(indicators.chats, channelId)
      ? indicators.chats[channelId]
      : null;
  const unread = state !== null && indicatorHasUnread(state);
  const { mutate: markRead } = useNotificationMarkEntityRead(client);
  useEffect(() => {
    if (!presented || channelId === null || !unread) return;
    markRead({ epicId: botId, chatId: channelId });
  }, [botId, channelId, markRead, presented, unread]);
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
  const presented = usePresented(shown);
  const threadId = thread?.threadId ?? null;
  const unread = threadId !== null && isUnread(threadId);
  const { mutate: markRead } = useNotificationMarkEntityRead(client);
  useEffect(() => {
    if (!presented || threadId === null || !unread) return;
    markRead({ epicId: botId, chatId: threadId });
  }, [botId, markRead, presented, threadId, unread]);
}
