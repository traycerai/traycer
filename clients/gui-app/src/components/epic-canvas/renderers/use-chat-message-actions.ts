import { useCallback, useMemo, useRef } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import type {
  ChatForkMode,
  ChatMessageActions,
} from "@/components/chat/chat-message";
import {
  buildAbForkWorkspaceSeed,
  buildForkWorkspaceSeed,
} from "@/lib/worktree/fork-workspace-seed";
import {
  pendingForkChatStagingKey,
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { EMPTY_COMPOSER_DRAFT } from "@/stores/composer/composer-draft-store";
import type {
  ChatSessionState,
  ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import type { AuthProfile } from "@/stores/auth/auth-store";
import type { ChatForkDialogTarget } from "@/components/chat/chat-fork-dialog";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import {
  hasUndoableFileEditsFromMessage,
  scopedArtifactCountFromMessage,
} from "@/lib/chat/file-edits-below-message";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import {
  editablePersistentMessageId,
  forkableAssistantMessageId,
  forkableDuringInterviewAssistantMessageId,
  userMessageSenderForProfile,
} from "./chat-tile-session-state";
import type {
  ChatTileUiAction,
  InlineEditState,
} from "./chat-tile-session-state";
import type { PendingInterviewView } from "./chat-tile-types";

/** A composer submit captured for the message-edit path. */
export interface MessageEditSubmission {
  /** Already-submitted composer JSON (image atoms inline). */
  readonly content: JsonContent;
  readonly settings: ChatRunSettings;
}

export interface ChatMessageActionsInput {
  readonly dispatchUi: (action: ChatTileUiAction) => void;
  /**
   * Session-store handle for call-time reads (`getState()`) inside submit
   * callbacks. `submitActiveMessageEdit` flows into the composer's
   * `onSubmitMessage`, so it must NOT close over the per-snapshot
   * `messages`/`events` arrays - that identity churn would re-render the
   * composer on every streamed token (see steerQueuedItemNow for the same
   * pattern).
   */
  readonly handle: ChatSessionStoreHandle;
  readonly activeInlineEdit: InlineEditState | null;
  readonly canModifyMessages: boolean;
  readonly canAct: boolean;
  readonly currentComposerSettings: ChatRunSettings;
  readonly currentEpicId: string;
  readonly node: EpicNodeRef;
  readonly chatTitle: string | null;
  readonly chatParentId: string | null;
  readonly messages: ChatSessionState["messages"];
  readonly events: ChatSessionState["events"];
  readonly profile: AuthProfile | null;
  readonly chatActions: ChatActions;
  readonly confirmingDeleteMessageId: string | null;
  readonly setForkTarget: (target: ChatForkDialogTarget | null) => void;
  // The chat's currently host-pending interview, if any. Enables forking during
  // Q&A: while the assistant is asking a question, the fork affordance is
  // offered on the interview-owning message (and the interview card) so the user
  // can branch off and cross-question the assistant.
  readonly pendingInterview: PendingInterviewView | null;
  // The source chat's live binding, used to seed the fork dialog's workspace
  // picker so a fork starts from the same folders / worktree modes.
  readonly worktreeBinding: WorktreeBinding | null;
  readonly revertOnEditOpen: boolean;
  /**
   * Draft-store writer for this chat's bottom composer. The pencil loads the
   * edited message's content into the composer through this (mirroring
   * queue-item editing), and a dialog-path submit clears it after the edit
   * frame is accepted.
   */
  readonly replaceDraftContent: (
    nodeId: string,
    content: JsonContent,
    context: null,
  ) => void;
}

export interface ChatMessageActionsResult {
  readonly messageActionsFor: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  /**
   * Opens the fork dialog to branch the chat through the given assistant
   * message, pre-configured for the chosen fork mode ("cross-question" =
   * source binding verbatim + carried questions settled as reference;
   * "ab-worktree" = new worktrees carrying the working tree + carried
   * questions re-opened as answerable). Used by the pending-interview card's
   * actions; the per-message fork buttons route through the same seed.
   */
  readonly forkAtAssistantMessage: (
    assistantMessageId: string,
    mode: ChatForkMode,
  ) => void;
  /**
   * Routes a bottom-composer submit into the active message edit. Returns
   * true when the edit frame was sent (the composer should clear); false when
   * nothing was sent - either no edit is active, a guard failed, or the
   * revert-on-edit dialog was opened (the draft must stay put until the
   * dialog decides).
   */
  readonly submitActiveMessageEdit: (
    submission: MessageEditSubmission,
  ) => boolean;
  /** Ends message-edit mode; the composer keeps its text as a plain draft. */
  readonly cancelActiveMessageEdit: () => void;
  readonly revertOnEdit: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly onRevert: (revertArtifacts: boolean) => void;
    readonly onDontRevert: () => void;
    readonly artifactCount: number;
  };
}

/**
 * Encapsulates message-level actions (edit, delete, fork) and the
 * message-edit lifecycle. Editing happens in the BOTTOM COMPOSER: the pencil
 * loads the message content as the composer draft (exactly like editing a
 * queued item), the composer's full toolbar applies to the resubmit, and the
 * chat tile routes the next submit here via `submitActiveMessageEdit`.
 *
 * All callbacks preserve the same `useCallback` dependency structure as the
 * original view-model so memoized children are not disturbed.
 */
export function useChatMessageActions(
  input: ChatMessageActionsInput,
): ChatMessageActionsResult {
  const {
    dispatchUi,
    handle,
    activeInlineEdit,
    canModifyMessages,
    canAct,
    currentComposerSettings,
    currentEpicId,
    node,
    chatTitle,
    chatParentId,
    messages,
    events,
    profile,
    chatActions,
    confirmingDeleteMessageId,
    setForkTarget,
    pendingInterview,
    worktreeBinding,
    replaceDraftContent,
  } = input;

  // The submit captured while the revert-on-edit dialog decides. A ref (not
  // state): it is written and consumed within user-action handlers only and
  // must never trigger renders.
  const pendingEditSubmission = useRef<MessageEditSubmission | null>(null);

  const beginMessageEdit = useCallback(
    (message: ChatMessageModel) => {
      if (!canModifyMessages) return;
      if (message.persistentMessageId === null) return;
      if (message.structuredContent === null) return;
      // Load the message into the bottom composer as the edit draft. The
      // reducer clears queue-edit mode (the two edit modes share the draft).
      replaceDraftContent(
        node.id,
        structuredClone(message.structuredContent),
        null,
      );
      dispatchUi({
        type: "beginInlineEdit",
        targetMessageId: message.persistentMessageId,
        originalMessage: message,
      });
    },
    [canModifyMessages, dispatchUi, node.id, replaceDraftContent],
  );

  /**
   * Sends the edit frame for the stashed submission. Returns true when the
   * frame went out (edit mode cleared); the caller owns clearing the
   * composer draft for its path.
   */
  const performEditSubmit = useCallback(
    (revertFileChanges: boolean, revertArtifacts: boolean): boolean => {
      // Always dismiss the modal first - if any guard below bails (the edit
      // was invalidated by an incoming snapshot, etc.) the modal must not be
      // left open with dead buttons.
      dispatchUi({ type: "setRevertOnEditOpen", open: false });
      const submission = pendingEditSubmission.current;
      pendingEditSubmission.current = null;
      if (submission === null) return false;
      if (activeInlineEdit === null) return false;
      if (!canModifyMessages) return false;
      const sender = userMessageSenderForProfile(profile);
      if (sender === null) return false;
      const sent = chatActions.editUserMessage({
        targetMessageId: activeInlineEdit.targetMessageId,
        content: submission.content,
        sender,
        settings: submission.settings,
        revertFileChanges,
        revertArtifacts,
      });
      if (sent === null) return false;
      dispatchUi({ type: "clearInlineEdit" });
      dispatchUi({
        type: "setConfirmingDeleteMessageId",
        confirmingDeleteMessageId: null,
      });
      return true;
    },
    [activeInlineEdit, canModifyMessages, chatActions, dispatchUi, profile],
  );

  const submitActiveMessageEdit = useCallback(
    (submission: MessageEditSubmission): boolean => {
      if (activeInlineEdit === null) return false;
      if (!canModifyMessages) return false;
      if (userMessageSenderForProfile(profile) === null) return false;
      pendingEditSubmission.current = submission;
      // Editing a message with reversible edits below it prompts for a revert
      // first; the composer keeps the draft until the dialog decides. Read the
      // live history at call time (not the per-snapshot props) so this
      // callback stays stream-stable - it feeds the composer's submit path.
      const session = handle.store.getState();
      if (
        hasUndoableFileEditsFromMessage(
          session.messages,
          session.events,
          activeInlineEdit.targetMessageId,
        )
      ) {
        dispatchUi({ type: "setRevertOnEditOpen", open: true });
        return false;
      }
      return performEditSubmit(false, true);
    },
    [
      activeInlineEdit,
      canModifyMessages,
      dispatchUi,
      handle.store,
      performEditSubmit,
      profile,
    ],
  );

  const cancelActiveMessageEdit = useCallback(() => {
    dispatchUi({ type: "clearInlineEdit" });
    // Also discard any submission stashed for the revert-on-edit dialog and
    // close it: cancelling the edit while that dialog is open would otherwise
    // leave `pendingEditSubmission` pointed at the now-cleared target and the
    // dialog able to fire an edit against it.
    pendingEditSubmission.current = null;
    dispatchUi({ type: "setRevertOnEditOpen", open: false });
  }, [dispatchUi]);

  // Dialog-path submits bypass the composer's own submit/clear cycle, so the
  // draft (still holding the edited text) is cleared here once the frame is
  // accepted.
  const performDialogEditSubmit = useCallback(
    (revertFileChanges: boolean, revertArtifacts: boolean): void => {
      if (!performEditSubmit(revertFileChanges, revertArtifacts)) return;
      replaceDraftContent(node.id, EMPTY_COMPOSER_DRAFT.content, null);
    },
    [node.id, performEditSubmit, replaceDraftContent],
  );

  const deleteMessageSuffix = useCallback(
    (messageId: string) => {
      if (!canModifyMessages) return;
      if (chatActions.deleteMessageSuffix(messageId) !== null) {
        dispatchUi({
          type: "setConfirmingDeleteMessageId",
          confirmingDeleteMessageId: null,
        });
      }
    },
    [canModifyMessages, chatActions, dispatchUi],
  );

  // Open the fork dialog seeded to branch the source chat through
  // `assistantMessageId`. Shared by the per-message fork buttons and the
  // pending interview card's actions so all entry points seed identically.
  // Cross Question seeds the source binding VERBATIM (same working copy:
  // local stays local, an existing worktree is adopted — matching the "+ chat"
  // defaults in a Task) and settles carried questions as reference. A/B Fork
  // REBASES each folder to the chat's actual working-copy directory (a
  // worktree-bound folder's base becomes the origin worktree path) and
  // pre-selects a new worktree off that base's working tree; carried questions
  // re-open as answerable.
  const forkAtAssistantMessage = useCallback(
    (assistantMessageId: string, mode: ChatForkMode) => {
      const sourceStagingKey: WorktreeStagingKey = {
        surface: "owner",
        epicId: currentEpicId,
        ownerKind: "chat",
        ownerId: node.id,
      };
      const seedInput = {
        binding: worktreeBinding,
        stagedIntent: readStagedWorktreeIntent(sourceStagingKey),
      };
      const workspaceSeed =
        mode === "ab-worktree"
          ? buildAbForkWorkspaceSeed(seedInput)
          : buildForkWorkspaceSeed(seedInput);
      // Seed the fork dialog's picker from the source chat's currently visible
      // workspace (its binding overlaid with any unsent staged choices) so it
      // opens exactly where the source chat's composer is. The dialog applies
      // this through the shared seedIntent -> seedEntryForFolder path the
      // terminal-agent launcher also uses; only the source owner differs (here,
      // the chat being forked).
      useWorktreeIntentStagingStore
        .getState()
        .clear(pendingForkChatStagingKey(currentEpicId));
      setForkTarget({
        sourceChatId: node.id,
        sourceChatTitle: chatTitle ?? node.name,
        assistantMessageId,
        parentId: chatParentId,
        settingsSeed: currentComposerSettings,
        workspaceSeed,
        seedIntentOverride:
          mode === "ab-worktree" ? "worktree-carry" : null,
        // Cross Question forks want the carried question as inert reference
        // with a free composer; A/B forks re-open it as an answerable card so
        // the user can answer differently and proceed.
        carriedInterviews: mode === "cross-question" ? "settled" : "pending",
        forkMode: mode,
      });
    },
    [
      chatParentId,
      chatTitle,
      currentComposerSettings,
      currentEpicId,
      node.id,
      node.name,
      setForkTarget,
      worktreeBinding,
    ],
  );

  const messageActionsFor = useCallback(
    (message: ChatMessageModel): ChatMessageActions | null => {
      // Ordinary fork (completed assistant message) OR fork during Q&A: while a
      // pending interview is open, the in-flight message that owns it is also a
      // valid fork boundary so the user can branch off to cross-question.
      const assistantMessageId =
        forkableAssistantMessageId(message) ??
        forkableDuringInterviewAssistantMessageId(message, pendingInterview);
      if (assistantMessageId !== null) {
        if (!canAct) return null;
        return {
          type: "assistant",
          fork: {
            enabled: true,
            pending: false,
            onFork: (mode: ChatForkMode) =>
              forkAtAssistantMessage(assistantMessageId, mode),
          },
        };
      }
      const persistentMessageId = editablePersistentMessageId(message);
      if (persistentMessageId === null) return null;
      if (!canModifyMessages) return null;

      return {
        type: "user",
        enabled: canModifyMessages,
        confirmingDelete: confirmingDeleteMessageId === persistentMessageId,
        isEditTarget: activeInlineEdit?.targetMessageId === persistentMessageId,
        onEdit: () => beginMessageEdit(message),
        onDeleteRequest: () => {
          dispatchUi({ type: "clearInlineEdit" });
          dispatchUi({
            type: "setConfirmingDeleteMessageId",
            confirmingDeleteMessageId: persistentMessageId,
          });
        },
        onDeleteConfirm: () => {
          deleteMessageSuffix(persistentMessageId);
        },
        onDeleteCancel: () => {
          dispatchUi({
            type: "setConfirmingDeleteMessageId",
            confirmingDeleteMessageId: null,
          });
        },
      };
    },
    [
      activeInlineEdit,
      beginMessageEdit,
      canAct,
      canModifyMessages,
      confirmingDeleteMessageId,
      deleteMessageSuffix,
      dispatchUi,
      forkAtAssistantMessage,
      pendingInterview,
    ],
  );

  const handleRevertOnEditOpenChange = useCallback(
    (open: boolean): void => {
      dispatchUi({ type: "setRevertOnEditOpen", open });
    },
    [dispatchUi],
  );

  const revertOnEditArtifactCount = useMemo(
    () =>
      activeInlineEdit === null
        ? 0
        : scopedArtifactCountFromMessage(
            messages,
            events,
            activeInlineEdit.targetMessageId,
          ),
    [activeInlineEdit, events, messages],
  );

  return {
    messageActionsFor,
    forkAtAssistantMessage,
    submitActiveMessageEdit,
    cancelActiveMessageEdit,
    revertOnEdit: {
      open: input.revertOnEditOpen,
      onOpenChange: handleRevertOnEditOpenChange,
      onRevert: (revertArtifacts: boolean) =>
        performDialogEditSubmit(true, revertArtifacts),
      onDontRevert: () => performDialogEditSubmit(false, true),
      artifactCount: revertOnEditArtifactCount,
    },
  };
}
