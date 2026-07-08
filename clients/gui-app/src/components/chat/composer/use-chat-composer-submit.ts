import { useCallback } from "react";
import type { RefObject } from "react";
import type {
  ChatActiveTurn,
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
  readonly onSubmitMessage:
    ((input: ChatComposerSubmitInput) => boolean) | null;
}

interface ChatComposerSubmitInput {
  readonly content: JsonContent;
  readonly contentText: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly settings: ChatRunSettings;
}

export function useChatComposerSubmit(args: UseChatComposerSubmitArgs) {
  const {
    taskId,
    editorRef,
    pickerStore,
    toolbarStore,
    activeTurnStatus,
    hasPendingApprovals,
    sendDisabled,
    workspaceBlocked,
    imagesUnsupported,
    onSubmitMessage,
  } = args;
  const appendMessage = useChatStore((state) => state.appendMessage);
  const clearDraftInStore = useComposerDraftStore((state) => state.clearDraft);

  return useCallback(() => {
    if (
      activeTurnStatus === "stopping" ||
      hasPendingApprovals ||
      sendDisabled ||
      workspaceBlocked ||
      imagesUnsupported
    ) {
      return;
    }
    const toolbar = toolbarStore.getState();
    if (toolbar.selection.modelSlug.length === 0) return;
    const editor = editorRef.current;
    if (editor === null) return;
    const editorContent = editor.getJSON();
    const contentText = extractPlainTextFromComposerJSONContent(editorContent);
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
      agentMode: toolbar.agentMode,
    });

    const submittedContent = buildSubmittedChatJSONContent(editorContent);
    const attachments = buildAttachmentsFromJSONContent(submittedContent);
    const send = (): boolean => {
      if (onSubmitMessage !== null) {
        return onSubmitMessage({
          content: submittedContent,
          contentText,
          attachments,
          settings,
        });
      }
      appendMessage(taskId, {
        role: "user",
        content: submittedContent,
        contentText,
        attachments,
        settings,
      });
      return true;
    };

    if (!send()) return;
    clearDraftInStore(taskId);
    pickerStore.getState().reset();
    editor.clear();
  }, [
    activeTurnStatus,
    appendMessage,
    clearDraftInStore,
    editorRef,
    hasPendingApprovals,
    imagesUnsupported,
    onSubmitMessage,
    pickerStore,
    sendDisabled,
    taskId,
    toolbarStore,
    workspaceBlocked,
  ]);
}
