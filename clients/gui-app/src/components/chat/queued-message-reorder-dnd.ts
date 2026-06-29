import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  closestCenter,
  type CollisionDetection,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type ClientRect,
  type Modifiers,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS, type Transform } from "@dnd-kit/utilities";
import type { ChatQueuedItem } from "@traycer/protocol/host/agent/gui/subscribe";

const QUEUED_MESSAGE_DND_TYPE = "queued-message";

interface QueuedMessageDragModifierInput {
  readonly draggingNodeRect: ClientRect | null;
  readonly scrollableAncestorRects: ReadonlyArray<ClientRect>;
  readonly transform: Transform;
}

const restrictQueuedMessageDragToScrollContainer = (
  args: QueuedMessageDragModifierInput,
): Transform => {
  const { draggingNodeRect, scrollableAncestorRects, transform } = args;
  if (draggingNodeRect === null || scrollableAncestorRects.length === 0) {
    return transform;
  }
  const scrollContainerRect = scrollableAncestorRects[0];

  return {
    ...transform,
    x: clampTransformAxis({
      currentStart: draggingNodeRect.left,
      currentEnd: draggingNodeRect.right,
      boundaryStart: scrollContainerRect.left,
      boundaryEnd: scrollContainerRect.right,
      transformValue: transform.x,
    }),
    y: clampTransformAxis({
      currentStart: draggingNodeRect.top,
      currentEnd: draggingNodeRect.bottom,
      boundaryStart: scrollContainerRect.top,
      boundaryEnd: scrollContainerRect.bottom,
      transformValue: transform.y,
    }),
  };
};

export const QUEUED_MESSAGE_DND_MODIFIERS: Modifiers = [
  restrictQueuedMessageDragToScrollContainer,
];

interface QueuedMessageDndData {
  readonly kind: typeof QUEUED_MESSAGE_DND_TYPE;
  readonly queueItemId: string;
  readonly index: number;
  readonly orderKey: string;
}

interface ActiveQueuedMessageDrag {
  readonly queueItemId: string;
  readonly orderKey: string;
}

export interface QueuedMessageDropPreview {
  readonly queueItemId: string;
  readonly beforeQueueItemId: string | null;
  readonly index: number;
}

export interface ResolveQueuedMessageDropPreviewInput {
  readonly sourceQueueItemId: string;
  readonly targetQueueItemId: string;
  readonly targetIndex: number;
  readonly targetTop: number;
  readonly targetHeight: number;
  readonly pointerY: number;
  readonly orderedQueueItemIds: ReadonlyArray<string>;
  readonly activeOrderKey: string;
  readonly currentOrderKey: string;
}

interface UseQueuedMessageReorderDndOptions {
  readonly items: ReadonlyArray<ChatQueuedItem>;
  readonly onReorder: (
    item: ChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
}

interface UseQueuedMessageReorderDndReturn {
  readonly orderKey: string;
  readonly sortableItemIds: ReadonlyArray<string>;
  readonly dropPreview: QueuedMessageDropPreview | null;
  readonly collisionDetection: CollisionDetection;
  readonly handleDragStart: (event: DragStartEvent) => void;
  readonly handleDragMove: (event: DragMoveEvent) => void;
  readonly handleDragOver: (event: DragOverEvent) => void;
  readonly handleDragEnd: (event: DragEndEvent) => void;
  readonly handleDragCancel: () => void;
}

interface UseQueuedMessageRowSortableOptions {
  readonly queueItemId: string;
  readonly index: number;
  readonly orderKey: string;
  readonly disabled: boolean;
}

interface UseQueuedMessageRowSortableReturn {
  readonly setNodeRef: (element: HTMLElement | null) => void;
  readonly setActivatorNodeRef: (element: HTMLElement | null) => void;
  readonly attributes: DraggableAttributes;
  readonly listeners: DraggableSyntheticListeners;
  readonly style: CSSProperties;
  readonly isDragSource: boolean;
  readonly isDropTarget: boolean;
  readonly disabled: boolean;
}

export function buildQueuedMessageOrderKey(
  orderedQueueItemIds: ReadonlyArray<string>,
): string {
  return orderedQueueItemIds.join("\u001f");
}

export function resolveQueuedMessageDropPreview(
  input: ResolveQueuedMessageDropPreviewInput,
): QueuedMessageDropPreview | null {
  if (input.activeOrderKey !== input.currentOrderKey) return null;

  const sourceIndex = input.orderedQueueItemIds.indexOf(
    input.sourceQueueItemId,
  );
  const targetIndex = input.orderedQueueItemIds.indexOf(
    input.targetQueueItemId,
  );
  if (sourceIndex === -1 || targetIndex === -1) return null;
  if (targetIndex !== input.targetIndex) return null;

  const targetMiddleY = input.targetTop + input.targetHeight / 2;
  const rawInsertIndex =
    input.pointerY < targetMiddleY ? targetIndex : targetIndex + 1;
  const boundedInsertIndex = Math.max(
    0,
    Math.min(rawInsertIndex, input.orderedQueueItemIds.length),
  );

  if (
    boundedInsertIndex === sourceIndex ||
    boundedInsertIndex === sourceIndex + 1
  ) {
    return null;
  }

  return {
    queueItemId: input.sourceQueueItemId,
    beforeQueueItemId: input.orderedQueueItemIds[boundedInsertIndex] ?? null,
    index: boundedInsertIndex,
  };
}

export function useQueuedMessageReorderDnd(
  options: UseQueuedMessageReorderDndOptions,
): UseQueuedMessageReorderDndReturn {
  const { items, onReorder } = options;
  const orderedQueueItemIds = useMemo(
    () => items.map((item) => item.queueItemId),
    [items],
  );
  const itemById = useMemo(() => {
    const map = new Map<string, ChatQueuedItem>();
    items.forEach((item) => {
      map.set(item.queueItemId, item);
    });
    return map;
  }, [items]);
  const orderKey = useMemo(
    () => buildQueuedMessageOrderKey(orderedQueueItemIds),
    [orderedQueueItemIds],
  );
  const [activeDrag, setActiveDrag] = useState<ActiveQueuedMessageDrag | null>(
    null,
  );
  const [dropPreview, setDropPreview] =
    useState<QueuedMessageDropPreview | null>(null);
  const activeDragRef = useRef<ActiveQueuedMessageDrag | null>(null);
  const lastDropPreviewRef = useRef<QueuedMessageDropPreview | null>(null);
  const lastCollisionPointerYRef = useRef<number | null>(null);

  const resetDragState = useCallback(() => {
    activeDragRef.current = null;
    lastDropPreviewRef.current = null;
    lastCollisionPointerYRef.current = null;
    setActiveDrag(null);
    setDropPreview(null);
  }, []);

  /**
   * Collision detection for the queue's local DndContext: delegates to
   * `closestCenter` and stashes the pass's `pointerCoordinates`. This is the
   * ONLY pointer source for the midline math below. @dnd-kit/core's event
   * `delta` is scroll-adjusted (it folds in the scroll delta since drag
   * start) while droppable rects and `pointerCoordinates` live in the
   * current viewport frame, so reconstructing the pointer as
   * `activatorEvent.clientY + delta.y` drifts by the scroll amount once the
   * queue list auto-scrolls mid-drag. Keyboard drags carry no pointer
   * coordinates and resolve no preview, matching the previous behavior.
   */
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    lastCollisionPointerYRef.current = args.pointerCoordinates?.y ?? null;
    return closestCenter(args);
  }, []);

  const resolveDropPreviewFromEvent = useCallback(
    (
      event: DragMoveEvent | DragOverEvent | DragEndEvent,
    ): QueuedMessageDropPreview | null => {
      const active = activeDragRef.current;
      if (active === null) return null;
      const sourceData = readQueuedMessageDndData(event.active.data.current);
      const targetData = readQueuedMessageDndData(event.over?.data.current);
      const targetRect = event.over?.rect;
      const pointerY = lastCollisionPointerYRef.current;
      if (
        sourceData === null ||
        targetData === null ||
        targetRect === undefined ||
        pointerY === null ||
        active.queueItemId !== sourceData.queueItemId
      ) {
        return null;
      }

      return resolveQueuedMessageDropPreview({
        sourceQueueItemId: sourceData.queueItemId,
        targetQueueItemId: targetData.queueItemId,
        targetIndex: targetData.index,
        targetTop: targetRect.top,
        targetHeight: targetRect.height,
        pointerY,
        orderedQueueItemIds,
        activeOrderKey: active.orderKey,
        currentOrderKey: orderKey,
      });
    },
    [orderKey, orderedQueueItemIds],
  );

  const setPreview = useCallback((next: QueuedMessageDropPreview | null) => {
    const previous = lastDropPreviewRef.current;
    if (queuedMessageDropPreviewEqual(previous, next)) return;
    lastDropPreviewRef.current = next;
    setDropPreview(next);
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const sourceData = readQueuedMessageDndData(event.active.data.current);
      if (sourceData === null || sourceData.orderKey !== orderKey) return;
      const next = {
        queueItemId: sourceData.queueItemId,
        orderKey: sourceData.orderKey,
      };
      activeDragRef.current = next;
      setActiveDrag(next);
      setPreview(null);
    },
    [orderKey, setPreview],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      setPreview(resolveDropPreviewFromEvent(event));
    },
    [resolveDropPreviewFromEvent, setPreview],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      setPreview(resolveDropPreviewFromEvent(event));
    },
    [resolveDropPreviewFromEvent, setPreview],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const active = activeDragRef.current;
      const finalPreview =
        active === null || active.orderKey !== orderKey
          ? null
          : (resolveDropPreviewFromEvent(event) ?? lastDropPreviewRef.current);

      if (finalPreview !== null) {
        const item = itemById.get(finalPreview.queueItemId);
        if (item !== undefined) {
          onReorder(item, finalPreview.beforeQueueItemId);
        }
      }

      resetDragState();
    },
    [
      itemById,
      onReorder,
      orderKey,
      resetDragState,
      resolveDropPreviewFromEvent,
    ],
  );

  const handleDragCancel = useCallback(() => {
    resetDragState();
  }, [resetDragState]);

  return {
    orderKey,
    sortableItemIds: orderedQueueItemIds,
    dropPreview:
      activeDrag !== null && activeDrag.orderKey !== orderKey
        ? null
        : dropPreview,
    collisionDetection,
    handleDragStart,
    handleDragMove,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  };
}

export function useQueuedMessageRowSortable(
  options: UseQueuedMessageRowSortableOptions,
): UseQueuedMessageRowSortableReturn {
  const data = useMemo<QueuedMessageDndData>(
    () => ({
      kind: QUEUED_MESSAGE_DND_TYPE,
      queueItemId: options.queueItemId,
      index: options.index,
      orderKey: options.orderKey,
    }),
    [options.index, options.orderKey, options.queueItemId],
  );
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({
    id: options.queueItemId,
    data,
    disabled: options.disabled,
  });

  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition: transition ?? undefined,
    }),
    [transform, transition],
  );

  return {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    style,
    isDragSource: isDragging,
    isDropTarget: isOver,
    disabled: options.disabled,
  };
}

function queuedMessageDropPreviewEqual(
  left: QueuedMessageDropPreview | null,
  right: QueuedMessageDropPreview | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.queueItemId === right.queueItemId &&
    left.beforeQueueItemId === right.beforeQueueItemId &&
    left.index === right.index
  );
}

function readQueuedMessageDndData(value: unknown): QueuedMessageDndData | null {
  if (!isRecord(value)) return null;
  if (
    value.kind !== QUEUED_MESSAGE_DND_TYPE ||
    typeof value.queueItemId !== "string" ||
    value.queueItemId.length === 0 ||
    typeof value.index !== "number" ||
    !Number.isInteger(value.index) ||
    value.index < 0 ||
    typeof value.orderKey !== "string"
  ) {
    return null;
  }
  return {
    kind: QUEUED_MESSAGE_DND_TYPE,
    queueItemId: value.queueItemId,
    index: value.index,
    orderKey: value.orderKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampTransformAxis(input: {
  readonly currentStart: number;
  readonly currentEnd: number;
  readonly boundaryStart: number;
  readonly boundaryEnd: number;
  readonly transformValue: number;
}): number {
  if (input.currentStart + input.transformValue <= input.boundaryStart) {
    return input.boundaryStart - input.currentStart;
  }
  if (input.currentEnd + input.transformValue >= input.boundaryEnd) {
    return input.boundaryEnd - input.currentEnd;
  }
  return input.transformValue;
}
