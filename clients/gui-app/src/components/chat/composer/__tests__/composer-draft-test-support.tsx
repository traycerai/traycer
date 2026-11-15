import { useState } from "react";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useChatComposerDraft } from "../use-chat-composer-draft";
import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createComposerPickerStore } from "../picker/composer-picker-store";

export interface ComposerDraftSelectionRef {
  current: { readonly from: number; readonly to: number } | null;
}

export interface ComposerDraftEditorHarnessProps {
  readonly chatId: string;
  readonly epicId: string;
  readonly hostId: string;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
  readonly selectionRef: ComposerDraftSelectionRef;
}

export function ComposerDraftEditorHarness(
  props: ComposerDraftEditorHarnessProps,
) {
  const { chatId, epicId, hostId, editorRef, selectionRef } = props;
  const [editorReadyTick, setEditorReadyTick] = useState(0);
  const draft = useChatComposerDraft({
    chatId,
    epicId,
    hostId,
    editorRef,
    editorReadyTick,
    chatTitle: null,
    epicTitle: null,
  });
  const [pickerStore] = useState(() => createComposerPickerStore());

  return (
    <ComposerPromptEditor
      ref={(instance) => {
        editorRef.current = instance;
      }}
      initialContent={draft.initialContent}
      initialSelection={draft.initialSelection}
      pickerStore={pickerStore}
      placeholder="test"
      editorClassName={undefined}
      isActive={false}
      disabled={false}
      slashProviderId="claude"
      hasPastedImageBytes={null}
      ingestPastedComposerImages={null}
      stabilizeImageAttachmentCaret={false}
      onDocumentChange={draft.handleDocumentChange}
      onSelectionChange={(selection) => {
        selectionRef.current = selection;
        draft.handleSelectionChange(selection);
      }}
      onSubmit={() => undefined}
      onPaste={() => undefined}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onKeyDown={undefined}
      interceptKeyDown={null}
      onFocus={() => undefined}
      onBlur={() => undefined}
      onEditorReady={() => setEditorReadyTick((tick) => tick + 1)}
    />
  );
}

export interface ComposerDraftObservation {
  readonly editorJSON: string;
  readonly draftJSON: string;
  readonly visibleText: string;
}

export function observeComposerDraft(
  chatId: string,
  editorRef: { current: ComposerPromptEditorHandle | null },
  editorElement: HTMLElement,
): ComposerDraftObservation {
  const editor = editorRef.current;
  if (editor === null) throw new Error("Expected composer editor");
  const draft = useComposerDraftStore.getState().drafts[chatId];
  if (draft === undefined) throw new Error("Expected canonical composer draft");
  return {
    editorJSON: JSON.stringify(editor.getJSON()),
    draftJSON: JSON.stringify(draft.content),
    visibleText: editorElement.textContent ?? "",
  };
}
