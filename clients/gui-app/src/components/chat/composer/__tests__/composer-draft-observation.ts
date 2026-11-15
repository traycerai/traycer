import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";

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
    visibleText: editorElement.textContent,
  };
}
