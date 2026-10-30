import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  hashKey,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { botMutationKeys } from "@/lib/query-keys/bot-mutation-keys";
import type { TranscriptRowLocator } from "@traycer/protocol/persistence/chat-transcript/locate-row";
import { useChatLocateRowAnswer } from "@/hooks/chats/use-chat-locate-row";
import {
  replyFollowsPost,
  replyRowIdFor,
  sendCardFor,
} from "@/lib/bots/reply-row";
import { botTurnIndexOf, turnOfMessages } from "@/lib/bots/bot-turn-receipt";
import type { BotTurnRef } from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useBotTurnLocateQuery } from "@/hooks/bots/use-bot-turn-locate-query";
import { useBotFailedRecovery } from "@/components/bots/bot-failed-recovery";
import type { BotTurnOpen } from "@/stores/bots/bot-open-thread-store";
import type { ChatMessage } from "@/stores/composer/chat-store";
import {
  botMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BotChannelIntro } from "@/components/bots/bot-channel-intro";
import { ChatTimelineHeaderContext } from "@/components/chat/chat-timeline-header-context";
import {
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import {
  ChatBotPresentationContext,
  type ChatBotFailedRequest,
  type ChatBotPresentation,
  type ChatBotThreadLine,
  type ChatBotTurnReceipt,
} from "@/components/chat/chat-bot-presentation-context";
import type { QuestionCardAnswer } from "@/components/chat/question-card";
import { ChatContainerContext } from "@/components/chat/chat-container-context";
import { TasklessMarkdownLinkProvider } from "@/components/chat/chat-markdown-link-provider";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TileErrorBoundary } from "@/components/epic-canvas/renderers/tile-error-boundary";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBotSessionMessages } from "@/hooks/bots/use-bot-session-messages";
import {
  isWindowedTranscript,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";

/**
 * What a bot chat is to the person reading it: the bot's channel or one of
 * its threads.
 */
export type BotTranscriptSurface =
  | {
      readonly kind: "channel";
      /** The thread line under a post, by the post's message id. */
      readonly threadLine: (postMessageId: string) => ChatBotThreadLine | null;
      /** Opens a post's thread; `null` where threads cannot be opened. */
      readonly openThread: ((postMessageId: string) => void) | null;
      /** Opens the thread under a question, a proposal, a direct post or another row of the bot; `null` where threads cannot be opened. */
      readonly openAnnouncementThread:
        | ((announcementId: string, anchorKind: string | null) => void)
        | null;
      /** The rows of the bot its host opens their own thread under. */
      readonly threadAnchorKinds: readonly string[];
      /** Posts a direct reply's chosen option as a new post; `null` while one is being sent. */
      readonly chooseOption: ((choice: string) => void) | null;
      /** Sends a question card's answer at the channel's top level; `null` where nothing can send it. */
      readonly answerQuestion: QuestionAnswerSend | null;
      /** Opens a question's thread with the person's draft in its box; `null` where threads cannot be opened. */
      readonly discussQuestion:
        | ((questionMessageId: string, draft: string) => void)
        | null;
      /** A post the bot failed to answer, by its request id and writer, and what can be done about it. */
      readonly failedRequest: (
        requestId: string,
        senderUserId: string | null,
      ) => ChatBotFailedRequest | null;
      /** Opens a turn of the bot, its session landed on it; `null` where nothing can show one. */
      readonly openTurn: BotTurnOpen | null;
      /** The session that answers the channel (the trunk), whose failed turn the agent chat's actions recover. */
      readonly sessionChatId: string | null;
      /** What the top of the channel says while nobody has written in it. */
      readonly intro: {
        readonly botTitle: string;
        readonly directive: string | null;
      };
      /**
       * A live team main bot's setup history (T67b), above every post and in
       * place of the intro; `null` for any other channel.
       */
      readonly history: ReactNode;
    }
  | {
      readonly kind: "thread";
      /** Posts a reply's chosen option in the thread; `null` while one is being sent. */
      readonly chooseOption: ((choice: string) => void) | null;
      /** Sends a question card's answer in the thread; `null` where the thread takes no send. */
      readonly answerQuestion: QuestionAnswerSend | null;
      /** Puts the person's draft in the thread's box, unsent. */
      readonly discussQuestion:
        | ((questionMessageId: string, draft: string) => void)
        | null;
      /** A message the bot failed to answer, by its request id and writer, and what can be done about it. */
      readonly failedRequest: (
        requestId: string,
        senderUserId: string | null,
      ) => ChatBotFailedRequest | null;
      /** Opens a turn of the bot, its session landed on it; `null` where nothing can show one. */
      readonly openTurn: BotTurnOpen | null;
      /** The thread's session, whose failed turn the agent chat's actions recover; `null` while not known. */
      readonly sessionChatId: string | null;
    };

/**
 * Sends a question card's answer or Skip to the question on the row
 * `questionMessageId`: resolves once the host takes it, rejects when not.
 */
export type QuestionAnswerSend = (
  questionMessageId: string,
  answer: QuestionCardAnswer,
) => Promise<void>;

const CHAT_NOT_VISIBLE_CODE = "CHAT_NOT_VISIBLE";

/**
 * Per query client, per chat, the newest successful `bot.conversation.send`
 * by the cache's mutation id, which only grows. Recorded as the success
 * happens, whether or not a transcript is mounted, and kept after the cache
 * drops the mutation (five minutes unobserved): the session registry keeps a
 * closed channel's handle longer than that.
 */
const newestSendByClient = new WeakMap<QueryClient, Map<string, number>>();
const sendLedgerListeners = new Set<() => void>();
const CONVERSATION_SEND_KEY = hashKey(botMutationKeys.conversationSend());

function conversationIdOf(variables: unknown): string | null {
  if (typeof variables !== "object" || variables === null) return null;
  if (!("conversationId" in variables)) return null;
  return typeof variables.conversationId === "string"
    ? variables.conversationId
    : null;
}

/** The ledger of `queryClient`, which listens to its mutation cache from its first read. */
function sendLedgerOf(queryClient: QueryClient): Map<string, number> {
  const existing = newestSendByClient.get(queryClient);
  if (existing !== undefined) return existing;
  const ledger = new Map<string, number>();
  newestSendByClient.set(queryClient, ledger);
  queryClient.getMutationCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const { mutation } = event;
    if (mutation.state.status !== "success") return;
    if (hashKey(mutation.options.mutationKey ?? []) !== CONVERSATION_SEND_KEY) {
      return;
    }
    const chatId = conversationIdOf(mutation.state.variables);
    if (chatId === null) return;
    if ((ledger.get(chatId) ?? -1) >= mutation.mutationId) return;
    ledger.set(chatId, mutation.mutationId);
    for (const listener of [...sendLedgerListeners]) listener();
  });
  return ledger;
}

function subscribeSendLedger(listener: () => void): () => void {
  sendLedgerListeners.add(listener);
  return () => sendLedgerListeners.delete(listener);
}

/** The newest successful send to `chatId`; `null` for none. */
function useNewestSendTo(chatId: string): number | null {
  const ledger = sendLedgerOf(useQueryClient());
  return useSyncExternalStore(
    subscribeSendLedger,
    () => ledger.get(chatId) ?? null,
  );
}

/** The sends one session handle has counted, and whether one is still owed. */
interface SendMarker {
  counted: number | null;
  owed: boolean;
}

/**
 * Kept with the session handle the registry retains, not with the view: a
 * send that succeeds while the transcript is unmounted (the tab showing
 * another panel) is still owed when it comes back to the same closed session.
 */
const sendMarkers = new WeakMap<ChatSessionStoreHandle, SendMarker>();

/**
 * Re-subscribes once a send to `chatId` succeeds while the view `waiting`
 * on a chat the host had not created: the send is the write that creates it.
 * A send that lands while the subscription is still connecting, or while the
 * view is unmounted, is owed to the first close after it; one the live view
 * has caught up with is owed nothing. Sends from before the session handle
 * was first shown are not counted.
 */
function useResubscribeOnNextSend(input: {
  readonly handle: ChatSessionStoreHandle;
  readonly chatId: string;
  readonly waiting: boolean;
  readonly caughtUp: boolean;
  readonly retry: () => void;
}): void {
  const { handle, chatId, waiting, caughtUp, retry } = input;
  const newestSend = useNewestSendTo(chatId);
  useEffect(() => {
    let marker = sendMarkers.get(handle);
    if (marker === undefined) {
      marker = { counted: newestSend, owed: false };
      sendMarkers.set(handle, marker);
    }
    if (
      newestSend !== null &&
      (marker.counted === null || newestSend > marker.counted)
    ) {
      marker.counted = newestSend;
      marker.owed = true;
    }
    if (caughtUp) {
      marker.owed = false;
      return;
    }
    if (!waiting || !marker.owed) return;
    marker.owed = false;
    retry();
  }, [caughtUp, handle, newestSend, retry, waiting]);
}

/**
 * A bot chat's transcript (Tracy Bots): the conversation a person has with
 * the bot, or the bot's own trunk, read through the chat session the tab host
 * serves. The container is the BOT - its id is the `epicId` every bot chat
 * is keyed by on the host - and only the bound host serves it, which is why
 * the tab this renders in is bound to that host.
 *
 * This is the existing chat view, not a new one: the same session store,
 * the same row renderer, the same virtualised list. What it leaves out is
 * the Epic tile's chrome (composer, dock, restore, plan actions), because a
 * bot chat has none of those.
 *
 * `surface` says what the chat is to the person. A channel and a thread
 * draw their rows in Slack's layout: a channel post carries the line that
 * opens its thread, every channel row that can take a thread offers "Reply
 * in thread" on hover, and a thread's answered message jumps to the reply in
 * this list that answered it. `null` is one of the bot's own sessions (the
 * trunk, a thread's session): the plain transcript, read-only.
 *
 * `resolveMember` names and pictures the members whose messages the chat
 * carries; a member it does not know shows as their user id.
 *
 * `showConnecting` holds the transcript's place with a spinner while its
 * session connects; without it nothing is drawn until then, for a thread
 * with no reply yet whose box follows its post.
 *
 * A channel or thread draws, under each reply of the bot and under a post it
 * failed to answer, the receipt of the turn behind it (Tracy Bots T86), as
 * the bound host names the turns (`bot.turn.locate`); the receipt opens the
 * turn's session, read-only and landed on the turn (T93), through the
 * surface. A post its session failed on, where that session
 * names the post's turn as its last failed attempt, says so with the agent
 * chat's reason and actions.
 */
export function BotChatTranscript(props: {
  readonly botId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly title: string;
  readonly instanceId: string;
  readonly surface: BotTranscriptSurface | null;
  readonly resolveMember: BotMemberResolver;
  readonly showConnecting: boolean;
  /** A message the list lands on once it loads; `null` keeps where it opens. */
  readonly landOn: BotTranscriptLanding | null;
}): ReactNode {
  const { botId, chatId, hostId, title, instanceId, surface, resolveMember } =
    props;
  const handle = useChatSessionHandleForContainer(botId, chatId, hostId, true);
  if (handle === null) {
    if (!props.showConnecting) return null;
    return (
      <div
        className="flex flex-1 items-center justify-center py-10 text-muted-foreground"
        aria-busy="true"
        data-testid="bot-chat-transcript-connecting"
      >
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }
  return (
    <TileErrorBoundary instanceId={instanceId} resetKey={chatId}>
      <BotChatTranscriptBody
        handle={handle}
        botId={botId}
        chatId={chatId}
        hostId={hostId}
        title={title}
        instanceId={instanceId}
        surface={surface}
        resolveMember={resolveMember}
        landOn={props.landOn}
      />
    </TileErrorBoundary>
  );
}

type ChannelIntro = Extract<BotTranscriptSurface, { kind: "channel" }>["intro"];

/**
 * A channel nobody has written in opens with what it is for, as Slack's
 * does; a windowed one is empty only when the host counts no row. `null`
 * on a thread, before the snapshot, and once the channel has a row.
 */
/** The setup history a channel surface keeps at its top; `null` elsewhere. */
function channelHistoryOf(surface: BotTranscriptSurface | null): ReactNode {
  return surface?.kind === "channel" ? surface.history : null;
}

/** An empty channel's first screen: its setup history, or else its intro. */
function BotChannelOpening(props: {
  readonly history: ReactNode;
  readonly intro: ChannelIntro;
}): ReactNode {
  return (
    props.history ?? (
      <BotChannelIntro
        botTitle={props.intro.botTitle}
        directive={props.intro.directive}
      />
    )
  );
}

function channelIntro(
  surface: BotTranscriptSurface | null,
  snapshotLoaded: boolean,
  renderedRows: number,
  transcriptWindow: { readonly rowCount: number } | null,
): ChannelIntro | null {
  if (surface?.kind !== "channel" || !snapshotLoaded) return null;
  if (renderedRows > 0) return null;
  if (transcriptWindow !== null && transcriptWindow.rowCount > 0) return null;
  return surface.intro;
}

function BotChatTranscriptBody(props: {
  readonly handle: ChatSessionStoreHandle;
  readonly botId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly title: string;
  readonly instanceId: string;
  readonly surface: BotTranscriptSurface | null;
  readonly resolveMember: BotMemberResolver;
  readonly landOn: BotTranscriptLanding | null;
}): ReactNode {
  const {
    handle,
    botId,
    chatId,
    hostId,
    title,
    instanceId,
    surface,
    resolveMember,
    landOn,
  } = props;
  const { state, messages } = useBotSessionMessages({
    handle,
    botId,
    chatId,
    viewTabId: instanceId,
    resolveMember,
  });
  // A host that creates the channel chat only on its first post answers a
  // subscribe before it with CHAT_NOT_VISIBLE: the channel is empty, not
  // broken, so it is drawn empty, and the next post sent to it re-subscribes.
  const channelNotHereYet =
    surface?.kind === "channel" &&
    state.fatalClose?.code === CHAT_NOT_VISIBLE_CODE;
  useResubscribeOnNextSend({
    handle,
    chatId,
    waiting: channelNotHereYet,
    caughtUp: state.snapshotLoaded && state.fatalClose === null,
    retry: state.retry,
  });
  const profile = useAuthStore((s) => s.profile);
  const tabClient = useTabHostClient();
  const subagentDrillIn = useSubagentDrillIn(state.snapshotLoaded);

  // "See reply" names the reply's MESSAGE id; the list lands by RENDERED ROW
  // key, so the id is resolved to the row that renders it (see
  // `replyRowIdFor`). A reply outside the hydrated window has no row yet: the
  // id is held as pending, the host locates its ordinal, the store hydrates
  // around it (`requestTranscriptOrdinal`), and the scroll is issued the
  // moment the row renders.
  // Requests are numbered past every one issued, settled ones included: the
  // list drops a request whose id it has handled, and a settled request is
  // cleared.
  const [scroll, setScroll] = useState<{
    readonly request: ChatMessageScrollRequest | null;
    readonly issued: number;
  }>({ request: null, issued: 0 });
  const scrollRequest = scroll.request;
  const [pendingJump, setPendingJump] = useState<PendingJump | null>(null);
  const issueScroll = useCallback(
    (target: { readonly rowId: string; readonly blockId: string | null }) => {
      setScroll((previous) => ({
        request: {
          kind: "message",
          messageId: target.rowId,
          blockId: target.blockId,
          requestId: previous.issued + 1,
        },
        issued: previous.issued + 1,
      }));
    },
    [],
  );
  const jumpTo = useCallback(
    (jump: PendingJump) => {
      const target = jumpTargetIn(messages, jump);
      if (target !== null) {
        setPendingJump(null);
        issueScroll(target);
        return;
      }
      setPendingJump(jump);
    },
    [issueScroll, messages],
  );
  const scrollToMessage = useCallback(
    (messageId: string) => jumpTo({ kind: "message", messageId }),
    [jumpTo],
  );
  const land = useCallback(
    (landing: BotTranscriptLanding) =>
      jumpTo(
        landing.sendPostId === null
          ? { kind: "message", messageId: landing.messageId }
          : {
              kind: "send",
              postId: landing.sendPostId,
              fallbackMessageId: landing.messageId,
            },
      ),
    [jumpTo],
  );
  // The row a pending jump waited on has rendered: settle it during render
  // (the adjust-state-on-prop-change pattern), so the scroll is issued in the
  // same pass the row appears in and no effect sets state.
  const pendingTarget =
    pendingJump === null ? null : jumpTargetIn(messages, pendingJump);
  if (pendingTarget !== null) {
    setPendingJump(null);
    issueScroll(pendingTarget);
  }
  // A send's card is located by the post its call wrote; a message by its id.
  const pendingLocator = useMemo<TranscriptRowLocator | null>(() => {
    if (pendingJump === null) return null;
    return pendingJump.kind === "message"
      ? { kind: "message", messageId: pendingJump.messageId }
      : { kind: "receipt", messageId: pendingJump.postId };
  }, [pendingJump]);
  const located = useChatLocateRowAnswer({
    client: tabClient,
    epicId: botId,
    chatId,
    target: pendingLocator,
    epoch: state.transcriptWindow.epoch,
  });
  // A session with no card for the post (a send from before the host stamped
  // its post, or a host that does not locate one) lands on the turn instead.
  if (pendingJump?.kind === "send" && located.status === "missing") {
    setPendingJump({
      kind: "message",
      messageId: pendingJump.fallbackMessageId,
    });
  }
  const locatedOrdinal = located.status === "found" ? located.ordinal : null;
  const { requestTranscriptOrdinal } = state;
  // The store's pending-jump ordinal follows the pending jump: named while
  // the host has located it and the row is still missing, cleared the moment
  // the jump settles (or the transcript goes away).
  useEffect(() => {
    if (pendingJump === null || locatedOrdinal === null) {
      requestTranscriptOrdinal(null);
      return;
    }
    requestTranscriptOrdinal(locatedOrdinal);
  }, [locatedOrdinal, pendingJump, requestTranscriptOrdinal]);
  useEffect(
    () => () => {
      requestTranscriptOrdinal(null);
    },
    [requestTranscriptOrdinal],
  );
  const onScrollRequestSettled = useCallback((requestId: number) => {
    setScroll((current) =>
      current.request !== null && current.request.requestId === requestId
        ? { request: null, issued: current.issued }
        : current,
    );
  }, []);
  useLandOnMessage(landOn, state.snapshotLoaded, land);
  const getMessageActions = useCallback(() => null, []);
  const turns = useTranscriptTurns({
    client: tabClient,
    hostId,
    botId,
    messages,
    surface,
  });
  const presentation = useMemo<ChatBotPresentation | null>(() => {
    if (surface === null) return null;
    const followsPost = (postMessageId: string, replyMessageId: string) =>
      replyFollowsPost(messages, postMessageId, replyMessageId);
    const questions = {
      botId,
      viewerUserId: profile?.userId ?? null,
      memberName: (userId: string) =>
        botMemberName(userId, profile, resolveMember),
      answer: surface.answerQuestion,
      discuss: surface.discussQuestion,
    };
    if (surface.kind === "thread") {
      return {
        botTitle: title,
        scrollToMessage,
        replyFollowsPost: followsPost,
        threadLine: null,
        openThread: null,
        openAnnouncementThread: null,
        threadAnchorKinds: [],
        chooseOption: surface.chooseOption,
        questions,
        failedRequest: surface.failedRequest,
        ...turns,
      };
    }
    return {
      botTitle: title,
      // A thread post's verdict is in its thread, which the thread line
      // opens; a direct post's reply is here.
      scrollToMessage,
      replyFollowsPost: followsPost,
      threadLine: surface.threadLine,
      openThread: surface.openThread,
      openAnnouncementThread: surface.openAnnouncementThread,
      threadAnchorKinds: surface.threadAnchorKinds,
      chooseOption: surface.chooseOption,
      questions,
      failedRequest: surface.failedRequest,
      ...turns,
    };
  }, [
    botId,
    messages,
    profile,
    resolveMember,
    scrollToMessage,
    surface,
    title,
    turns,
  ]);

  const transcriptWindow = isWindowedTranscript(state)
    ? state.transcriptWindow
    : null;
  const channelHistory = channelHistoryOf(surface);
  const intro = channelIntro(
    surface,
    state.snapshotLoaded,
    messages.length,
    transcriptWindow,
  );

  // The channel's first screen, as a created channel nobody has written in
  // opens: the next post re-subscribes on its own, so nothing more is said.
  if (channelNotHereYet) {
    return (
      <div
        data-testid="bot-channel-not-here-yet"
        className="flex min-h-0 flex-1 flex-col"
      >
        <BotChannelOpening history={surface.history} intro={surface.intro} />
      </div>
    );
  }

  return (
    <ChatContainerContext.Provider value={botId}>
      <ChatBotPresentationContext.Provider value={presentation}>
        <div
          data-chat-keyboard-scroll-scope=""
          data-active="true"
          data-testid="bot-chat-transcript"
          className="flex min-h-0 flex-1 flex-col"
        >
          {intro !== null ? (
            <BotChannelOpening history={channelHistory} intro={intro} />
          ) : (
            <ChatTimelineHeaderContext value={channelHistory}>
              <TasklessMarkdownLinkProvider
                tabId={instanceId}
                tabHostId={hostId}
              >
                <ChatMessages
                  taskTitle={title}
                  taskId={chatId}
                  epicId={botId}
                  hostId={hostId}
                  messages={messages}
                  transcriptWindow={transcriptWindow}
                  onVisibleOrdinalRangeChange={
                    state.reportVisibleTranscriptRange
                  }
                  onFindReadOrdinalChange={state.requestFindReadOrdinal}
                  baselineEpoch={state.transcriptBaselineEpoch}
                  hydrationSequence={state.transcriptHydrationSequence}
                  coldRewrittenMessageIds={state.coldRewrittenMessageIds}
                  backgroundItems={state.backgroundItems}
                  getMessageActions={getMessageActions}
                  nextStepActions={null}
                  instanceId={instanceId}
                  visible
                  systemOverlayActive={false}
                  scrollRequest={scrollRequest}
                  onScrollRequestSettled={onScrollRequestSettled}
                  composerOverlayHeight={0}
                  subagentDrillIn={subagentDrillIn}
                />
              </TasklessMarkdownLinkProvider>
            </ChatTimelineHeaderContext>
          )}
        </div>
      </ChatBotPresentationContext.Provider>
    </ChatContainerContext.Provider>
  );
}

/**
 * A message the list lands on, and the visit that asks it to: a request to
 * land on the message the list last landed on is a new visit, and lands
 * again. `sendPostId` names a post one of the session's sends wrote (Tracy
 * Bots T94): the list lands on that send's card instead, and on `messageId`
 * where the session has no such card.
 */
export interface BotTranscriptLanding {
  readonly messageId: string;
  readonly sendPostId: string | null;
  readonly visit: number;
}

/**
 * A list opened to show one message lands on it once the snapshot is in,
 * once per visit: settled during render (the adjust-state-on-prop-change
 * pattern), as a pending jump is, so no effect sets state.
 */
function useLandOnMessage(
  landing: BotTranscriptLanding | null,
  ready: boolean,
  land: (landing: BotTranscriptLanding) => void,
): void {
  const [landed, setLanded] = useState<BotTranscriptLanding | null>(null);
  if (landing !== null && ready && !sameLanding(landed, landing)) {
    setLanded(landing);
    land(landing);
  }
}

/**
 * A jump waiting on its row: to a message, or to the card of the send that
 * wrote a post, landing on `fallbackMessageId` where the session has none.
 */
type PendingJump =
  | { readonly kind: "message"; readonly messageId: string }
  | {
      readonly kind: "send";
      readonly postId: string;
      readonly fallbackMessageId: string;
    };

/** Where a jump lands among the rendered rows; `null` while no row carries it. */
function jumpTargetIn(
  messages: ReadonlyArray<ChatMessage>,
  jump: PendingJump,
): { readonly rowId: string; readonly blockId: string | null } | null {
  if (jump.kind === "send") return sendCardFor(messages, jump.postId);
  const rowId = replyRowIdFor(messages, jump.messageId);
  return rowId === null ? null : { rowId, blockId: null };
}

function sameLanding(
  landed: BotTranscriptLanding | null,
  landing: BotTranscriptLanding,
): boolean {
  return (
    landed !== null &&
    landed.messageId === landing.messageId &&
    landed.sendPostId === landing.sendPostId &&
    landed.visit === landing.visit
  );
}

/** The turn receipts and failed-turn recovery a channel or thread draws, for its presentation. */
type TranscriptTurns = Pick<
  ChatBotPresentation,
  "replyReceipt" | "requestReceipt" | "failedRecovery"
>;

const NO_TURNS: TranscriptTurns = {
  replyReceipt: null,
  requestReceipt: null,
  failedRecovery: null,
};

/**
 * The turns behind a channel's or thread's rows: one `bot.turn.locate` for
 * the replies it renders and the posts it draws as not answered, read again
 * as those change and as the bot's turns settle; and the receipt each row
 * draws, which opens the turn's session landed on it. Where the surface's
 * session names a post's turn as its last failed attempt, the agent chat's
 * reason and actions.
 */
function useTranscriptTurns(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly botId: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly surface: BotTranscriptSurface | null;
}): TranscriptTurns {
  const { client, hostId, botId, messages, surface } = input;
  const failedRequest = surface?.failedRequest ?? null;
  const keys = useMemo(
    () => turnLocateKeysOf(messages, failedRequest),
    [failedRequest, messages],
  );
  const located = useBotTurnLocateQuery({
    client,
    hostId,
    botId,
    messageIds: keys.messageIds,
    requestIds: keys.requestIds,
    turns: NO_TURN_KEYS,
  });
  const index = useMemo(
    () => botTurnIndexOf(located.data?.turns),
    [located.data],
  );
  const turnOfRequest = useCallback(
    (requestId: string) => index.byRequestId.get(requestId) ?? null,
    [index],
  );
  const failedRecovery = useBotFailedRecovery({
    botId,
    hostId,
    sessionChatId: surface?.sessionChatId ?? null,
    turnOfRequest,
  });
  const openTurn = surface?.openTurn ?? null;
  return useMemo((): TranscriptTurns => {
    if (surface === null) return NO_TURNS;
    return {
      replyReceipt:
        openTurn === null
          ? null
          : (messageIds) => {
              const ref = turnOfMessages(index, messageIds);
              // The reply's own post leads its ids: the session lands on the
              // card of the send that wrote it.
              return ref === null
                ? null
                : receiptOf(ref, openTurn, messageIds[0] ?? null);
            },
      requestReceipt:
        openTurn === null
          ? null
          : (requestId) => {
              const ref = index.byRequestId.get(requestId);
              return ref === undefined ? null : receiptOf(ref, openTurn, null);
            },
      failedRecovery,
    };
  }, [failedRecovery, index, openTurn, surface]);
}

const NO_TURN_KEYS: ReadonlyArray<{ chatId: string; turnId: string }> = [];

/**
 * What to ask the host about a list's rows: every reply of the bot (not an
 * announcement), by each record its row carries, and every post the bot
 * failed to answer, by its request.
 */
function turnLocateKeysOf(
  messages: ReadonlyArray<ChatMessage>,
  failedRequest: BotTranscriptSurface["failedRequest"] | null,
): {
  readonly messageIds: ReadonlyArray<string>;
  readonly requestIds: ReadonlyArray<string>;
} {
  const messageIds: string[] = [];
  const requestIds: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      if (message.announcement !== undefined) continue;
      if (message.persistentMessageId !== null) {
        messageIds.push(message.persistentMessageId);
      }
      for (const id of message.turnMessageIds ?? []) messageIds.push(id);
      continue;
    }
    const request = message.conversationRequest;
    if (request === undefined || failedRequest === null) continue;
    if (
      failedRequest(request.requestId, message.senderUserId ?? null) !== null
    ) {
      requestIds.push(request.requestId);
    }
  }
  return { messageIds, requestIds };
}

function receiptOf(
  ref: BotTurnRef,
  openTurn: BotTurnOpen,
  sendPostId: string | null,
): ChatBotTurnReceipt {
  return {
    summary: ref.summary,
    startedAt: ref.startedAt,
    endedAt: ref.endedAt,
    open: () => openTurn(ref, sendPostId),
  };
}
