import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import "@/index.css";

/**
 * The REAL `ComposerPromptEditor` with its `onUserInput` signal recorded: each
 * call appends whether the document was empty before the input to
 * `window.__userInputs`. `window.__composer` is the editor's own handle, for
 * the writes the app makes itself (a restored draft, a dictation segment).
 * `browser-tests/composer-user-input.spec.ts` drives it with real keystrokes.
 */
interface ProbeWindow extends Window {
  __userInputs: boolean[];
  __composer: ComposerPromptEditorHandle | null;
}
const probeWindow: ProbeWindow = Object.assign(window, {
  __userInputs: [] as boolean[],
  __composer: null as ComposerPromptEditorHandle | null,
});

export function Fixture() {
  const [pickerStore] = useState(() => createComposerPickerStore());
  const initialContent: JsonContent = {
    type: "doc",
    content: [{ type: "paragraph" }],
  };
  return (
    <ComposerPromptEditor
      ref={(handle) => {
        probeWindow.__composer = handle;
      }}
      initialContent={initialContent}
      initialSelection={null}
      pickerStore={pickerStore}
      placeholder="Message"
      editorClassName="min-h-16 w-full"
      isActive
      disabled={false}
      slashProviderId="claude"
      hasPastedImageBytes={null}
      ingestPastedComposerImages={null}
      stabilizeImageAttachmentCaret={false}
      onDocumentChange={() => undefined}
      onUserInput={(wasEmpty) => {
        probeWindow.__userInputs.push(wasEmpty);
      }}
      onSelectionChange={() => undefined}
      onSubmit={() => undefined}
      onPaste={() => undefined}
      onDragOver={() => undefined}
      onDrop={() => undefined}
      onKeyDown={undefined}
      interceptKeyDown={null}
      onFocus={() => undefined}
      onBlur={() => undefined}
      onEditorReady={null}
    />
  );
}

const container = document.getElementById("root");
if (container !== null) createRoot(container).render(<Fixture />);
