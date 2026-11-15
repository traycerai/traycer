import { useState } from "react";
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
