import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMutationState } from "@tanstack/react-query";
import { botMutationKeys } from "@/lib/query-keys/bot-mutation-keys";
import type { TranscriptRowLocator } from "@traycer/protocol/persistence/chat-transcript/locate-row";
import { useChatLocateRow } from "@/hooks/chats/use-chat-locate-row";
import { repliedPostOf, replyRowIdFor } from "@/lib/bots/reply-row";
import {
  botUserSenderAvatarUrl,
  botUserSenderLabel,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import {
  ChatBotPresentationContext,
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
    }
  | {
      readonly kind: "thread";
      /** Posts a reply's chosen option in the thread; `null` while one is being sent. */
      readonly chooseOption: ((choice: string) => void) | null;
    };

const NO_COLLABORATORS: SenderDisplayContext["collaborators"] = [];
const EMPTY_SETUP_CARD_WINDOWS: ReadonlyArray<SetupCardWindowIdentity> = [];
const CHAT_NOT_VISIBLE_CODE = "CHAT_NOT_VISIBLE";

/**
 * The newest successful send to `chatId`, by the cache's mutation id, which
 * only grows; `null` for none. A mutation the cache later drops can only
 * lower this, and lowering is never read as a send.
 */
function useNewestSendTo(chatId: string): number | null {
  const sent = useMutationState({
    filters: {
      mutationKey: botMutationKeys.conversationSend(),
      status: "success",
    },
    select: (mutation) => {
      const variables: unknown = mutation.state.variables;
      const conversationId =
        typeof variables === "object" &&
        variables !== null &&
        "conversationId" in variables
          ? variables.conversationId
          : null;
      return conversationId === chatId ? mutation.mutationId : null;
    },
  });
  return sent.reduce<number | null>(
    (newest, id) =>
      id !== null && (newest === null || id > newest) ? id : newest,
    null,
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
 * opens its thread, and a thread's resolved request jumps to the reply in
 * this list that resolved it. `null` is one of the bot's own sessions (the
 * trunk, a thread's session): the plain transcript, read-only.
 *
 * `resolveMember` names and pictures the members whose messages the chat
 * carries; a member it does not know shows as their user id.
 */
export function BotChatTranscript(props: {
  readonly botId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly title: string;
  readonly instanceId: string;
  readonly surface: BotTranscriptSurface | null;
  readonly resolveMember: BotMemberResolver;
}): ReactNode {
  const { botId, chatId, hostId, title, instanceId, surface, resolveMember } =
    props;
  const handle = useChatSessionHandleForContainer(botId, chatId, hostId, true);
  if (handle === null) {
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
    if (surface.kind === "thread") {
      return {
        botTitle: title,
        scrollToMessage,
        repliedPost: null,
        threadLine: null,
        openThread: null,
        openAnnouncementThread: null,
        chooseOption: surface.chooseOption,
      };
    }
    return {
      botTitle: title,
      // A thread post's verdict is in its thread, which the thread line
      // opens; a direct post's reply, and the post it answers, are here.
      scrollToMessage,
      repliedPost: (messageId) => repliedPostOf(messages, messageId),
      threadLine: surface.threadLine,
      openThread: surface.openThread,
      openAnnouncementThread: surface.openAnnouncementThread,
      chooseOption: surface.chooseOption,
    };
  }, [messages, scrollToMessage, surface, title]);

  const transcriptWindow = isWindowedTranscript(state)
    ? state.transcriptWindow
    : null;

  if (channelNotHereYet) {
    return (
      <div
        data-testid="bot-channel-not-here-yet"
        className="flex min-h-0 flex-1 flex-col items-center justify-center p-4"
      >
        <p role="status" className="text-ui-sm text-muted-foreground">
          No messages yet. Your first message starts the channel.
        </p>
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
        </div>
      </ChatBotPresentationContext.Provider>
    </ChatContainerContext.Provider>
  );
}
