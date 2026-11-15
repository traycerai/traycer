import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type DragEventHandler,
  type ReactNode,
} from "react";

import { FILE_DROP_OVERLAY_CONTENT } from "@/components/home/composer/composer-drop-overlay-content";
import { ComposerDropOverlay } from "@/components/home/composer/composer-shell";
import { dragIsInZone } from "@/hooks/composer/use-composer-paste";
import {
  classifyFileTransferDrag,
  hasClaimableFileTransfer,
  type FileTransferDragOverlayVariant,
} from "@/lib/files/file-transfer-paths";

/**
 * A pane that is one drop zone for the message box inside it: a file dragged
 * anywhere over the pane is taken by that box, and the box's drop affordance
 * covers the pane. The pane owns the element and the overlay; the box owns
 * what a drop does, so the two never disagree about what is accepted.
 */
export interface ComposerDropTarget {
  readonly onDragEnter: DragEventHandler<HTMLElement>;
  readonly onDragLeave: DragEventHandler<HTMLElement>;
  readonly onDragOver: DragEventHandler<HTMLElement>;
  readonly onDrop: DragEventHandler<HTMLElement>;
  readonly overlayVariant: FileTransferDragOverlayVariant | null;
}

type ComposerDropTargetClaim = (target: ComposerDropTarget | null) => void;

const ComposerDropScopeContext = createContext<ComposerDropTargetClaim | null>(
  null,
);

type ComposerDropZoneProps = Pick<
  ComposerDropTarget,
  "onDragEnter" | "onDragLeave" | "onDragOver" | "onDrop"
>;

function keepFileDragHere(event: DragEvent<HTMLElement>): void {
  if (!dragIsInZone(event.currentTarget, event.target)) return;
  if (classifyFileTransferDrag(event.dataTransfer) === null) return;
  event.stopPropagation();
}

/**
 * Before the drop only the transfer's type names can be read, and a link
 * dragged from a page has the same `text/uri-list` type as a file reference.
 * So every file-like drag is held here for the drop to decide, and only one
 * that certainly carries files is shown as refused.
 */
function refuseFileDragOver(event: DragEvent<HTMLElement>): void {
  if (!dragIsInZone(event.currentTarget, event.target)) return;
  if (classifyFileTransferDrag(event.dataTransfer) === null) return;
  event.preventDefault();
  event.stopPropagation();
  if (Array.from(event.dataTransfer.types).includes("Files")) {
    event.dataTransfer.dropEffect = "none";
  }
}

function refuseFileDrop(event: DragEvent<HTMLElement>): void {
  if (!dragIsInZone(event.currentTarget, event.target)) return;
  if (!hasClaimableFileTransfer(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Takes a file drag and refuses it, so the file reaches neither the window
 * nor a pane around this element. A pane with no box mounted is this, and so
 * is an element inside a pane that takes drops itself (a message being edited
 * in the transcript): what its own handlers do not take is not the pane's
 * box's to take. A link or text dragged over it is left alone.
 */
export const REFUSING_DROP_ZONE_PROPS: ComposerDropZoneProps = {
  onDragEnter: keepFileDragHere,
  onDragLeave: keepFileDragHere,
  onDragOver: refuseFileDragOver,
  onDrop: refuseFileDrop,
};

export interface ComposerDropScope {
  /** Spread on the pane's element, which must be positioned. */
  readonly zoneProps: ComposerDropZoneProps;
  /** Rendered as the pane element's last child. */
  readonly overlay: ReactNode;
  /** Wraps the pane's content, so the box inside can claim the zone. */
  readonly provide: (children: ReactNode) => ReactNode;
}

/** The pane's half. The box nearest inside it claims the zone. */
export function useComposerDropScope(): ComposerDropScope {
  const [target, setTarget] = useState<ComposerDropTarget | null>(null);
  return useMemo(
    () => ({
      zoneProps:
        target === null
          ? REFUSING_DROP_ZONE_PROPS
          : {
              onDragEnter: target.onDragEnter,
              onDragLeave: target.onDragLeave,
              onDragOver: target.onDragOver,
              onDrop: target.onDrop,
            },
      overlay:
        target === null || target.overlayVariant === null ? null : (
          <ComposerDropOverlay
            {...FILE_DROP_OVERLAY_CONTENT[target.overlayVariant]}
          />
        ),
      provide: (children) => (
        <ComposerDropScopeContext value={setTarget}>
          {children}
        </ComposerDropScopeContext>
      ),
    }),
    [target],
  );
}

function ignoreDrag(): void {}

const PANE_TAKES_DROPS: ComposerDropTarget = {
  onDragEnter: ignoreDrag,
  onDragLeave: ignoreDrag,
  onDragOver: ignoreDrag,
  onDrop: ignoreDrag,
  overlayVariant: null,
};

/**
 * The box's half: hands its drop handling to the pane around it, and returns
 * what the box's own frame takes. That is nothing once a pane has it, and the
 * box's own handling in no pane.
 *
 * The pane is given handlers that stay the same while the box's own change,
 * so a box whose handlers are new on every render claims the zone once.
 */
export function useComposerDropScopeTarget(
  target: ComposerDropTarget,
): ComposerDropTarget {
  const claim = use(ComposerDropScopeContext);
  const latest = useRef(target);
  useLayoutEffect(() => {
    latest.current = target;
  });
  const { overlayVariant } = target;
  useEffect(() => {
    if (claim === null) return;
    claim({
      onDragEnter: (event) => latest.current.onDragEnter(event),
      onDragLeave: (event) => latest.current.onDragLeave(event),
      onDragOver: (event) => latest.current.onDragOver(event),
      onDrop: (event) => latest.current.onDrop(event),
      overlayVariant,
    });
    return () => claim(null);
  }, [claim, overlayVariant]);
  return claim === null ? target : PANE_TAKES_DROPS;
}
