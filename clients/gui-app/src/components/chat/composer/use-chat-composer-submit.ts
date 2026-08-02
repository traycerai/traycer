import { useCallback, useState } from "react";
import type { RefObject } from "react";
import type {
  ChatActiveTurn,
  ChatQueueDeliveryPolicy,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";

import { useChatStore } from "@/stores/composer/chat-store";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
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
    ((input: ChatComposerSubmitInput) => boolean) | null;
}

interface ChatComposerSubmitInput {
  readonly content: JsonContent;
  readonly contentText: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly settings: ChatRunSettings;
  readonly deliveryPolicy: ChatQueueDeliveryPolicy;
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
      const editorContent = editor.getJSON();
      const contentText =
        extractPlainTextFromComposerJSONContent(editorContent);
      const trimmed = contentText.trim();
      const hasImages = containsImageAtoms(editorContent);
      if (trimmed.length === 0 && !hasImages) return;

      // `toolbar.serviceTier` is already clamped to the selected model in the
      // toolbar store (the single site shared with the picker display), so a tier
      // the model doesn't advertise never reaches the wire or the recorded turn.
      // The raw preference stays sticky in the store's `values` for a later model
      // that honors it, and the codex-adapter still re-filters against the
      // model's authoritative supportedServiceTiers at thread/start.
      const settings = buildChatRunSettings({
        selection: toolbar.selection,
        permission: toolbar.permission,
        reasoning: toolbar.reasoning,
        serviceTier: toolbar.serviceTier,
      });

      const submittedContent = buildSubmittedChatJSONContent(
        editorContent,
        pickerStore.getState().knownSlashCommands,
      );
      const attachments = buildAttachmentsFromJSONContent(submittedContent);
      const deliveryPolicy = resolveSubmitDeliveryPolicy({
        source,
        activeTurnStatus,
        steerEnabled,
        steerProtocolSupported,
      });

      // The drift confirmation is a capability-gated affordance: only a
      // steer-capable harness can actually restart-under-new-settings, so only it
      // asks. On an unsupported harness the `after_safe_point` send goes straight
      // through and the host records the benign fallback ("After turn") row.
      if (deliveryPolicy === "after_safe_point" && steerCapable) {
        // A turn-start-baked setting (harness/model/reasoning/tier/agent-mode/
        // profile - never permissionMode) differing from the running turn can't
        // fold in silently: confirm ending the turn first (decision 6). The host
        // owns the actual safe-point-vs-interrupt-restart promotion; this is the
        // renderer's consent gate. Keep the composer text until the user acts.
        const originTurn = getActiveTurnForSteer();
        const decision = decideSteerSettings(originTurn, settings);
        if (decision.kind === "interrupt_restart") {
          setPendingConflict({
            content: submittedContent,
            contentText,
            attachments,
            settings: decision.newSettings,
            changed: decision.changed,
            originTurnId: originTurn?.turnId ?? null,
          });
          return;
        }
      }

      finalizeSend({
        content: submittedContent,
        contentText,
        attachments,
        settings,
        deliveryPolicy,
      });
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
    steerConflict: {
      open: pendingConflict !== null,
      changed: pendingConflict?.changed ?? [],
      onOpenChange,
      onRestart,
    },
  };
}
