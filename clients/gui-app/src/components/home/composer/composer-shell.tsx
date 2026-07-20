import { memo, type DragEventHandler, type ReactNode } from "react";
import { FileText, Files, ImageIcon } from "lucide-react";

import { ComposerMenu } from "@/components/chat/composer/menu/composer-menu";
import type { ComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import { ComposerNarrowProvider } from "@/components/home/composer/composer-narrow-context";
import { useComposerNarrowObserver } from "@/components/home/composer/composer-narrow-hooks";
import type { FileTransferDragOverlayVariant } from "@/lib/files/file-transfer-paths";

const FILE_DROP_OVERLAY_CONTENT = {
  images: {
    Icon: ImageIcon,
    title: "Drop image to attach",
    subtitle: "PNG, JPG, GIF up to 5MB",
  },
  paths: {
    Icon: FileText,
    title: "Drop to insert file path",
    subtitle: "Path will be inserted in the message",
  },
  mixed: {
    Icon: Files,
    title: "Drop to attach images and insert file paths",
    subtitle: "Images attach; file paths are inserted",
  },
} satisfies Record<
  FileTransferDragOverlayVariant,
  {
    readonly Icon: typeof ImageIcon;
    readonly title: string;
    readonly subtitle: string;
  }
>;

function ComposerFileDropOverlay({
  variant,
}: {
  readonly variant: FileTransferDragOverlayVariant;
}) {
  const { Icon, title, subtitle } = FILE_DROP_OVERLAY_CONTENT[variant];
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-card/90 backdrop-blur-sm"
    >
      <Icon className="size-6 text-primary" aria-hidden />
      <p className="text-ui-sm font-medium text-foreground">{title}</p>
      <p className="text-ui-xs text-muted-foreground">{subtitle}</p>
    </div>
  );
}

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
  readonly dragOverlayVariant: FileTransferDragOverlayVariant | null;
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
    dragOverlayVariant,
    attachmentsStrip,
    editor,
    toolbar,
  } = props;

  const { ref, isNarrow } = useComposerNarrowObserver();
  const overlay =
    dragOverlayVariant === null ? null : (
      <ComposerFileDropOverlay variant={dragOverlayVariant} />
    );
  const editorSlot = (
    <>
      {attachmentsStrip}
      {editor}
    </>
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
