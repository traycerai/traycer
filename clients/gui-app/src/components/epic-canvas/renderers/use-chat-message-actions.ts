import { useCallback, useEffect, useMemo, useRef } from "react";
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
import {
  inlineImageHashesFromSession,
  inlineLocalImageHashes,
} from "@/lib/composer/composer-image-inlining";
import {
  planAttachmentsByHash,
  resolveSendContentByHash,
  sendAttachmentsByHashSupported,
} from "@/lib/composer/attachments-by-hash";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { captureComposerSubmitGeneration } from "@/lib/composer/composer-submit-generation";
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
  // The tab's own client, for the edit-and-resend by-hash gate below. The chat
  // is bound to this host for life, so this is the host the edit is dispatched
  // at and the one whose draft blob tier its uploads have to land in.
  const tabHostClient = useTabHostClient();
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
  // Held across the session-cold image read in `performEditSubmit`: nothing
  // clears the inline editor until the edit is accepted, so a second Enter
  // during that read would submit the same edit twice.
  //
  // It holds the EPOCH the read was started under rather than a bare boolean,
  // so the latch belongs to ONE edit session. A boolean outlived its session in
  // both directions once the epoch below made sessions distinguishable: cancel
  // and reopen during a read left it stuck true and silently swallowed the next
  // submit, and the abandoned read's clear then released the latch out from
  // under the session that had replaced it. `null` is "no read in flight".
  const editImageResolutionEpoch = useRef<number | null>(null);
  /**
   * The LIVE inline edit, for the document generation an async submit reads
   * back after its await. The `activeInlineEdit` the submit callback closed
   * over is the one that existed when the callback was built, which is exactly
   * the stale value the guard exists to detect.
   */
  const activeInlineEditRef = useRef<InlineEditState | null>(activeInlineEdit);
  useEffect(() => {
    activeInlineEditRef.current = activeInlineEdit;
  }, [activeInlineEdit]);
  /**
   * WHICH EDIT SESSION IS LIVE, read at dispatch time rather than through the
   * closure `performEditSubmit` captured at submit time.
   *
   * An edit submit can now await an image read, and an edit is CANCELLABLE
   * across that await — Escape and the Cancel button both just dispatch
   * `clearInlineEdit`. Without this the settled read still called
   * `chatActions.editUserMessage` with the captured target and the captured
   * revert flags, so a cancelled edit rewrote message history and reverted
   * files on disk. `inlineEditIsPending` is no defence: it is set INSIDE the
   * dispatch, so during the read there is nothing for Cancel to refuse and
   * nothing for the dispatch to notice.
   *
   * A monotonic epoch, not the target id: cancelling and reopening the SAME
   * message would otherwise read as the same session and let the abandoned
   * dispatch through. Bumped on both halves of the effect so every transition
   * — begin, cancel, retarget, unmount — invalidates whatever was in flight.
   * Typing does NOT bump it (`inlineEditTargetMessageId` ignores content), so
   * an edit the user is still working on is not cancelled by its own author.
   */
  const editSessionEpoch = useRef(0);

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
  useEffect(() => {
    editSessionEpoch.current += 1;
    return () => {
      editSessionEpoch.current += 1;
    };
  }, [inlineEditTargetMessageId]);
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
      const targetMessageId = activeInlineEdit.targetMessageId;
      // The session this submit belongs to. Revalidated inside `dispatchEdit`,
      // which is the only place that writes.
      const submittedUnderEpoch = editSessionEpoch.current;
      // THE DOCUMENT generation, which the epoch above deliberately is not.
      //
      // The epoch answers "is this still the same edit SESSION" and typing does
      // not bump it - by design, so an edit the user is still working on is not
      // cancelled by its own author. But the submit can now await a blob upload
      // or an IndexedDB read, `editing.pending` stays false until
      // `markInlineEditPending` runs INSIDE the dispatch, and the editor is
      // enabled the whole time. So: submit an image edit A, type B during the
      // upload, and the settled read dispatched A and
      // `normalizeInlineEditForSession` then cleared the live editor on
      // acceptance - destroying B, unsent and unrecoverable. Same failure the
      // composer has `captureComposerSubmitGeneration` for, and the same
      // mechanism rather than a second one shaped differently.
      const editGeneration = captureComposerSubmitGeneration(
        () => activeInlineEditRef.current?.revision ?? -1,
      );
      // AHEAD OF EVERY DISPATCH PATH, the synchronous one below included. It
      // used to sit between them, which left this hole: a first submit goes
      // async on a session-cold image, the cache then warms (or the cold image
      // is removed), a second Enter takes the SYNCHRONOUS path and dispatches
      // at once - and then the first read settles and dispatches the same edit
      // again. `markInlineEditPending` is no defence: it changes neither the
      // target id nor the epoch, so the settling read still recognises its own
      // session. A resolution in flight owns this edit session.
      if (editImageResolutionEpoch.current === submittedUnderEpoch) return;
      const dispatchEdit = (content: JsonContent): void => {
        // The edit was cancelled, retargeted, or unmounted while its images
        // were being read. Rewriting history and reverting files for an edit
        // the user took back is not something a later undo can put right, so
        // this returns before the FIRST write rather than trying to unwind.
        if (editSessionEpoch.current !== submittedUnderEpoch) return;
        // Same session, but a DIFFERENT document: the user typed during the
        // read. Dispatching the capture would send the older text and then
        // `normalizeInlineEditForSession` would clear the editor holding the
        // newer, destroying work still on screen. Leaving the edit open is the
        // recoverable answer - the text is all still there and Enter re-sends
        // it.
        //
        // WHY THIS DOES NOT RE-ENTER THE WAY THE COMPOSER DOES, since the two
        // guards otherwise match: not because the composer has cleared
        // anything by this point - it has not, `clearAcceptedDraft` runs only
        // inside an ACCEPTED dispatch, so both editors still hold their
        // document here. The difference is what the gesture owes the user. The
        // composer's Enter is a SEND: it either completes or puts the prompt
        // back, so a stale capture has to be re-resolved rather than dropped,
        // or the send silently never happens. An edit that is still open owes
        // nothing - the editor is on screen with the newer text in it, and the
        // next Enter is the retry.
        if (!editGeneration.stillCurrent()) return;
        const sent = chatActions.editUserMessage({
          targetMessageId,
          content,
          sender,
          settings: editSettings,
          revertFileChanges,
          revertArtifacts,
        });
        if (sent === null) return;
        dispatchUi({
          type: "markInlineEditPending",
          targetMessageId,
          clientActionId: sent.clientActionId,
          messageId: sent.messageId,
        });
        dispatchUi({
          type: "setConfirmingDeleteMessageId",
          confirmingDeleteMessageId: null,
        });
      };
      const built = buildSubmittedChatJSONContent(
        activeInlineEdit.currentContent,
        slashCatalog,
      );
      // Only the session that took the latch releases it. A read abandoned by a
      // cancel settles late, and by then the latch may belong to the session
      // that replaced it.
      const releaseResolutionLatch = (): void => {
        if (editImageResolutionEpoch.current !== submittedUnderEpoch) return;
        editImageResolutionEpoch.current = null;
      };
      // THE WIRE TAKES HASHES on `chat.subscribe@1.11`, and an edit-and-resend
      // is a send: it goes out on the same stream, through the same host-side
      // materializer, and it is the one send path that was still inlining
      // unconditionally. Same gate as `use-chat-composer-submit.ts`, and
      // deliberately AHEAD of the inline arms below - a host that takes hashes
      // should never be handed base64 this window had to re-read from disk.
      //
      // Best effort on both sides of the gate, as on the composer: an edited
      // message's document routinely holds hashes whose bytes were never local
      // (the message was sent from another window, or its images address the
      // epic's own attachment store), and `resolveSendContentByHash` leaves
      // those hash-only rather than refusing. A hash genuinely lost on both
      // sides comes back as the existing `MISSING_ATTACHMENT_BYTES` rejection.
      const plan = planAttachmentsByHash(built);
      if (
        tabHostClient !== null &&
        plan.eligible.length > 0 &&
        sendAttachmentsByHashSupported(tabHostId)
      ) {
        // Always async - whether the host already holds these bytes is not a
        // question this window can answer from memory - so it takes the same
        // latch the cold-read arm does. The guard that reads the latch sits at
        // the top of this callback, ahead of the synchronous dispatch too.
        editImageResolutionEpoch.current = submittedUnderEpoch;
        // Two-argument `then`: a `catch` chained after the success arm would
        // also catch a throw from `dispatchEdit` and submit the edit twice.
        void resolveSendContentByHash({
          hostId: tabHostId,
          client: tabHostClient,
          content: built,
          plan,
        })
          .then(dispatchEdit, () => {
            // The upload or the byte read failed outright. Dispatch the
            // document as it stands: on a `@1.11` host a hash-only node is a
            // shape the host understands, and one it cannot resolve comes back
            // as the existing rejection, which restores the prompt.
            dispatchEdit(built);
          })
          .finally(releaseResolutionLatch);
        return;
      }
      // Below the minor (or nothing eligible): the edit composer pastes
      // hash-first like every other composer now, so a newly attached image is
      // a hash into THIS window's store and has to go back inline for the host.
      // Images the message already carried are also hash-only, but theirs
      // address the host's EPIC store: those resolve to no local bytes and are
      // deliberately left alone, which is exactly what this path did before -
      // `inlineLocalImageHashes` never refuses.
      const inlined = inlineImageHashesFromSession(built);
      if (inlined !== null) {
        dispatchEdit(inlined);
        return;
      }
      // Taken only once the submit is committed to the async path; the check
      // itself is hoisted above, ahead of the synchronous dispatch.
      editImageResolutionEpoch.current = submittedUnderEpoch;
      // Two-argument `then`: a `catch` chained after the success arm would also
      // catch a throw from `dispatchEdit` and submit the edit twice.
      void inlineLocalImageHashes(built)
        .then(dispatchEdit, () => {
          dispatchEdit(built);
        })
        .finally(releaseResolutionLatch);
    },
    [
      activeInlineEdit,
      canModifyMessages,
      chatActions,
      dispatchUi,
      editSettings,
      profile,
      slashCatalog,
      tabHostClient,
      tabHostId,
    ],
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
