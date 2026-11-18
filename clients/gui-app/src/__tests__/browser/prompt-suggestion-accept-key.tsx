import { useCallback, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { ChatComposerEditorSlot } from "@/components/chat/composer/chat-composer-editor-slot";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import {
  fillComposerWithSuggestion,
  promptSuggestionAllowed,
} from "@/components/chat/composer/prompt-suggestion";
import type { ChordString } from "@/lib/keybindings/chord";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE SUGGESTED PROMPT'S ACCEPT KEY: the real chat editor slot over the real
 * prompt editor, offered a suggestion by the production gate, filled by the
 * production fill, and reading the production keybinding store.
 *
 * jsdom cannot decide what this is for. Whether a Tab the composer does not
 * take moves focus to the next control, and whether one it does take keeps
 * focus in the composer, is the browser's own focus traversal; and the order
 * in which the editor's keydown hook, its keymaps and the browser default see
 * a key is ProseMirror's real event handling against a real contenteditable.
 * `browser-tests/prompt-suggestion-accept-key.spec.ts` drives it with real
 * keyboard input.
 *
 * A control sits on either side of the composer, so there is somewhere for a
 * Tab and a Shift+Tab to go. The spec rebinds through `window.__acceptKeyProbe`
 * rather than a fresh page load per binding.
 */
const SUGGESTION = "Add a test for the new endpoint";
const EMPTY_DOCUMENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};
const NOOP = (): void => undefined;

interface AcceptKeyProbe {
  readonly bind: (chord: ChordString | null) => void;
  readonly submits: () => number;
}

declare global {
  interface Window {
    __acceptKeyProbe: AcceptKeyProbe | undefined;
  }
}

let submits = 0;

window.__acceptKeyProbe = {
  bind: (chord) => {
    const store = useKeybindingStore.getState();
    if (chord === null) store.clearBinding("composer.suggestion.accept");
    else store.setBinding("composer.suggestion.accept", chord);
  },
  submits: () => submits,
};

export function PromptSuggestionAcceptKeyFixture(): ReactElement {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [pickerStore] = useState(() => createComposerPickerStore());
  const [draftContent, setDraftContent] = useState(EMPTY_DOCUMENT);
  const fill = useCallback(
    (suggestion: string): boolean =>
      fillComposerWithSuggestion(editorRef.current, suggestion),
    [],
  );
  const onSubmit = useCallback(() => {
    submits += 1;
  }, []);
  // The gate's document check is the one this fixture can exercise: typing or
  // a fill makes the draft a non-empty paragraph, which withdraws the offer.
  const offered = promptSuggestionAllowed({
    topBannerKind: "none",
    sendDisabled: false,
    workspaceBlocked: false,
    draftHasText: false,
    draftHasImages: false,
    draftContent,
  })
    ? SUGGESTION
    : null;

  return (
    <div className="flex h-full w-full flex-col gap-3 bg-background p-4 text-foreground">
      <button type="button" data-testid="before-composer">
        Before
      </button>
      <div className="flex border bg-card p-3">
        <ChatComposerEditorSlot
          ref={editorRef}
          pickerStore={pickerStore}
          initialContent={EMPTY_DOCUMENT}
          initialSelection={null}
          slashProviderId="claude"
          hasPastedImageBytes={null}
          ingestPastedComposerImages={null}
          isActive={false}
          disabled={false}
          onDocumentChange={setDraftContent}
          onSelectionChange={NOOP}
          onSubmit={onSubmit}
          steerHintActive={false}
          suggestedPrompt={offered}
          onAcceptSuggestion={fill}
          onPaste={NOOP}
          onDragOver={NOOP}
          onDrop={NOOP}
          onEditorReady={null}
          onFocus={NOOP}
        />
      </div>
      <button type="button" data-testid="after-composer">
        After
      </button>
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<PromptSuggestionAcceptKeyFixture />);
