import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { TranscriptRowLocator } from "@traycer/protocol/persistence/chat-transcript/locate-row";
import { useChatLocateRow } from "@/hooks/chats/use-chat-locate-row";
import { replyRowIdFor } from "@/lib/bots/reply-row";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  ChatMessages,
  type ChatMessageScrollRequest,
} from "@/components/chat/chat-messages";
import { ChatConversationRequestContext } from "@/components/chat/chat-conversation-request-context";
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
  resolveSenderLabel,
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

const NO_COLLABORATORS: SenderDisplayContext["collaborators"] = [];
const EMPTY_SETUP_CARD_WINDOWS: ReadonlyArray<SetupCardWindowIdentity> = [];

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
 * `linkRequests` wires the user rows' "See reply" link to a scroll of this
 * list, so a resolved request lands on the reply that resolved it.
 */
export function BotChatTranscript(props: {
  readonly botId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly title: string;
  readonly instanceId: string;
  readonly linkRequests: boolean;
}): ReactNode {
  const { botId, chatId, hostId, title, instanceId, linkRequests } = props;
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
        linkRequests={linkRequests}
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
  readonly linkRequests: boolean;
}): ReactNode {
  const { handle, botId, chatId, hostId, title, instanceId, linkRequests } =
    props;
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
    })),
  );
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
        resolveSenderLabel(sender, displayContext),
      resolveAgentSenderDisplay: (sender) =>
        resolveAgentSenderDisplay(sender, displayContext),
      resolveAgentReasoningLabel: (sender, reasoningEffort) =>
        resolveAgentReasoningLabel(sender, reasoningEffort, displayContext),
      resolveAgentServiceTierLabel: (sender, serviceTier) =>
        resolveAgentServiceTierLabel(sender, serviceTier, displayContext),
      contentBlocksPreview,
    }),
    [displayContext],
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

  const transcriptWindow = isWindowedTranscript(state)
    ? state.transcriptWindow
    : null;

  return (
    <ChatContainerContext.Provider value={botId}>
      <ChatConversationRequestContext.Provider
        value={linkRequests ? scrollToMessage : null}
      >
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
      </ChatConversationRequestContext.Provider>
    </ChatContainerContext.Provider>
  );
}
