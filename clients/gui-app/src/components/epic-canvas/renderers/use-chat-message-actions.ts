import type { ChatMessageDelivery } from "@traycer/protocol/host/agent/gui/message-delivery";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
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
import {
  hashOnlyImageHashes,
  inlineHashOnlyImageBytes,
} from "@/lib/composer/image-atoms";
import { withHeldComposerContentImageRoots } from "@/lib/composer/composer-content-image-roots";
import { toast } from "sonner";

import { appLogger } from "@/lib/logger";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import {
  confirmedDraftBlobHashes,
  currentDraftBlobOwnerId,
  isDraftBlobUnbridgeable,
  putDraftBlobs,
} from "@/lib/drafts/draft-blob-transport";
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

function canEditUserMessage(input: {
  readonly message: ChatMessageModel;
  readonly delivery: ChatMessageDelivery | null;
  readonly canAct: boolean;
  readonly deliveryPending: boolean;
  readonly canModifyMessages: boolean;
}): boolean {
  if (input.message.agentSenderInfo !== null) return false;
  if (input.delivery === null)
    return (
      input.message.providerHistory !== "excluded" && input.canModifyMessages
    );
  return (
    input.canAct &&
    !input.deliveryPending &&
    (input.delivery.state.phase === "pending" ||
      input.delivery.state.phase === "paused")
  );
}

export interface ChatMessageActionsInput {
  readonly dispatchUi: (action: ChatTileUiAction) => void;
  readonly activeInlineEdit: InlineEditState | null;
  readonly canModifyMessages: boolean;
  readonly canAct: boolean;
  readonly messageDelivery?: ChatMessageDelivery | null;
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
  /**
   * Whether THIS chat's live stream can materialize a draft blob from a bare
   * hash (`chat.subscribe@1.12`).
   *
   * A GETTER, not the boolean, and the same shape `useChatComposerSubmit` and
   * the initial-handoff driver take - for the reason
   * `submit-host-held-image-hashes.ts` states at length: an edit's image read is
   * asynchronous, and the capability can change under it. A reconnect onto a
   * downgraded host between Save and the byte read would leave a captured `true`
   * sending bare hashes into a session that cannot resolve them. Read at each
   * consultation, the answer is the one the send will actually meet.
   *
   * It is a per-CHAT fact rather than a per-host one: one host can serve this
   * chat on a stream that understands the bridge and its neighbour on one that
   * does not, which is why it arrives from the tile rather than being read from
   * a module here.
   */
  readonly getDraftBlobBridgeSupported: () => boolean;
}

export interface ChatMessageActionsResult {
  readonly messageActionsFor: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  /**
   * Opens the fork dialog through the given assistant message, or the latest
   * checkpoint when null, pre-configured for the chosen fork mode ("cross-question" =
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
    assistantMessageId: string | null,
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
/**
 * The inline edit as it is RIGHT NOW, published synchronously at every dispatch
 * site rather than read back after React commits.
 *
 * The reducer's copy is a VIEW, and a view arrives late: `dispatchUi` only
 * queues, so an update made while an image preparation is awaiting - an async
 * paste settling, a keystroke - is invisible to every reader outside React
 * until the commit. A layout effect does not help, because the interval that
 * matters is BEFORE any commit happens: the preparation resumes in a microtask
 * and reads a ref that no effect has had a chance to move yet. The send then
 * carried the previous document while the reducer went on to apply the newer
 * one and mark THAT pending, so the acknowledgement closed the editor over an
 * edit that was never sent.
 *
 * So the authority for the DOCUMENT lives here, written before the dispatch that
 * queues the same change, and every send publishes the `revision` it carried.
 *
 * Identity and acknowledgement state are NOT this record's to answer. Which
 * message is being edited, and whether a send is already pending, move through
 * the committed projection - including moves this hook never dispatched, like a
 * rejected dispatch clearing the pending ids so the user can retry. Reading
 * those from here would freeze an editor the projection had already reopened.
 */
interface LiveInlineEdit {
  readonly sessionId: string;
  readonly targetMessageId: string;
  readonly deliveryRevision: number | null;
  readonly initialContent: JsonContent;
  readonly content: JsonContent;
  readonly revision: number;
  /**
   * The revision this hook last put on the wire for this session, or `null`
   * when nothing is outstanding.
   *
   * Not a boolean, and not read from the committed `pendingClientActionId`: a
   * send is dispatched and marked pending in the same breath, so between the
   * send and the commit the committed state still says "nothing pending" and a
   * keystroke landing in that gap passed every gate. The reducer then DROPPED
   * it (its own pending guard had caught up by the time it applied) while this
   * record kept it - leaving a document only the next send could see. Cleared
   * when the committed projection shows the send settled, which is what keeps a
   * REJECTED dispatch editable.
   */
  readonly sentRevision: number | null;
}

/**
 * Is a send outstanding for this edit? Both records answer half of it.
 *
 * The LIVE one covers the window the committed copy cannot: a send is
 * dispatched and marked pending in the same breath, so until that mark commits
 * the projection still says nothing is pending. The COMMITTED one covers a mark
 * this hook instance did not make - a renderer remounted around an open editor
 * inherits a send it never issued.
 */
function inlineEditSendOutstanding(
  live: LiveInlineEdit,
  committed: InlineEditState | null,
): boolean {
  if (live.sentRevision !== null) return true;
  return (
    committed !== null &&
    committed.sessionId === live.sessionId &&
    committed.pendingClientActionId !== null
  );
}

export function useChatMessageActions(
  input: ChatMessageActionsInput,
): ChatMessageActionsResult {
  // The chat is bound to this tab's host for life, so both its own staged
  // slot and the fork scratch slot it seeds belong to that host.
  const tabHostId = useTabHostId();
  // The chat's own host, not the app-wide one, for the same reason `tabHostId`
  // is: the bytes an edit uploads must land where the edit will be sent.
  const tabHostClient = useTabHostClient();
  const {
    dispatchUi,
    activeInlineEdit,
    canModifyMessages,
    canAct,
    messageDelivery = null,
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
    getDraftBlobBridgeSupported,
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

  /** See `LiveInlineEdit`: the authority for what a send would carry. */
  const liveInlineEditRef = useRef<LiveInlineEdit | null>(null);
  /**
   * The last COMMITTED edit, and its ONLY job is to re-seed the live record.
   *
   * The reducer lives above this hook, so its state can outlive this hook's own
   * instance - a tile whose renderer remounts around an open editor would find
   * `liveInlineEditRef` empty and refuse to save. Effect timing is fine for a
   * fallback: it is consulted only when there is no live record at all, never to
   * second-guess one.
   */
  const committedInlineEditRef = useRef(activeInlineEdit);

  /**
   * The live record, adopting the committed edit when this hook has none yet.
   * Seeds the live ref on adoption so the async continuations below - which have
   * no render-time value to fall back on - always find one.
   */
  const currentLiveInlineEdit = useCallback((): LiveInlineEdit | null => {
    const committed = committedInlineEditRef.current;
    const live = liveInlineEditRef.current;
    if (committed === null) return null;
    // Identity from the COMMITTED state, document from the live record: a
    // committed edit that disagrees about which session or which message is
    // being edited is a different edit, and the live record belongs to the one
    // it replaced.
    if (
      live !== null &&
      live.sessionId === committed.sessionId &&
      live.targetMessageId === committed.targetMessageId
    ) {
      return live;
    }
    const adopted: LiveInlineEdit = {
      sessionId: committed.sessionId,
      targetMessageId: committed.targetMessageId,
      deliveryRevision: committed.messageDeliveryRevision ?? null,
      initialContent: committed.initialContent,
      content: committed.currentContent,
      revision: committed.revision,
      // A remount around an open editor adopts whatever the projection says,
      // including a send that is still outstanding.
      sentRevision:
        committed.pendingClientActionId === null ? null : committed.revision,
    };
    liveInlineEditRef.current = adopted;
    return adopted;
  }, []);

  const beginInlineEdit = useCallback(
    (message: ChatMessageModel) => {
      const delivery =
        messageDelivery?.messageId === message.persistentMessageId
          ? messageDelivery
          : null;
      const canEditDelivery =
        canAct &&
        delivery !== null &&
        (delivery.state.phase === "pending" ||
          delivery.state.phase === "paused");
      if (
        message.providerHistory === "excluded"
          ? !canEditDelivery
          : !canModifyMessages
      )
        return;
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
      // Minted here, not in the reducer: React may invoke a reducer twice and
      // `uuidv4()` would answer differently each time.
      const sessionId = uuidv4();
      liveInlineEditRef.current = {
        sessionId,
        targetMessageId: persistentMessageId,
        deliveryRevision: delivery?.revision ?? null,
        initialContent: content,
        content,
        revision: 0,
        sentRevision: null,
      };
      dispatchUi({
        type: "beginInlineEdit",
        messageDeliveryRevision: delivery?.revision,
        sessionId,
        targetMessageId: persistentMessageId,
        originalMessage: message,
        initialContent: content,
      });
    },
    [activeInlineEdit, canAct, canModifyMessages, dispatchUi, messageDelivery],
  );

  const updateInlineEdit = useCallback(
    (content: JsonContent, _selection: { from: number; to: number }) => {
      const live = currentLiveInlineEdit();
      if (live === null) return;
      // Mirrors the reducer's own guard: once a send is out, the editor is
      // frozen until it settles.
      if (inlineEditSendOutstanding(live, committedInlineEditRef.current)) {
        return;
      }
      const revision = live.revision + 1;
      liveInlineEditRef.current = { ...live, content, revision };
      dispatchUi({ type: "updateInlineEditContent", content, revision });
    },
    [currentLiveInlineEdit, dispatchUi],
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
      edit: LiveInlineEdit,
      draftImageBase64ByHash: ReadonlyMap<string, string>,
      revertFileChanges: boolean,
      revertArtifacts: boolean,
    ) => {
      if (edit.deliveryRevision !== null ? !canAct : !canModifyMessages) return;
      const sender = userMessageSenderForProfile(profile);
      if (sender === null) return;
      const content = buildSubmittedChatJSONContent(
        inlineHashOnlyImageBytes(edit.content, draftImageBase64ByHash),
        slashCatalog,
      );
      const source = messages.find(
        (message) => message.messageId === edit.targetMessageId,
      );
      const sent =
        edit.deliveryRevision !== null
          ? chatActions.messageDeliveryEdit({
              messageId: edit.targetMessageId,
              expectedRevision: edit.deliveryRevision,
              content,
              browserAnnotations:
                source?.role === "user" && source.message.kind === "user"
                  ? source.message.browserAnnotations
                  : [],
            })
          : chatActions.editUserMessage({
              targetMessageId: edit.targetMessageId,
              content,
              sender,
              settings: editSettings,
              revertFileChanges,
              revertArtifacts,
            });
      if (sent === null) return;
      // Before the dispatch, for the same reason the content is live at all:
      // this is what freezes the editor, and a value that only becomes true at
      // commit is not read by anything running before it.
      if (liveInlineEditRef.current?.sessionId === edit.sessionId) {
        liveInlineEditRef.current = { ...edit, sentRevision: edit.revision };
      }
      dispatchUi({
        type: "markInlineEditPending",
        targetMessageId: edit.targetMessageId,
        clientActionId: sent.clientActionId,
        messageId: sent.messageId,
        // What this send actually carried. The reducer refuses the mark if the
        // committed edit has moved past it.
        sentRevision: edit.revision,
      });
      dispatchUi({
        type: "setConfirmingDeleteMessageId",
        confirmingDeleteMessageId: null,
      });
    },
    [
      canModifyMessages,
      canAct,
      messages,
      chatActions,
      dispatchUi,
      editSettings,
      profile,
      slashCatalog,
    ],
  );
  // The LATEST send, for the continuation below: `submitPreparedEdit` gets a
  // fresh identity whenever its own inputs move, and a value captured before an
  // await is stale by construction. LAYOUT-timed so it is in place before the
  // browser paints the render that produced it.
  const submitPreparedEditRef = useRef(submitPreparedEdit);
  useLayoutEffect(() => {
    submitPreparedEditRef.current = submitPreparedEdit;
  }, [submitPreparedEdit]);
  // The document itself is NOT mirrored through an effect - see `LiveInlineEdit`
  // for why no effect timing can cover it. What an effect IS right for is the
  // projection: `activeInlineEdit` can become null with no dispatch at all (an
  // acknowledgement settles the edit through `projectInlineEditAgainstState`),
  // and the live record has to follow it down or it outlives its editor.
  useLayoutEffect(() => {
    committedInlineEditRef.current = activeInlineEdit;
    if (activeInlineEdit === null) {
      liveInlineEditRef.current = null;
      return;
    }
    // A send that is no longer pending has settled, and a REJECTED dispatch
    // settles by reopening the editor - so the freeze has to lift here rather
    // than stay latched on the record. Accepted sends never reach this: the
    // projection answers `null` for them and the branch above runs instead.
    const live = liveInlineEditRef.current;
    if (
      live !== null &&
      live.sessionId === activeInlineEdit.sessionId &&
      live.sentRevision !== null &&
      activeInlineEdit.pendingClientActionId === null
    ) {
      liveInlineEditRef.current = { ...live, sentRevision: null };
    }
  }, [activeInlineEdit]);
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
      // The live record, not the committed projection: the whole decision below
      // - which hashes need inlining, and therefore whether this send is
      // synchronous at all - is about the document that would be SENT.
      const live = currentLiveInlineEdit();
      if (live === null) return;
      if (inlineEditSendOutstanding(live, committedInlineEditRef.current)) {
        return;
      }
      // The images this editor was SEEDED with are the sent message's own, so
      // the epic already holds them and they travel as bare hashes exactly as
      // they always have. Only what the user added since is this client's to
      // supply. Re-inlining the inherited ones would put the whole screenshot
      // back on a wire that has been carrying a 64-character hash.
      const missing = new Set(
        messageDelivery?.state.phase === "paused"
          ? messageDelivery.state.missingHashes
          : [],
      );
      const inherited = new Set(
        blobHashesFromContent(live.initialContent).filter(
          (hash) => !missing.has(hash),
        ),
      );
      // ...and what this client has since PUT on the host joins them, because a
      // digest the host acknowledges holding is a digest it can materialize.
      //
      // The ordinary send's `submitHostHeldImageHashes` in the same union, and
      // deliberately not a call to it: that function's inherited half comes from
      // the composer incarnation registry, which an inline edit has no entry in -
      // its seeded document IS its record. Everything below the first line is
      // that function, so read its docblock for the argument; what follows is
      // only what differs.
      //
      // Recomputed at every call rather than captured: the upload below widens
      // it mid-flight, and the chat's stream can lose the bridge while an
      // image read is still running. Both readings have to be as of NOW - which
      // is also why `getDraftBlobBridgeSupported` is a getter and not the
      // boolean this render saw.
      const hostHeldFor = (content: JsonContent): ReadonlySet<string> => {
        if (!getDraftBlobBridgeSupported()) return inherited;
        const confirmed = confirmedDraftBlobHashes(
          tabHostId,
          currentDraftBlobOwnerId(),
          hashOnlyImageHashes(content),
        );
        if (confirmed.size === 0) return inherited;
        const held = new Set(inherited);
        for (const hash of confirmed) {
          // A digest this host has refused by FORMAT is subtracted even when it
          // is otherwise confirmed: both can be true after a downgrade, and the
          // refusal is the more recent and more specific fact.
          if (isDraftBlobUnbridgeable(tabHostId, hash)) continue;
          held.add(hash);
        }
        return held;
      };
      const pending = draftImageInliningNeeded(
        live.content,
        hostHeldFor(live.content),
      );
      // The editing SESSION, not just its target. Cancel-and-reopen of the same
      // message keeps `targetMessageId` and is a different edit entirely - the
      // user did not press send on it.
      const sessionId = live.sessionId;
      if (pending.length === 0) {
        submitPreparedEdit(
          live,
          NO_DRAFT_IMAGE_BYTES,
          revertFileChanges,
          revertArtifacts,
        );
        return;
      }
      if (editImagePrepFlight.current === sessionId) return;
      editImagePrepFlight.current = sessionId;
      const targetMessageId = live.targetMessageId;
      // `currentContent` lives only in this tile's reducer, so while the read
      // runs it is the sole thing naming these bytes to the image GC.
      // A LABEL; the helper mints the per-acquisition key. See its doc.
      const rootsLabel = `inline-edit-submit:${targetMessageId}`;
      // The hold/release try/finally lives in the helper: a `try` without a
      // `catch` in a hook body defeats the React Compiler's memoization.
      // The live document's hash-only images MINUS anything host-held, read as
      // of NOW. Hoisted out of the `prepareDraftImageInlining` argument because
      // the upload below has to be followed by exactly this read: the set that
      // survives an upload is the set that still owes bytes.
      const readRequiredHashes = (): ReadonlyArray<string> => {
        const current = currentLiveInlineEdit();
        if (current === null) return [];
        if (current.sessionId !== sessionId) return [];
        return draftImageInliningNeeded(
          current.content,
          hostHeldFor(current.content),
        );
      };
      void withHeldComposerContentImageRoots(
        rootsLabel,
        live.content,
        async () => {
          // UPLOAD FIRST, and inline only what the upload could not place.
          //
          // The order is the whole point of the arm. `prepareDraftImageInlining`
          // reads bytes for its `initialHashes` unconditionally on the first
          // pass, so a set computed before the upload would be read, base64'd
          // and committed even for digests the host had meanwhile acked - the
          // megabyte back on a wire that was about to carry 64 characters.
          //
          // Inside the held roots, so the bytes this reads are the ones the GC
          // is being told not to collect. Before the reconcile loop, because
          // that loop's first act is the read this upload exists to avoid.
          //
          // FAIL-CLOSED per digest and by construction, not by checking: the
          // return value is ignored because the only thing that widens
          // `hostHeldFor` is the confirmation `putDraftBlobs` records, and it
          // records one only for a digest the host acked. A missing local blob,
          // a digest mismatch, an over-cap body, a failed put, a host that
          // withholds the methods - every one of them simply leaves the hash in
          // the required set below, where it inlines exactly as it did before
          // this arm existed.
          //
          // Only `pending` is offered. An image pasted DURING the upload is not
          // chased with a second one: it arrives in the reconcile loop and
          // travels inline, which costs bytes and never an image.
          if (tabHostClient !== null && getDraftBlobBridgeSupported()) {
            await putDraftBlobs(
              tabHostId,
              tabHostClient,
              pending,
              // Read at the upload. An account switch between Save and here
              // must record the confirmation against whoever is signed in NOW,
              // because that is who `hostHeldFor` will ask about.
              currentDraftBlobOwnerId(),
            );
          }
          await prepareDraftImageInlining({
            // Post-upload, so a digest the host just acked is never read for
            // bytes. Empty is the ordinary outcome of a successful upload, and
            // it is a real state here rather than a degenerate one: the loop
            // resolves nothing, finds nothing missing, and commits an empty map
            // - which is the synchronous send with every node left hash-only.
            initialHashes: readRequiredHashes(),
            // The edit composer's bytes are mirrored to the CHAT's own host,
            // not the app-wide one, and the live mirror session is resolved
            // here rather than captured in render.
            target: draftImageByteTargetForHost(tabHostId),
            readRequiredHashes,
            // Synchronous with the final required-set read: no image can
            // arrive between that check and this send.
            commit: (base64ByHash) => {
              const current = currentLiveInlineEdit();
              // A different target, a closed edit, or one the user already sent
              // is a different intent; sending the captured document would send
              // text the user can no longer see.
              if (
                current === null ||
                current.targetMessageId !== targetMessageId
              ) {
                return;
              }
              // A cancelled-and-reopened edit of the SAME message is a new
              // session, and this preparation belongs to the old one.
              if (current.sessionId !== sessionId) return;
              // Already sent and awaiting its acknowledgement.
              if (
                inlineEditSendOutstanding(
                  current,
                  committedInlineEditRef.current,
                )
              ) {
                return;
              }
              submitPreparedEditRef.current(
                current,
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
        // this unhandled. The flag is cleared by its `finally` either way.
        appLogger.error(
          "[chat-tile] inline edit image preparation failed",
          { targetMessageId },
          error,
        );
        // And the user is TOLD. Third surface with this shape - the chat
        // composer toasts and the new-conversation modal raises a notice - and
        // the one where silence reads worst: Save simply finishes with the
        // editor still open and nothing changed.
        toast.error("Couldn't prepare the images in this edit.", {
          description: "The edit is still open - try saving again.",
        });
      });
    },
    [
      currentLiveInlineEdit,
      messageDelivery,
      dispatchUi,
      getDraftBlobBridgeSupported,
      submitPreparedEdit,
      tabHostClient,
      tabHostId,
    ],
  );

  const submitInlineEdit = useCallback(() => {
    if (activeInlineEdit === null) return;
    if (activeInlineEdit.messageDeliveryRevision !== undefined) {
      if (canAct) performEditSubmit(false, false);
      return;
    }
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
    canAct,
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
  // `assistantMessageId`, or the latest available checkpoint when null. Shared
  // by the host picker, per-message fork buttons, and interview actions.
  // Cross Question seeds the source binding VERBATIM (same working copy:
  // local stays local, an existing worktree is adopted — matching the "+ chat"
  // defaults in a Task) and settles carried questions as reference. A/B Fork
  // REBASES each folder to the chat's actual working-copy directory (a
  // worktree-bound folder's base becomes the origin worktree path) and
  // pre-selects a new worktree off that base's working tree; unanswered
  // carried questions re-open as answerable.
  const forkAtAssistantMessage = useCallback(
    (
      assistantMessageId: string | null,
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

  const deliveryPending = Object.values(pendingActions).some(
    (action) =>
      action.action === "messageDeliveryEdit" ||
      action.action === "messageDeliveryRetry" ||
      action.action === "messageDeliveryCancel",
  );
  const deliveryActions = useMemo(
    () => ({
      pending: deliveryPending,
      onRetry: () => {
        if (messageDelivery !== null)
          chatActions.messageDeliveryRetry(
            messageDelivery,
            currentComposerSettings,
          );
      },
      onCancel: () => {
        if (messageDelivery !== null)
          chatActions.messageDeliveryCancel(messageDelivery);
      },
    }),
    [chatActions, currentComposerSettings, deliveryPending, messageDelivery],
  );

  const userMessageActionsFor = useCallback(
    (message: ChatMessageModel): ChatMessageActions | null => {
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
      const delivery =
        messageDelivery?.messageId === persistentMessageId &&
        messageDelivery.state.phase !== "started"
          ? messageDelivery
          : null;
      const canEdit = canEditUserMessage({
        message,
        delivery,
        canAct,
        deliveryPending,
        canModifyMessages,
      });
      if (!canModifyMessages && editing === null && delivery === null)
        return null;
      if (message.providerHistory === "excluded" && delivery === null)
        return null;
      const pending = inlineEditIsPending(editing);

      return {
        type: "user",
        enabled: canEdit && !pending,
        delivery:
          delivery === null
            ? undefined
            : {
                ...deliveryActions,
                state: delivery.state,
                canAct: canAct && !deliveryPending && !pending,
              },
        confirmingDelete: confirmingDeleteMessageId === persistentMessageId,
        editing: chatMessageEditingForInlineEdit({
          editing,
          canModifyMessages: canEdit,
          editSettings,
          mentionRoots,
          fallbackToGlobalMentionRoots,
          currentEpicId,
          onSnapshot: updateInlineEdit,
          onSubmit: submitInlineEdit,
          onCancel: () => {
            if (pending) return;
            liveInlineEditRef.current = null;
            dispatchUi({ type: "clearInlineEdit" });
          },
        }),
        onEdit: () => beginInlineEdit(message),
        onDeleteRequest: () => {
          liveInlineEditRef.current = null;
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
      deliveryActions,
      deliveryPending,
      dispatchUi,
      editSettings,
      fallbackToGlobalMentionRoots,
      mentionRoots,
      messageDelivery,
      submitInlineEdit,
      updateInlineEdit,
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
      return userMessageActionsFor(message);
    },
    [
      canAct,
      interviewDeliveryRetryProtocolSupported,
      pendingActions,
      acceptedActions,
      chatActions,
      forkAtAssistantMessage,
      userMessageActionsFor,
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
