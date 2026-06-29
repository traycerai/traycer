import { useMemo } from "react";
import type {
  ChatRunSettings,
  ChatActiveTurn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { PermissionMode } from "@traycer/protocol/persistence/epic/foundation";
import type {
  InterviewAnswer,
  UserMessageSender,
} from "@traycer/protocol/persistence/epic/schemas";
import type { RuntimeApprovalDecision } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type {
  ChatSessionStoreHandle,
  EditUserMessageInput,
  SentChatMessageAction,
} from "@/stores/chats/chat-session-store";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

/**
 * Memoised stable callbacks bound to a `ChatSessionStoreHandle`.
 *
 * The chat tile previously called `handle.store.getState().X()` from
 * inside callbacks. Each call read the store fresh, which is correct,
 * but the callbacks themselves were created on every render. That was
 * harmless but spread the host-RPC surface across the renderer.
 *
 * `useChatActions(handle)` consolidates every action the tile needs into
 * a single memoised object. The actions read store state fresh on
 * invocation (via `handle.store.getState()`), so the chat-session store
 * remains the single source of truth - these are just typed proxies.
 */
export interface ChatActions {
  readonly sendMessage: (
    content: JsonContent,
    sender: UserMessageSender,
    settings: ChatRunSettings,
  ) => SentChatMessageAction | null;
  readonly deleteMessageSuffix: (fromMessageId: string) => string | null;
  readonly editUserMessage: (
    input: EditUserMessageInput,
  ) => SentChatMessageAction | null;
  readonly revertFileChanges: (
    fromMessageId: string | null,
    filePaths: ReadonlyArray<string> | null,
    revertArtifacts: boolean,
  ) => string | null;
  readonly stopTurn: () => string | null;
  readonly stopBackgroundItem: (taskId: string) => string | null;
  readonly stopAllBackgroundItems: () => string | null;
  readonly resumeQueue: () => string | null;
  readonly queueEdit: (
    queueItemId: string,
    content: JsonContent,
  ) => string | null;
  readonly queueSettingsUpdate: (
    queueItemId: string,
    settings: ChatRunSettings,
  ) => string | null;
  readonly restampQueuedItemSettings: (
    settings: ChatRunSettings,
    excludeQueueItemId: string | null,
  ) => void;
  readonly updateActivePermissionMode: (
    permissionMode: PermissionMode,
  ) => string | null;
  readonly queueCancel: (queueItemId: string) => string | null;
  readonly queueReorder: (
    queueItemId: string,
    beforeQueueItemId: string | null,
  ) => string | null;
  readonly queueSteerNow: (
    queueItemId: string,
    newSettings: ChatRunSettings | null,
  ) => string | null;
  readonly queueAbortSteer: (queueItemId: string) => string | null;
  readonly approvalDecision: (
    approvalId: string,
    decision: RuntimeApprovalDecision,
  ) => string | null;
  readonly fileEditApprovalDecision: (
    approvalId: string,
    decision: RuntimeApprovalDecision,
  ) => string | null;
  readonly restoreCheckpoint: (
    checkpointId: string,
    revertArtifacts: boolean,
  ) => string | null;
  readonly interviewAnswer: (
    blockId: string,
    answers: ReadonlyArray<InterviewAnswer>,
  ) => string | null;
  readonly interviewError: (blockId: string, reason: string) => string | null;
  readonly ackFailedSendRestoration: (clientActionId: string) => void;
  readonly ackAcceptedAction: (clientActionId: string) => void;
  readonly takeSetupFailedRestoration: (
    messageId: string,
  ) => JsonContent | null;
}

export function useChatActions(handle: ChatSessionStoreHandle): ChatActions {
  return useMemo<ChatActions>(
    () => ({
      sendMessage: (content, sender, settings) => {
        Analytics.getInstance().track(AnalyticsEvent.ChatMessageSent, {
          harness: settings.harnessId,
          model: settings.model,
          mode: settings.agentMode,
        });
        return handle.store.getState().sendMessage(content, sender, settings);
      },
      deleteMessageSuffix: (fromMessageId) =>
        handle.store.getState().deleteMessageSuffix(fromMessageId),
      editUserMessage: (input) =>
        handle.store.getState().editUserMessage(input),
      revertFileChanges: (fromMessageId, filePaths, revertArtifacts) =>
        handle.store
          .getState()
          .revertFileChanges(fromMessageId, filePaths, revertArtifacts),
      stopTurn: () => handle.store.getState().stopTurn(),
      stopBackgroundItem: (taskId) =>
        handle.store.getState().stopBackgroundItem(taskId),
      stopAllBackgroundItems: () =>
        handle.store.getState().stopAllBackgroundItems(),
      resumeQueue: () => handle.store.getState().resumeQueue(),
      queueEdit: (queueItemId, content) =>
        handle.store.getState().queueEdit(queueItemId, content),
      queueSettingsUpdate: (queueItemId, settings) =>
        handle.store.getState().queueSettingsUpdate(queueItemId, settings),
      restampQueuedItemSettings: (settings, excludeQueueItemId) =>
        handle.store
          .getState()
          .restampQueuedItemSettings(settings, excludeQueueItemId),
      updateActivePermissionMode: (permissionMode) =>
        handle.store.getState().updateActivePermissionMode(permissionMode),
      queueCancel: (queueItemId) =>
        handle.store.getState().queueCancel(queueItemId),
      queueReorder: (queueItemId, beforeQueueItemId) =>
        handle.store.getState().queueReorder(queueItemId, beforeQueueItemId),
      queueSteerNow: (queueItemId, newSettings) =>
        handle.store.getState().queueSteerNow(queueItemId, newSettings),
      queueAbortSteer: (queueItemId) =>
        handle.store.getState().queueAbortSteer(queueItemId),
      approvalDecision: (approvalId, decision) =>
        handle.store.getState().approvalDecision(approvalId, decision),
      fileEditApprovalDecision: (approvalId, decision) =>
        handle.store.getState().fileEditApprovalDecision(approvalId, decision),
      restoreCheckpoint: (checkpointId, revertArtifacts) =>
        handle.store
          .getState()
          .restoreCheckpoint(checkpointId, revertArtifacts),
      interviewAnswer: (blockId, answers) =>
        handle.store.getState().interviewAnswer(blockId, answers),
      interviewError: (blockId, reason) =>
        handle.store.getState().interviewError(blockId, reason),
      ackFailedSendRestoration: (clientActionId) =>
        handle.store.getState().ackFailedSendRestoration(clientActionId),
      ackAcceptedAction: (clientActionId) =>
        handle.store.getState().ackAcceptedAction(clientActionId),
      takeSetupFailedRestoration: (messageId) =>
        handle.store.getState().takeSetupFailedRestoration(messageId),
    }),
    [handle.store],
  );
}

// Re-exported for consumers that need to know the active-turn shape.
export type { ChatActiveTurn };
