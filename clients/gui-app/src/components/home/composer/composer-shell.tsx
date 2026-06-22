import { memo, useMemo, type DragEventHandler, type ReactNode } from "react";
import { ImageIcon } from "lucide-react";

import { ComposerMenu } from "@/components/chat/composer/menu/composer-menu";
import type { ComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { ComposerNarrowProvider } from "@/components/home/composer/composer-narrow-context";
import { useComposerNarrowObserver } from "@/components/home/composer/composer-narrow-hooks";

export interface ComposerAreaProps {
  readonly pickerStore: ComposerPickerStore;
  readonly overlay: ReactNode;
  readonly editor: ReactNode;
  readonly toolbar: ReactNode | null;
}

function ComposerAreaImpl({
  pickerStore,
  overlay,
  editor,
  toolbar,
}: ComposerAreaProps): ReactNode {
  return (
    <div className="relative">
      <ComposerMenu pickerStore={pickerStore} />
      <div
        data-composer-shell=""
        className="relative rounded-lg bg-muted/30 ring-1 ring-border ring-inset focus-within:ring-ring/30"
      >
        {overlay}
        <div className="px-4 pt-4">{editor}</div>
        {toolbar}
      </div>
    </div>
  );
}

export const ComposerArea = memo(ComposerAreaImpl);

interface ComposerShellProps {
  readonly pickerStore: ComposerPickerStore;
  readonly onDragOver: DragEventHandler<HTMLElement>;
  readonly onDrop: DragEventHandler<HTMLElement>;
  readonly onDragEnter: DragEventHandler<HTMLElement>;
  readonly onDragLeave: DragEventHandler<HTMLElement>;
  readonly isDraggingFiles: boolean;
  /** Slot rendered just above the editor (e.g. image-attachment chips). */
  readonly attachmentsStrip: ReactNode;
  /** Slot for the editor surface. */
  readonly editor: ReactNode;
  /** Slot for the bottom toolbar (model/reasoning/permission/send). */
  readonly toolbar: ReactNode;
}

function ComposerShellImpl(props: ComposerShellProps) {
  const {
    pickerStore,
    onDragOver,
    onDrop,
    onDragEnter,
    onDragLeave,
    isDraggingFiles,
    attachmentsStrip,
    editor,
    toolbar,
  } = props;

  const { ref, isNarrow } = useComposerNarrowObserver();
  const overlay = useMemo(
    () =>
      isDraggingFiles ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-card/90 backdrop-blur-sm"
        >
          <ImageIcon className="size-6 text-primary" aria-hidden />
          <p className="text-ui-sm font-medium text-foreground">
            Drop image to attach
          </p>
          <p className="text-ui-xs text-muted-foreground">
            PNG, JPG, GIF up to 5MB
          </p>
        </div>
      ) : null,
    [isDraggingFiles],
  );
  const editorSlot = useMemo(
    () => (
      <>
        {attachmentsStrip}
        {editor}
      </>
    ),
    [attachmentsStrip, editor],
  );

  return (
    <ComposerNarrowProvider isNarrow={isNarrow}>
      <div
        ref={ref}
        className="@container"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
      >
        <ComposerArea
          pickerStore={pickerStore}
          overlay={overlay}
          editor={editorSlot}
          toolbar={toolbar}
        />
      </div>
    </ComposerNarrowProvider>
  );
}

export const ComposerShell = memo(ComposerShellImpl);
