import { useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type KeyboardCodes,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE,
  EpicCanvasPointerSensor,
} from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";

const MODIFIERS = [restrictToVerticalAxis];

/**
 * Space picks a row up and drops it, as the tab strip's keyboard drag does;
 * Enter is left to the row, which opens its channel or toggles its section.
 */
const KEYBOARD_CODES: KeyboardCodes = {
  start: ["Space"],
  cancel: ["Escape"],
  end: ["Space"],
};

/**
 * The default rect intersection, except that a pointer outside the list (the
 * box its rows span) is over nothing. The vertical-axis modifier keeps the
 * lifted row inside the column, so a pointer carried sideways out of the
 * list would otherwise still drop on the row the lifted one last covered. A
 * keyboard drag has no pointer and keeps the default.
 */
const collisionDetection: CollisionDetection = (args) => {
  const pointer = args.pointerCoordinates;
  if (pointer === null) return rectIntersection(args);
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const container of args.droppableContainers) {
    const rect = args.droppableRects.get(container.id);
    if (rect === undefined) continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  const inside =
    pointer.x >= left &&
    pointer.x <= right &&
    pointer.y >= top &&
    pointer.y <= bottom;
  return inside ? rectIntersection(args) : [];
};

/** What a sortable row spreads on the element it is dragged by. */
export type ColumnDragHandle = {
  readonly ref: (element: HTMLElement | null) => void;
  readonly attributes: DraggableAttributes;
  readonly listeners: DraggableSyntheticListeners;
};

/**
 * One list of the channel column the person reorders by dragging (decision
 * 151): the sections, or one section's channels. Its own drag context, so a
 * row never leaves its list: a drop over nothing of it, or with the pointer
 * outside it, changes nothing. The
 * sensors are the tab strip's: the pointer past the same activation distance,
 * never a touch press (that is a scroll), and the keyboard. The dragged row
 * lifts while the list reflows under it to show where it lands; on a drop
 * `onReorder` gets the list's full new order. Each row is a `useSortable`
 * of its id, faded in place while its lifted copy is dragged.
 */
export function SortableColumnList(props: {
  readonly ids: ReadonlyArray<string>;
  readonly onReorder: (order: ReadonlyArray<string>) => void;
  /** The lifted copy of the row being dragged. */
  readonly renderLifted: (id: string) => ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const { ids, onReorder } = props;
  const sensors = useSensors(
    useSensor(EpicCanvasPointerSensor, {
      activationConstraint: { distance: EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: KEYBOARD_CODES,
    }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const handleDragStart = (event: DragStartEvent): void => {
    setActiveId(String(event.active.id));
  };
  const handleDragEnd = (event: DragEndEvent): void => {
    setActiveId(null);
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove([...ids], from, to));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      modifiers={MODIFIERS}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        {props.children}
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeId === null ? null : (
          <div inert className="rounded-md bg-popover shadow-md">
            {props.renderLifted(activeId)}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
