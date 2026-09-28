import {
  useCallback,
  useRef,
  type ClipboardEventHandler,
  type DragEventHandler,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from "react";
import { PHONE_COMPOSER_EDITOR_CAP_CLASSNAME } from "@/components/home/composer/composer-editor-classnames";
import { cn } from "@/lib/utils";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

import type { ChatComposerSubmitSource } from "@/lib/chats/resolve-steer-submit";
import { isMac, modLabel } from "@/lib/keybindings/platform";
import { shortcutHintsVisible } from "@/lib/keybindings/shortcut-hints";
import { useIsComposerNarrow } from "@/components/home/composer/composer-narrow-hooks";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./composer-prompt-editor";
import type {
  PastedComposerImage,
  PastedComposerImageOutcome,
} from "./editor/extensions/chat-paste-handler";
import type { ComposerPickerStore } from "./picker/composer-picker-store";
import {
  isPromptSuggestionAcceptKey,
  PROMPT_SUGGESTION_TAP_SLOP_PX,
} from "./prompt-suggestion";

const PLACEHOLDER =
  "Ask anything, @tag files/folder, or use / to show available commands";
const NARROW_PLACEHOLDER = "Ask anything…";
// Mid-turn steer discovery hint (decision 8): shown as the empty-composer
// placeholder while a steer-capable turn runs, naming both keys.
const STEER_HINT_PLACEHOLDER = isMac()
  ? "Enter to queue · ⌘Enter to steer this turn"
  : "Enter to queue · Ctrl+Enter to steer this turn";
const NARROW_STEER_HINT_PLACEHOLDER = `${modLabel()}+Enter to steer`;
const NOOP = (): void => undefined;
interface ChatComposerEditorSlotProps {
  readonly ref: Ref<ComposerPromptEditorHandle>;
  readonly pickerStore: ComposerPickerStore;
  readonly initialContent: JsonContent;
  readonly initialSelection: { from: number; to: number } | null;
  readonly slashProviderId: GuiHarnessId;
  readonly hasPastedImageBytes: ((hash: string) => boolean) | null;
  readonly ingestPastedComposerImages:
    | ((
        images: ReadonlyArray<PastedComposerImage>,
      ) => ReadonlyArray<PastedComposerImageOutcome>)
    | null;
  readonly isActive: boolean;
  readonly disabled: boolean;
  readonly onDocumentChange: (
    content: JsonContent,
    selection: { from: number; to: number },
  ) => void;
  readonly onSelectionChange: (selection: { from: number; to: number }) => void;
  readonly onSubmit: (source: ChatComposerSubmitSource) => void;
  /** True while a Cmd+Enter here would steer the running turn (decision 8 hint). */
  readonly steerHintActive: boolean;
  /**
   * The provider's predicted next prompt, already gated by
   * `promptSuggestionAllowed` (so the draft is empty); `null` offers nothing.
   * Shown as the placeholder; → or a tap on a touch device accepts it.
   */
  readonly suggestedPrompt: string | null;
  /** Fills and focuses the composer with the suggestion. Must never send. */
  readonly onAcceptSuggestion: (suggestion: string) => void;
  readonly onPaste: ClipboardEventHandler<HTMLElement>;
  readonly onDragOver: DragEventHandler<HTMLElement>;
  readonly onDrop: DragEventHandler<HTMLElement>;
  readonly onEditorReady: (() => void) | null;
  /** Fired when the user focuses this composer. */
  readonly onFocus: () => void;
}

/**
 * Bound to the narrow context exposed by `<ComposerShell>` so the chat
 * composer can swap placeholders without ChatComposer re-rendering on
 * width changes.
 */
export function ChatComposerEditorSlot(props: ChatComposerEditorSlotProps) {
  const {
    ref,
    pickerStore,
    initialContent,
    initialSelection,
    slashProviderId,
    hasPastedImageBytes,
    ingestPastedComposerImages,
    isActive,
    disabled,
    onDocumentChange,
    onSelectionChange,
    onSubmit,
    steerHintActive,
    suggestedPrompt,
    onAcceptSuggestion,
    onPaste,
    onDragOver,
    onDrop,
    onEditorReady,
    onFocus,
  } = props;
  const isNarrow = useIsComposerNarrow();
  const basePlaceholder = isNarrow ? NARROW_PLACEHOLDER : PLACEHOLDER;
  let placeholder = basePlaceholder;
  // The steer hint is entirely a naming of two keys, so where shortcut hints
  // are suppressed there is nothing left of it to show - the composer keeps
  // its ordinary placeholder rather than a hint stripped of its chord.
  if (steerHintActive && shortcutHintsVisible()) {
    placeholder = isNarrow
      ? NARROW_STEER_HINT_PLACEHOLDER
      : STEER_HINT_PLACEHOLDER;
  }
  // A suggestion only stands between turns (the provider predicts it at a
  // turn's end), so it outranks the steer hint, which only stands mid-turn.
  if (suggestedPrompt !== null) {
    placeholder = suggestedPrompt;
  }

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (suggestedPrompt === null) return;
      if (
        !isPromptSuggestionAcceptKey({
          key: event.key,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          isComposing: event.nativeEvent.isComposing,
        })
      ) {
        return;
      }
      event.preventDefault();
      onAcceptSuggestion(suggestedPrompt);
    },
    [suggestedPrompt, onAcceptSuggestion],
  );

  // Touch has no → key, so a tap on the composer accepts instead. Only a tap:
  // a touch that travels is a scroll or a drag, and a mouse or pen click is
  // just placing the caret.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const handlePointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    touchStartRef.current =
      event.pointerType === "touch"
        ? { x: event.clientX, y: event.clientY }
        : null;
  }, []);
  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = touchStartRef.current;
      touchStartRef.current = null;
      if (start === null || suggestedPrompt === null) return;
      if (event.pointerType !== "touch") return;
      const travel = Math.hypot(
        event.clientX - start.x,
        event.clientY - start.y,
      );
      if (travel > PROMPT_SUGGESTION_TAP_SLOP_PX) return;
      onAcceptSuggestion(suggestedPrompt);
    },
    [suggestedPrompt, onAcceptSuggestion],
  );
  const handlePointerCancel = useCallback(() => {
    touchStartRef.current = null;
  }, []);

  return (
    // `contents` keeps the wrapper out of layout; it only observes the tap.
    <div
      className="contents"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <ComposerPromptEditor
        ref={ref}
        pickerStore={pickerStore}
        initialContent={initialContent}
        initialSelection={initialSelection}
        slashProviderId={slashProviderId}
        hasPastedImageBytes={hasPastedImageBytes}
        ingestPastedComposerImages={ingestPastedComposerImages}
        isActive={isActive}
        disabled={disabled}
        placeholder={placeholder}
        // Desktop keeps the chat editor compact; a phone lets it grow to the
        // same cap as the landing composer.
        editorClassName={cn(
          "max-h-[3.5lh] min-h-9",
          PHONE_COMPOSER_EDITOR_CAP_CLASSNAME,
        )}
        stabilizeImageAttachmentCaret
        onDocumentChange={onDocumentChange}
        onSelectionChange={onSelectionChange}
        onSubmit={onSubmit}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
        onBlur={NOOP}
        onEditorReady={onEditorReady}
      />
    </div>
  );
}
