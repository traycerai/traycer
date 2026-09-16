import { sniffImageMimeType } from "@/lib/composer/prompt-stash-image-signature";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

import { blurTextEntry } from "@/components/layout/shell/shell-gestures";
import { isMobileApp } from "@/lib/mobile-app";
import { useChatStore } from "@/stores/composer/chat-store";
import { submitComposerDraft } from "@/lib/drafts/draft-mirror-coordinator";
import { readComposerDraftSnapshot } from "@/stores/composer/composer-draft-store";
import { toast } from "sonner";

import { appLogger } from "@/lib/logger";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  appendImageAttachmentAtoms,
  containsImageAtoms,
  hashOnlyImageHashes,
  inlineHashOnlyImageBytes,
} from "@/lib/composer/image-atoms";
import {
  clearHostHeldImageHashes,
  NO_HOST_HELD_HASHES,
} from "@/lib/composer/host-held-image-hashes";
import { submitHostHeldImageHashes } from "@/lib/composer/submit-host-held-image-hashes";
import { reinlineRefusedSendContent } from "@/lib/drafts/draft-image-retry-content";
import { currentDraftBlobOwnerId } from "@/lib/drafts/draft-blob-transport";
import { withHeldComposerContentImageRoots } from "@/lib/composer/composer-content-image-roots";
import {
  draftImageInliningNeeded,
  prepareDraftImageInlining,
} from "@/lib/drafts/draft-image-inlining";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  getImageBytes,
  sessionImageBytes,
} from "@/lib/composer/landing-image-store";
import type { BrowserAnnotationRecord } from "@/lib/browser-view/annotation/browser-annotation-record";
import type { ChatSendRestore } from "@/stores/chats/chat-session-store";
import { v4 as uuidv4 } from "uuid";
import {
  buildAttachmentsFromJSONContent,
  buildSubmittedChatJSONContent,
  extractPlainTextFromComposerJSONContent,
} from "@/lib/composer/tiptap-json-content";
import { buildChatRunSettings } from "@/lib/composer/chat-run-settings";
import { decideSteerSettings } from "@/lib/chats/decide-steer-settings";
import {
  resolveSubmitDeliveryPolicy,
  type ChatComposerSubmitSource,
} from "@/lib/chats/resolve-steer-submit";
import { splitLeadingSideChatCommand } from "@/lib/chats/side-chat-command";
import type { ComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import type { Attachment } from "@/lib/composer/types";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ChatComposerSubmitInput } from "./chat-composer";
import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";

interface UseChatComposerSubmitArgs {
  readonly taskId: string;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly pickerStore: ComposerPickerStore;
  /**
   * Toolbar settings source. Read via `getState()` at submit time (the
   * sanctioned escape hatch) so this callback stays referentially stable
   * across model/permission/reasoning changes. This also owns the
   * model-resolution gate: an empty slug is the transient "catalog still
   * loading" marker and must never reach the wire as `model: ""` - the
   * editor's Enter handler calls this directly, bypassing the send button's
   * `canSubmit` gate, so the block is checked here.
   */
  readonly toolbarStore: ComposerToolbarStore;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  /**
   * Whether the running turn's harness supports same-turn steering, projected
   * from the host `activeTurn.sameTurnSteeringSupported` capability. Gates
   * whether a `Mod-Enter` steers or falls back to plain queueing (decision 5).
   */
  readonly steerCapable: boolean;
  /** App-wide opt-out preference (default ON - decision 17). */
  readonly steerEnabled: boolean;
  /**
   * Whether the tab's negotiated `chat.subscribe` protocol version understands
   * `after_safe_point` (host handshake minor >= 5). `false` degrades `Mod-Enter`
   * to plain-Enter queueing so a new renderer never steers a released <=1.4 host
   * that predates same-turn steering.
   */
  readonly steerProtocolSupported: boolean;
  /**
   * Reads the live active turn at submit time (not a reactive prop) so the
   * settings-drift comparison never re-creates this callback per streamed
   * token - mirrors `steerQueuedItemNow`'s live-turn read.
   */
  readonly getActiveTurnForSteer: () => ChatActiveTurn | null;
  readonly hasPendingApprovals: boolean;
  readonly sendDisabled: boolean | undefined;
  /**
   * True when the bound workspace folder can't back a turn (none linked, or
   * the host resolved no existing folder). The editor's Enter handler calls
   * this directly, bypassing the send button's `canSubmit` gate, so the block
   * is re-checked here.
   */
  readonly workspaceBlocked: boolean;
  readonly imagesUnsupported: boolean;
  readonly attachmentPreparationPending: boolean;
  readonly onSubmitMessage:
    | ((input: ChatComposerSubmitInput) => boolean)
    | null;
  /**
   * Handles a prompt that leads with `/btw` / `/side`
   * (`lib/chats/side-chat-command.ts`): fork the chat and ask the remainder
   * there, instead of sending it here. Returning `false` keeps the composer
   * text, exactly like a refused `onSubmitMessage`. `null` where there is no
   * chat to fork; the prompt then goes through the ordinary send untouched.
   */
  readonly onSideChat: ((input: ChatComposerSideChatInput) => boolean) | null;
  /**
   * The host this composer submits to - its tab's host, which is also the host
   * its draft mirror uploaded blobs to. That equivalence is what makes
   * `drafts.readBlob` the right second leg when submit has to resolve a
   * hash-only image node's bytes.
   */
  readonly targetHostId: string | null;
  /**
   * The queued prompt this composer is currently editing, or `null` for an
   * ordinary send. Part of the submit INTENT: `onSubmitMessage`'s destination
   * is chosen from this id, so a preparation that started while editing Q must
   * not deliver into whatever the composer is pointed at when it finishes.
   */
  readonly queueEditTargetId: string | null;
  /**
   * Whether THIS chat's live stream can materialize a hash-only draft image at
   * send (T1's `chat.subscribe` 1.11 capability). The gate is per-session and
   * not app-wide: one host can serve one chat on a bridging stream and another
   * on a 1.9 one.
   *
   * A GETTER bound to the session store, deliberately - the same shape as
   * `getActiveTurnForSteer`, and for a sharper version of the same reason. A
   * render prop is a value from the last COMMITTED render, and a ref refreshed
   * in an effect is the last committed EFFECT; neither is the store. A stream
   * transition to a non-bridging session queued between two microtasks of an
   * image preparation is visible in the store and not yet in either copy, and
   * the final required-hash read then authorizes a bare hash on a stream that
   * cannot resolve it. Reading the store at the decision is the only version
   * of this that is true when it is asked.
   */
  readonly getDraftBlobBridgeSupported: () => boolean;
}

export interface ChatComposerSideChatInput {
  /** The prompt with the command token stripped; may be empty (bare `/btw`). */
  readonly content: JsonContent;
  readonly settings: ChatRunSettings;
}

interface PendingSteerConflict {
  // The submit INTENT only - deliberately NOT the resolved `deliveryPolicy`. The
  // policy is re-resolved from the CURRENT connection/turn state at confirmation
  // time (see `onRestart`), so a host reconnect/downgrade or turn-end while the
  // dialog is open can never let a stale `after_safe_point` slip past the
  // negotiated gate.
  readonly content: JsonContent;
  readonly contentText: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly restore: ChatSendRestore;
  readonly settings: ChatRunSettings;
  readonly changed: ReadonlyArray<string>;
  // The turnId this consent was DISPLAYED for. The composer persists across turn
  // replacement, so a dialog opened for turn T1 must never confirm into a
  // successor T2: at confirm time `onRestart` re-reads the live turn and only
  // steers/restarts when it is still this same turn. `null` when the drift was
  // computed against no active turn (defensive; a real interrupt_restart drift
  // always has one).
  readonly originTurnId: string | null;
}

export interface ChatComposerSubmitResult {
  readonly submitDraft: (source: ChatComposerSubmitSource) => void;
  readonly annotationPreparationPending: boolean;
  /**
   * Confirm-dialog state for a `Mod-Enter` steer whose settings differ from the
   * running turn's baked settings (decision 6). Open means the send is staged
   * behind an interrupt-and-restart confirmation; the composer text is kept
   * until the user confirms or cancels.
   */
  readonly steerConflict: {
    readonly open: boolean;
    readonly changed: ReadonlyArray<string>;
    readonly onOpenChange: (open: boolean) => void;
    readonly onRestart: () => void;
  };
}

export function useChatComposerSubmit(
  args: UseChatComposerSubmitArgs,
): ChatComposerSubmitResult {
  const {
    taskId,
    editorRef,
    pickerStore,
    toolbarStore,
    activeTurnStatus,
    steerCapable,
    steerEnabled,
    steerProtocolSupported,
    getActiveTurnForSteer,
    hasPendingApprovals,
    sendDisabled,
    workspaceBlocked,
    imagesUnsupported,
    attachmentPreparationPending,
    onSubmitMessage,
    onSideChat,
    targetHostId,
    queueEditTargetId,
    getDraftBlobBridgeSupported,
  } = args;
  const appendMessage = useChatStore((state) => state.appendMessage);
  // The LIVE queue-edit target, for the continuation to re-check. A captured
  // value cannot answer "is this still the submit the user asked for" - that is
  // precisely the question, and the closure froze its answer at preparation
  // time. Same shape the other latest-value bridges in this tree use.
  //
  // LAYOUT-timed, like every other latest-value bridge in this hook. A passive
  // effect can run after an awaited read resumes in the post-commit microtask,
  // so the "live" value would be the one from the render before the change -
  // which is the staleness these refs exist to remove.
  const queueEditTargetIdRef = useRef(queueEditTargetId);
  useLayoutEffect(() => {
    queueEditTargetIdRef.current = queueEditTargetId;
  }, [queueEditTargetId]);
  const [pendingConflict, setPendingConflict] =
    useState<PendingSteerConflict | null>(null);
  // The LIVE staged conflict, for the deferred confirm's continuation to
  // re-check. Its closure froze `pendingConflict` at the render that started
  // the read, which is precisely the value that cannot answer "is this consent
  // still standing".
  const conflictStagedRef = useRef<PendingSteerConflict | null>(null);
  useLayoutEffect(() => {
    conflictStagedRef.current = pendingConflict;
  }, [pendingConflict]);
  // One confirmation flight at a time, so repeated clicks cannot start a
  // second read or produce a second send.
  const conflictInliningFlight = useRef(false);
  const [annotationPreparationPending, setAnnotationPreparationPending] =
    useState(false);
  const annotationPrepFlight = useRef(false);

  // Everything an ACCEPTED submit does to the composer, shared by the send and
  // the side-chat paths so a refused one leaves the text in place on both.
  const clearAcceptedDraft = useCallback((): void => {
    void submitComposerDraft(taskId);
    pickerStore.getState().reset();
    // The inherited queue-edit document is gone with the send, so its
    // host-custody claim goes with it. Hygiene only - a stale entry would leave
    // a hash bare on a later send, which is what this composer did before any
    // of this existed.
    clearHostHeldImageHashes(taskId);
    editorRef.current?.clear();
    // A rejected send leaves the text in place, and dropping the keyboard
    // there would take the user away from the message they still have to fix.
    // On a phone the keyboard covers most of the screen, so holding it open
    // after a send hides the reply the send was for.
    if (isMobileApp()) blurTextEntry();
  }, [editorRef, pickerStore, taskId]);

  const finalizeSend = useCallback(
    (input: ChatComposerSubmitInput): boolean => {
      const accepted =
        onSubmitMessage !== null
          ? onSubmitMessage(input)
          : (appendMessage(taskId, {
              role: "user",
              content: input.content,
              contentText: input.contentText,
              attachments: input.attachments,
              settings: input.settings,
            }),
            true);
      if (!accepted) return false;
      clearAcceptedDraft();
      return true;
    },
    [appendMessage, clearAcceptedDraft, onSubmitMessage, taskId],
  );

  // The conditions that block a live submit, shared verbatim between the live
  // `submitDraft` path and the deferred `onRestart` confirm so a guard added to
  // one path can never miss the other.
  const submitBlocked = useCallback(
    (): boolean =>
      activeTurnStatus === "stopping" ||
      hasPendingApprovals ||
      sendDisabled === true ||
      workspaceBlocked ||
      imagesUnsupported ||
      attachmentPreparationPending,
    [
      activeTurnStatus,
      attachmentPreparationPending,
      hasPendingApprovals,
      imagesUnsupported,
      sendDisabled,
      workspaceBlocked,
    ],
  );

  // The LIVE blocking predicate, for the deferred confirmation's continuation.
  // `submitBlocked` is rebuilt per render from props; a continuation holds the
  // one from the render it started in, which is the render before the block.
  //
  // Published in a LAYOUT effect, not a passive one. A passive effect runs
  // after the browser has had a chance to hand control back, so an awaited
  // image read can resume in the post-commit microtask BEFORE it - and the
  // "live" gate then answers with the value from the render before the block,
  // which is exactly the staleness it exists to remove. React commits layout
  // effects synchronously with the commit, ahead of any such continuation.
  const submitBlockedRef = useRef(submitBlocked);
  useLayoutEffect(() => {
    submitBlockedRef.current = submitBlocked;
  }, [submitBlocked]);

  // The steering inputs, live for the same reason and read at the same moment.
  // `getActiveTurnForSteer` is already a getter - the turn was the fact most
  // obviously able to move while a dialog is open - but the other three inputs
  // to the policy were still the staging render's. A host that reconnected and
  // negotiated a line without same-turn steering during the byte read would
  // have its restart dispatched as a STEER it can no longer serve.
  //
  // `steerCapable` rides with them. It gates the settings-drift comparison
  // rather than the policy, so it looked like a different kind of fact - but it
  // is the same kind: preparation can span a turn being REPLACED, and a capable
  // turn arriving where an incapable one was would have its settings drift
  // injected without the restart confirmation, while the reverse would offer a
  // confirmation for a turn that can only fall back.
  const steerInputsRef = useRef({
    activeTurnStatus,
    steerCapable,
    steerEnabled,
    steerProtocolSupported,
  });
  useLayoutEffect(() => {
    steerInputsRef.current = {
      activeTurnStatus,
      steerCapable,
      steerEnabled,
      steerProtocolSupported,
    };
  }, [activeTurnStatus, steerCapable, steerEnabled, steerProtocolSupported]);

  const submitDraft = useCallback(
    (source: ChatComposerSubmitSource): void => {
      if (submitBlocked()) return;
      const toolbar = toolbarStore.getState();
      if (toolbar.selection.modelSlug.length === 0) return;
      const editor = editorRef.current;
      // A handle exists from the owner's first commit, before Tiptap's async
      // `useEditor` resolves - `getJSON()`/`clear()` silently no-op until
      // then, so a submit in that window would read the fallback initial JSON
      // and clear nothing, letting the just-submitted text resurrect once the
      // editor finishes initializing from that same stale initial content.
      if (editor === null || !editor.isReady()) return;
      if (annotationPrepFlight.current) return;
      const { annotationRecords } = readDraftSidecars(taskId);
      const editorContent = editor.getJSON();
      const contentText =
        extractPlainTextFromComposerJSONContent(editorContent);
      if (
        isEmptyComposerSubmit({
          contentText,
          editorContent,
          annotationRecords,
        })
      ) {
        return;
      }

      const submitPreparedDraft = (
        annotationImages: ReadonlyArray<AnnotationImageAtom>,
        draftImageBase64ByHash: ReadonlyMap<string, string>,
      ): void => {
        // LIVE, not the `submitBlocked` this render built. Every call below
        // reaches here after an awaited image read, and a workspace that became
        // blocked, a send that became disabled or a draft that became read-only
        // during it moves none of the identity checks that follow - so the
        // captured predicate would send the prompt and clear the composer
        // against a block that is already in force. Same reason the deferred
        // staged-conflict continuation reads the ref.
        if (submitBlockedRef.current()) return;
        // Re-read the document rather than comparing the `revision` captured
        // before the async annotation-image read. `revision` bumps on every
        // keystroke, so a single character typed during that read dropped the
        // send silently; and the pre-flight capture is not what the user is
        // looking at by the time we clear the editor, so sending it would
        // discard those keystrokes. The live document is both.
        const liveContent = editor.getJSON();
        const liveContentText =
          extractPlainTextFromComposerJSONContent(liveContent);
        // Re-inline against the RE-READ document, not the captured one, for the
        // same reason. An image node that appeared during the read keeps
        // whatever payload it has: inline stays inline, and a hash nothing
        // resolved is left hash-only for the host's dangling-hash guard, which
        // is the only authority on whether that send may proceed.
        //
        // `restore.content` below deliberately keeps the UN-inlined document:
        // it is what goes back into the composer on a failed send, and the
        // composer's own shape is not the wire's. Its hashes stay rooted
        // through `chat-session-store`'s restore-content root source.
        const sendableContent = inlineHashOnlyImageBytes(
          liveContent,
          draftImageBase64ByHash,
        );
        // Re-read the sidecar array for the same reason the document is
        // re-read: an annotation attached while the crop bytes resolved is
        // what the user is looking at, and the `clearDraft` below wipes it -
        // the pre-flight capture would drop it silently. `annotationImages`
        // still covers only the records captured BEFORE that read, so a late
        // annotation sends its record without an inlined crop atom rather
        // than not being sent at all.
        const { annotationRecords: liveAnnotationRecords } =
          readDraftSidecars(taskId);
        const settings = buildChatRunSettings({
          selection: toolbar.selection,
          permission: toolbar.permission,
          reasoning: toolbar.reasoning,
          serviceTier: toolbar.serviceTier,
        });
        const submittedContent = appendImageAttachmentAtoms(
          buildSubmittedChatJSONContent(
            sendableContent,
            pickerStore.getState().knownSlashCommands,
          ),
          annotationImages,
        );
        const attachments: ReadonlyArray<Attachment> = [
          ...buildAttachmentsFromJSONContent(submittedContent),
          ...liveAnnotationRecords,
        ];

        // A `/btw` prompt never reaches this chat: the remainder is asked in a
        // fork instead. Decided AFTER chip conversion (so a typed `/btw` and a
        // picked chip read the same) and BEFORE the delivery/steer decision
        // below - a side question asked mid-turn is the whole point, and it
        // must neither steer nor queue. It sits inside the prepared-draft path
        // so it reads the same live document the send would, and the annotation
        // atoms appended above are transparent to the leading-token scan.
        if (onSideChat !== null) {
          const sideChat = splitLeadingSideChatCommand(submittedContent);
          if (sideChat !== null) {
            // A `/btw` prompt does NOT go to this chat's stream - it becomes a
            // forked chat's `initialMessage` through `epic.createChat`. That
            // is a CREATE, and the settled decision is that every create
            // travels inline: there is no negotiated session yet whose bridge
            // capability could have been consulted, and nothing on the create
            // path re-inlines. So a memo-confirmed hash that the gate quite
            // correctly let through for an ordinary send has to be inlined
            // again on its way out here. Missing this made `/btw` the one
            // create path that could forward a bare hash.
            // Whatever bytes this needed were resolved by the preparation
            // loop ABOVE, because the pre-flight required set forces every
            // hash-only node on a would-be side chat (see `sideChatPreflight`).
            // Nothing is awaited here, so this commit keeps the pending flag,
            // the incarnation check, the intent token and the live re-read the
            // ordinary send has. A detached read placed here instead froze the
            // document, left the pending flag false, and cleared text typed
            // during it.
            //
            // Two very different situations produce a surviving hash here, and
            // the first version treated both as the race and returned - which
            // made a `/btw` whose image resolves NOWHERE into a permanently
            // dead send button: every Enter did the read, returned, and said
            // nothing, and a second Enter could not help because the pre-flight
            // had agreed with the document the first time too.
            //
            //  - The command appeared DURING the read (`sideChatPreflight`
            //    disagreed with this commit). The required set was computed
            //    for a non-side-chat, so these bytes were never asked for and
            //    the next Enter will pre-flight correctly. Abandon, keeping
            //    the draft.
            //  - The pre-flight DID ask and every leg missed. This used to
            //    send anyway, on the policy that an unresolved hash is the
            //    HOST's guard to rule on - which is true of an ordinary send
            //    and false here. `startSideChat` is a unary `epic.createChat`
            //    with no `chat.subscribe` session behind it, so there is no
            //    negotiated bridge to resolve the hash, no
            //    `MISSING_ATTACHMENT_BYTES` acknowledgement to retry from, and
            //    `markFailedByAction` makes the handoff terminal with nothing
            //    restoring the content to this composer. Same asymmetry the
            //    new-conversation create path answers the same way: keep the
            //    draft.
            //
            // So an unresolved hash abandons either way, and only the WORDING
            // differs - a command that appeared mid-read is worth retrying
            // immediately, a genuine miss is not.
            if (hashOnlyImageHashes(sideChat.rest).length > 0) {
              toast.info(
                sideChatPreflight
                  ? "An image in this side question could not be loaded."
                  : "Send again to ask this as a side question.",
                {
                  description: sideChatPreflight
                    ? "The draft has been kept - try removing and re-attaching it."
                    : "The side question was typed while its images were being prepared.",
                },
              );
              return;
            }
            if (onSideChat({ content: sideChat.rest, settings })) {
              clearAcceptedDraft();
            }
            return;
          }
        }

        // LIVE, for the same reason the blocking predicate above is: this
        // runs after an awaited image read, and a reconnect during it sets
        // `steerProtocolSupported` false until the new handshake completes.
        // The render-captured `true` would resolve `after_safe_point`, and
        // `sendMessage` does not revalidate the policy - the host would be
        // asked to steer on a line that no longer offers it. The synchronous
        // path reads the same ref on the same render, so nothing changes there.
        const liveSteerInputs = steerInputsRef.current;
        const deliveryPolicy = resolveSubmitDeliveryPolicy({
          source,
          activeTurnStatus: liveSteerInputs.activeTurnStatus,
          steerEnabled: liveSteerInputs.steerEnabled,
          steerProtocolSupported: liveSteerInputs.steerProtocolSupported,
        });
        const sendInput: ChatComposerSubmitInput = {
          content: submittedContent,
          contentText: liveContentText,
          attachments,
          settings,
          deliveryPolicy,
          restore: {
            content: liveContent,
            browserAnnotations: liveAnnotationRecords,
          },
        };
        if (
          deliveryPolicy === "after_safe_point" &&
          liveSteerInputs.steerCapable
        ) {
          const originTurn = getActiveTurnForSteer();
          const decision = decideSteerSettings(originTurn, settings);
          if (decision.kind === "interrupt_restart") {
            setPendingConflict({
              content: submittedContent,
              contentText: liveContentText,
              attachments,
              restore: {
                content: liveContent,
                browserAnnotations: liveAnnotationRecords,
              },
              settings: decision.newSettings,
              changed: decision.changed,
              originTurnId: originTurn?.turnId ?? null,
            });
            return;
          }
        }
        finalizeSend(sendInput);
      };

      // Hash-only image nodes this client still owes bytes for. A hash the
      // composer INHERITED from the host - the queued prompt a queue-edit
      // re-opened - is already an epic attachment, so it travels bare exactly
      // as it always has; re-inlining one would put megabytes back on a wire
      // that has been carrying a 64-character hash since message editing
      // existed. Keyed to this editor incarnation, so a re-created editor never
      // carries a previous one's inheritance forward.
      const incarnation = editor.getEditorIncarnation();
      // Recomputed per document rather than captured once: an upload confirmed
      // (or a confirmation invalidated) while the async leg runs must be
      // visible to the live re-read below, and so must a capability the store
      // has changed since preparation began.
      // A `/btw` prompt forks a new chat, and a CREATE always travels inline -
      // there is no negotiated session whose bridge capability could have been
      // consulted, and nothing on the create path re-inlines. So when this
      // document reads as a side chat, nothing is host-held for it and every
      // hash-only node joins the required set, resolved by the same loop and
      // committed under the same guards as an ordinary send.
      //
      // Checked against the CONVERTED document, the same one
      // `splitLeadingSideChatCommand` sees at commit, so a typed `/btw` and a
      // picked chip agree here exactly as they do there.
      const sideChatPreflight =
        onSideChat !== null &&
        splitLeadingSideChatCommand(
          buildSubmittedChatJSONContent(
            editorContent,
            pickerStore.getState().knownSlashCommands,
          ),
        ) !== null;
      const hostHeldFor = (content: JsonContent): ReadonlySet<string> =>
        sideChatPreflight
          ? NO_HOST_HELD_HASHES
          : submitHostHeldImageHashes({
              surfaceKey: taskId,
              incarnation,
              content,
              hostId: targetHostId,
              bridgeSupported: getDraftBlobBridgeSupported(),
              ownerUserId: currentDraftBlobOwnerId(),
            });
      const pendingImageHashes = draftImageInliningNeeded(
        editorContent,
        hostHeldFor(editorContent),
      );
      // The submit INTENT, captured whole. The incarnation alone cannot answer
      // "is this still the submit the user asked for": `restoreQueuedEditDraft`
      // and every other document REPLACEMENT go through `replaceDraft`, which
      // swaps the document via `resetEpoch` WITHOUT recreating the editor. So a
      // cancelled queue-edit passes an incarnation check, and the continuation
      // would then send the restored, unrelated draft into the cancelled item's
      // destination and clear it. `resetEpoch` moves on replacement and NOT on
      // a keystroke (`setSnapshot` passes `bumpResetEpoch: false`), which is
      // exactly the distinction this needs - ordinary typing must still reach
      // the live-document re-read below.
      //
      // `resetEpoch` also bumps when a HOST document replaces the row, which
      // looked at first like a source of spurious abandons on the routine
      // upsert round-trip. It is not, and the reason is worth stating exactly,
      // because an earlier version of this comment got it wrong: the composer's
      // own dirty-write ACK does not call the apply path AT ALL - it updates the
      // held revision and calls `rememberSynced` and nothing else
      // (`draft-mirror-session.ts`'s dirty-write ACK). The apply-before-remember
      // sequence belongs to `publishImmutable`, which is the STASH flow, not
      // this one. Own subscribe echoes are suppressed twice over: by the
      // local-dirty gate before the ACK, and by the equal held revision after
      // it.
      //
      // What remains is a genuine replacement - another window, a clear, or a
      // clean reconnect bootstrap. Abandoning there is the accepted behaviour,
      // and note it includes a bootstrap whose content EQUALS the current text:
      // nothing compares documents at that point, so an in-flight send can be
      // cancelled with the text unchanged. Fail-safe - no send, no clear, the
      // draft stands - and the user's next Enter goes through.
      const intent = {
        queueEditTargetId,
        resetEpoch: readComposerDraftSnapshot(taskId).resetEpoch,
      };

      if (annotationRecords.length === 0 && pendingImageHashes.length === 0) {
        submitPreparedDraft([], NO_DRAFT_IMAGE_BYTES);
        return;
      }

      annotationPrepFlight.current = true;
      setAnnotationPreparationPending(true);
      // The captured document is the only thing still naming these bytes if the
      // draft row is replaced mid-read, so it is a GC root for exactly as long
      // as the preparation runs.
      // A LABEL, not a key - the helper mints a per-acquisition key so two
      // overlapping preparations under one `taskId` cannot release each other.
      const rootsLabel = `chat-composer-submit:${taskId}`;
      // The hold/release try/finally lives in the helper, not here: a `try`
      // without a `catch` inside a hook body is something the React Compiler
      // cannot lower, and it would cost this whole hook its memoization. The
      // helper deliberately does not swallow a rejection, so the `catch` below
      // is where one lands: `void` alone left it unhandled, and the send is
      // already abandoned by then - what was missing was saying so.
      void withHeldComposerContentImageRoots(
        rootsLabel,
        editorContent,
        async () => {
          // Awaited BEFORE the reconcile loop, not beside it. As one leg of a
          // `Promise.all` the image leg could finish while this one was still
          // pending, and an image added during the remaining wait was never
          // attempted - the loop had already stopped looking.
          const annotationImages =
            annotationRecords.length === 0
              ? EMPTY_ANNOTATION_IMAGES
              : await resolveAnnotationImageAtoms(annotationRecords);
          if (annotationImages === null) {
            reportableErrorToast(
              "Couldn't attach the annotation image.",
              {
                description: "The crop is missing. Try attaching again.",
              },
              {
                title: "Annotation image missing",
                message: null,
                code: null,
                source: "Chat composer",
              },
            );
            return;
          }
          await prepareDraftImageInlining({
            initialHashes: pendingImageHashes,
            // Resolved inside the continuation: a draft mirror is acquired and
            // released as tiles mount, so the live session is the one that can
            // answer.
            target: draftImageByteTargetForHost(targetHostId),
            readRequiredHashes: () => {
              const live = editorRef.current;
              if (live === null) return [];
              const liveContent = live.getJSON();
              return draftImageInliningNeeded(
                liveContent,
                hostHeldFor(liveContent),
              );
            },
            // Synchronous with the final required-set read above it: no image
            // can arrive between that check and this send.
            commit: (draftImageBase64ByHash) => {
              // A re-created editor is a DIFFERENT document. `editor` here is
              // the handle captured before the read, so without this the send
              // would carry the destroyed editor's content while
              // `clearAcceptedDraft` cleared the live one - a stale prompt sent
              // and a live one wiped.
              if (editorRef.current?.getEditorIncarnation() !== incarnation) {
                return;
              }
              // And the same document in the same editor can still be a
              // different SUBMIT: the queue-edit destination may have been
              // cancelled or switched, or the document replaced underneath.
              if (
                queueEditTargetIdRef.current !== intent.queueEditTargetId ||
                readComposerDraftSnapshot(taskId).resetEpoch !==
                  intent.resetEpoch
              ) {
                return;
              }
              // The annotation set must be the SAME set the crops were
              // resolved from - in both directions, because the two sides are
              // carried separately and only agree if nothing moved.
              //
              // Added: the record is live but has no resolved crop atom, and
              // the protocol needs the crop to ride an `imageAttachment`.
              // Sending delivered the record bare and then cleared the
              // sidecar, so the crop was gone for good.
              //
              // Removed: the atom is still in `annotationImages` and
              // `appendImageAttachmentAtoms` still appends it, while the live
              // records no longer describe it - so the message carries a crop
              // of something the user deleted, with no metadata saying what it
              // is. That is the worse of the two: a send that shows an image
              // the user chose to take out.
              //
              // `commit` is synchronous by contract - that is what makes the
              // image set exact - so this preparation can neither grow an atom
              // nor drop one safely. Either way the send is abandoned: nothing
              // is cleared, the composer is untouched, and the next send
              // resolves the current set in its own pre-flight capture.
              const resolvedCrops = new Set(
                annotationImages.map((atom) => atom.hash),
              );
              const liveCrops = new Set(
                readDraftSidecars(taskId).annotationRecords.map(
                  (record) => record.imageHash,
                ),
              );
              const added = [...liveCrops].filter(
                (hash) => !resolvedCrops.has(hash),
              ).length;
              const removed = [...resolvedCrops].filter(
                (hash) => !liveCrops.has(hash),
              ).length;
              if (added > 0 || removed > 0) {
                toast.info(
                  "Annotations changed - send again to include them.",
                  {
                    description:
                      removed > 0
                        ? "An annotation was removed while the images were being prepared."
                        : "An annotation was added while the images were being prepared.",
                  },
                );
                return;
              }
              submitPreparedDraft(annotationImages, draftImageBase64ByHash);
            },
          });
        },
        () => {
          annotationPrepFlight.current = false;
          setAnnotationPreparationPending(false);
        },
      ).catch((error: unknown) => {
        appLogger.error(
          "[chat-composer] submit image preparation failed",
          { taskId },
          error,
        );
        // The draft is kept - `onSettled` has already cleared the pending flag
        // - but kept is not the same as EXPLAINED. Without this the user
        // presses Send, waits out the preparation, and sees nothing happen at
        // all. The new-conversation sibling raises its own notice for exactly
        // this; this surface has no notice channel, so it toasts.
        toast.error("Couldn't prepare the images in this message.", {
          description: "The draft has been kept - try sending again.",
        });
      });
    },
    [
      // `activeTurnStatus`, `steerCapable`, `steerEnabled` and
      // `steerProtocolSupported` are deliberately ABSENT: every reader in this
      // callback now goes through `steerInputsRef`, precisely because a value
      // captured at this render is stale by the time an awaited image read
      // returns. Listing them would rebuild the callback for values it no
      // longer reads.
      clearAcceptedDraft,
      editorRef,
      finalizeSend,
      onSideChat,
      pickerStore,
      getActiveTurnForSteer,
      queueEditTargetId,
      getDraftBlobBridgeSupported,
      submitBlocked,
      targetHostId,
      taskId,
      toolbarStore,
    ],
  );

  const restartStagedConflict = useCallback(
    (pendingConflict: PendingSteerConflict): void => {
      // The same guards the live submit path enforces (submitDraft) must block this
      // deferred confirm too. If any holds now, the consent cannot be honored -
      // dismiss the dialog (the composer text is kept, so the user can retry once it
      // clears) rather than pushing the send through the guards.
      if (submitBlocked()) {
        setPendingConflict(null);
        return;
      }
      // Bind the consent to the turn it was DISPLAYED for. The composer persists
      // across turn replacement, so if the running turn changed (a successor turn
      // is live, or none is) since the dialog opened, steering/restarting it would
      // act on consent shown for a DIFFERENT turn. Only re-resolve to a steer when
      // it is still that same turn; otherwise degrade to a plain queued send - never
      // interrupt-restart a successor turn on stale consent. (Re-resolving also
      // degrades to "auto" if the host reconnected/downgraded while the dialog was
      // open.) It was always a `mod-enter` chord that opened this dialog.
      const currentTurn = getActiveTurnForSteer();
      const sameTurn =
        currentTurn !== null &&
        pendingConflict.originTurnId !== null &&
        currentTurn.turnId === pendingConflict.originTurnId;
      const steerInputs = steerInputsRef.current;
      const deliveryPolicy = sameTurn
        ? resolveSubmitDeliveryPolicy({
            source: "mod-enter",
            activeTurnStatus: steerInputs.activeTurnStatus,
            steerEnabled: steerInputs.steerEnabled,
            steerProtocolSupported: steerInputs.steerProtocolSupported,
          })
        : "auto";
      if (
        finalizeSend({
          content: pendingConflict.content,
          contentText: pendingConflict.contentText,
          attachments: pendingConflict.attachments,
          settings: pendingConflict.settings,
          deliveryPolicy,
          restore: pendingConflict.restore,
        })
      ) {
        setPendingConflict(null);
      }
    },
    [finalizeSend, getActiveTurnForSteer, submitBlocked],
  );

  const onRestart = useCallback((): void => {
    if (pendingConflict === null) return;
    // The staged content was prepared when the dialog OPENED, and a steer
    // conflict can sit open for as long as the user takes to read it. If the
    // bridge capability has gone false in that time, whatever bare hashes this
    // content carries can no longer be resolved by the stream it is about to
    // go out on - the same staleness F5 fixes for the async submit path, one
    // dialog further out. Re-inline through the one inlining path before
    // dispatching, and only when it is actually needed.
    // RR4: full ELIGIBILITY, not just the capability boolean. A dialog can sit
    // open long enough for a mirror close or new bootstrap to invalidate the
    // confirmation, or for another refusal to mark the hash unbridgeable,
    // while the stream still speaks 1.11. Checking only the flag sent the old
    // bare hash in all of those cases. `submitHostHeldImageHashes` is the one
    // place that knows the whole question, so ask it rather than a piece of it.
    const stagedHashes = hashOnlyImageHashes(pendingConflict.content);
    const stillHeld = submitHostHeldImageHashes({
      surfaceKey: taskId,
      // `null` matches any incarnation, which is the right answer here: the
      // staged content is frozen, so the question is whether its hashes are
      // still eligible, not which editor instance is mounted now.
      incarnation: null,
      content: pendingConflict.content,
      hostId: targetHostId,
      bridgeSupported: getDraftBlobBridgeSupported(),
      ownerUserId: currentDraftBlobOwnerId(),
    });
    if (stagedHashes.some((hash) => !stillHeld.has(hash))) {
      // Single owner. A second confirmation while this read is outstanding
      // must not start a second one, and must not dispatch: the click that
      // opened this flight is the consent, and there is exactly one of it.
      if (conflictInliningFlight.current) return;
      conflictInliningFlight.current = true;
      const staged = pendingConflict;
      const intent = {
        queueEditTargetId: queueEditTargetIdRef.current,
        resetEpoch: readComposerDraftSnapshot(taskId).resetEpoch,
      };
      void reinlineRefusedSendContent({
        content: staged.content,
        hostId: targetHostId,
      })
        .then(({ content }) => {
          // Consent is re-checked OUTSIDE the state updater, and the dispatch
          // is gated on that check rather than following it unconditionally.
          // Guarding only the updater left the send running after the dialog
          // was cancelled: the old prompt went out and cleared a replacement
          // draft the user had typed in the meantime.
          //
          // `conflictStagedRef` is the live value, not the closed-over one -
          // `pendingConflict` here is from the render that started the read.
          if (conflictStagedRef.current !== staged) return;
          // And the same submit intent the ordinary path re-checks: the
          // queue-edit destination may have moved, or the document been
          // replaced, across this newly added wait.
          if (
            queueEditTargetIdRef.current !== intent.queueEditTargetId ||
            readComposerDraftSnapshot(taskId).resetEpoch !== intent.resetEpoch
          ) {
            return;
          }
          // RR3: the BLOCKING guards, read live. `restartStagedConflict`
          // closes over the `submitBlocked` of the render that staged this
          // dialog, so a workspace that became blocked or a draft that became
          // read-only during the byte read was invisible to it - the old
          // prompt went out and the composer was cleared against a live block.
          // Neither the staged identity nor `resetEpoch` moves for those.
          if (submitBlockedRef.current()) {
            setPendingConflict(null);
            return;
          }
          restartStagedConflict({ ...staged, content });
        })
        .finally(() => {
          conflictInliningFlight.current = false;
        });
      return;
    }
    restartStagedConflict(pendingConflict);
  }, [
    getDraftBlobBridgeSupported,
    pendingConflict,
    restartStagedConflict,
    targetHostId,
    taskId,
  ]);

  const onOpenChange = useCallback((open: boolean): void => {
    if (open) return;
    setPendingConflict(null);
  }, []);

  return {
    submitDraft,
    annotationPreparationPending,
    steerConflict: {
      open: pendingConflict !== null,
      changed: pendingConflict?.changed ?? [],
      onOpenChange,
      onRestart,
    },
  };
}

/**
 * The synchronous path's empty resolution map. Shared so the "nothing to
 * re-inline" send reads as the deliberate case it is rather than allocating a
 * map per keystroke-free submit.
 */
const NO_DRAFT_IMAGE_BYTES: ReadonlyMap<string, string> = new Map<
  string,
  string
>();

/** Shared empty for the no-annotation branch, so it allocates nothing. */
const EMPTY_ANNOTATION_IMAGES: ReadonlyArray<AnnotationImageAtom> = [];

interface ComposerDraftSidecars {
  readonly annotationRecords: ReadonlyArray<BrowserAnnotationRecord>;
}

/**
 * The draft's non-document sidecar array, read live. Both the pre-flight read
 * and the post-async finalize go through here so they can never diverge.
 */
function readDraftSidecars(taskId: string): ComposerDraftSidecars {
  const draft = readComposerDraftSnapshot(taskId);
  return { annotationRecords: draft.browserAnnotations };
}

function isEmptyComposerSubmit(input: {
  readonly contentText: string;
  readonly editorContent: JsonContent;
  readonly annotationRecords: ReadonlyArray<BrowserAnnotationRecord>;
}): boolean {
  return (
    input.contentText.trim().length === 0 &&
    !containsImageAtoms(input.editorContent) &&
    input.annotationRecords.length === 0
  );
}

type AnnotationImageAtom = {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly b64content: string;
  readonly hash: string;
};

async function resolveAnnotationImageAtoms(
  records: ReadonlyArray<BrowserAnnotationRecord>,
): Promise<ReadonlyArray<AnnotationImageAtom> | null> {
  const atoms: AnnotationImageAtom[] = [];
  for (const record of records) {
    const sessionBytes = sessionImageBytes(record.imageHash);
    const bytes =
      sessionBytes ??
      // An IndexedDB open/transaction failure is "the crop is not available",
      // the same outcome as a missing key - and it must reach the caller as
      // `null` rather than a rejection, which nothing above awaits with a
      // `catch` and which would silently abandon the submit with no toast.
      (await getImageBytes(record.imageHash).catch((error: unknown) => {
        appLogger.error(
          "[chat-composer] annotation image read failed",
          { imageHash: record.imageHash },
          error,
        );
        return undefined;
      })) ??
      null;
    if (bytes === null) return null;
    atoms.push({
      id: uuidv4(),
      fileName: record.imageFileName,
      // SNIFFED, not assumed. A crop is a PNG when the browser view captures
      // it, and it is not one after a stash round trip: the stash canonicalizes
      // a large PNG to WebP and re-points the record at those bytes. Labelling
      // WebP bytes `image/png` was wrong in the atom, in the media type and in
      // the data URL a preview builds from them.
      mimeType: sniffImageMimeType(bytes) ?? "image/png",
      size: bytes.byteLength,
      b64content: bytesToBase64(bytes),
      hash: record.imageHash,
    });
  }
  return atoms;
}
