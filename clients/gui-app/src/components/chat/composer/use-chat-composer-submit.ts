import { useCallback, useRef, useState } from "react";
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
import { appLogger } from "@/lib/logger";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  appendImageAttachmentAtoms,
  containsImageAtoms,
} from "@/lib/composer/image-atoms";
import {
  inlineImageHashesFromSession,
  inlineLocalImageHashes,
} from "@/lib/composer/composer-image-inlining";
import { captureComposerSubmitGeneration } from "@/lib/composer/composer-submit-generation";
import { useImageContentRoot } from "@/hooks/composer/use-image-content-root";
import {
  planAttachmentsByHash,
  resolveSendContentByHash,
  sendAttachmentsByHashSupported,
} from "@/lib/composer/attachments-by-hash";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import { sniffImageMimeType } from "@/lib/composer/prompt-stash-image-signature";
import {
  getImageBytes,
  sessionImageBytes,
} from "@/lib/composer/composer-image-store";
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
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

import type { ChatComposerSubmitInput } from "./chat-composer";
import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";

interface UseChatComposerSubmitArgs {
  readonly taskId: string;
  /**
   * The TAB's host - the machine this chat is bound to for life - and the
   * client its requests go out on. Both are needed only by the image seam: the
   * send's shape depends on what that host's chat stream negotiated, and a hash
   * this window has not yet pushed has to be uploaded to THAT host's blob tier
   * before the frame can reference it. Passed in rather than re-resolved here,
   * so this hook cannot disagree with the composer around it about which
   * machine it is talking to.
   */
  readonly hostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
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
  /**
   * True while this chat's draft is a replica of another host's row that has
   * not been claimed. The editor is disabled, but the toolbar's send button
   * and the deferred steer confirm both reach this hook without passing the
   * editor, so the block belongs in `submitBlocked` beside the others.
   */
  readonly draftReadOnly: boolean;
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
   * True while a submit is reading a session-cold image's bytes back out of
   * IndexedDB to inline them. Kept separate from the annotation flag rather
   * than folded into it: they are two different reads with two different
   * failures, and a composer that reported "annotation preparation" for an
   * ordinary restored draft would send the next reader looking in the wrong
   * place. Both gate the send button the same way.
   */
  readonly imageResolutionPending: boolean;
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
    hostId,
    hostClient,
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
    draftReadOnly,
    onSubmitMessage,
    onSideChat,
  } = args;
  const appendMessage = useChatStore((state) => state.appendMessage);
  const [pendingConflict, setPendingConflict] =
    useState<PendingSteerConflict | null>(null);
  // GC root while the interrupt-restart dialog is open. This is the one send
  // path that parks a fully built document in component state and waits for a
  // human: `clearAcceptedDraft` has NOT run (the send has not gone out), but
  // any other composer sending in the meantime schedules the reconcile, and
  // the confirm would then dispatch hash-only nodes whose bytes were deleted
  // while the dialog sat there. `restore.content` is the same document
  // hash-only, so rooting `content` covers both.
  useImageContentRoot(pendingConflict?.content ?? null);
  const [annotationPreparationPending, setAnnotationPreparationPending] =
    useState(false);
  const annotationPrepFlight = useRef(false);
  const [imageResolutionPending, setImageResolutionPending] = useState(false);
  // The editor is NOT cleared until a send is accepted, so a second Enter
  // during the session-cold read would otherwise start a second send of the
  // same message. Mirrors `annotationPrepFlight` (and the landing composer's
  // `submissionInFlightRef`), which exist for exactly this reason.
  const imageResolutionInFlight = useRef(false);

  // Everything an ACCEPTED submit does to the composer, shared by the send and
  // the side-chat paths so a refused one leaves the text in place on both.
  const clearAcceptedDraft = useCallback((): void => {
    void submitComposerDraft(taskId);
    pickerStore.getState().reset();
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
      attachmentPreparationPending ||
      draftReadOnly,
    [
      activeTurnStatus,
      attachmentPreparationPending,
      draftReadOnly,
      hasPendingApprovals,
      imagesUnsupported,
      sendDisabled,
      workspaceBlocked,
    ],
  );

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
      // The guard above narrows `editor`, but control-flow narrowing does not
      // reach a hoisted function declaration - `runSubmitFromAnnotationStage`
      // could in principle be called before the guard ran, so TS will not carry
      // it in. Re-binding makes the handle NON-NULLABLE BY TYPE rather than by
      // position, which every reader below then gets for free.
      const readyEditor = editor;
      if (annotationPrepFlight.current) return;

      const submitPreparedDraft = (
        annotationImages: ReadonlyArray<AnnotationImageAtom>,
        resolutionAttempt: number,
      ): void => {
        if (submitBlocked()) return;
        // AHEAD OF EVERY DISPATCH PATH, the synchronous one included. It used to
        // sit inside each async arm, which left this hole: a first submit goes
        // async on a session-cold hash, the user types, a second submit now
        // finds every hash session-warm, takes the SYNCHRONOUS fast path below
        // and sends immediately - and then the first arm settles and sends the
        // same message again. A resolution in flight owns this submit.
        if (imageResolutionInFlight.current) return;
        // Re-read the document rather than comparing the `revision` captured
        // before the async annotation-image read. `revision` bumps on every
        // keystroke, so a single character typed during that read dropped the
        // send silently; and the pre-flight capture is not what the user is
        // looking at by the time we clear the editor, so sending it would
        // discard those keystrokes. The live document is both.
        const liveContent = readyEditor.getJSON();
        const liveContentText =
          extractPlainTextFromComposerJSONContent(liveContent);
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
            liveContent,
            pickerStore.getState().knownSlashCommands,
          ),
          annotationImages,
        );

        // Everything from the side-chat split onwards, taking the content the
        // host will actually receive. Split out because resolving a hash-only
        // node's bytes can need an IndexedDB read, and the two paths below must
        // not be able to drift from one another.
        const dispatchSubmittedContent = (sendContent: JsonContent): void => {
          const attachments: ReadonlyArray<Attachment> = [
            ...buildAttachmentsFromJSONContent(sendContent),
            ...liveAnnotationRecords,
          ];

          // A `/btw` prompt never reaches this chat: the remainder is asked in
          // a fork instead. Decided AFTER chip conversion (so a typed `/btw`
          // and a picked chip read the same) and BEFORE the delivery/steer
          // decision below - a side question asked mid-turn is the whole point,
          // and it must neither steer nor queue. It sits inside the
          // prepared-draft path so it reads the same live document the send
          // would, and the annotation atoms appended above are transparent to
          // the leading-token scan.
          if (onSideChat !== null) {
            const sideChat = splitLeadingSideChatCommand(sendContent);
            if (sideChat !== null) {
              if (onSideChat({ content: sideChat.rest, settings })) {
                clearAcceptedDraft();
              }
              return;
            }
          }

          const deliveryPolicy = resolveSubmitDeliveryPolicy({
            source,
            activeTurnStatus,
            steerEnabled,
            steerProtocolSupported,
          });
          const sendInput: ChatComposerSubmitInput = {
            content: sendContent,
            contentText: liveContentText,
            attachments,
            settings,
            deliveryPolicy,
            // The RESTORE is the hash-only live document, never the inlined
            // send: a refused send puts this straight back in the composer,
            // where base64 is exactly what this change removed.
            restore: {
              content: liveContent,
              browserAnnotations: liveAnnotationRecords,
            },
          };
          if (deliveryPolicy === "after_safe_point" && steerCapable) {
            const originTurn = getActiveTurnForSteer();
            const decision = decideSteerSettings(originTurn, settings);
            if (decision.kind === "interrupt_restart") {
              setPendingConflict({
                content: sendContent,
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

        // Captured BEFORE either await. `revision` bumps on document edits AND
        // on browser-annotation add/remove, which is exactly the pair
        // `clearAcceptedDraft` wipes; it deliberately ignores selection.
        const generation = captureComposerSubmitGeneration(
          () => readComposerDraftSnapshot(taskId).revision,
        );

        // How BOTH async arms settle - the sameness is the point, so an arm
        // added later cannot grow a differently shaped guard.
        //
        // The latch is released FIRST, because the re-entry below has to get
        // past the guard at the top of this function.
        const settleResolvedSend = (sendContent: JsonContent): void => {
          imageResolutionInFlight.current = false;
          setImageResolutionPending(false);
          if (generation.stillCurrent()) {
            dispatchSubmittedContent(sendContent);
            return;
          }
          // The user typed, or attached an annotation, while the bytes were
          // being resolved. Dispatching now would send the document captured
          // before that and then clear the one containing it - destroying work
          // the user can still see, with no way back.
          //
          // So re-run the submit instead - from the ANNOTATION STAGE, not from
          // here. `annotationImages` holds the crops resolved for the sidecar
          // as it stood at the first submit, and the sidecar is one of the
          // things the user can have changed during the read: re-entering with
          // those atoms appends a crop for an annotation that has since been
          // REMOVED (it arrives as an ordinary image the user never sent) and
          // has no crop for one attached since. Restarting the stage resolves
          // the sidecar that is actually on screen.
          if (resolutionAttempt === 0) {
            runSubmitFromAnnotationStage(resolutionAttempt + 1);
            return;
          }
          // Changed again during the retry. Send nothing and clear nothing: the
          // composer still holds everything the user has typed, and the send
          // button is live again. Bounded rather than looping, because the
          // re-entry is driven by keystrokes and this arm must terminate.
        };

        const beginResolution = (): void => {
          imageResolutionInFlight.current = true;
          setImageResolutionPending(true);
        };

        // THE WIRE TAKES HASHES on `chat.subscribe@1.11`: the host materializes
        // a hash-only node from this account's draft blob tier immediately
        // before the dangling-hash guard that would otherwise refuse it. So the
        // first question is whether this host's stream negotiates that, and
        // only if it does not do the bytes have to be put back inline.
        //
        // Best effort on both sides of the gate, and for the same reason: this
        // composer's document routinely holds hashes whose bytes were never
        // local (an image copied out of a rendered message, a restored failed
        // send), and those address the epic's own attachment store, which the
        // host resolves first. A genuinely lost hash fails visibly either way.
        const plan = planAttachmentsByHash(submittedContent);
        if (
          hostId !== null &&
          hostClient !== null &&
          plan.eligible.length > 0 &&
          sendAttachmentsByHashSupported(hostId)
        ) {
          // Always async - "does the host already hold these bytes" is not a
          // question this window can answer from memory - so it takes the same
          // re-entry guard and the same pending flag as the cold-read path.
          // (The guard itself now sits at the top of this function, ahead of
          // the synchronous path too.)
          beginResolution();
          // Two-argument `then`, not `.then(...).catch(...)`: a `catch` chained
          // after the success arm also catches a throw from the dispatch itself
          // and would send the message a second time.
          void resolveSendContentByHash({
            hostId,
            client: hostClient,
            content: submittedContent,
            plan,
          }).then(settleResolvedSend, () => {
            // The upload or the byte read failed outright. Send the document
            // as it stands: on a `@1.11` host a hash-only node is a shape the
            // host understands, and one it cannot resolve comes back as the
            // existing rejection, which restores the prompt.
            settleResolvedSend(submittedContent);
          });
          return;
        }
        // Below the minor: the composer is hash-first and this wire is not, so
        // hashes this window holds bytes for go back to inline base64. Fast
        // path: every hash is in the session cache (the ordinary "you just
        // pasted it" case) → stay in this stack frame, so the document is read
        // and cleared with nothing able to run in between.
        const inlined = inlineImageHashesFromSession(submittedContent);
        if (inlined !== null) {
          dispatchSubmittedContent(inlined);
          return;
        }
        // Something is not session-cached: a draft restored in a later session,
        // or — the ordinary case on this surface — a hash that was never local
        // at all, addressing the epic attachment store on the host. Read what
        // this window has and leave the rest hash-only for the host to resolve,
        // exactly as it does today. Guarded at the top of this function,
        // because the editor is NOT cleared until the send is accepted, so a
        // second Enter during the read would otherwise start a second send of
        // the same message.
        beginResolution();
        // Two-argument `then`, not `.then(...).catch(...)`: a `catch` CHAINED
        // after the success arm also catches a throw from the dispatch itself
        // and would send the message a second time.
        void inlineLocalImageHashes(submittedContent).then(
          settleResolvedSend,
          () => {
            // An IndexedDB open/transaction failure (private browsing, quota, a
            // corrupt DB). Send the document as it stands rather than losing
            // the message: hash-only nodes the host cannot resolve come back as
            // the existing rejection, which restores the prompt.
            settleResolvedSend(submittedContent);
          },
        );
      };

      /**
       * THE WHOLE SUBMIT FROM THE ANNOTATION-RESOLUTION STAGE DOWN, so that the
       * first attempt and the stale-generation retry take the identical path.
       *
       * A function declaration rather than a `const` arrow because
       * `settleResolvedSend`, defined above inside `submitPreparedDraft`, calls
       * it: hoisting is what lets the two reference each other without a ref.
       *
       * The empty-submit guard lives HERE rather than at the top of
       * `submitDraft` for the same reason the stage is re-entered at all - the
       * retry is driven by the draft having changed, and one of the things it
       * can have changed into is empty (the user deleted the text and removed
       * the annotation while the bytes were read). Nothing further out re-asks.
       */
      function runSubmitFromAnnotationStage(resolutionAttempt: number): void {
        const { annotationRecords } = readDraftSidecars(taskId);
        const editorContent = readyEditor.getJSON();
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

        if (annotationRecords.length === 0) {
          submitPreparedDraft([], resolutionAttempt);
          return;
        }

        annotationPrepFlight.current = true;
        setAnnotationPreparationPending(true);
        void (async () => {
          try {
            const annotationImages =
              await resolveAnnotationImageAtoms(annotationRecords);
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
            submitPreparedDraft(annotationImages, resolutionAttempt);
          } finally {
            annotationPrepFlight.current = false;
            setAnnotationPreparationPending(false);
          }
        })();
      }

      runSubmitFromAnnotationStage(0);
    },
    [
      activeTurnStatus,
      clearAcceptedDraft,
      editorRef,
      finalizeSend,
      hostClient,
      hostId,
      onSideChat,
      pickerStore,
      getActiveTurnForSteer,
      steerCapable,
      steerEnabled,
      steerProtocolSupported,
      submitBlocked,
      taskId,
      toolbarStore,
    ],
  );

  const onRestart = useCallback((): void => {
    if (pendingConflict === null) return;
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
    const deliveryPolicy = sameTurn
      ? resolveSubmitDeliveryPolicy({
          source: "mod-enter",
          activeTurnStatus,
          steerEnabled,
          steerProtocolSupported,
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
  }, [
    finalizeSend,
    pendingConflict,
    activeTurnStatus,
    steerEnabled,
    steerProtocolSupported,
    getActiveTurnForSteer,
    submitBlocked,
  ]);

  const onOpenChange = useCallback((open: boolean): void => {
    if (open) return;
    setPendingConflict(null);
  }, []);

  return {
    submitDraft,
    annotationPreparationPending,
    imageResolutionPending,
    steerConflict: {
      open: pendingConflict !== null,
      changed: pendingConflict?.changed ?? [],
      onOpenChange,
      onRestart,
    },
  };
}

interface ComposerDraftSidecars {
  readonly annotationRecords: ReadonlyArray<BrowserAnnotationRecord>;
}

/**
 * Crops are prepared at attach time (`attachBrowserAnnotation`), so the stored
 * bytes are already within the universal policy and pass through this path
 * untouched. What preparation can change is the ENCODING — the record carries
 * only a hash and a file name, so the atom's MIME type is read back off the
 * bytes rather than assumed to be the PNG the tile captured.
 */
function annotationImageMimeType(bytes: Uint8Array): string {
  return sniffImageMimeType(bytes) ?? "image/png";
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
      mimeType: annotationImageMimeType(bytes),
      size: bytes.byteLength,
      b64content: bytesToBase64(bytes),
      hash: record.imageHash,
    });
  }
  return atoms;
}
