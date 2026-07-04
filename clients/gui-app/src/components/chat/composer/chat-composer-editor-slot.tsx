import type { ClipboardEventHandler, DragEventHandler, Ref } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

import { useIsComposerNarrow } from "@/components/home/composer/composer-narrow-hooks";

import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./composer-prompt-editor";
import type { ComposerPickerStore } from "./picker/composer-picker-store";

const PLACEHOLDER =
  "Ask anything, @tag files/folder, or use / to show available commands";
const NARROW_PLACEHOLDER = "Ask anything…";
const NOOP = (): void => undefined;

interface ChatComposerEditorSlotProps {
  readonly ref: Ref<ComposerPromptEditorHandle>;
  readonly pickerStore: ComposerPickerStore;
  readonly initialContent: JsonContent;
  readonly initialSelection: { from: number; to: number } | null;
  readonly slashProviderId: GuiHarnessId;
  readonly isActive: boolean;
  readonly onSnapshot: (
    content: JsonContent,
    selection: { from: number; to: number },
  ) => void;
  readonly onSubmit: () => void;
  readonly onPaste: ClipboardEventHandler<HTMLElement>;
  readonly onDragOver: DragEventHandler<HTMLElement>;
  readonly onDrop: DragEventHandler<HTMLElement>;
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
    isActive,
    onSnapshot,
    onSubmit,
    onPaste,
    onDragOver,
    onDrop,
  } = props;
  const isNarrow = useIsComposerNarrow();
  return (
    <ComposerPromptEditor
      ref={ref}
      pickerStore={pickerStore}
      initialContent={initialContent}
      initialSelection={initialSelection}
      slashProviderId={slashProviderId}
      isActive={isActive}
      disabled={false}
      placeholder={isNarrow ? NARROW_PLACEHOLDER : PLACEHOLDER}
      editorClassName="max-h-[3.5lh] min-h-9"
      stabilizeImageAttachmentCaret
      onSnapshot={onSnapshot}
      onSubmit={onSubmit}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onKeyDown={undefined}
      onFocus={NOOP}
      onBlur={NOOP}
    />
  );
}
