import { useMemo } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { SetupCardWindowIdentity } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { queuedPromptMessageIds } from "@/components/chat/chat-queue-utils";
import { useGuiHarnessCatalogForClient } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  botUserSenderAvatarUrl,
  botUserSenderId,
  botUserSenderLabel,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { contentBlocksPreview } from "@/lib/chat/content-block-text";
import { getModelLabelIndex } from "@/lib/chat/model-label-index";
import {
  resolveAgentReasoningLabel,
  resolveAgentSenderDisplay,
  resolveAgentServiceTierLabel,
  type SenderDisplayContext,
} from "@/lib/chat/sender-display";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  composerTurnStatus,
  resolvedTurnStatus,
} from "@/stores/chats/chat-run-activity";
import {
  withdrawnMessageDeliveryId,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import type { ChatMessage } from "@/stores/composer/chat-store";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
} from "@/stores/chats/rendered-messages";

const NO_COLLABORATORS: SenderDisplayContext["collaborators"] = [];
const EMPTY_SETUP_CARD_WINDOWS: ReadonlyArray<SetupCardWindowIdentity> = [];

/** The slice of a bot session's state its transcript and the rail's turn read. */
export type BotSessionState = Pick<
  ChatSessionState,
  | "snapshotLoaded"
  | "messages"
  | "events"
  | "transcriptRowContext"
  | "transcriptDerived"
  | "pendingUserMessages"
  | "queue"
  | "turnInProgress"
  | "messageDelivery"
  | "liveAssistantMessage"
  | "activeTurn"
  | "pendingApprovals"
  | "pendingFileEditApprovals"
  | "pendingInterviews"
  | "runStatus"
  | "transcriptWindow"
  | "transcriptBaselineEpoch"
  | "transcriptHydrationSequence"
  | "coldRewrittenMessageIds"
  | "backgroundItems"
  | "reportVisibleTranscriptRange"
  | "requestFindReadOrdinal"
  | "requestTranscriptOrdinal"
  | "fatalClose"
  | "retry"
>;

/**
 * One of a bot's chats as the transcript renders its rows: the session's
 * state and its rendered messages, named and pictured as the bot's surfaces
 * name its members and labelled with the tab host's model catalog. Shared by
 * the transcript and the turn the rail shows, which reads one turn's rows
 * of the same session.
 */
export function useBotSessionMessages(input: {
  readonly handle: ChatSessionStoreHandle;
  readonly botId: string;
  readonly chatId: string;
  readonly viewTabId: string;
  readonly resolveMember: BotMemberResolver;
}): {
  readonly state: BotSessionState;
  readonly messages: ReadonlyArray<ChatMessage>;
} {
  const { handle, botId, chatId, viewTabId, resolveMember } = input;
  const state = useStore(
    handle.store,
    useShallow((s): BotSessionState => ({
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
      viewTabId,
    },
    renderedDisplayContext,
  );
  return { state, messages };
}
