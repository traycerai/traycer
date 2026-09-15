import { useCallback, useEffect, useMemo, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import type {
  ChatForkMode,
  ChatMessageActions,
} from "@/components/chat/chat-message";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  buildAbForkWorkspaceSeed,
  buildForkWorkspaceSeed,
} from "@/lib/worktree/fork-workspace-seed";
import {
  readStagedWorktreeIntent,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { clearChatForkWorkspacesForEpic } from "@/lib/worktree/chat-fork-workspace-staging";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type {
  ChatSessionState,
  InterviewDeliveryRetryIdentity,
} from "@/stores/chats/chat-session-store";
import type { AuthProfile } from "@/stores/auth/auth-store";
import type { ChatForkDialogTarget } from "@/components/chat/chat-fork-dialog";
import type { ChatSurfaceNode } from "./chat-tile-types";
import {
  editSubmitNeedsRevertPrompt,
  resolveRevertScope,
  revertPromptArtifactCount,
  type RevertScope,
} from "@/lib/chat/file-edits-below-message";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";
import {
  buildSubmittedChatJSONContent,
  type SlashCommandCatalog,
} from "@/lib/composer/tiptap-json-content";
import { inlineHashOnlyImageBytes } from "@/lib/composer/image-atoms";
import { withHeldComposerContentImageRoots } from "@/lib/composer/composer-content-image-roots";
import { appLogger } from "@/lib/logger";
import { blobHashesFromContent } from "@/lib/drafts/draft-write-codec";
import {
  draftImageInliningNeeded,
  prepareDraftImageInlining,
} from "@/lib/drafts/draft-image-inlining";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
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
  readonly interviewDeliveryRetryProtocolSupported: boolean;
  readonly currentComposerSettings: ChatRunSettings;
  readonly editSettings: ChatRunSettings;
  /**
   * The tile's loaded command catalog, or null when it has not loaded. An edit
   * resubmit re-runs `buildSubmittedChatJSONContent`, so it needs the same
   * catalog the original send used - otherwise a `$skill` the user retyped
   * after deleting its chip would silently stay prose.
   */
  readonly slashCatalog: SlashCommandCatalog | null;
  readonly mentionRoots: ReadonlyArray<string>;
  readonly fallbackToGlobalMentionRoots: boolean;
  readonly currentEpicId: string;
  readonly node: ChatSurfaceNode;
  readonly chatTitle: string | null;
  readonly chatParentId: string | null;
  readonly messages: ChatSessionState["messages"];
  readonly events: ChatSessionState["events"];
  /**
   * The hydration state behind `messages`/`events`, or `null` on the legacy
   * line where those two ARE the whole transcript. Read only by the
   * revert-scope resolution, which is the one thing here that scans DOWNWARD
   * from a message and so cannot treat the two arrays as complete.
   */
  readonly transcriptWindow: TranscriptWindow | null;
  readonly profile: AuthProfile | null;
  readonly chatActions: ChatActions;
  readonly pendingActions: ChatSessionState["pendingActions"];
  readonly acceptedActions: ChatSessionState["acceptedActions"];
  readonly confirmingDeleteMessageId: string | null;
  readonly setForkTarget: (target: ChatForkDialogTarget | null) => void;
  // The source chat's live binding, used to seed the fork dialog's workspace
  // picker so a fork starts from the same folders / worktree modes.
  readonly worktreeBinding: WorktreeBinding | null;
  readonly revertOnEditOpen: boolean;
  /**
   * Items currently parked in the message queue. They survive a history edit
   * untouched and send after the replacement turn; the revert-on-edit dialog
   * surfaces the count so that isn't a surprise.
   */
  readonly queuedCount: number;
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
   *
   * `initialHostId` preselects the dialog's host picker — the host-switch
   * gesture passes the host the user picked there; every per-message entry
   * point passes `null` (open on the source chat's own host).
   */
  readonly forkAtAssistantMessage: (
    assistantMessageId: string,
    mode: ChatForkMode,
    interviewBlockId: string | null,
    initialHostId: string | null,
  ) => void;
  readonly revertOnEdit: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly onRevert: (revertArtifacts: boolean) => void;
    readonly onDontRevert: () => void;
    /**
     * `null` when the transcript below the edit point is not fully hydrated, so
     * the count would be an under-count rather than a measurement. The dialog
     * renders the artifact opt-out without a number in that case - see
     * {@link RevertScope}.
     */
    readonly artifactCount: number | null;
    readonly queuedCount: number;
  };
}

/**
 * The synchronous path's empty resolution map - every edit whose images came
 * from the sent message it is editing, which is all of them until a composer
 * starts minting hashes of its own.
 */
const NO_DRAFT_IMAGE_BYTES: ReadonlyMap<string, string> = new Map<
  string,
  string
>();

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
  // The chat is bound to this tab's host for life, so both its own staged
  // slot and the fork scratch slot it seeds belong to that host.
  const tabHostId = useTabHostId();
  const {
    dispatchUi,
    activeInlineEdit,
    canModifyMessages,
    canAct,
    interviewDeliveryRetryProtocolSupported,
    currentComposerSettings,
    editSettings,
    slashCatalog,
    mentionRoots,
    fallbackToGlobalMentionRoots,
    currentEpicId,
    node,
    chatTitle,
    chatParentId,
    messages,
    events,
    transcriptWindow,
    profile,
    chatActions,
    pendingActions,
    acceptedActions,
    confirmingDeleteMessageId,
    setForkTarget,
    worktreeBinding,
  } = input;

  /**
   * What a revert from the message being edited would touch.
   *
   * Resolved once for both readers below - the submit gate and the dialog's
   * artifact count - because they are two halves of one prompt and must not be
   * able to disagree about its scope.
   */
  // Keyed on the target id alone, NOT on `activeInlineEdit`: that object gets a
  // fresh identity on every `updateInlineEditContent`, i.e. per keystroke,
  // while the scope depends only on which message is being edited. Widening it
  // back would re-run three transcript passes for each character typed.
  const inlineEditTargetMessageId = activeInlineEdit?.targetMessageId ?? null;
  const revertScope = useMemo<RevertScope | null>(
    () =>
      inlineEditTargetMessageId === null
        ? null
        : resolveRevertScope({
            messages,
            events,
            transcriptWindow,
            fromMessageId: inlineEditTargetMessageId,
          }),
    [inlineEditTargetMessageId, events, messages, transcriptWindow],
  );

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
        // Minted here, not in the reducer: React may invoke a reducer twice and
        // `uuidv4()` would answer differently each time.
        sessionId: uuidv4(),
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

  /**
   * The edit send itself, over the inline-edit state that is going to be sent.
   *
   * `edit` is a parameter rather than the closed-over `activeInlineEdit`
   * because the byte-resolution branch below re-reads the LIVE edit after its
   * await - the reducer mints a fresh `currentContent` on every keystroke, so
   * the captured one is stale by the time a host read returns.
   */
  const submitPreparedEdit = useCallback(
    (
      edit: InlineEditState,
      draftImageBase64ByHash: ReadonlyMap<string, string>,
      revertFileChanges: boolean,
      revertArtifacts: boolean,
    ) => {
      if (!canModifyMessages) return;
      const sender = userMessageSenderForProfile(profile);
      if (sender === null) return;
      const sent = chatActions.editUserMessage({
        targetMessageId: edit.targetMessageId,
        content: buildSubmittedChatJSONContent(
          inlineHashOnlyImageBytes(edit.currentContent, draftImageBase64ByHash),
          slashCatalog,
        ),
        sender,
        settings: editSettings,
        revertFileChanges,
        revertArtifacts,
      });
      if (sent === null) return;
      dispatchUi({
        type: "markInlineEditPending",
        targetMessageId: edit.targetMessageId,
        clientActionId: sent.clientActionId,
        messageId: sent.messageId,
      });
      dispatchUi({
        type: "setConfirmingDeleteMessageId",
        confirmingDeleteMessageId: null,
      });
    },
    [
      canModifyMessages,
      chatActions,
      dispatchUi,
      editSettings,
      profile,
      slashCatalog,
    ],
  );
  // The LIVE inline edit and the LATEST send, for the continuation below. Both
  // move while a byte read is in flight - the document on every keystroke, the
  // send's own guards on every render - and a value captured before the await
  // is stale by construction.
  const activeInlineEditRef = useRef(activeInlineEdit);
  const submitPreparedEditRef = useRef(submitPreparedEdit);
  useEffect(() => {
    activeInlineEditRef.current = activeInlineEdit;
    submitPreparedEditRef.current = submitPreparedEdit;
  }, [activeInlineEdit, submitPreparedEdit]);
  /**
   * The edit SESSION whose image preparation is in flight, or `null`.
   *
   * A session rather than a boolean. The continuation'"'"'s `sessionId` checks
   * already stop an obsolete preparation from sending, but a bare flag stayed
   * set until that obsolete I/O settled - so an edit cancelled and reopened
   * while a read was outstanding met the guard below and its Send did nothing,
   * silently and with no pending state shown, for as long as a host or cloud
   * timeout takes. Keyed by session, a new edit is never blocked by an old
   * one'"'"'s flight, and the old flight still cannot send.
   */
  const editImagePrepFlight = useRef<string | null>(null);

  const performEditSubmit = useCallback(
    (revertFileChanges: boolean, revertArtifacts: boolean) => {
      // Always dismiss the modal first - if any guard below bails (the inline
      // edit was invalidated by an incoming snapshot, etc.) the modal must not
      // be left open with dead buttons.
      dispatchUi({ type: "setRevertOnEditOpen", open: false });
      if (activeInlineEdit === null) return;
      // The images this editor was SEEDED with are the sent message's own, so
      // the epic already holds them and they travel as bare hashes exactly as
      // they always have. Only what the user added since is this client's to
      // supply. Re-inlining the inherited ones would put the whole screenshot
      // back on a wire that has been carrying a 64-character hash.
      const hostHeld = new Set(
        blobHashesFromContent(activeInlineEdit.initialContent),
      );
      const pending = draftImageInliningNeeded(
        activeInlineEdit.currentContent,
        hostHeld,
      );
      // The editing SESSION, not just its target. Cancel-and-reopen of the same
      // message keeps `targetMessageId` and is a different edit entirely - the
      // user did not press send on it.
      const sessionId = activeInlineEdit.sessionId;
      if (pending.length === 0) {
        submitPreparedEdit(
          activeInlineEdit,
          NO_DRAFT_IMAGE_BYTES,
          revertFileChanges,
          revertArtifacts,
        );
        return;
      }
      if (editImagePrepFlight.current === sessionId) return;
      editImagePrepFlight.current = sessionId;
      const targetMessageId = activeInlineEdit.targetMessageId;
      // `currentContent` lives only in this tile's reducer, so while the read
      // runs it is the sole thing naming these bytes to the image GC.
      // A LABEL; the helper mints the per-acquisition key. See its doc.
      const rootsLabel = `inline-edit-submit:${targetMessageId}`;
      // The hold/release try/finally lives in the helper: a `try` without a
      // `catch` in a hook body defeats the React Compiler's memoization.
      void withHeldComposerContentImageRoots(
        rootsLabel,
        activeInlineEdit.currentContent,
        async () => {
          await prepareDraftImageInlining({
            initialHashes: pending,
            // The edit composer's bytes are mirrored to the CHAT's own host,
            // not the app-wide one, and the live mirror session is resolved
            // here rather than captured in render.
            target: draftImageByteTargetForHost(tabHostId),
            readRequiredHashes: () => {
              const current = activeInlineEditRef.current;
              if (current === null) return [];
              if (current.sessionId !== sessionId) return [];
              return draftImageInliningNeeded(current.currentContent, hostHeld);
            },
            // Synchronous with the final required-set read: no image can
            // arrive between that check and this send.
            commit: (base64ByHash) => {
              const live = activeInlineEditRef.current;
              // A different target, a closed edit, or one the user already sent
              // is a different intent; sending the captured document would send
              // text the user can no longer see.
              if (live === null || live.targetMessageId !== targetMessageId) {
                return;
              }
              // A cancelled-and-reopened edit of the SAME message is a new
              // session, and this preparation belongs to the old one.
              if (live.sessionId !== sessionId) return;
              if (live.pendingClientActionId !== null) return;
              submitPreparedEditRef.current(
                live,
                base64ByHash,
                revertFileChanges,
                revertArtifacts,
              );
            },
          });
        },
        () => {
          // Only if this flight still owns the slot: a newer session'"'"'s
          // preparation may have claimed it while this one was in the air, and
          // clearing it then would unblock a double-send for that session.
          if (editImagePrepFlight.current === sessionId) {
            editImagePrepFlight.current = null;
          }
        },
      ).catch((error: unknown) => {
        // The helper propagates rather than swallowing, so `void` alone left
        // this unhandled. The flag is cleared by its `finally` either way; what
        // this adds is a record that the edit was abandoned.
        appLogger.error(
          "[chat-tile] inline edit image preparation failed",
          { targetMessageId },
          error,
        );
      });
    },
    [activeInlineEdit, dispatchUi, submitPreparedEdit, tabHostId],
  );

  const submitInlineEdit = useCallback(() => {
    if (activeInlineEdit === null) return;
    if (!canModifyMessages) return;
    if (userMessageSenderForProfile(profile) === null) return;
    // Editing a previous message with reversible edits below it - or a history
    // this side cannot see the bottom of - prompts for a revert first;
    // otherwise submit straight through. See `editSubmitNeedsRevertPrompt`.
    //
    // Null only when there is no active edit, which the guard above already
    // returned on - the memo is keyed by the same value.
    if (revertScope === null) return;
    if (editSubmitNeedsRevertPrompt(revertScope)) {
      dispatchUi({ type: "setRevertOnEditOpen", open: true });
      return;
    }
    performEditSubmit(false, true);
  }, [
    activeInlineEdit,
    canModifyMessages,
    dispatchUi,
    performEditSubmit,
    profile,
    revertScope,
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
      initialHostId: string | null,
    ) => {
      const sourceStagingKey: WorktreeStagingKey = {
        surface: "owner",
        hostId: tabHostId,
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
          : buildForkWorkspaceSeed({
              ...seedInput,
              hostId: tabHostId,
            });
      // Seed the fork dialog's picker from the source chat's currently visible
      // workspace (its binding overlaid with any unsent staged choices) so it
      // opens exactly where the source chat's composer is. The dialog applies
      // this through the shared seedIntent -> seedEntryForFolder path the
      // terminal-agent launcher also uses; only the source owner differs (here,
      // the chat being forked).
      // Every host's slot, not just this tab's: the dialog can retarget while
      // it is open, so a previous fork that moved to another machine before
      // closing would otherwise leave that machine's folders staged for the
      // next open.
      clearChatForkWorkspacesForEpic(currentEpicId);
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
        initialHostId,
      });
    },
    [
      chatParentId,
      chatTitle,
      tabHostId,
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
      const interviewDeliveryRetry =
        canAct && interviewDeliveryRetryProtocolSupported
          ? {
              isPending: (identity: InterviewDeliveryRetryIdentity): boolean =>
                [
                  ...Object.values(pendingActions),
                  ...Object.values(acceptedActions),
                ].some((action) => {
                  const pendingIdentity = action.interviewDeliveryRetry;
                  return (
                    pendingIdentity !== null &&
                    pendingIdentity.blockId === identity.blockId &&
                    pendingIdentity.settlementId === identity.settlementId &&
                    pendingIdentity.deliveryId === identity.deliveryId &&
                    pendingIdentity.generation === identity.generation
                  );
                }),
              onRetry: (identity: InterviewDeliveryRetryIdentity): void => {
                chatActions.interviewDeliveryRetry(identity);
              },
            }
          : null;
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
                null,
              ),
          },
          interviewDeliveryRetry,
        };
      }
      if (message.role === "assistant" && interviewDeliveryRetry !== null) {
        return {
          type: "assistant",
          fork: null,
          interviewDeliveryRetry,
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
          fallbackToGlobalMentionRoots,
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
      fallbackToGlobalMentionRoots,
      forkAtAssistantMessage,
      interviewDeliveryRetryProtocolSupported,
      mentionRoots,
      pendingActions,
      acceptedActions,
      chatActions,
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

  const revertOnEditArtifactCount = revertPromptArtifactCount(revertScope);

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
      queuedCount: input.queuedCount,
    },
  };
}
