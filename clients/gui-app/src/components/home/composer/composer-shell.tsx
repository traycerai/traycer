import { memo, type DragEventHandler, type ReactNode } from "react";
import { FileText, Files, ImageIcon } from "lucide-react";

import { ComposerMenu } from "@/components/chat/composer/menu/composer-menu";
import type { ComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import {
  ComposerExpandHandle,
  type ComposerExpansion,
} from "@/components/home/composer/composer-expand-handle";
import { ComposerNarrowProvider } from "@/components/home/composer/composer-narrow-context";
import { useComposerNarrowObserver } from "@/components/home/composer/composer-narrow-hooks";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import type { FileTransferDragOverlayVariant } from "@/lib/files/file-transfer-paths";
import { cn } from "@/lib/utils";

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

export function ComposerDropOverlay({
  Icon,
  title,
  subtitle,
}: {
  readonly Icon: typeof ImageIcon;
  readonly title: string;
  readonly subtitle: string;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-card/90"
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
  readonly utilityRail: ReactNode;
  readonly attachmentsStrip: ReactNode;
  readonly editor: ReactNode;
  readonly toolbar: ReactNode | null;
  /** The phone grabber and sheet state; `null` renders the card in flow only. */
  readonly expansion: ComposerExpansion | null;
}

function ComposerAreaImpl({
  pickerStore,
  overlay,
  utilityRail,
  attachmentsStrip,
  editor,
  toolbar,
  expansion,
}: ComposerAreaProps): ReactNode {
  const expanded = expansion?.expanded === true;
  return (
    <div className="relative">
      <ComposerMenu pickerStore={pickerStore} />
      {/* The dim behind the sheet. A sibling rather than the sheet's own
          pseudo-element: a negative-z child paints above its parent's
          background, and the entrance animation's transform would make the
          sheet the pseudo-element's containing block for its duration. Same
          layer as the sheet, earlier in the DOM, so the sheet paints over it. */}
      {expanded ? (
        <div
          aria-hidden
          data-composer-sheet-backdrop=""
          className="fixed inset-0 z-40 bg-canvas/60"
        />
      ) : null}
      <div
        data-composer-shell=""
        data-composer-expanded={expanded ? "" : undefined}
        className={cn(
          "relative rounded-lg bg-foreground/3 ring-1 ring-border ring-inset focus-within:ring-ring/30",
          // The sheet fills the SURFACE the card sits on: `fixed`, so it does
          // not depend on the stack of positioned wrappers between it and
          // that surface, and both surfaces that mount it are layout roots -
          // the canvas tile host transforms its tile, the landing surface is
          // `contain-layout` - so "fixed" resolves against them, under the
          // app header, rather than against the viewport. The bottom clears
          // the home indicator only while the keyboard is down: with it up,
          // the surface already ends at the keyboard (the shell's
          // safe-height tokens subtract it), and the inset dwarfs the
          // indicator's, so the max is 0. The frame takes the scroll so the
          // toolbar stays put.
          expanded &&
            "fixed inset-x-4 top-2 bottom-[calc(max(0px,var(--safe-area-inset-bottom)-var(--keyboard-inset))+1rem)] z-40 flex flex-col bg-card shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-200",
        )}
      >
        {overlay}
        {expansion === null ? null : <ComposerExpandHandle {...expansion} />}
        <div
          data-composer-utility-overlay=""
          className={cn(
            "absolute right-3 top-0 z-40 -translate-y-1/2 empty:hidden",
            expanded && "hidden",
          )}
        >
          {utilityRail}
        </div>
        <div
          data-composer-editor-frame=""
          className={cn(
            "px-4 pt-4",
            expanded &&
              "min-h-0 flex-1 overflow-y-auto overscroll-y-contain [&_[data-composer-editor]]:max-h-none",
          )}
        >
          <div
            data-composer-attachment-rail=""
            className="flex min-w-0 items-start gap-2 pb-2 empty:hidden"
          >
            {attachmentsStrip}
          </div>
          {editor}
        </div>
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
  /** Compact composer chrome anchored outside document flow. */
  readonly utilityRail: ReactNode;
  /** Slot rendered just above the editor (e.g. image-attachment chips). */
  readonly attachmentsStrip: ReactNode;
  /** Slot for the editor surface. */
  readonly editor: ReactNode;
  /** Slot for the bottom toolbar (model/reasoning/permission/send). */
  readonly toolbar: ReactNode;
  /**
   * Lets the phone layout pull the composer up into a sheet over the surface
   * (the grabber on the card's top edge). Honoured only in the phone layout;
   * a desktop window has room for the card to grow in place. `null` for a
   * composer that already sits in an overlay of its own.
   */
  readonly expansion: ComposerExpansion | null;
}

function ComposerShellImpl(props: ComposerShellProps) {
  const {
    pickerStore,
    onDragOver,
    onDrop,
    onDragEnter,
    onDragLeave,
    dragOverlayVariant,
    utilityRail,
    attachmentsStrip,
    editor,
    toolbar,
    expansion,
  } = props;

  const phoneLayout = useIsMobileViewport();
  const { ref: narrowRef, isNarrow } = useComposerNarrowObserver();
  const overlayContent =
    dragOverlayVariant === null
      ? null
      : FILE_DROP_OVERLAY_CONTENT[dragOverlayVariant];
  return (
    <ComposerNarrowProvider isNarrow={isNarrow}>
      <div
        ref={narrowRef}
        className="@container"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
      >
        <ComposerArea
          pickerStore={pickerStore}
          overlay={
            overlayContent === null ? null : (
              <ComposerDropOverlay {...overlayContent} />
            )
          }
          utilityRail={utilityRail}
          attachmentsStrip={attachmentsStrip}
          editor={editor}
          toolbar={toolbar}
          expansion={phoneLayout ? expansion : null}
        />
      </div>
    </ComposerNarrowProvider>
  );
}

export const ComposerShell = memo(ComposerShellImpl);
