import { useCallback, useMemo } from "react";
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
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import type { AuthProfile } from "@/stores/auth/auth-store";
import type { ChatForkDialogTarget } from "@/components/chat/chat-fork-dialog";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import {
  hasUndoableFileEditsFromMessage,
  scopedArtifactCountFromMessage,
} from "@/lib/chat/file-edits-below-message";
import { buildSubmittedChatJSONContent } from "@/lib/composer/tiptap-json-content";
import type { ChatActions } from "@/hooks/chats/use-chat-actions";
import {
  chatMessageEditingForInlineEdit,
  editablePersistentMessageId,
  forkableAssistantMessageId,
  forkableInterviewAssistantMessageId,
  inlineEditForPersistentMessage,
  inlineEditIsPending,
  inlineEditLocksMessageActions,
  userMessageSenderForProfile,
} from "./chat-tile-session-state";
import type {
  ChatTileUiAction,
  InlineEditState,
} from "./chat-tile-session-state";

export interface ChatMessageActionsInput {
  readonly dispatchUi: (action: ChatTileUiAction) => void;
  readonly activeInlineEdit: InlineEditState | null;
  readonly canModifyMessages: boolean;
  readonly canAct: boolean;
  readonly currentComposerSettings: ChatRunSettings;
  readonly editSettings: ChatRunSettings;
  readonly mentionRoots: ReadonlyArray<string>;
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
  // The source chat's live binding, used to seed the fork dialog's workspace
  // picker so a fork starts from the same folders / worktree modes.
  readonly worktreeBinding: WorktreeBinding | null;
  readonly revertOnEditOpen: boolean;
}

export interface ChatMessageActionsResult {
  readonly messageActionsFor: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  /**
   * Opens the fork dialog to branch the chat through the given assistant
   * message, pre-configured for the chosen fork mode ("cross-question" =
   * source binding verbatim + carried questions settled as reference;
   * "ab-worktree" = new worktrees carrying the working tree + unanswered
   * carried questions re-opened as answerable). Used by pending and resolved
   * interview actions; the per-message fork buttons route through the same
   * seed.
   */
  readonly forkAtAssistantMessage: (
    assistantMessageId: string,
    mode: ChatForkMode,
    interviewBlockId: string | null,
  ) => void;
  readonly revertOnEdit: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly onRevert: (revertArtifacts: boolean) => void;
    readonly onDontRevert: () => void;
    readonly artifactCount: number;
  };
}

/**
 * Encapsulates the inline-edit lifecycle (begin, update, submit, delete) and the
 * `messageActionsFor` factory that wires them into the per-message action surface.
 *
 * All callbacks preserve the same `useCallback` dependency structure as the
 * original view-model so memoized children are not disturbed.
 */
export function useChatMessageActions(
  input: ChatMessageActionsInput,
): ChatMessageActionsResult {
  const {
    dispatchUi,
    activeInlineEdit,
    canModifyMessages,
    canAct,
    currentComposerSettings,
    editSettings,
    mentionRoots,
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
    worktreeBinding,
  } = input;

  const beginInlineEdit = useCallback(
    (message: ChatMessageModel) => {
      if (!canModifyMessages) return;
      if (message.persistentMessageId === null) return;
      if (message.structuredContent === null) return;
      const persistentMessageId = message.persistentMessageId;
      if (
        activeInlineEdit !== null &&
        activeInlineEdit.targetMessageId !== persistentMessageId &&
        activeInlineEdit.dirty
      ) {
        return;
      }
      const content = structuredClone(message.structuredContent);
      dispatchUi({
        type: "beginInlineEdit",
        targetMessageId: persistentMessageId,
        originalMessage: message,
        initialContent: content,
      });
    },
    [activeInlineEdit, canModifyMessages, dispatchUi],
  );

  const updateInlineEdit = useCallback(
    (content: JsonContent, _selection: { from: number; to: number }) => {
      dispatchUi({ type: "updateInlineEditContent", content });
    },
    [dispatchUi],
  );

  const performEditSubmit = useCallback(
    (revertFileChanges: boolean, revertArtifacts: boolean) => {
      // Always dismiss the modal first - if any guard below bails (the inline
      // edit was invalidated by an incoming snapshot, etc.) the modal must not
      // be left open with dead buttons.
      dispatchUi({ type: "setRevertOnEditOpen", open: false });
      if (activeInlineEdit === null) return;
      if (!canModifyMessages) return;
      const sender = userMessageSenderForProfile(profile);
      if (sender === null) return;
      const sent = chatActions.editUserMessage({
        targetMessageId: activeInlineEdit.targetMessageId,
        content: buildSubmittedChatJSONContent(activeInlineEdit.currentContent),
        sender,
        settings: editSettings,
        revertFileChanges,
        revertArtifacts,
      });
      if (sent === null) return;
      dispatchUi({
        type: "markInlineEditPending",
        targetMessageId: activeInlineEdit.targetMessageId,
        clientActionId: sent.clientActionId,
        messageId: sent.messageId,
      });
      dispatchUi({
        type: "setConfirmingDeleteMessageId",
        confirmingDeleteMessageId: null,
      });
    },
    [
      activeInlineEdit,
      canModifyMessages,
      chatActions,
      dispatchUi,
      editSettings,
      profile,
    ],
  );

  const submitInlineEdit = useCallback(() => {
    if (activeInlineEdit === null) return;
    if (!canModifyMessages) return;
    if (userMessageSenderForProfile(profile) === null) return;
    // Editing a previous message with reversible edits below it prompts for
    // a revert first; otherwise submit straight through.
    if (
      hasUndoableFileEditsFromMessage(
        messages,
        events,
        activeInlineEdit.targetMessageId,
      )
    ) {
      dispatchUi({ type: "setRevertOnEditOpen", open: true });
      return;
    }
    performEditSubmit(false, true);
  }, [
    activeInlineEdit,
    canModifyMessages,
    dispatchUi,
    events,
    messages,
    performEditSubmit,
    profile,
  ]);

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
  // interview actions so all entry points seed identically.
  // Cross Question seeds the source binding VERBATIM (same working copy:
  // local stays local, an existing worktree is adopted — matching the "+ chat"
  // defaults in a Task) and settles carried questions as reference. A/B Fork
  // REBASES each folder to the chat's actual working-copy directory (a
  // worktree-bound folder's base becomes the origin worktree path) and
  // pre-selects a new worktree off that base's working tree; unanswered
  // carried questions re-open as answerable.
  const forkAtAssistantMessage = useCallback(
    (
      assistantMessageId: string,
      mode: ChatForkMode,
      interviewBlockId: string | null,
    ) => {
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
        interviewBlockId,
        parentId: chatParentId,
        settingsSeed: currentComposerSettings,
        workspaceSeed,
        seedIntentOverride: mode === "ab-worktree" ? "worktree-carry" : null,
        // A/B forks re-open a carried question as an answerable card so the
        // user can answer differently and proceed; plain and Cross Question
        // forks leave it settled (inert reference, composer free). Moot for a
        // plain fork of a completed message — no streaming interview to carry.
        carriedInterviews: mode === "ab-worktree" ? "pending" : "settled",
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
      // A completed assistant message exposes the plain footer fork. A stable
      // message with a resolved interview also exposes its Q&A fork icons while
      // the rest of that assistant turn may still be running.
      const plainForkMessageId = forkableAssistantMessageId(message);
      const hasTerminalInterview = message.segments.some(
        (segment) =>
          segment.kind === "interview" &&
          segment.status !== "streaming" &&
          !segment.forkedWithoutAnswer,
      );
      const interviewForkMessageId = hasTerminalInterview
        ? forkableInterviewAssistantMessageId(message)
        : null;
      const assistantMessageId = plainForkMessageId ?? interviewForkMessageId;
      if (assistantMessageId !== null) {
        if (!canAct) return null;
        return {
          type: "assistant",
          fork: {
            enabled: true,
            pending: false,
            onFork: (mode, interviewBlockId) =>
              forkAtAssistantMessage(
                assistantMessageId,
                mode,
                interviewBlockId,
              ),
          },
        };
      }
      const persistentMessageId = editablePersistentMessageId(message);
      if (persistentMessageId === null) return null;
      if (
        inlineEditLocksMessageActions(activeInlineEdit, persistentMessageId)
      ) {
        return null;
      }

      const editing = inlineEditForPersistentMessage(
        activeInlineEdit,
        persistentMessageId,
      );
      if (!canModifyMessages && editing === null) return null;
      const pending = inlineEditIsPending(editing);

      return {
        type: "user",
        enabled: canModifyMessages && !pending,
        confirmingDelete: confirmingDeleteMessageId === persistentMessageId,
        editing: chatMessageEditingForInlineEdit({
          editing,
          canModifyMessages,
          editSettings,
          mentionRoots,
          currentEpicId,
          onSnapshot: updateInlineEdit,
          onSubmit: submitInlineEdit,
          onCancel: () => {
            if (pending) return;
            dispatchUi({ type: "clearInlineEdit" });
          },
        }),
        onEdit: () => beginInlineEdit(message),
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
      beginInlineEdit,
      canAct,
      canModifyMessages,
      confirmingDeleteMessageId,
      currentEpicId,
      deleteMessageSuffix,
      dispatchUi,
      editSettings,
      forkAtAssistantMessage,
      mentionRoots,
      submitInlineEdit,
      updateInlineEdit,
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
    revertOnEdit: {
      open: input.revertOnEditOpen,
      onOpenChange: handleRevertOnEditOpenChange,
      onRevert: (revertArtifacts: boolean) =>
        performEditSubmit(true, revertArtifacts),
      onDontRevert: () => performEditSubmit(false, true),
      artifactCount: revertOnEditArtifactCount,
    },
  };
}
