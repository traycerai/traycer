import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import {
  hashKey,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { botMutationKeys } from "@/lib/query-keys/bot-mutation-keys";
import type { TranscriptRowLocator } from "@traycer/protocol/persistence/chat-transcript/locate-row";
import { useChatLocateRowAnswer } from "@/hooks/chats/use-chat-locate-row";
import type { BotReplyTarget } from "@/lib/bots/bot-reply-target";
import { replyRowIdFor, sendCardFor } from "@/lib/bots/reply-row";
import { botTurnIndexOf, turnOfMessages } from "@/lib/bots/bot-turn-receipt";
import type { BotTurnRef } from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useBotSearchWordMarks } from "@/hooks/bots/use-bot-search-word-marks";
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
  CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME,
  CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS,
} from "@/components/chat/chat-navigation-highlight";
import {
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import {
  ChatBotPresentationContext,
  ChatBotRepliesContext,
  type ChatBotFailedRequest,
  type ChatBotPresentation,
  type ChatBotQuestionAnswers,
  type ChatBotReplies,
  type ChatBotThreadLine,
  type ChatBotThreadOpening,
  type ChatBotTurnReceipt,
} from "@/components/chat/chat-bot-presentation-context";
import type { QuestionCardAnswer } from "@/components/chat/question-card";
import { ChatContainerContext } from "@/components/chat/chat-container-context";
import { TasklessMarkdownLinkProvider } from "@/components/chat/chat-markdown-link-provider";
import { TracyTranscriptOriginScope } from "@/components/bots/tracy-transcript-origin-scope";
import { BotTranscriptImageScope } from "@/components/bots/bot-transcript-image-scope";
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
import {
  transcriptListRows,
  type TranscriptListRow,
} from "@/stores/chats/transcript-list-rows";
import type {
  OrdinalRange,
  TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { Button } from "@/components/ui/button";
import { ChatMessage as ChatMessageRow } from "@/components/chat/chat-message";
import { rowPaintsNothing } from "@/components/chat/chat-special-segment";
import { cn } from "@/lib/utils";
import { BotSessionStatusSlotContext } from "@/components/bots/bot-session-status-context";

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
      /** Names a row of the channel in the channel's box as the message its send replies to (T166); `null` where none can. */
      readonly reply: ((target: BotReplyTarget) => void) | null;
      /** Sends a question card's answer at the channel's top level; `null` where nothing can send it. */
      readonly answerQuestion: QuestionAnswerSend | null;
      /** Sends a card's answers together at the channel's top level; `null` where they go one at a time. */
      readonly answerQuestions: QuestionAnswersSend | null;
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
      /** Names a row of the thread in the thread's box as the message its send replies to (T166); `null` where none can. */
      readonly reply: ((target: BotReplyTarget) => void) | null;
      /** Sends a question card's answer in the thread; `null` where the thread takes no send. */
      readonly answerQuestion: QuestionAnswerSend | null;
      /** Sends a card's answers together in the thread; `null` where they go one at a time. */
      readonly answerQuestions: QuestionAnswersSend | null;
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
      /** The post the thread opens on, which a reply's badge may name (T165). */
      readonly opening: ChatBotThreadOpening;
    };

/**
 * Sends a question card's answer or Skip to the question on the row
 * `questionMessageId`: resolves once the host takes it, rejects when not.
 */
export type QuestionAnswerSend = (
  questionMessageId: string,
  answer: QuestionCardAnswer,
) => Promise<void>;

/**
 * Sends a member's answers to every open question of the row
 * `questionMessageId` as one message (T167): resolves once the host takes
 * them, rejects when not.
 */
export type QuestionAnswersSend = (
  questionMessageId: string,
  answers: ChatBotQuestionAnswers,
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
 * `header` is what the list shows above its first row, scrolling with the
 * rows, and above the spinner while it connects: a thread's post. A channel's
 * setup history comes through `surface`.
 *
 * A channel or thread draws, under each reply of the bot and under a post it
 * failed to answer, the receipt of the turn behind it (Tracy Bots T86), as
 * the bound host names the turns (`bot.turn.locate`); the receipt opens the
 * turn's session, read-only and landed on the turn, through the
 * surface. A post its session failed on, where that session
 * names the post's turn as its last failed attempt, says so with the agent
 * chat's reason and actions.
 *
 * `flow` draws the rows in the page's own flow instead of a list that
 * scrolls them, as a Threads card does (Tracy Bots T137): the same rows,
 * under the header, as tall as they are.
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
  readonly header: ReactNode;
  /** A message the list lands on once it loads; `null` keeps where it opens. */
  readonly landOn: BotTranscriptLanding | null;
  /** The rows in the page's flow; `null` for a list of their own. */
  readonly flow: BotTranscriptFlow | null;
}): ReactNode {
  const {
    botId,
    chatId,
    hostId,
    title,
    instanceId,
    surface,
    resolveMember,
    header,
  } = props;
  const handle = useChatSessionHandleForContainer(botId, chatId, hostId, true);
  const statusSlot = useContext(BotSessionStatusSlotContext);
  if (handle === null) {
    if (!props.showConnecting) return null;
    const connecting = (
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
    if (header === null) return connecting;
    return (
      <div
        className={cn(
          "flex flex-col pt-3",
          props.flow === null && "min-h-0 flex-1 overflow-y-auto",
        )}
      >
        {header}
        {connecting}
      </div>
    );
  }
  return (
    <TileErrorBoundary instanceId={instanceId} resetKey={chatId}>
      <BotTranscriptImageScope botId={botId} chatId={chatId} hostId={hostId}>
        <TracyTranscriptOriginScope botId={botId}>
          <BotChatTranscriptBody
            minimapEnabled={surface?.kind !== "thread"}
            handle={handle}
            botId={botId}
            chatId={chatId}
            hostId={hostId}
            title={title}
            instanceId={instanceId}
            surface={surface}
            resolveMember={resolveMember}
            header={header}
            landOn={props.landOn}
            flow={props.flow}
          />
          {statusSlot?.(handle)}
        </TracyTranscriptOriginScope>
      </BotTranscriptImageScope>
    </TileErrorBoundary>
  );
}

type ChannelIntro = Extract<BotTranscriptSurface, { kind: "channel" }>["intro"];

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

/**
 * A channel nobody has written in opens with what it is for, as Slack's
 * does; a windowed one is empty only when the host counts no row. `null`
 * on a thread, before the snapshot, and once the channel has a row.
 */
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
  readonly minimapEnabled: boolean;
  readonly handle: ChatSessionStoreHandle;
  readonly botId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly title: string;
  readonly instanceId: string;
  readonly surface: BotTranscriptSurface | null;
  readonly resolveMember: BotMemberResolver;
  readonly header: ReactNode;
  readonly landOn: BotTranscriptLanding | null;
  readonly flow: BotTranscriptFlow | null;
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
    header,
    landOn,
    flow,
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

  // A landing names a MESSAGE id; the list lands by RENDERED ROW key, so the
  // id is resolved to the row that renders it (see `replyRowIdFor`). A
  // message outside the hydrated window has no row yet: the id is held as
  // pending, the host locates its ordinal, the store hydrates around it
  // (`requestTranscriptOrdinal`), and the scroll is issued the moment the
  // row renders.
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
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const rowIdOf = useCallback(
    (messageId: string): string | null =>
      jumpTargetIn(messages, { kind: "message", messageId })?.rowId ?? null,
    [messages],
  );
  useBotSearchWordMarks(transcriptRef, chatId, rowIdOf);
  const getMessageActions = useCallback(() => null, []);
  const turns = useTranscriptTurns({
    client: tabClient,
    hostId,
    botId,
    messages,
    surface,
  });
  // A store the registry built to replace an evicted one starts its epochs
  // again: a card's baseline names the session as well as its epoch.
  const store = handle.sessionGeneration;
  const baselineEpoch = state.transcriptBaselineEpoch;
  const presentation = useMemo<ChatBotPresentation | null>(() => {
    if (surface === null) return null;
    const questions = {
      botId,
      viewerUserId: profile?.userId ?? null,
      memberName: (userId: string) =>
        botMemberName(userId, profile, resolveMember),
      answer: surface.answerQuestion,
      answerAll: surface.answerQuestions,
      baseline: { store, epoch: baselineEpoch },
      discuss: surface.discussQuestion,
    };
    if (surface.kind === "thread") {
      return {
        botTitle: title,
        threadLine: null,
        openThread: null,
        openAnnouncementThread: null,
        threadAnchorKinds: [],
        chooseOption: surface.chooseOption,
        reply: surface.reply,
        questions,
        failedRequest: surface.failedRequest,
        ...turns,
      };
    }
    return {
      botTitle: title,
      threadLine: surface.threadLine,
      openThread: surface.openThread,
      openAnnouncementThread: surface.openAnnouncementThread,
      threadAnchorKinds: surface.threadAnchorKinds,
      chooseOption: surface.chooseOption,
      reply: surface.reply,
      questions,
      failedRequest: surface.failedRequest,
      ...turns,
    };
  }, [
    baselineEpoch,
    botId,
    profile,
    resolveMember,
    store,
    surface,
    title,
    turns,
  ]);

  const transcriptWindow = isWindowedTranscript(state)
    ? state.transcriptWindow
    : null;
  const repliesBase = useMemo<RepliesBase | null>(
    () =>
      surface === null
        ? null
        : {
            botId,
            hostId,
            conversationId: chatId,
            botTitle: title,
            memberName: (userId) =>
              userId === null
                ? "Member"
                : botMemberName(userId, profile, resolveMember),
            opening: surface.kind === "thread" ? surface.opening : null,
          },
    [botId, chatId, hostId, profile, resolveMember, surface, title],
  );
  // The list's rows; a transcript in the page's flow judges its own, as it
  // folds them (`BotTranscriptFlowRows`).
  const listReplies = useMemo<ChatBotReplies | null>(() => {
    if (repliesBase === null || flow !== null) return null;
    const above = rowsAbove(
      transcriptListRows({
        window: transcriptWindow,
        rendered: messages,
        splitLongTurns: false,
      }),
      repliesBase.opening?.messageId ?? null,
    );
    return {
      ...repliesBase,
      above: (messageId) => above.get(messageId) ?? null,
      open: (messageId) => jumpTo({ kind: "message", messageId }),
    };
  }, [flow, jumpTo, messages, repliesBase, transcriptWindow]);
  const listHeader = surface?.kind === "channel" ? surface.history : header;
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
        <ChatBotRepliesContext.Provider value={listReplies}>
          <BotTranscriptRows
            ref={transcriptRef}
            flow={flow}
            replies={repliesBase}
            intro={intro}
            header={listHeader}
            instanceId={instanceId}
            hostId={hostId}
            messages={messages}
            transcriptWindow={transcriptWindow}
            reportVisibleRange={state.reportVisibleTranscriptRange}
            list={
              <ChatMessages
                minimapEnabled={props.minimapEnabled}
                taskTitle={title}
                taskId={chatId}
                epicId={botId}
                hostId={hostId}
                messages={messages}
                transcriptWindow={transcriptWindow}
                onVisibleOrdinalRangeChange={state.reportVisibleTranscriptRange}
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
            }
          />
        </ChatBotRepliesContext.Provider>
      </ChatBotPresentationContext.Provider>
    </ChatContainerContext.Provider>
  );
}

/**
 * The transcript's rows: an empty channel's opening (`intro`), the rows in
 * the page's flow (`flow`), or else the list of their own (`list`), whose
 * first row sits under `header`.
 */
function BotTranscriptRows(props: {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly flow: BotTranscriptFlow | null;
  /** What the rows' badges read, but for the rows above and landing, which the flow's rows give. */
  readonly replies: RepliesBase | null;
  readonly intro: ChannelIntro | null;
  readonly header: ReactNode;
  readonly instanceId: string;
  readonly hostId: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly transcriptWindow: TranscriptWindow | null;
  readonly reportVisibleRange: (range: OrdinalRange | null) => void;
  readonly list: ReactNode;
}): ReactNode {
  const { ref, flow, intro, header, instanceId, hostId } = props;
  let rows: ReactNode;
  if (intro !== null) {
    rows = <BotChannelOpening history={header} intro={intro} />;
  } else if (flow === null) {
    rows = (
      <ChatTimelineHeaderContext value={header}>
        <TasklessMarkdownLinkProvider tabId={instanceId} tabHostId={hostId}>
          {props.list}
        </TasklessMarkdownLinkProvider>
      </ChatTimelineHeaderContext>
    );
  } else {
    rows = (
      <TasklessMarkdownLinkProvider tabId={instanceId} tabHostId={hostId}>
        <BotTranscriptFlowRows
          header={header}
          replies={props.replies}
          messages={props.messages}
          transcriptWindow={props.transcriptWindow}
          reportVisibleRange={props.reportVisibleRange}
          fold={flow.fold}
          mark={flow.mark}
        />
      </TasklessMarkdownLinkProvider>
    );
  }
  return (
    <div
      ref={ref}
      data-chat-keyboard-scroll-scope=""
      data-active="true"
      data-testid="bot-chat-transcript"
      className={cn("flex flex-col", flow === null && "min-h-0 flex-1")}
    >
      {rows}
    </div>
  );
}

/**
 * A transcript drawn in the page's flow, which scrolls it (a Threads card):
 * every row under the header, or, with `fold`, a long one's newest rows under
 * a line that shows the rest in place.
 */
export interface BotTranscriptFlow {
  readonly fold: BotTranscriptFold | null;
  /** A mark drawn under one message's row; `null` draws none. */
  readonly mark: BotTranscriptMark | null;
}

/**
 * A mark under the row of `messageId`, drawn once that row is, and anew for
 * each message, handed to `ref`: for whoever needs to know that message is
 * in view.
 */
export interface BotTranscriptMark {
  readonly messageId: string;
  readonly ref: (node: HTMLElement | null) => void;
}

/**
 * How a long transcript folds: one of more than `maxRows` rows draws only
 * its newest `tail` rows, under a line naming how many more there are;
 * choosing the line calls `onUnfold`, whose caller passes no fold after.
 */
export interface BotTranscriptFold {
  readonly maxRows: number;
  readonly tail: number;
  readonly onUnfold: () => void;
}

const NO_BACKGROUND_TOOL_BLOCKS: ReadonlySet<string> = new Set();

/**
 * The rows in the page's flow, under `header`: each one the list's own row
 * (`ChatMessage`), with the list's padding, so a row behaves as it does in
 * the list. A row the window has not hydrated yet holds its place with a
 * spinner, one for a run of them. On the windowed line the rows drawn are
 * reported as the visible range, which is what hydrates them, and withdrawn
 * when the rows go. `mark` is drawn under its message's row while that row
 * is drawn. A reply's badge judges the row above it among the rows drawn, so
 * a message folded away is not above, and lands here (`useFlowLanding`).
 */
function BotTranscriptFlowRows(props: {
  readonly header: ReactNode;
  readonly replies: RepliesBase | null;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly transcriptWindow: TranscriptWindow | null;
  readonly reportVisibleRange: (range: OrdinalRange | null) => void;
  readonly fold: BotTranscriptFold | null;
  readonly mark: BotTranscriptMark | null;
}): ReactNode {
  const { header, messages, transcriptWindow, reportVisibleRange, fold, mark } =
    props;
  const rows = useMemo(
    () =>
      transcriptListRows({
        window: transcriptWindow,
        rendered: messages,
        splitLongTurns: false,
      }).filter(
        (row) => row.kind === "placeholder" || !rowPaintsNothing(row.model),
      ),
    [messages, transcriptWindow],
  );
  const folded = fold !== null && rows.length > fold.maxRows;
  const shown = useMemo(
    () =>
      fold !== null && folded ? rows.slice(rows.length - fold.tail) : rows,
    [fold, folded, rows],
  );
  const hidden = rows.length - shown.length;
  const {
    ref: landingRef,
    highlightedRowId,
    open: land,
  } = useFlowLanding({
    shown,
    onUnfold: fold !== null && folded ? fold.onUnfold : null,
  });
  const replies = useFlowReplies(props.replies, shown, folded, land);
  const markRowId =
    mark === null
      ? null
      : replyRowIdFor(
          shown.flatMap((row) => (row.kind === "hydrated" ? [row.model] : [])),
          mark.messageId,
        );
  const range = ordinalRangeOf(shown);
  const fromOrdinal = range?.fromOrdinal ?? null;
  const toOrdinal = range?.toOrdinal ?? null;
  const windowed = transcriptWindow !== null;
  useEffect(() => {
    if (!windowed) return;
    reportVisibleRange(
      fromOrdinal === null || toOrdinal === null
        ? null
        : { fromOrdinal, toOrdinal },
    );
  }, [fromOrdinal, reportVisibleRange, toOrdinal, windowed]);
  // Withdrawn on unmount only: between two ranges the next report replaces
  // the last.
  useEffect(
    () => () => {
      if (windowed) reportVisibleRange(null);
    },
    [reportVisibleRange, windowed],
  );
  return (
    <ChatBotRepliesContext.Provider value={replies}>
      <div
        ref={landingRef}
        className="flex flex-col"
        data-testid="bot-chat-transcript-flow"
      >
        {header}
        {folded ? (
          <div className="px-6 py-1">
            <Button
              type="button"
              variant="link"
              size="inline-xs"
              data-testid="bot-chat-transcript-unfold"
              onClick={fold.onUnfold}
            >
              {hidden === 1
                ? "Show 1 more reply"
                : `Show ${hidden} more replies`}
            </Button>
          </div>
        ) : null}
        {flowRowsOf(shown).map((row) =>
          row.kind === "placeholders" ? (
            <div
              key={row.key}
              className="flex justify-center py-2 text-muted-foreground"
              aria-busy="true"
              data-testid="bot-chat-transcript-row-loading"
            >
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            </div>
          ) : (
            <div
              key={row.key}
              data-message-id={row.model.id}
              className={cn(
                "w-full rounded-md px-4 pb-0.5",
                row.model.id === highlightedRowId &&
                  CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME,
              )}
            >
              <ChatMessageRow
                message={row.model}
                actions={null}
                backgroundToolBlockIds={NO_BACKGROUND_TOOL_BLOCKS}
                nextStepActions={null}
                part={null}
              />
              {mark !== null && row.model.id === markRowId ? (
                <div
                  key={mark.messageId}
                  ref={mark.ref}
                  aria-hidden="true"
                  data-testid="bot-chat-transcript-mark"
                  data-mark-message-id={mark.messageId}
                />
              ) : null}
            </div>
          ),
        )}
      </div>
    </ChatBotRepliesContext.Provider>
  );
}

/** What a row's badge reads, but for the rows above it and landing, which its list gives. */
type RepliesBase = Omit<ChatBotReplies, "above" | "open">;

/**
 * Landing on a message among a flow's rows, as a reply's badge asks (Tracy
 * Bots T165): a folded flow is unfolded first when the message is not among
 * the rows drawn, then the message's row, once drawn, is scrolled into view
 * and highlighted for as long as a list's landing is.
 */
function useFlowLanding(input: {
  readonly shown: ReadonlyArray<TranscriptListRow>;
  /** Unfolds the flow; `null` while it is not folded. */
  readonly onUnfold: (() => void) | null;
}): {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly highlightedRowId: string | null;
  readonly open: (messageId: string) => void;
} {
  const { shown, onUnfold } = input;
  const ref = useRef<HTMLDivElement | null>(null);
  const visits = useRef(0);
  const [target, setTarget] = useState<{
    readonly messageId: string;
    readonly visit: number;
  } | null>(null);
  const shownModels = useMemo(
    () => shown.flatMap((row) => (row.kind === "hydrated" ? [row.model] : [])),
    [shown],
  );
  const targetRowId =
    target === null ? null : replyRowIdFor(shownModels, target.messageId);
  const visit = target?.visit ?? null;
  useEffect(() => {
    if (visit === null || targetRowId === null) return undefined;
    const nodes =
      ref.current?.querySelectorAll<HTMLElement>("[data-message-id]");
    Array.from(nodes ?? [])
      .find((node) => node.dataset.messageId === targetRowId)
      ?.scrollIntoView({ block: "nearest" });
    const timer = window.setTimeout(() => {
      setTarget((current) => (current?.visit === visit ? null : current));
    }, CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [targetRowId, visit]);
  const open = useCallback(
    (messageId: string) => {
      if (onUnfold !== null && replyRowIdFor(shownModels, messageId) === null) {
        onUnfold();
      }
      visits.current += 1;
      setTarget({ messageId, visit: visits.current });
    },
    [onUnfold, shownModels],
  );
  return { ref, highlightedRowId: targetRowId, open };
}

/**
 * A flow's badge context: the row above each row among the rows drawn, the
 * post a thread opens on above the first only while nothing is folded away
 * between them.
 */
function useFlowReplies(
  base: RepliesBase | null,
  shown: ReadonlyArray<TranscriptListRow>,
  folded: boolean,
  open: (messageId: string) => void,
): ChatBotReplies | null {
  return useMemo(() => {
    if (base === null) return null;
    const above = rowsAbove(
      shown,
      folded ? null : (base.opening?.messageId ?? null),
    );
    return {
      ...base,
      above: (messageId) => above.get(messageId) ?? null,
      open,
    };
  }, [base, folded, open, shown]);
}

/**
 * By message id, the message of the row drawn directly above each drawn row:
 * `opening` above the first (the post a thread opens on; `null` in a
 * channel), and nothing below a row not loaded yet or not stored yet, whose
 * message is not known.
 */
function rowsAbove(
  rows: ReadonlyArray<TranscriptListRow>,
  opening: string | null,
): ReadonlyMap<string, string | null> {
  const above = new Map<string, string | null>();
  let previous: string | null = opening;
  for (const row of rows) {
    if (row.kind !== "hydrated") {
      previous = null;
      continue;
    }
    if (rowPaintsNothing(row.model)) continue;
    const id = row.model.persistentMessageId;
    if (id !== null) above.set(id, previous);
    previous = id;
  }
  return above;
}

/** The ordinals `rows` cover, end exclusive; `null` where none has one. */
function ordinalRangeOf(
  rows: ReadonlyArray<TranscriptListRow>,
): OrdinalRange | null {
  let from: number | null = null;
  let to: number | null = null;
  for (const row of rows) {
    if (row.ordinal === null) continue;
    from = from === null ? row.ordinal : Math.min(from, row.ordinal);
    to = to === null ? row.ordinal : Math.max(to, row.ordinal);
  }
  return from === null || to === null
    ? null
    : { fromOrdinal: from, toOrdinal: to + 1 };
}

/** A flow's rows, each run of placeholders one item. */
function flowRowsOf(
  rows: ReadonlyArray<TranscriptListRow>,
): ReadonlyArray<
  | Extract<TranscriptListRow, { readonly kind: "hydrated" }>
  | { readonly kind: "placeholders"; readonly key: string }
> {
  const items: Array<
    | Extract<TranscriptListRow, { readonly kind: "hydrated" }>
    | { readonly kind: "placeholders"; readonly key: string }
  > = [];
  for (const row of rows) {
    if (row.kind === "hydrated") {
      items.push(row);
      continue;
    }
    if (items.at(-1)?.kind !== "placeholders") {
      items.push({ kind: "placeholders", key: row.key });
    }
  }
  return items;
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
 * What to ask the host about a list's rows: every row of the bot (a reply,
 * a question or an announcement), by each record its row carries, and every
 * post the bot failed to answer, by its request. A row no turn wrote (an
 * announcement the host posts itself) is asked too, and the host names no
 * turn for it.
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
