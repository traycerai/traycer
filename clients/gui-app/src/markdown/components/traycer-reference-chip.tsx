import {
  useDraggable,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { useId, useMemo, type MouseEvent, type ReactNode } from "react";
import {
  CHAT_ARTIFACT_DND_TYPE,
  getChatArtifactDragId,
  type EpicCanvasChatArtifactDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { isEpicArtifactKind } from "@/lib/artifacts/node-display";
import { cn } from "@/lib/utils";

interface TraycerReferenceChipProps {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly title: string | undefined;
  readonly refKind: "spec" | "ticket" | "chat" | "epic";
  readonly onOpen: ((event: MouseEvent<HTMLButtonElement>) => void) | null;
  readonly sameEpicNodeRef: EpicNodeRef | null;
  readonly epicId: string | undefined;
}

/**
 * Shared inline chip for the legacy `<traycer-*>` reference components. Mirrors
 * the visual treatment of the prior `TraycerFileReference` chip: a small inline
 * button with an icon and the model-authored label.
 *
 * When `onOpen` is `null` the reference is not openable (missing id, no epic
 * context, or an unresolved same-epic node) and the chip degrades to the plain
 * label text - no button, no dead click.
 *
 * A same-epic `spec` / `ticket` reference doubles as a drag source into the
 * canvas (mirroring the sidebar): the whole pill is the drag surface. Only that
 * case mounts `DraggableReferenceChip`, which owns the canvas-store subscription
 * and the `useDraggable` registration. Every other openable chip (chat, epic,
 * cross-epic `navigate`) renders the plain, presentational button and pays no
 * drag cost - so the generic chip never couples to the canvas for references
 * that can never be dragged.
 */
export function TraycerReferenceChip(props: TraycerReferenceChipProps) {
  // Inert reference: plain label text, no button, no canvas/DnD coupling.
  if (props.onOpen === null) {
    return <span>{props.children}</span>;
  }
  if (isChatArtifactDragCandidate(props)) {
    return <DraggableReferenceChip {...props} onOpen={props.onOpen} />;
  }
  return (
    <ReferenceChipButton
      icon={props.icon}
      title={props.title}
      refKind={props.refKind}
      onOpen={props.onOpen}
      drag={null}
    >
      {props.children}
    </ReferenceChipButton>
  );
}

/**
 * Drag eligibility narrower than click: only a resolved same-epic `spec` /
 * `ticket` node is a canvas drag source. Computed from props alone (no hooks),
 * so the parent can decide whether to mount the drag-capable child without
 * itself subscribing to the canvas store.
 */
function isChatArtifactDragCandidate(
  props: TraycerReferenceChipProps,
): boolean {
  return (
    (props.refKind === "spec" || props.refKind === "ticket") &&
    props.sameEpicNodeRef !== null &&
    props.epicId !== undefined &&
    props.epicId.length > 0
  );
}

/**
 * The drag-capable variant, mounted only for same-epic spec/ticket references.
 * Owns the canvas-store subscription (`viewTabId`) and the `useDraggable`
 * registration; a `null` `viewTabId` (no open tab for the epic) still renders
 * the same button but disables the drag surface.
 */
function DraggableReferenceChip(
  props: TraycerReferenceChipProps & {
    readonly onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  },
) {
  const { refKind, sameEpicNodeRef, epicId } = props;
  // Occurrence-unique drag id (C3): the same artifact may be mentioned many
  // times in one message, so the id keys on `useId()`, not the artifact id.
  const occurrenceId = useId();
  // `viewTabId` (C1) comes from the pure, non-side-effecting resolver read via
  // the canvas store - never the side-effecting `resolveTargetTabForEpic`. A
  // `null` result (no open tab for the epic) makes the chip non-draggable.
  const viewTabId = useEpicCanvasStore((state) =>
    epicId === undefined || epicId.length === 0
      ? null
      : state.resolveTabIdForEpic(epicId),
  );
  // `epicNodeRefForNodeId` mints a fresh `instanceId` every render, so the ref
  // object identity churns each render even though the payload omits it. Depend
  // the memo on the primitive fields it actually reads (not the ref object) so
  // `useDraggable` receives a stable `data` reference across renders.
  const nodeId = sameEpicNodeRef === null ? null : sameEpicNodeRef.id;
  const nodeType = sameEpicNodeRef === null ? null : sameEpicNodeRef.type;
  const nodeName = sameEpicNodeRef === null ? null : sameEpicNodeRef.name;
  const nodeHostId = sameEpicNodeRef === null ? null : sameEpicNodeRef.hostId;
  const dragData = useMemo<EpicCanvasChatArtifactDragData | undefined>(() => {
    if (refKind !== "spec" && refKind !== "ticket") return undefined;
    if (epicId === undefined || epicId.length === 0) return undefined;
    if (viewTabId === null) return undefined;
    if (nodeId === null || nodeName === null || nodeHostId === null) {
      return undefined;
    }
    // The ref is a spec/ticket artifact here (given the refKind gate); the
    // guard narrows the kind to the artifact-only identity the payload carries.
    if (!isEpicArtifactKind(nodeType)) return undefined;
    return {
      kind: CHAT_ARTIFACT_DND_TYPE,
      epicId,
      viewTabId,
      artifact: {
        id: nodeId,
        type: nodeType,
        name: nodeName,
        hostId: nodeHostId,
      },
    };
  }, [refKind, epicId, viewTabId, nodeId, nodeType, nodeName, nodeHostId]);

  const isDraggable = dragData !== undefined;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: getChatArtifactDragId(occurrenceId),
    disabled: !isDraggable,
    data: dragData,
  });

  return (
    <ReferenceChipButton
      icon={props.icon}
      title={props.title}
      refKind={refKind}
      onOpen={props.onOpen}
      drag={
        isDraggable
          ? { ref: setNodeRef, attributes, listeners, isDragging }
          : null
      }
    >
      {props.children}
    </ReferenceChipButton>
  );
}

/** dnd-kit wiring the button spreads when it is an active drag surface. */
interface ReferenceChipDragWiring {
  readonly ref: (element: HTMLElement | null) => void;
  readonly attributes: DraggableAttributes;
  readonly listeners: DraggableSyntheticListeners;
  readonly isDragging: boolean;
}

/**
 * The presentational reference button. `drag` is `null` for click-only chips and
 * carries the dnd-kit wiring for an active drag source. The drag surface is
 * attached only when `drag` is non-null, so a click-only chip is never announced
 * as `draggable` / `aria-disabled` and its click/navigate semantics stay
 * untouched.
 */
function ReferenceChipButton(props: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly title: string | undefined;
  readonly refKind: "spec" | "ticket" | "chat" | "epic";
  readonly onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly drag: ReferenceChipDragWiring | null;
}) {
  const drag = props.drag;
  return (
    <button
      ref={drag === null ? undefined : drag.ref}
      {...(drag === null ? undefined : drag.attributes)}
      {...(drag === null ? undefined : drag.listeners)}
      type="button"
      onClick={props.onOpen}
      title={props.title}
      data-traycer-ref={props.refKind}
      className={cn(
        "mx-px inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/60 px-1.5 py-0.5 align-baseline text-ui-sm font-medium text-foreground/90 no-underline",
        "transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        // Affordance (plan section 6): whole pill is the drag surface -
        // grab cursor + a subtle border/ring emphasis on hover, no inline grip.
        drag !== null &&
          "cursor-grab hover:border-primary/40 hover:ring-1 hover:ring-primary/40",
        drag !== null && drag.isDragging && "cursor-grabbing opacity-60",
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {props.icon}
      </span>
      <span className="truncate">{props.children}</span>
    </button>
  );
}
