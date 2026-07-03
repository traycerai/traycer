import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { type MouseEvent, type ReactNode } from "react";
import {
  useChatArtifactDragSource,
  type ChatArtifactDragIdentity,
} from "@/components/epic-canvas/dnd/use-chat-artifact-drag-source";
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
 * Delegates the canvas-store subscription (`viewTabId`) and the `useDraggable`
 * registration to the shared `useChatArtifactDragSource` hook; a non-draggable
 * result (e.g. no open tab for the epic) still renders the same button but
 * disables the drag surface.
 */
function DraggableReferenceChip(
  props: TraycerReferenceChipProps & {
    readonly onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  },
) {
  const { refKind, sameEpicNodeRef, epicId } = props;
  // Build the artifact identity from the resolved same-epic ref, guarding the
  // kind to the artifact-only payload type. `null` when the ref is absent or is
  // not an artifact kind, which disables the drag surface. This component only
  // mounts for spec/ticket candidates (see `isChatArtifactDragCandidate`), so
  // the shared hook's own gate is `enabled: true`.
  const identity: ChatArtifactDragIdentity | null =
    sameEpicNodeRef === null || !isEpicArtifactKind(sameEpicNodeRef.type)
      ? null
      : {
          id: sameEpicNodeRef.id,
          type: sameEpicNodeRef.type,
          name: sameEpicNodeRef.name,
          hostId: sameEpicNodeRef.hostId,
        };
  const { isDraggable, setNodeRef, listeners, attributes, isDragging } =
    useChatArtifactDragSource({ epicId, identity, enabled: true });

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
