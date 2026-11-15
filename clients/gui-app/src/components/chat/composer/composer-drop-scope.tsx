import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type DragEventHandler,
  type ReactNode,
} from "react";

import { FILE_DROP_OVERLAY_CONTENT } from "@/components/home/composer/composer-drop-overlay-content";
import { ComposerDropOverlay } from "@/components/home/composer/composer-shell";
import {
  classifyFileTransferDrag,
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

function keepFromPane(event: DragEvent<HTMLElement>): void {
  if (classifyFileTransferDrag(event.dataTransfer) === null) return;
  event.stopPropagation();
}

function refuseFileDrag(event: DragEvent<HTMLElement>): void {
  if (classifyFileTransferDrag(event.dataTransfer) === null) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "none";
}

/**
 * A pane with no box mounted still answers a file drag: it refuses it, so the
 * file is not handed to the window or to a pane around this one.
 */
const REFUSING_ZONE_PROPS: ComposerDropZoneProps = {
  onDragEnter: keepFromPane,
  onDragLeave: keepFromPane,
  onDragOver: refuseFileDrag,
  onDrop: refuseFileDrag,
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
          ? REFUSING_ZONE_PROPS
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
 * The four handlers must keep their identity between renders: each change is
 * a new claim, which renders the pane and the box again.
 */
export function useComposerDropScopeTarget(
  target: ComposerDropTarget,
): ComposerDropTarget {
  const claim = use(ComposerDropScopeContext);
  const { onDragEnter, onDragLeave, onDragOver, onDrop, overlayVariant } =
    target;
  useEffect(() => {
    if (claim === null) return;
    claim({ onDragEnter, onDragLeave, onDragOver, onDrop, overlayVariant });
    return () => claim(null);
  }, [claim, onDragEnter, onDragLeave, onDragOver, onDrop, overlayVariant]);
  return claim === null ? target : PANE_TAKES_DROPS;
}

/**
 * For an element inside a pane that takes drops itself (a message being
 * edited in the transcript): the pane's zone ends at its edge, so the pane's
 * affordance never covers a drop the pane's box will not receive.
 */
export const OWN_DROP_TARGET_PROPS = {
  onDragEnter: keepFromPane,
  onDragLeave: keepFromPane,
} as const;
