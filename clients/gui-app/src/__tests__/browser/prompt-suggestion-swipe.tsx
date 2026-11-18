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
import "@/lib/theme-applier";
import "@/index.css";

/**
 * THE SUGGESTED PROMPT ON A TOUCH SCREEN: the real chat editor slot over the
 * real prompt editor, offered a suggestion by the production gate and filled
 * by the production fill.
 *
 * jsdom cannot decide what this is for. Whether a tap only focuses, and
 * whether a sideways drag reaches the page as pointer moves at all, are both
 * the browser's own touch arbitration: it takes a drag for panning unless the
 * element under it has reserved that axis, and cancels the pointer sequence
 * when it does - a few pixels in, whether or not anything on the page can
 * actually pan that way. `browser-tests/prompt-suggestion-swipe.spec.ts`
 * drives it with real touch input.
 *
 * The composer sits under a timeline, the way it does in a chat.
 */
const SUGGESTION = "Add a test for the new endpoint";
const EMPTY_DOCUMENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};
const TIMELINE_ROWS = Array.from(
  { length: 40 },
  (_, index) => `Timeline row ${String(index + 1)}`,
);
const NOOP = (): void => undefined;

export function PromptSuggestionSwipeFixture(): ReactElement {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [pickerStore] = useState(() => createComposerPickerStore());
  const [draftContent, setDraftContent] = useState(EMPTY_DOCUMENT);
  const fill = useCallback(
    (suggestion: string): boolean =>
      fillComposerWithSuggestion(editorRef.current, suggestion),
    [],
  );
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
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {TIMELINE_ROWS.map((row) => (
          <p key={row} className="py-2 text-ui">
            {row}
          </p>
        ))}
      </div>
      <div className="flex border-t bg-card p-3">
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
          onSubmit={NOOP}
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
    </div>
  );
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<PromptSuggestionSwipeFixture />);
