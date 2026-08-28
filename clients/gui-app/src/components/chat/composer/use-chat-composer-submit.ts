import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type {
  ChatActiveTurn,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

import { blurTextEntry } from "@/components/layout/shell/shell-gestures";
import { isMobileApp } from "@/lib/mobile-app";
import { useChatStore } from "@/stores/composer/chat-store";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import { appLogger } from "@/lib/logger";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  appendImageAttachmentAtoms,
  containsImageAtoms,
} from "@/lib/composer/image-atoms";
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
  } = args;
  const appendMessage = useChatStore((state) => state.appendMessage);
  const clearDraftInStore = useComposerDraftStore((state) => state.clearDraft);
  const [pendingConflict, setPendingConflict] =
    useState<PendingSteerConflict | null>(null);
  const [annotationPreparationPending, setAnnotationPreparationPending] =
    useState(false);
  const annotationPrepFlight = useRef(false);

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
      clearDraftInStore(taskId);
      pickerStore.getState().reset();
      editorRef.current?.clear();
      // Gated on ACCEPTANCE, which is why it sits below the early return: a
      // rejected send leaves the text in place, and dropping the keyboard there
      // would take the user away from the message they still have to fix. On a
      // phone the keyboard covers most of the screen, so holding it open after
      // a send hides the reply the send was for.
      if (isMobileApp()) blurTextEntry();
      return true;
    },
    [
      appendMessage,
      clearDraftInStore,
      editorRef,
      onSubmitMessage,
      pickerStore,
      taskId,
    ],
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
      ): void => {
        if (submitBlocked()) return;
        // Re-read the document rather than comparing the `revision` captured
        // before the async annotation-image read. `revision` bumps on every
        // keystroke, so a single character typed during that read dropped the
        // send silently; and the pre-flight capture is not what the user is
        // looking at by the time we clear the editor, so sending it would
        // discard those keystrokes. The live document is both.
        const liveContent = editor.getJSON();
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
        const attachments: ReadonlyArray<Attachment> = [
          ...buildAttachmentsFromJSONContent(submittedContent),
          ...liveAnnotationRecords,
        ];
        const deliveryPolicy = resolveSubmitDeliveryPolicy({
          source,
          activeTurnStatus,
          steerEnabled,
          steerProtocolSupported,
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
        if (deliveryPolicy === "after_safe_point" && steerCapable) {
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

      if (annotationRecords.length === 0) {
        submitPreparedDraft([]);
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
          submitPreparedDraft(annotationImages);
        } finally {
          annotationPrepFlight.current = false;
          setAnnotationPreparationPending(false);
        }
      })();
    },
    [
      activeTurnStatus,
      editorRef,
      finalizeSend,
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
      mimeType: "image/png",
      size: bytes.byteLength,
      b64content: bytesToBase64(bytes),
      hash: record.imageHash,
    });
  }
  return atoms;
}
