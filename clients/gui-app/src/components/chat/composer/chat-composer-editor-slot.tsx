import type { ClipboardEventHandler, DragEventHandler, Ref } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

import type { ChatComposerSubmitSource } from "@/lib/chats/resolve-steer-submit";
import { isMac, modLabel } from "@/lib/keybindings/platform";
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
  readonly onDocumentChange: (
    content: JsonContent,
    selection: { from: number; to: number },
  ) => void;
  readonly onSelectionChange: (selection: { from: number; to: number }) => void;
  readonly onSubmit: (source: ChatComposerSubmitSource) => void;
  /** True while a Cmd+Enter here would steer the running turn (decision 8 hint). */
  readonly steerHintActive: boolean;
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
    onDocumentChange,
    onSelectionChange,
    onSubmit,
    steerHintActive,
    onPaste,
    onDragOver,
    onDrop,
    onEditorReady,
    onFocus,
  } = props;
  const isNarrow = useIsComposerNarrow();
  const basePlaceholder = isNarrow ? NARROW_PLACEHOLDER : PLACEHOLDER;
  let placeholder = basePlaceholder;
  if (steerHintActive) {
    placeholder = isNarrow
      ? NARROW_STEER_HINT_PLACEHOLDER
      : STEER_HINT_PLACEHOLDER;
  }
  return (
    <ComposerPromptEditor
      ref={ref}
      pickerStore={pickerStore}
      initialContent={initialContent}
      initialSelection={initialSelection}
      slashProviderId={slashProviderId}
      hasPastedImageBytes={hasPastedImageBytes}
      ingestPastedComposerImages={ingestPastedComposerImages}
      isActive={isActive}
      disabled={false}
      placeholder={placeholder}
      editorClassName="max-h-[3.5lh] min-h-9"
      stabilizeImageAttachmentCaret
      onDocumentChange={onDocumentChange}
      onSelectionChange={onSelectionChange}
      onSubmit={onSubmit}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onKeyDown={undefined}
      onFocus={onFocus}
      onBlur={NOOP}
      onEditorReady={onEditorReady}
    />
  );
}
