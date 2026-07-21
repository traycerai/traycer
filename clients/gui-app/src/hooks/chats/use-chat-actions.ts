import { useMemo } from "react";
import type {
  ChatRunSettings,
  ChatActiveTurn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
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
  readonly pauseQueue: () => string | null;
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
  readonly updateActiveProfile: (
    harnessId: GuiHarnessId,
    profileId: string | null,
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

/**
 * Emits the semantic event only when the store accepted the dispatch (a
 * `null` result means the action was rejected locally and never left the
 * renderer). Analytics is best-effort by design: a dispatch the host later
 * rejects still counts as the user taking the action.
 */
function tracked<Result>(
  result: Result | null,
  emit: () => void,
): Result | null {
  if (result !== null) emit();
  return result;
}

export function useChatActions(handle: ChatSessionStoreHandle): ChatActions {
  return useMemo<ChatActions>(
    () => ({
      sendMessage: (content, sender, settings) =>
        tracked(
          handle.store.getState().sendMessage(content, sender, settings),
          () => {
            Analytics.getInstance().track(AnalyticsEvent.ChatMessageSent, {
              harness: settings.harnessId,
              mode: settings.agentMode,
            });
          },
        ),
      deleteMessageSuffix: (fromMessageId) =>
        tracked(
          handle.store.getState().deleteMessageSuffix(fromMessageId),
          () => {
            Analytics.getInstance().track(
              AnalyticsEvent.ChatMessageSuffixDeleted,
              null,
            );
          },
        ),
      editUserMessage: (input) =>
        tracked(handle.store.getState().editUserMessage(input), () => {
          Analytics.getInstance().track(AnalyticsEvent.ChatMessageEdited, null);
        }),
      revertFileChanges: (fromMessageId, filePaths, revertArtifacts) =>
        tracked(
          handle.store
            .getState()
            .revertFileChanges(fromMessageId, filePaths, revertArtifacts),
          () => {
            Analytics.getInstance().track(AnalyticsEvent.FileChangesReverted, {
              file_count: filePaths === null ? 0 : filePaths.length,
              revert_artifacts: revertArtifacts,
            });
          },
        ),
      stopTurn: () =>
        tracked(handle.store.getState().stopTurn(), () => {
          Analytics.getInstance().track(AnalyticsEvent.ChatStopped, {
            scope: "current",
          });
        }),
      stopBackgroundItem: (taskId) =>
        tracked(handle.store.getState().stopBackgroundItem(taskId), () => {
          Analytics.getInstance().track(
            AnalyticsEvent.ChatBackgroundItemStopped,
            { scope: "one" },
          );
        }),
      stopAllBackgroundItems: () =>
        tracked(handle.store.getState().stopAllBackgroundItems(), () => {
          Analytics.getInstance().track(
            AnalyticsEvent.ChatBackgroundItemStopped,
            { scope: "all" },
          );
        }),
      pauseQueue: () =>
        tracked(handle.store.getState().pauseQueue(), () => {
          Analytics.getInstance().track(AnalyticsEvent.ChatQueuePaused, null);
        }),
      resumeQueue: () =>
        tracked(handle.store.getState().resumeQueue(), () => {
          Analytics.getInstance().track(AnalyticsEvent.ChatQueueResumed, null);
        }),
      queueEdit: (queueItemId, content) =>
        tracked(handle.store.getState().queueEdit(queueItemId, content), () => {
          Analytics.getInstance().track(
            AnalyticsEvent.ChatQueueItemEdited,
            null,
          );
        }),
      queueSettingsUpdate: (queueItemId, settings) =>
        handle.store.getState().queueSettingsUpdate(queueItemId, settings),
      restampQueuedItemSettings: (settings, excludeQueueItemId) =>
        handle.store
          .getState()
          .restampQueuedItemSettings(settings, excludeQueueItemId),
      updateActivePermissionMode: (permissionMode) =>
        handle.store.getState().updateActivePermissionMode(permissionMode),
      updateActiveProfile: (harnessId, profileId) =>
        handle.store.getState().updateActiveProfile(harnessId, profileId),
      queueCancel: (queueItemId) =>
        tracked(handle.store.getState().queueCancel(queueItemId), () => {
          Analytics.getInstance().track(
            AnalyticsEvent.ChatQueueItemCancelled,
            null,
          );
        }),
      queueReorder: (queueItemId, beforeQueueItemId) =>
        tracked(
          handle.store.getState().queueReorder(queueItemId, beforeQueueItemId),
          () => {
            Analytics.getInstance().track(
              AnalyticsEvent.ChatQueueItemReordered,
              null,
            );
          },
        ),
      queueSteerNow: (queueItemId, newSettings) =>
        tracked(
          handle.store.getState().queueSteerNow(queueItemId, newSettings),
          () => {
            Analytics.getInstance().track(AnalyticsEvent.ChatQueueItemSteered, {
              settings_changed: newSettings !== null,
            });
          },
        ),
      queueAbortSteer: (queueItemId) =>
        handle.store.getState().queueAbortSteer(queueItemId),
      approvalDecision: (approvalId, decision) =>
        tracked(
          handle.store.getState().approvalDecision(approvalId, decision),
          () => {
            Analytics.getInstance().track(AnalyticsEvent.ApprovalDecided, {
              decision: decision.approved ? "approved" : "denied",
            });
          },
        ),
      fileEditApprovalDecision: (approvalId, decision) =>
        tracked(
          handle.store
            .getState()
            .fileEditApprovalDecision(approvalId, decision),
          () => {
            Analytics.getInstance().track(
              AnalyticsEvent.FileEditApprovalDecided,
              { decision: decision.approved ? "approved" : "denied" },
            );
          },
        ),
      restoreCheckpoint: (checkpointId, revertArtifacts) =>
        tracked(
          handle.store
            .getState()
            .restoreCheckpoint(checkpointId, revertArtifacts),
          () => {
            Analytics.getInstance().track(AnalyticsEvent.CheckpointRestored, {
              revert_artifacts: revertArtifacts,
            });
          },
        ),
      interviewAnswer: (blockId, answers) =>
        tracked(
          handle.store.getState().interviewAnswer(blockId, answers),
          () => {
            Analytics.getInstance().track(AnalyticsEvent.InterviewAnswered, {
              answer_count: answers.length,
            });
          },
        ),
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
