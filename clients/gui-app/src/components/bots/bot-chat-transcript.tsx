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
import { useChatLocateRow } from "@/hooks/chats/use-chat-locate-row";
import {
  repliedPostOf,
  replyFollowsPost,
  replyRowIdFor,
} from "@/lib/bots/reply-row";
import {
  botUserSenderAvatarUrl,
  botUserSenderId,
  botUserSenderLabel,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BotChannelIntro } from "@/components/bots/bot-channel-intro";
import {
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import {
  ChatBotPresentationContext,
  type ChatBotFailedRequest,
  type ChatBotPresentation,
  type ChatBotThreadLine,
} from "@/components/chat/chat-bot-presentation-context";
import { ChatContainerContext } from "@/components/chat/chat-container-context";
import { queuedPromptMessageIds } from "@/components/chat/chat-queue-utils";
import { useSubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { TileErrorBoundary } from "@/components/epic-canvas/renderers/tile-error-boundary";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useGuiHarnessCatalogForClient } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import { contentBlocksPreview } from "@/lib/chat/content-block-text";
import { getModelLabelIndex } from "@/lib/chat/model-label-index";
import {
  resolveAgentReasoningLabel,
  resolveAgentSenderDisplay,
  type SenderDisplayContext,
  resolveAgentServiceTierLabel,
} from "@/lib/chat/sender-display";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  composerTurnStatus,
  resolvedTurnStatus,
} from "@/stores/chats/chat-run-activity";
import {
  isWindowedTranscript,
  withdrawnMessageDeliveryId,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
} from "@/stores/chats/rendered-messages";
import type { SetupCardWindowIdentity } from "@traycer/protocol/host/agent/gui/subscribe-windowed";

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
      /** Opens the thread under a question, a proposal or a direct post; `null` where threads cannot be opened. */
      readonly openAnnouncementThread:
        | ((announcementId: string) => void)
        | null;
      /** Posts a direct reply's chosen option as a new post; `null` while one is being sent. */
      readonly chooseOption: ((choice: string) => void) | null;
      /** A post the bot failed to answer, by its request id and writer, and what can be done about it. */
      readonly failedRequest: (
        requestId: string,
        senderUserId: string | null,
      ) => ChatBotFailedRequest | null;
      /** What the top of the channel says while nobody has written in it. */
      readonly intro: {
        readonly botTitle: string;
        readonly directive: string | null;
      };
    }
  | {
      readonly kind: "thread";
      /** Posts a reply's chosen option in the thread; `null` while one is being sent. */
      readonly chooseOption: ((choice: string) => void) | null;
      /** A message the bot failed to answer, by its request id and writer, and what can be done about it. */
      readonly failedRequest: (
        requestId: string,
        senderUserId: string | null,
      ) => ChatBotFailedRequest | null;
    };

const NO_COLLABORATORS: SenderDisplayContext["collaborators"] = [];
const EMPTY_SETUP_CARD_WINDOWS: ReadonlyArray<SetupCardWindowIdentity> = [];
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
  } = props;
  const state = useStore(
    handle.store,
    useShallow((s) => ({
      snapshotLoaded: s.snapshotLoaded,
      messages: s.messages,
      events: s.events,
      transcriptRowContext: s.transcriptRowContext,
      transcriptDerived: s.transcriptDerived,
      pendingUserMessages: s.pendingUserMessages,
      queue: s.queue,
      turnInProgress: s.turnInProgress,
      messageDelivery: s.messageDelivery,
      liveAssistantMessage: s.liveAssistantMessage,
      activeTurn: s.activeTurn,
      pendingApprovals: s.pendingApprovals,
      pendingFileEditApprovals: s.pendingFileEditApprovals,
      pendingInterviews: s.pendingInterviews,
      runStatus: s.runStatus,
      transcriptWindow: s.transcriptWindow,
      transcriptBaselineEpoch: s.transcriptBaselineEpoch,
      transcriptHydrationSequence: s.transcriptHydrationSequence,
      coldRewrittenMessageIds: s.coldRewrittenMessageIds,
      backgroundItems: s.backgroundItems,
      reportVisibleTranscriptRange: s.reportVisibleTranscriptRange,
      requestFindReadOrdinal: s.requestFindReadOrdinal,
      requestTranscriptOrdinal: s.requestTranscriptOrdinal,
      fatalClose: s.fatalClose,
      retry: s.retry,
    })),
  );
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
  // Label-only, cache-only: whoever fetched this host's catalog (a composer,
  // Settings) filled the host-keyed cache this reads; nothing here fetches.
  const catalog = useGuiHarnessCatalogForClient(tabClient, null, {
    enabled: false,
    subscribed: true,
    modelsFetch: "cached-only",
  });
  const { modelLabels, modelReasoningLabels, modelServiceTierLabels } = useMemo(
    () => getModelLabelIndex(catalog.harnesses),
    [catalog.harnesses],
  );
  const displayContext = useMemo<SenderDisplayContext>(
    () => ({
      profile,
      collaborators: NO_COLLABORATORS,
      modelLabels,
      modelReasoningLabels,
      modelServiceTierLabels,
    }),
    [modelLabels, modelReasoningLabels, modelServiceTierLabels, profile],
  );
  const renderedDisplayContext = useMemo<RenderedMessagesDisplayContext>(
    () => ({
      resolveUserSenderLabel: (sender) =>
        botUserSenderLabel(sender, displayContext, resolveMember),
      resolveUserSenderAvatarUrl: (sender) =>
        botUserSenderAvatarUrl(sender, resolveMember),
      resolveUserSenderId: botUserSenderId,
      resolveAgentSenderDisplay: (sender) =>
        resolveAgentSenderDisplay(sender, displayContext),
      resolveAgentReasoningLabel: (sender, reasoningEffort) =>
        resolveAgentReasoningLabel(sender, reasoningEffort, displayContext),
      resolveAgentServiceTierLabel: (sender, serviceTier) =>
        resolveAgentServiceTierLabel(sender, serviceTier, displayContext),
      contentBlocksPreview,
    }),
    [displayContext, resolveMember],
  );
  const queuedPromptIds = useMemo(
    () => queuedPromptMessageIds(state.queue.items),
    [state.queue.items],
  );
  const turnStatus = resolvedTurnStatus(
    state,
    composerTurnStatus(state.runStatus),
  );
  const messages = useRenderedMessages(
    {
      messages: state.messages,
      events: state.events,
      rowContext: state.transcriptRowContext,
      setupCardWindows:
        state.transcriptDerived?.setupCardWindows ?? EMPTY_SETUP_CARD_WINDOWS,
      pendingUserMessages: state.pendingUserMessages,
      queuedPromptMessageIds: queuedPromptIds,
      withdrawnMessageId: withdrawnMessageDeliveryId(state.messageDelivery),
      liveAssistantMessage: state.liveAssistantMessage,
      activeTurn: state.activeTurn,
      pendingApprovals: state.pendingApprovals,
      pendingFileEditApprovals: state.pendingFileEditApprovals,
      pendingInterviews: state.pendingInterviews,
      runStatus: turnStatus ?? "idle",
      chatWorking: state.runStatus !== "idle",
      epicId: botId,
      ownerId: chatId,
      ownerKind: "chat",
      viewTabId: instanceId,
    },
    renderedDisplayContext,
  );
  const subagentDrillIn = useSubagentDrillIn(state.snapshotLoaded);

  // "See reply" names the reply's MESSAGE id; the list lands by RENDERED ROW
  // key, so the id is resolved to the row that renders it (see
  // `replyRowIdFor`). A reply outside the hydrated window has no row yet: the
  // id is held as pending, the host locates its ordinal, the store hydrates
  // around it (`requestTranscriptOrdinal`), and the scroll is issued the
  // moment the row renders.
  const [scrollRequest, setScrollRequest] =
    useState<ChatMessageScrollRequest | null>(null);
  const [pendingReplyId, setPendingReplyId] = useState<string | null>(null);
  const issueScroll = useCallback((rowId: string) => {
    setScrollRequest((previous) => ({
      kind: "message",
      messageId: rowId,
      blockId: null,
      requestId: (previous?.requestId ?? 0) + 1,
    }));
  }, []);
  const scrollToMessage = useCallback(
    (messageId: string) => {
      const rowId = replyRowIdFor(messages, messageId);
      if (rowId !== null) {
        setPendingReplyId(null);
        issueScroll(rowId);
        return;
      }
      setPendingReplyId(messageId);
    },
    [issueScroll, messages],
  );
  // The row a pending jump waited on has rendered: settle it during render
  // (the adjust-state-on-prop-change pattern), so the scroll is issued in the
  // same pass the row appears in and no effect sets state.
  const pendingRowId =
    pendingReplyId === null ? null : replyRowIdFor(messages, pendingReplyId);
  if (pendingRowId !== null) {
    setPendingReplyId(null);
    issueScroll(pendingRowId);
  }
  const pendingTarget = useMemo<TranscriptRowLocator | null>(
    () =>
      pendingReplyId === null
        ? null
        : { kind: "message", messageId: pendingReplyId },
    [pendingReplyId],
  );
  const locatedOrdinal = useChatLocateRow({
    client: tabClient,
    epicId: botId,
    chatId,
    target: pendingTarget,
    epoch: state.transcriptWindow.epoch,
  });
  const { requestTranscriptOrdinal } = state;
  // The store's pending-jump ordinal follows the pending reply: named while
  // the host has located it and the row is still missing, cleared the moment
  // the jump settles (or the transcript goes away).
  useEffect(() => {
    if (pendingReplyId === null || locatedOrdinal === null) {
      requestTranscriptOrdinal(null);
      return;
    }
    requestTranscriptOrdinal(locatedOrdinal);
  }, [locatedOrdinal, pendingReplyId, requestTranscriptOrdinal]);
  useEffect(
    () => () => {
      requestTranscriptOrdinal(null);
    },
    [requestTranscriptOrdinal],
  );
  const onScrollRequestSettled = useCallback((requestId: number) => {
    setScrollRequest((current) =>
      current !== null && current.requestId === requestId ? null : current,
    );
  }, []);
  const getMessageActions = useCallback(() => null, []);
  const presentation = useMemo<ChatBotPresentation | null>(() => {
    if (surface === null) return null;
    const followsPost = (postMessageId: string, replyMessageId: string) =>
      replyFollowsPost(messages, postMessageId, replyMessageId);
    if (surface.kind === "thread") {
      return {
        botTitle: title,
        scrollToMessage,
        replyFollowsPost: followsPost,
        repliedPost: null,
        threadLine: null,
        openThread: null,
        openAnnouncementThread: null,
        chooseOption: surface.chooseOption,
        failedRequest: surface.failedRequest,
      };
    }
    return {
      botTitle: title,
      // A thread post's verdict is in its thread, which the thread line
      // opens; a direct post's reply, and the post it answers, are here.
      scrollToMessage,
      replyFollowsPost: followsPost,
      repliedPost: (messageId) => repliedPostOf(messages, messageId),
      threadLine: surface.threadLine,
      openThread: surface.openThread,
      openAnnouncementThread: surface.openAnnouncementThread,
      chooseOption: surface.chooseOption,
      failedRequest: surface.failedRequest,
    };
  }, [messages, scrollToMessage, surface, title]);

  const transcriptWindow = isWindowedTranscript(state)
    ? state.transcriptWindow
    : null;
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
        <BotChannelIntro
          botTitle={surface.intro.botTitle}
          directive={surface.intro.directive}
        />
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
            <BotChannelIntro
              botTitle={intro.botTitle}
              directive={intro.directive}
            />
          ) : (
            <ChatMessages
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
          )}
        </div>
      </ChatBotPresentationContext.Provider>
    </ChatContainerContext.Provider>
  );
}
